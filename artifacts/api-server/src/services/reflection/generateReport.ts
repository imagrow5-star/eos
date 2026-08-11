import { db, reflectionReportsTable, type ReflectionReport } from "@workspace/db";
import { getAnthropic, logAiUsage } from "../ai.js";
import { logger } from "../../lib/logger.js";
// Type-only import — erased at build time, so this creates NO runtime dependency
// on the routes layer (and no import cycle). We reuse the EXISTING export loader
// (routes/account.ts fetchExportPayload) as the single data source; the report
// generator is just a new CONSUMER of that payload, never a parallel pipeline.
import type { fetchExportPayload } from "../../routes/account.js";
import { REPORT_SYSTEM_PROMPT, SELF_CHECK_SYSTEM_PROMPT } from "./prompts.js";

/** The exact shape returned by fetchExportPayload — we consume a subset of it. */
export type ReflectionSource = Awaited<ReturnType<typeof fetchExportPayload>>;

// Cheap model — summarising already-captured text does not need the premium
// conversation model (spec §4). Same Haiku the extraction path uses.
const REFLECTION_MODEL = "claude-haiku-4-5";

// Minimum-content gate (spec requirement): a sparse period isn't worth an
// auto-report that just says "not enough here to reflect on yet". The AUTO
// weekly run skips below this bar; the on-demand button always runs regardless.
export const MIN_USER_MESSAGES_FOR_AUTO = 5;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** User messages in the period with real content — the signal the gate counts. */
function userMessages(payload: ReflectionSource): string[] {
  return (payload.messages ?? [])
    .filter((m) => (m as { role?: unknown }).role === "user")
    .map((m) => str((m as { content?: unknown }).content).trim())
    .filter((c) => c.length > 0);
}

/**
 * Is there enough conversation in this period to be worth an AUTO report?
 * Deliberately simple and deterministic (unit-tested): count the user's own
 * messages. The on-demand path does not call this — it always generates.
 */
export function hasEnoughContent(payload: ReflectionSource): boolean {
  return userMessages(payload).length >= MIN_USER_MESSAGES_FOR_AUTO;
}

// Cap the transcript fed to the model so a chatty week can't blow up cost or
// context. Weekly windows keep this small in practice (spec §9); this is a
// backstop, keeping the most RECENT messages (the tail is what a reflection
// leads with).
const MAX_SOURCE_CHARS = 40_000;

/**
 * Assemble the LLM input from the period's already-decrypted export payload:
 * the transcript, saved memories (facts + feelings), and goals. Pure and
 * deterministic so it can be unit-tested without a model. This is the ONLY
 * place we turn the shared payload into report input — no second data path.
 */
export function buildReflectionSourceText(payload: ReflectionSource): string {
  const sections: string[] = [];

  const transcript = (payload.messages ?? [])
    .map((m) => {
      const role = (m as { role?: unknown }).role === "user" ? "User" : "Companion";
      const content = str((m as { content?: unknown }).content).trim();
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
  if (transcript) {
    // Keep the most recent messages if we're over the cap.
    const clipped =
      transcript.length > MAX_SOURCE_CHARS ? transcript.slice(-MAX_SOURCE_CHARS) : transcript;
    sections.push(`CONVERSATION TRANSCRIPT (this period):\n${clipped}`);
  }

  const facts = (payload.memoryFacts ?? [])
    .map((f) => str((f as { fact?: unknown }).fact).trim())
    .filter(Boolean);
  if (facts.length) {
    sections.push(`SAVED MEMORIES (facts the user shared):\n${facts.map((f) => `- ${f}`).join("\n")}`);
  }

  const feelings = (payload.memoryFeelings ?? [])
    .map((f) => str((f as { feeling?: unknown }).feeling).trim())
    .filter(Boolean);
  if (feelings.length) {
    sections.push(`SAVED FEELINGS (emotional moments):\n${feelings.map((f) => `- ${f}`).join("\n")}`);
  }

  const goals = (payload.goals ?? [])
    .map((g) => {
      const title = str((g as { title?: unknown }).title).trim();
      const desc = str((g as { description?: unknown }).description).trim();
      if (!title && !desc) return "";
      return desc && desc !== title ? `- ${title} — ${desc}` : `- ${title || desc}`;
    })
    .filter(Boolean);
  if (goals.length) {
    sections.push(`STATED GOALS:\n${goals.join("\n")}`);
  }

  return sections.join("\n\n");
}

export type GenerateOutcome =
  | { status: "generated"; report: ReflectionReport }
  | { status: "skipped_insufficient" }
  | { status: "unavailable" };

/** One cheap Haiku call: system + a single user message. Returns trimmed text. */
async function haikuCall(
  anthropic: NonNullable<ReturnType<typeof getAnthropic>>,
  callType: string,
  system: string,
  userContent: string,
): Promise<string> {
  const response = await anthropic.messages.create({
    model: REFLECTION_MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: userContent }],
  });
  logAiUsage(callType, REFLECTION_MODEL, response.usage);
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
}

/**
 * Generate a reflection report for one user over one period, store it encrypted,
 * and return the stored row.
 *
 * - `generatedBy: "auto"` respects the minimum-content gate (returns
 *   `skipped_insufficient` when the period is too thin to be worth it).
 * - `generatedBy: "on_demand"` always runs (the button never refuses).
 *
 * Runs the spec's two calls: the report generator, then a self-check pass that
 * strips anything unsupported / diagnostic. Falls back to the draft only if the
 * self-check returns empty (never lose a real report to a flaky second call).
 */
export async function generateReflectionReport(params: {
  userId: number;
  payload: ReflectionSource;
  periodStart: Date;
  periodEnd: Date;
  generatedBy: "on_demand" | "auto";
}): Promise<GenerateOutcome> {
  const { userId, payload, periodStart, periodEnd, generatedBy } = params;

  if (generatedBy === "auto" && !hasEnoughContent(payload)) {
    return { status: "skipped_insufficient" };
  }

  const anthropic = getAnthropic();
  if (!anthropic) return { status: "unavailable" };

  const source = buildReflectionSourceText(payload);

  try {
    const draft = await haikuCall(anthropic, "reflection_report", REPORT_SYSTEM_PROMPT, source);
    if (!draft) return { status: "unavailable" };

    const checked = await haikuCall(
      anthropic,
      "reflection_selfcheck",
      SELF_CHECK_SYSTEM_PROMPT,
      `DRAFT REPORT:\n${draft}\n\n---\nSOURCE TEXT:\n${source}`,
    );

    const content = checked || draft;

    const [report] = await db
      .insert(reflectionReportsTable)
      .values({ userId, content, periodStart, periodEnd, generatedBy })
      .returning();

    return { status: "generated", report: report as ReflectionReport };
  } catch (err) {
    // Privacy: never log the model output — it quotes the user's own words.
    logger.error({ err }, "reflection: report generation failed");
    return { status: "unavailable" };
  }
}
