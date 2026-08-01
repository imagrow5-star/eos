/**
 * One-time semantic-dedup backfill (Sprint: dedup & reset).
 *
 * Existing accounts accumulated duplicate rows before extraction-time dedup
 * (dedup.ts) shipped. This pass cleans them up: per user, per table
 * (memory_facts, habits, commitments, goals), it clusters semantically-
 * equivalent rows with a batched Haiku call and merges each cluster down to ONE
 * canonical row — the OLDEST — folding the duplicates' reference counters (and,
 * for facts, emotional weight + the important flag) into it before deleting them.
 *
 * Non-negotiables honoured here:
 *   • Idempotent — a clean account produces no clusters, so a second run is a
 *     no-op. The merge planner is pure and deterministic given the clusters.
 *   • Never deletes a unique row — only ids the model grouped WITH another, and
 *     every id is re-validated against the loaded rows.
 *   • Never crosses user boundaries — every query is scoped to one user_id, and
 *     users are processed one at a time.
 *   • Skips a batch (never corrupts) if its Haiku call fails — groupSemanticClusters
 *     returns null and we move on.
 *   • Runs in the background at boot without blocking startup (see index.ts).
 *
 * Cost control: because a per-user Haiku sweep isn't free, the boot hook is
 * gated behind DEDUP_BACKFILL_ON_BOOT=true — the operator enables it for the one
 * deploy that should clean house, then unsets it. The functions themselves are
 * safe to run anytime; only the boot trigger is gated.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  memoryFactsTable,
  habitsTable,
  habitCompletionsTable,
  commitmentsTable,
  goalsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { hashUserIdForLog } from "../../lib/logging/hashUserIdForLog.js";
import {
  groupSemanticClusters,
  type DedupEntry,
  type SemanticCluster,
} from "./dedup.js";

const BACKFILL_BATCH_SIZE = 20;

/** Injectable so tests drive clustering deterministically (no network). */
export type ClusterGrouper = (entries: DedupEntry[]) => Promise<SemanticCluster[] | null>;
const defaultGrouper: ClusterGrouper = (entries) => groupSemanticClusters(entries);

// ─── Pure merge planner ────────────────────────────────────────────────────────

export interface MergeRow {
  id: number;
  createdAt: Date;
  timesReferenced: number;
  lastReferencedAt: Date | null;
  emotionalWeight?: number;
  userMarkedImportant?: boolean;
}

export interface MergePlan {
  keeperId: number;
  deleteIds: number[];
  timesReferenced: number;
  lastReferencedAt: Date | null;
  emotionalWeight: number | null; // null when the table has no such column
  userMarkedImportant: boolean | null;
}

/**
 * Turn the model's clusters into concrete merges. For each cluster the KEEPER is
 * the oldest row (lowest createdAt; id breaks ties for determinism); the rest
 * are deleted after their counters fold into the keeper:
 *   timesReferenced  → sum across the whole cluster
 *   lastReferencedAt → latest across the cluster
 *   emotionalWeight  → max across the cluster (facts only)
 *   userMarkedImportant → OR across the cluster (facts only)
 * Clusters that don't resolve to ≥2 real rows are dropped (never delete a unique
 * row). Pure and deterministic — the DB-gated test asserts against it.
 */
