// ─── Story threads — the processing-vs-stuck engine ──────────────────────────
// Tracks recurring episodes/stories the user retells across weeks and assesses
// whether each retelling is EVOLVING (new angles, new questions, shifting
// perspective) or staying FROZEN (same framing repeatedly).
//
// Product invariants (enforced here and in generate.ts, not just in prompts):
//   • chapters only ever surface the RELIEF framing — the evolution of the
//     user's own questions. Never retelling counts, never "stuck", and never
//     anything at all about a frozen thread;
//   • a frozen verdict needs multi-week high-confidence evidence: at least
//     FROZEN_STREAK_MIN consecutive same-framing retellings, each with
//     confidence ≥ SAME_CONFIDENCE_MIN, spanning ≥ FROZEN_MIN_SPAN_DAYS —
//     paraphrase noise in a single week can never flip the switch;
//   • question excerpts are verbatim-validated like every other quote; when
//     validation fails we keep a paraphrase and mark it non-verbatim so the UI
//     never shows quote marks around words the user didn't say;
//   • one retelling per thread per week (idempotent under sweep re-runs).

import { eq } from "drizzle-orm";
import { db, storyThreadsTable, type StoryRetelling, type StoryThread } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { isCrisisText } from "./crisis.js";
import { validateExcerpt, type QuoteSource } from "./quotes.js";

export const SAME_CONFIDENCE_MIN = 0.7; // per-week confidence floor for "same framing"
export const FROZEN_STREAK_MIN = 3; // consecutive same-framing weeks to confirm frozen
export const FROZEN_MIN_SPAN_DAYS = 14; // first→last of the streak must span at least this
export const RETELLINGS_CAP = 12; // keep the most recent N retellings per thread
export const RAISE_COOLDOWN_DAYS = 10; // min days between conversational soft-raises
export const SUPPORT_COOLDOWN_DAYS = 21; // min days between professional-support escalations

// ─── Pure state machine (unit-tested directly) ───────────────────────────────

export interface ThreadStateInput {
  state: string;
  frozenStreak: number;
  retellings: StoryRetelling[]; // includes the incoming retelling as last element
}

export function advanceThreadState(input: ThreadStateInput): { state: "watch" | "evolving" | "frozen"; frozenStreak: number } {
  const incoming = input.retellings[input.retellings.length - 1];
  if (!incoming) return { state: "watch", frozenStreak: 0 };

  // An evolving retelling (new angle / low confidence in sameness) always
  // resets the freeze evidence — recovery is instant, suspicion is slow.
  if (!incoming.sameAsPrior || incoming.confidence < SAME_CONFIDENCE_MIN) {
    return { state: input.retellings.length >= 2 ? "evolving" : "watch", frozenStreak: 0 };
  }

  const streak = input.frozenStreak + 1;
  if (streak >= FROZEN_STREAK_MIN) {
    // Multi-week evidence: the streak's weeks must genuinely span time —
    // FROZEN_STREAK_MIN retellings crammed into force-reruns can't qualify.
    const streakWeeks = input.retellings.slice(-streak).map((r) => r.weekStart);
    const first = streakWeeks[0];
    const last = streakWeeks[streakWeeks.length - 1];
    const spanDays = first && last ? (Date.parse(last) - Date.parse(first)) / 86_400_000 : 0;
    if (spanDays >= FROZEN_MIN_SPAN_DAYS) return { state: "frozen", frozenStreak: streak };
  }
  return { state: "watch", frozenStreak: streak };
}

// ─── Digit-free relative week labels (kind-truth: chapters carry no digits) ───

const WEEK_WORDS = ["this week", "last week", "two weeks ago", "three weeks ago", "four weeks ago", "five weeks ago"];

export function weekLabelFor(weekStart: string, currentWeekStart: string): string {
  const diff = Math.round((Date.parse(currentWeekStart) - Date.parse(weekStart)) / (7 * 86_400_000));
  if (diff < 0) return "this week";
  return WEEK_WORDS[diff] ?? "a while back";
}

// ─── Working-through block (relief framing only) ─────────────────────────────

export interface WorkingThroughEntry {
  weekLabel: string;
  text: string; // the question they were asking that week
  verbatim: boolean; // true → UI may quote it; false → paraphrase, no quote marks
  messageId: number | null;
  date: string; // weekStart of the retelling
}

