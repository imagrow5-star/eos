/**
 * Memory cut measurement (memory research, PR 8) — instrumentation only.
 *
 * The prompt ranks a person's facts by importance and keeps the top 40. The
 * question this answers, per turn, is whether the cut is losing anything: did
 * what the person just said, or what Eos replied, touch a fact BELOW the cut?
 * The same lexical check the importance scorer uses for references
 * (messageReferencesFact: a shared 4+ letter non-stopword) is applied above
 * and below the cut, so the two rates can be compared.
 *
 * One "memory cut" log line per turn, numbers and the hashed id only; never
 * a fact. Nothing about retrieval changes here. If the below-cut hit rate
 * stays near zero, the top-40 is not losing anything and this stays as it is.
 */

import { logger } from "../../lib/logger.js";
import { hashUserIdForLog } from "../../lib/logging/hashUserIdForLog.js";
import { messageReferencesFact } from "./importance.js";
import type { SystemPromptParts } from "../systemPrompt.js";

export interface MemoryCutReport {
  /** Active facts the person has. */
  eligible: number;
  /** Facts that made the prompt. */
  included: number;
  /** Facts that did not (eligible − included). */
  excluded: number;
  /** Included / excluded facts the person's message referenced. */
  userHitsAboveCut: number;
  userHitsBelowCut: number;
  /** Included / excluded facts the reply referenced. */
  replyHitsAboveCut: number;
  replyHitsBelowCut: number;
}

function hits(text: string, facts: readonly string[]): number {
  if (!text.trim()) return 0;
  let n = 0;
  for (const f of facts) if (messageReferencesFact(text, f)) n += 1;
  return n;
}

/** Null when the prompt carried no memory accounting (demo, greeting-only prompts). */
export function memoryCutReport(parts: SystemPromptParts, userMessage: string, reply: string): MemoryCutReport | null {
  const memory = parts.memory;
  if (!memory) return null;
  return {
    eligible: memory.eligible,
    included: memory.included.length,
    excluded: memory.excluded.length,
    userHitsAboveCut: hits(userMessage, memory.included),
    userHitsBelowCut: hits(userMessage, memory.excluded),
    replyHitsAboveCut: hits(reply, memory.included),
    replyHitsBelowCut: hits(reply, memory.excluded),
  };
}

/** grep: "memory cut". Skipped without LOG_HASH_SALT, like "memory ranking". */
export function logMemoryCut(userId: number, callType: string, report: MemoryCutReport | null): void {
  if (!report) return;
  try {
    const uh = hashUserIdForLog(userId);
    if (uh === undefined) return;
    logger.info({ uh, callType, ...report }, "memory cut");
  } catch {
    /* observability must never break a reply */
  }
}