export function planMerges(rows: MergeRow[], clusters: SemanticCluster[]): MergePlan[] {
  const byId = new Map<number, MergeRow>(rows.map((r) => [r.id, r]));
  const plans: MergePlan[] = [];
  const used = new Set<number>();

  for (const cluster of clusters) {
    const memberIds = [cluster.canonicalId, ...cluster.duplicateIds].filter(
      (id, i, arr) => arr.indexOf(id) === i,
    );
    const members = memberIds
      .map((id) => byId.get(id))
      .filter((r): r is MergeRow => r != null && !used.has(r.id));
    if (members.length < 2) continue; // never touch a unique row

    // Keeper = oldest (lowest createdAt; lowest id as a stable tiebreak).
    const keeper = members.reduce((best, r) => {
      if (r.createdAt.getTime() !== best.createdAt.getTime()) {
        return r.createdAt.getTime() < best.createdAt.getTime() ? r : best;
      }
      return r.id < best.id ? r : best;
    });

    const timesReferenced = members.reduce((sum, r) => sum + (r.timesReferenced ?? 0), 0);
    const lastReferencedAt = members.reduce<Date | null>((latest, r) => {
      if (!r.lastReferencedAt) return latest;
      if (!latest) return r.lastReferencedAt;
      return r.lastReferencedAt.getTime() > latest.getTime() ? r.lastReferencedAt : latest;
    }, null);
    const hasWeight = members.some((r) => r.emotionalWeight !== undefined);
    const emotionalWeight = hasWeight
      ? members.reduce((max, r) => Math.max(max, r.emotionalWeight ?? 0), 0)
      : null;
    const hasImportant = members.some((r) => r.userMarkedImportant !== undefined);
    const userMarkedImportant = hasImportant
      ? members.some((r) => r.userMarkedImportant === true)
      : null;

    const deleteIds = members.filter((r) => r.id !== keeper.id).map((r) => r.id);
    for (const id of memberIds) used.add(id);

    plans.push({
      keeperId: keeper.id,
      deleteIds,
      timesReferenced,
      lastReferencedAt,
      emotionalWeight,
      userMarkedImportant,
    });
  }

  return plans;
}

/** Split into fixed-size batches so each Haiku call stays small/cheap. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Cluster the rows batch-by-batch; a failed batch (null) is skipped. */
async function clusterInBatches(
  entries: DedupEntry[],
  grouper: ClusterGrouper,
): Promise<SemanticCluster[]> {
  const all: SemanticCluster[] = [];
  for (const batch of chunk(entries, BACKFILL_BATCH_SIZE)) {
    if (batch.length < 2) continue;
    const clusters = await grouper(batch);
    if (clusters == null) continue; // batch failed → skip, don't corrupt
    all.push(...clusters);
  }
  return all;
}

export interface TableBackfillSummary {
  table: string;
  beforeCount: number;
  afterCount: number;
  mergedCount: number;
}

// ─── Per-table backfills ───────────────────────────────────────────────────────

async function backfillFacts(userId: number, grouper: ClusterGrouper): Promise<TableBackfillSummary> {
  const rows = await db
    .select({
      id: memoryFactsTable.id,
      content: memoryFactsTable.fact,
      createdAt: memoryFactsTable.createdAt,
      timesReferenced: memoryFactsTable.timesReferenced,
      lastReferencedAt: memoryFactsTable.lastReferencedAt,
      emotionalWeight: memoryFactsTable.emotionalWeight,
      userMarkedImportant: memoryFactsTable.userMarkedImportant,
    })
    .from(memoryFactsTable)
    .where(eq(memoryFactsTable.userId, userId))
    .orderBy(asc(memoryFactsTable.createdAt));
  const before = rows.length;
  if (before < 2) return { table: "memory_facts", beforeCount: before, afterCount: before, mergedCount: 0 };

  const clusters = await clusterInBatches(rows.map((r) => ({ id: r.id, content: r.content })), grouper);
  const plans = planMerges(rows as MergeRow[], clusters);
  if (plans.length === 0) return { table: "memory_facts", beforeCount: before, afterCount: before, mergedCount: 0 };

  let merged = 0;
  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .update(memoryFactsTable)
        .set({
          timesReferenced: p.timesReferenced,
          lastReferencedAt: p.lastReferencedAt,
          emotionalWeight: p.emotionalWeight ?? undefined,
          userMarkedImportant: p.userMarkedImportant ?? undefined,
        })
        .where(and(eq(memoryFactsTable.id, p.keeperId), eq(memoryFactsTable.userId, userId)));
      await tx
        .delete(memoryFactsTable)
        .where(and(inArray(memoryFactsTable.id, p.deleteIds), eq(memoryFactsTable.userId, userId)));
      merged += p.deleteIds.length;
    }
  });
  return { table: "memory_facts", beforeCount: before, afterCount: before - merged, mergedCount: merged };
}