export interface WorkingThrough {
  label: string;
  entries: WorkingThroughEntry[];
  reflection: string;
}

export const FALLBACK_WORKING_REFLECTION =
  "Look at how the question itself has been moving. That isn't someone stuck — that's a person working something through.";

/**
 * Picks the best EVOLVING thread for the chapter's relief framing, or null.
 * Frozen threads are structurally excluded here — not by prompt, by filter.
 */
export function pickWorkingThroughThread(threads: StoryThread[]): StoryThread | null {
  const eligible = threads.filter((t) => {
    if (t.state !== "evolving") return false;
    const retellings = (t.retellings as StoryRetelling[]) ?? [];
    return retellings.filter((r) => r.question && r.question.trim().length > 0).length >= 2;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => ((b.retellings as StoryRetelling[]).length ?? 0) - ((a.retellings as StoryRetelling[]).length ?? 0));
  return eligible[0] ?? null;
}

export function buildWorkingThroughEntries(thread: StoryThread, currentWeekStart: string): WorkingThroughEntry[] {
  const retellings = ((thread.retellings as StoryRetelling[]) ?? []).filter((r) => r.question && r.question.trim().length > 0);
  return retellings.slice(-3).map((r) => ({
    weekLabel: weekLabelFor(r.weekStart, currentWeekStart),
    text: r.question!.trim(),
    verbatim: r.questionMessageId != null,
    messageId: r.questionMessageId,
    date: r.weekStart,
  }));
}

// ─── Weekly update pass ───────────────────────────────────────────────────────

interface RawThreadUpdate {
  slug?: string | null;
  label?: string;
  weekSummary?: string;
  centralQuestion?: { messageId?: number; excerpt?: string } | null;
  framing?: string;
  sameAsPrior?: boolean;
  confidence?: number;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function threadUpdatePrompt(threads: StoryThread[], weekMessages: QuoteSource[]): string {
  const threadBrief =
    threads.length === 0
      ? "(none yet)"
      : threads
          .map((t) => {
            const retellings = (t.retellings as StoryRetelling[]).slice(-3);
            const history = retellings
              .map((r) => `    ${r.weekStart}: framing="${r.framing}" question="${r.question ?? "—"}"`)
              .join("\n");
            return `  slug="${t.slug}" label="${t.label}"\n${history}`;
          })
          .join("\n");
  const msgs = weekMessages.map((m) => `[${m.id}] (${m.localDate}) ${m.content.slice(0, 400)}`).join("\n");

  return `You are indexing RECURRING EPISODES in a person's messages — specific stories or moments they retell across weeks (e.g. "the airport goodbye", "the failed exam", "the last phone call"). NOT general topics, moods, or ongoing situations — only concrete, specific episodes/memories they narrate again.

KNOWN THREADS (their retelling history):
${threadBrief}

THIS WEEK'S MESSAGES:
${msgs}

For each episode genuinely retold THIS WEEK (matching a known thread or clearly new), output:
- "slug": the known thread's slug, or null for a new one
- "label": short neutral label in their own terms, lowercase, no judgment (e.g. "the airport goodbye")
- "weekSummary": ONE neutral sentence — how they told it this week
- "centralQuestion": the question they were asking about it this week, as {"messageId": <id>, "excerpt": "<VERBATIM substring copied EXACTLY from that message>"} — or null if no real question. The excerpt must be copy-paste exact, 8–160 chars.
- "framing": short description of the angle (e.g. "why did he leave — cause-hunting, past tense, their fault")
- "sameAsPrior": for KNOWN threads — is this week's telling essentially the SAME framing as the last recorded one (same angle, same question, same tense)? New wording alone does NOT make it different; a genuinely new angle, new question, or perspective shift does. For new threads: false.
- "confidence": 0..1 — your confidence in the sameAsPrior judgment. Be conservative: paraphrase noise should NOT produce high-confidence sameness.

Strict rules: max 3 updates. Nothing retold this week → {"updates":[]}. Only genuine retellings — a passing one-word mention is not a retelling.
Respond with ONLY valid JSON: {"updates":[{...}]}`;
}

export interface StoryThreadsUpdateResult {
  threads: StoryThread[]; // fresh post-update rows for this user
  updatedSlugs: string[];
}

/**
 * Runs the weekly indexing pass. `llm` is generate.ts's callClaude bound to a
 * call type — injected to keep model plumbing (and its usage logging) in one
 * place. Never throws: on any model/parse failure the week is simply skipped.
 */
export async function updateStoryThreads(opts: {
  userId: number;
  weekStart: string;
  weekMessages: QuoteSource[];
  llm: (prompt: string, maxTokens: number, temperature: number) => Promise<string>;
  parseJson: <T>(raw: string) => T | null;
}): Promise<StoryThreadsUpdateResult> {
  const { userId, weekStart, weekMessages } = opts;
  const existing = await db.select().from(storyThreadsTable).where(eq(storyThreadsTable.userId, userId));

  if (weekMessages.length === 0) return { threads: existing, updatedSlugs: [] };

  // validateExcerpt takes the same Map shape as the chapter quote pool.
  const messagePool = new Map(weekMessages.map((m) => [m.id, m]));

  let raw: string;
  try {
    raw = await opts.llm(threadUpdatePrompt(existing, weekMessages), 1200, 0.2);
  } catch (err) {
    logger.warn({ err, userId }, "story-threads: model call failed — skipping week");
    return { threads: existing, updatedSlugs: [] };
  }
  const parsed = opts.parseJson<{ updates?: RawThreadUpdate[] }>(raw);
  const updates = (parsed?.updates ?? []).slice(0, 3);
  const updatedSlugs: string[] = [];

  for (const u of updates) {
    const label = (u.label ?? "").trim().slice(0, 80);
    if (!label || !u.weekSummary || !u.framing) continue;
    const slug = u.slug?.trim() || slugify(label);
    if (!slug) continue;

    // Verbatim gate for the question excerpt — same rules as chapter quotes:
    // must be an exact substring of a non-crisis message from this user.
    let question: string | null = null;
    let questionMessageId: number | null = null;
    if (u.centralQuestion?.excerpt && typeof u.centralQuestion.messageId === "number") {
      const src = weekMessages.find((m) => m.id === u.centralQuestion!.messageId);
      if (src && !isCrisisText(src.content)) {
        const validated = validateExcerpt(u.centralQuestion.messageId, u.centralQuestion.excerpt, messagePool);
        if (validated) {
          question = validated.text;
          questionMessageId = validated.messageId;
        }
      }
      // Validation failed → keep the model's phrasing as a PARAPHRASE (no
      // message id), so the UI can render it without quote marks.
      if (!question && u.centralQuestion.excerpt.trim().length >= 8 && !isCrisisText(u.centralQuestion.excerpt)) {
        question = u.centralQuestion.excerpt.trim().slice(0, 160);
      }
    }

    const retelling: StoryRetelling = {
      weekStart,
      summary: u.weekSummary.trim().slice(0, 300),
      question,
      questionMessageId,
      framing: u.framing.trim().slice(0, 200),
      sameAsPrior: u.sameAsPrior === true,
      confidence: typeof u.confidence === "number" ? Math.max(0, Math.min(1, u.confidence)) : 0,
    };

    const prior = existing.find((t) => t.slug === slug);
    if (prior) {
      const priorRetellings = (prior.retellings as StoryRetelling[]) ?? [];
      if (priorRetellings.some((r) => r.weekStart === weekStart)) continue; // idempotent per week
      const retellings = [...priorRetellings, retelling].slice(-RETELLINGS_CAP);
      const next = advanceThreadState({ state: prior.state, frozenStreak: prior.frozenStreak, retellings });
      await db
        .update(storyThreadsTable)
        .set({ retellings, state: next.state, frozenStreak: next.frozenStreak, lastSeenWeek: weekStart, updatedAt: new Date() })
        .where(eq(storyThreadsTable.id, prior.id));
      updatedSlugs.push(slug);
    } else {
      await db
        .insert(storyThreadsTable)
        .values({
          userId,
          slug,
          label,
          state: "watch",
          frozenStreak: 0,
          retellings: [retelling],
          firstSeenWeek: weekStart,
          lastSeenWeek: weekStart,
        })
        .onConflictDoNothing();
      updatedSlugs.push(slug);
    }
  }

  const fresh = await db.select().from(storyThreadsTable).where(eq(storyThreadsTable.userId, userId));
  return { threads: fresh, updatedSlugs };
}
