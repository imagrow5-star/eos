/**
 * Semantic deduplication for extracted user memory (Sprint: dedup & reset).
 *
 * The extraction pipelines (services/ai.ts) pull structured items out of every
 * exchange — facts, habits, commitments, goals. A user who restates the same
 * intention across several turns ("I want to hit 100 crores this year", "my
 * target is 100 cr") used to get a new row each time, so the Memory Manifest
 * filled with near-duplicates. This module decides, before inserting, whether a
 * candidate is a semantic re-statement of an existing row — and the boot
 * backfill (dedupBackfill.ts) reuses the same LLM grouping to clean up rows that
 * predate it.
 *
 * Design:
 *   • Pure, unit-testable core — normalization, a cheap lexical pre-filter, the
 *     prompt builders, and robust parsers — none of which touch the network.
 *   • A tiny Haiku call does the actual semantic judgement (lexical overlap
 *     alone can't tell "read before bed" ≈ "read before sleep" apart from "read
 *     before work"). The call is injectable so tests drive it deterministically.
 *   • Fail-OPEN everywhere: any parse/network failure resolves to "not a
 *     duplicate", so a flaky Haiku call never loses the user's data — worst case
 *     a duplicate slips through and the backfill catches it later.
 *
 * Privacy: this module never logs candidate/existing text. Call sites log only
 * the decision + a hashed user id (Tier 3 guardrail).
 */

import { logger } from "../../lib/logger.js";

// Haiku alias — same model the extraction calls use (services/ai.ts). Cheap,
// small context: ~$0.0005 per dedup check.
export const DEDUP_MODEL = "claude-haiku-4-5";

// ─── Anthropic client (lazy, self-contained) ──────────────────────────────────
// Kept local so this module has no import cycle with ai.ts (which imports the
// finder from here). Mirrors ai.ts' lazy CJS init; tests spy on the shared
// Messages prototype, so both clients observe the stub.
let _client: import("@anthropic-ai/sdk").Anthropic | null = null;
function getClient(): import("@anthropic-ai/sdk").Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) {
    const Anthropic =
      require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk").Anthropic;
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DedupEntry {
  id: number;
  content: string;
}

export interface DedupDecision {
  isDuplicate: boolean;
  matchingId: number | null;
  reasoning: string;
}

export interface SemanticCluster {
  canonicalId: number;
  duplicateIds: number[];
}

/** Raw-text LLM call: prompt in, model text out. Injectable for tests. */
export type DedupLlm = (prompt: string) => Promise<string>;

/**
 * Extraction-time dedup check: candidate + the existing rows (with real ids) →
 * decision. The extraction pipelines take one of these (defaulting to the Haiku
 * finder) so tests can inject a deterministic finder over the real rows without
 * a network call.
 */
export type DedupFinder = (candidate: string, existing: DedupEntry[]) => Promise<DedupDecision>;

// ─── Normalization + cheap lexical pre-filter ─────────────────────────────────
// The pre-filter exists to save cost, not to make the decision: when a candidate
// shares NO meaningful token with any existing row it cannot be a duplicate, so
// we skip Haiku entirely. Anything with overlap goes to the model.

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "is", "am", "are", "be", "been", "being", "was", "were",
  "my", "i", "me", "we", "our", "you", "your", "it", "its", "this", "that", "these", "those",
  "and", "or", "but", "for", "in", "on", "at", "by", "with", "as", "so", "if", "then",
  "will", "would", "can", "could", "should", "do", "does", "did", "have", "has", "had",
  "want", "wanna", "gonna", "need", "get", "got",
]);