async function backfillHabits(userId: number, grouper: ClusterGrouper): Promise<TableBackfillSummary> {
  const rows = await db
    .select({
      id: habitsTable.id,
      content: habitsTable.name,
      createdAt: habitsTable.createdAt,
      timesReferenced: habitsTable.timesReferenced,
      lastReferencedAt: habitsTable.lastReferencedAt,
    })
    .from(habitsTable)
    .where(eq(habitsTable.userId, userId))
    .orderBy(asc(habitsTable.createdAt));
  const before = rows.length;
  if (before < 2) return { table: "habits", beforeCount: before, afterCount: before, mergedCount: 0 };

  const clusters = await clusterInBatches(rows.map((r) => ({ id: r.id, content: r.content })), grouper);
  const plans = planMerges(rows as MergeRow[], clusters);
  if (plans.length === 0) return { table: "habits", beforeCount: before, afterCount: before, mergedCount: 0 };

  let merged = 0;
  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .update(habitsTable)
        .set({ timesReferenced: p.timesReferenced, lastReferencedAt: p.lastReferencedAt })
        .where(and(eq(habitsTable.id, p.keeperId), eq(habitsTable.userId, userId)));
      // Preserve completion history: repoint the duplicates' completions onto
      // the keeper before deleting the duplicate habit rows.
      await tx
        .update(habitCompletionsTable)
        .set({ habitId: p.keeperId })
        .where(and(inArray(habitCompletionsTable.habitId, p.deleteIds), eq(habitCompletionsTable.userId, userId)));
      await tx
        .delete(habitsTable)
        .where(and(inArray(habitsTable.id, p.deleteIds), eq(habitsTable.userId, userId)));
      merged += p.deleteIds.length;
    }
  });
  return { table: "habits", beforeCount: before, afterCount: before - merged, mergedCount: merged };
}

async function backfillCommitments(userId: number, grouper: ClusterGrouper): Promise<TableBackfillSummary> {
  const rows = await db
    .select({
      id: commitmentsTable.id,
      content: commitmentsTable.content,
      createdAt: commitmentsTable.createdAt,
      timesReferenced: commitmentsTable.timesReferenced,
      lastReferencedAt: commitmentsTable.lastReferencedAt,
    })
    .from(commitmentsTable)
    .where(eq(commitmentsTable.userId, userId))
    .orderBy(asc(commitmentsTable.createdAt));
  const before = rows.length;
  if (before < 2) return { table: "commitments", beforeCount: before, afterCount: before, mergedCount: 0 };

  const clusters = await clusterInBatches(rows.map((r) => ({ id: r.id, content: r.content })), grouper);
  const plans = planMerges(rows as MergeRow[], clusters);
  if (plans.length === 0) return { table: "commitments", beforeCount: before, afterCount: before, mergedCount: 0 };

  let merged = 0;
  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .update(commitmentsTable)
        .set({ timesReferenced: p.timesReferenced, lastReferencedAt: p.lastReferencedAt })
        .where(and(eq(commitmentsTable.id, p.keeperId), eq(commitmentsTable.userId, userId)));
      await tx
        .delete(commitmentsTable)
        .where(and(inArray(commitmentsTable.id, p.deleteIds), eq(commitmentsTable.userId, userId)));
      merged += p.deleteIds.length;
    }
  });
  return { table: "commitments", beforeCount: before, afterCount: before - merged, mergedCount: merged };
}