/** Lowercase → split on non-alphanumerics → drop stopwords + 1-char noise. */
export function normalizeTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Jaccard overlap (0..1) of two strings' meaningful token sets. */
export function lexicalOverlap(a: string, b: string): number {
  const sa = new Set(normalizeTokens(a));
  const sb = new Set(normalizeTokens(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Highest lexical overlap between the candidate and any existing entry. */
export function bestLexicalOverlap(candidate: string, existing: DedupEntry[]): number {
  let best = 0;
  for (const e of existing) {
    const o = lexicalOverlap(candidate, e.content);
    if (o > best) best = o;
  }
  return best;
}

// ─── Prompt builders (pure) ────────────────────────────────────────────────────

export function buildDedupPrompt(candidate: string, existing: DedupEntry[]): string {
  const list = existing.map((e) => `  ${e.id}: ${e.content}`).join("\n");
  return `You are deduplicating a personal-memory store. A new candidate entry was just extracted from a conversation. Decide whether it is a SEMANTICALLY EQUIVALENT capture of the same underlying thing as one of the existing entries — the same intention, goal, habit, or fact worded differently — NOT merely on the same topic.

New candidate:
"""${candidate}"""

Existing entries (id: text):
${list}

Two entries are the SAME thing if a person would consider them one item (e.g. "hit 100 crores this year" and "my target is 100 cr" — same goal; "read before bed" and "read before sleep" — same habit). They are DIFFERENT if they capture distinct things even if related (e.g. "read before bed" vs "read before work" — different habits).

Reply with ONLY this JSON, no prose:
{"is_duplicate": true|false, "matching_id": <id of the equivalent existing entry, or null>, "reasoning": "<one short sentence>"}`;
}

export function buildClusterPrompt(entries: DedupEntry[]): string {
  const list = entries.map((e) => `  ${e.id}: ${e.content}`).join("\n");
  return `You are cleaning up a personal-memory store that has accumulated duplicates. Group the entries below into semantic-equivalence clusters: entries that capture the SAME underlying thing (same intention, goal, habit, or fact worded differently) belong in one cluster. Entries that are distinct — even if related or on the same topic — must NOT be grouped.

Entries (id: text):
${list}

Only report clusters that contain MORE THAN ONE entry (i.e. actual duplicates). Pick any one member as canonical_id; list the rest in duplicate_ids. Never place an id in more than one cluster. If there are no duplicates, return an empty array.

Reply with ONLY this JSON, no prose:
{"clusters": [{"canonical_id": <id>, "duplicate_ids": [<id>, ...]}]}`;
}

// ─── Robust parsers (pure) ──────────────────────────────────────────────────────

/** First balanced-ish `{...}` slice — tolerates code fences and stray prose. */
function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object");
  return text.slice(start, end + 1);
}

export function parseDedupDecision(text: string): DedupDecision {
  const obj = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const rawId = obj.matching_id;
  const matchingId =
    typeof rawId === "number" && Number.isInteger(rawId)
      ? rawId
      : typeof rawId === "string" && /^\d+$/.test(rawId)
        ? Number(rawId)
        : null;
  return {
    isDuplicate: obj.is_duplicate === true,
    matchingId: obj.is_duplicate === true ? matchingId : null,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
  };
}

export function parseClusterDecision(text: string): SemanticCluster[] {
  const obj = JSON.parse(extractJsonObject(text)) as { clusters?: unknown };
  if (!Array.isArray(obj.clusters)) return [];
  const out: SemanticCluster[] = [];
  for (const c of obj.clusters) {
    if (!c || typeof c !== "object") continue;
    const canonical = (c as any).canonical_id;
    const dups = (c as any).duplicate_ids;
    if (typeof canonical !== "number" || !Number.isInteger(canonical)) continue;
    if (!Array.isArray(dups)) continue;
    const duplicateIds = dups
      .filter((d) => typeof d === "number" && Number.isInteger(d) && d !== canonical)
      .map((d) => d as number);
    if (duplicateIds.length > 0) out.push({ canonicalId: canonical, duplicateIds });
  }
  return out;
}

// ─── Default Haiku LLM ──────────────────────────────────────────────────────────

export const haikuLlm: DedupLlm = async (prompt: string): Promise<string> => {
  const client = getClient();
  if (!client) return ""; // no key → empty → parse fails → fail-open (not a duplicate)
  const resp = await client.messages.create({
    model: DEDUP_MODEL,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });
  const block = resp.content.find((b: { type: string }) => b.type === "text") as
    | { text: string }
    | undefined;
  return block?.text ?? "";
};

// ─── Public API: single-candidate dedup (extraction-time) ─────────────────────

/**
 * Is `candidate` a semantic duplicate of one of `existing`? Fail-open: returns
 * a non-duplicate decision on any error or when the model can't be reached.
 * Skips the model call entirely when nothing shares a meaningful token (cheap
 * negative fast-path) so extraction cost only grows when there's a real
 * candidate to compare against.
 */
export const defaultDedupFinder: DedupFinder = (candidate, existing) =>
  findSemanticDuplicate(candidate, existing);

export async function findSemanticDuplicate(
  candidate: string,
  existing: DedupEntry[],
  llm: DedupLlm = haikuLlm,
): Promise<DedupDecision> {
  const notDup = (reasoning: string): DedupDecision => ({
    isDuplicate: false,
    matchingId: null,
    reasoning,
  });

  if (!candidate || candidate.trim().length < 3) return notDup("candidate too short");
  if (existing.length === 0) return notDup("no existing entries");
  if (bestLexicalOverlap(candidate, existing) === 0) return notDup("no lexical overlap");

  try {
    const text = await llm(buildDedupPrompt(candidate, existing));
    const decision = parseDedupDecision(text);
    // Guard against a hallucinated id: the match must be a real existing row.
    if (decision.isDuplicate && decision.matchingId != null) {
      if (existing.some((e) => e.id === decision.matchingId)) return decision;
      return notDup("model returned an unknown matching_id");
    }
    return notDup(decision.reasoning || "model: not a duplicate");
  } catch {
    // Fail-open — never lose data because the dedup check hiccupped.
    return notDup("dedup check failed (fail-open)");
  }
}

// ─── Public API: batch clustering (backfill) ──────────────────────────────────

/**
 * Group existing entries into semantic-equivalence clusters (duplicates only).
 * Returns null on any failure so the backfill can SKIP that batch rather than
 * risk a bad merge. Validates every id against the batch and drops clusters
 * whose canonical no longer resolves.
 */
export async function groupSemanticClusters(
  entries: DedupEntry[],
  llm: DedupLlm = haikuLlm,
): Promise<SemanticCluster[] | null> {
  if (entries.length < 2) return [];
  try {
    const text = await llm(buildClusterPrompt(entries));
    const clusters = parseClusterDecision(text);
    const ids = new Set(entries.map((e) => e.id));
    const claimed = new Set<number>();
    const valid: SemanticCluster[] = [];
    for (const c of clusters) {
      if (!ids.has(c.canonicalId) || claimed.has(c.canonicalId)) continue;
      const dups = c.duplicateIds.filter(
        (d) => ids.has(d) && d !== c.canonicalId && !claimed.has(d),
      );
      if (dups.length === 0) continue;
      claimed.add(c.canonicalId);
      for (const d of dups) claimed.add(d);
      valid.push({ canonicalId: c.canonicalId, duplicateIds: dups });
    }
    return valid;
  } catch (err) {
    logger.warn({ err }, "Semantic clustering failed for a batch — skipping it");
    return null;
  }
}