async function backfillGoals(userId: number, grouper: ClusterGrouper): Promise<TableBackfillSummary> {
  const rows = await db
    .select({
      id: goalsTable.id,
      content: goalsTable.title,
      createdAt: goalsTable.createdAt,
      timesReferenced: goalsTable.timesReferenced,
      lastReferencedAt: goalsTable.lastReferencedAt,
    })
    .from(goalsTable)
    .where(eq(goalsTable.userId, userId))
    .orderBy(asc(goalsTable.createdAt));
  const before = rows.length;
  if (before < 2) return { table: "goals", beforeCount: before, afterCount: before, mergedCount: 0 };

  const clusters = await clusterInBatches(rows.map((r) => ({ id: r.id, content: r.content })), grouper);
  const plans = planMerges(rows as MergeRow[], clusters);
  if (plans.length === 0) return { table: "goals", beforeCount: before, afterCount: before, mergedCount: 0 };

  let merged = 0;
  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .update(goalsTable)
        .set({ timesReferenced: p.timesReferenced, lastReferencedAt: p.lastReferencedAt })
        .where(and(eq(goalsTable.id, p.keeperId), eq(goalsTable.userId, userId)));
      // goal_tasks FK is ON DELETE CASCADE, so the duplicates' sub-tasks go with
      // them; the keeper keeps its own.
      await tx
        .delete(goalsTable)
        .where(and(inArray(goalsTable.id, p.deleteIds), eq(goalsTable.userId, userId)));
      merged += p.deleteIds.length;
    }
  });
  return { table: "goals", beforeCount: before, afterCount: before - merged, mergedCount: merged };
}

/** Dedupe every backfill table for ONE user. Each table is independent; a
 *  failure in one is logged and the others still run. */
export async function backfillUserDedup(
  userId: number,
  grouper: ClusterGrouper = defaultGrouper,
): Promise<TableBackfillSummary[]> {
  const summaries: TableBackfillSummary[] = [];
  const tasks: Array<[string, () => Promise<TableBackfillSummary>]> = [
    ["memory_facts", () => backfillFacts(userId, grouper)],
    ["habits", () => backfillHabits(userId, grouper)],
    ["commitments", () => backfillCommitments(userId, grouper)],
    ["goals", () => backfillGoals(userId, grouper)],
  ];
  for (const [table, run] of tasks) {
    try {
      const summary = await run();
      summaries.push(summary);
      if (summary.mergedCount > 0) {
        try {
          const uh = hashUserIdForLog(userId);
          if (uh)
            logger.info(
              { uh, table: summary.table, beforeCount: summary.beforeCount, afterCount: summary.afterCount, mergedCount: summary.mergedCount },
              "Dedup backfill merged duplicate rows",
            );
        } catch { /* logging must never crash the caller */ }
      }
    } catch (err) {
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.warn({ err, uh, table }, "Dedup backfill failed for a table — skipped");
      } catch { /* logging must never crash the caller */ }
    }
  }
  return summaries;
}

/**
 * Boot entry point — dedupe every user, one at a time. Gated behind
 * DEDUP_BACKFILL_ON_BOOT so it only runs on the deploy the operator chooses
 * (per-user Haiku calls aren't free). No-ops without the flag or an API key.
 */
export async function runDedupBackfill(grouper: ClusterGrouper = defaultGrouper): Promise<void> {
  if (process.env.DEDUP_BACKFILL_ON_BOOT !== "true") return;
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn("Dedup backfill requested but ANTHROPIC_API_KEY is unset — skipping");
    return;
  }

  const users = await db.select({ id: usersTable.id }).from(usersTable).orderBy(asc(usersTable.id));
  logger.info({ userCount: users.length }, "Dedup backfill starting");
  let totalMerged = 0;
  for (const u of users) {
    const summaries = await backfillUserDedup(u.id, grouper);
    totalMerged += summaries.reduce((s, x) => s + x.mergedCount, 0);
  }
  logger.info({ totalMerged }, "Dedup backfill complete");
}
