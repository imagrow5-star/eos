/**
 * Per-call fire coalescing (voice only).
 *
 * Hume EVI fires our custom-LLM completion endpoint more than once for a single
 * spoken turn. Two shapes were confirmed from a real call's timing lines (both
 * present in one call, even at a 1400ms end-of-turn threshold):
 *   • TRUE DOUBLE-SEND — the same utterance POSTed twice, ~1.3s apart, both
 *     generating a full reply (userChars identical across the pair);
 *   • GROWING TRANSCRIPT — a fire on a fragment, the person continues, a second
 *     fire with the fuller turn (userChars grows across the pair).
 * Either way the person can hear two replies to one turn.
 *
 * This guard keeps at most one SPOKEN reply per turn, safely:
 *   • it NEVER suppresses a fire unless a PRIOR fire for the same call already
 *     replied (state "replied") within a tight window — so it can't turn a
 *     turn silent by suppressing the only reply;
 *   • when a duplicate/continuation arrives while the prior fire is still
 *     generating, it SUPERSEDES: aborts the in-flight prior and lets the new
 *     (identical, or fuller) fire generate — exactly one generation completes;
 *   • a continuation whose prior already finished can't be un-spoken, so it just
 *     generates (an honest limitation — the two replies are to DIFFERENT
 *     content and ~seconds apart, not the echo we're killing).
 *
 * The decision core (decideFire) is pure and exhaustively unit-tested; the
 * registry wrapper holds per-call state, an AbortController, and a per-FIRE
 * token so a superseded fire's late end-marker can't clobber the fire that
 * replaced it. Keyed on userId:issuedAt (the voice token's call identity),
 * swept by TTL. Never logs content — callers log a suppression with length +
 * gap only.
 */
import { isContinuationOf } from "./continuation.js";

/** How the last fire for a call ended (or that it is still running). */
export type FireState = "in_flight" | "replied" | "aborted";

export interface PriorFire {
  /** The last fire's spoken user content (freshUserContent), for matching. */
  content: string;
  /** ms epoch when that fire started. */
  at: number;
  state: FireState;
}

export type FireDecision =
  | { action: "generate" }
  | { action: "supersede"; kind: "duplicate" | "continuation"; matchedChars: number; gapMs: number }
  | { action: "suppress"; kind: "duplicate" | "prefix"; matchedChars: number; gapMs: number };

// A duplicate/continuation of a fire that started more than this ago is treated
// as a fresh turn — the real double-fires land ~1.3–2s apart; continuations can
// trail further (a paused-then-resumed turn), so the outer window is generous.
export const COALESCE_WINDOW_MS = 15_000;
// A "suppress" (return an empty completion because the prior already spoke) only
// fires inside this tight window. Double-sends are sub-2s apart; keeping it
// tight means a genuine repeated short utterance ("yes" … "yes") seconds later
// is NEVER swallowed — it falls through to generate.
export const SUPPRESS_WINDOW_MS = 4_000;

/**
 * Decide what to do with a new fire given the call's prior fire. Pure.
 *
 * The safety invariant: `suppress` is returned ONLY against a prior that
 * actually `replied` and only inside SUPPRESS_WINDOW_MS. An in-flight prior is
 * never suppressed-against (it might yet be aborted) — the new fire supersedes
 * it instead, so exactly one generation survives. A prior that was aborted or
 * whose window lapsed yields `generate`.
 */
export function decideFire(prior: PriorFire | null, content: string, now: number): FireDecision {
  if (!prior) return { action: "generate" };
  const gapMs = now - prior.at;
  if (gapMs < 0 || gapMs > COALESCE_WINDOW_MS) return { action: "generate" };
  const matchedChars = prior.content.length;

  const exact = prior.content === content;
  // content is a shorter prefix of prior (a late fragment of an answered turn).
  const prefixOfPrior = !exact && isContinuationOf(content, prior.content);
  // content is prior + more (the fuller turn after a fragment fire).
  const growsPrior = !exact && isContinuationOf(prior.content, content);

  if (exact || prefixOfPrior) {
    if (prior.state === "in_flight") {
      return { action: "supersede", kind: "duplicate", matchedChars, gapMs };
    }
    if (prior.state === "replied" && gapMs <= SUPPRESS_WINDOW_MS) {
      return { action: "suppress", kind: exact ? "duplicate" : "prefix", matchedChars, gapMs };
    }
    return { action: "generate" }; // prior aborted, or replied but outside the tight window
  }

  if (growsPrior) {
    if (prior.state === "in_flight") {
      return { action: "supersede", kind: "continuation", matchedChars, gapMs };
    }
    return { action: "generate" }; // prior already finished — can't un-speak it
  }

  return { action: "generate" };
}

// ─── Stateful registry (one entry per live call) ─────────────────────────────

interface Entry {
  content: string;
  at: number;
  state: FireState;
  abort: AbortController | null;
  /** Identifies the fire that owns this entry, so a superseded fire's late
   *  end-marker can't clobber the fire that replaced it. */
  fireId: number;
}

const registry = new Map<string, Entry>();
const ENTRY_TTL_MS = 60_000;
let fireSeq = 0;

function keyOf(userId: number, issuedAt: number): string {
  return `${userId}:${issuedAt}`;
}

function sweep(now: number): void {
  for (const [k, e] of registry) {
    if (now - e.at > ENTRY_TTL_MS) registry.delete(k);
  }
}

export interface BeginResult {
  decision: FireDecision;
  /** Pass to attachController / markReplied / markAborted for THIS fire.
   *  null when the fire was suppressed (it owns no slot). */
  fireId: number | null;
}

/**
 * Decide, and reserve this call's slot for a fire that will generate.
 *
 * - On `supersede`, the prior's in-flight generation is aborted here, and this
 *   fire takes the slot with a fresh fireId.
 * - On `suppress`, the slot is LEFT as the prior (which already replied); the
 *   caller must not generate — it returns an empty completion instead, and
 *   passes no fireId onward.
 * - On `generate`, this fire takes the slot.
 *
 * `abort` is this request's controller (may be null now and attached via
 * attachController later); it lets a LATER fire supersede this one.
 */
export function beginFire(
  userId: number,
  issuedAt: number,
  content: string,
  abort: AbortController | null,
  now: number = Date.now(),
): BeginResult {
  sweep(now);
  const key = keyOf(userId, issuedAt);
  const prior = registry.get(key);
  const decision = decideFire(prior ?? null, content, now);

  if (decision.action === "supersede") {
    // Abort the prior in-flight generation if we still hold a live controller
    // for it. If we don't (its controller wasn't attached yet), fall through to
    // a plain reservation — both fires generating is no worse than today.
    if (prior?.abort && !prior.abort.signal.aborted) prior.abort.abort();
  }

  if (decision.action === "suppress") {
    return { decision, fireId: null };
  }

  const fireId = ++fireSeq;
  registry.set(key, { content, at: now, state: "in_flight", abort, fireId });
  return { decision, fireId };
}

/** Attach this fire's AbortController once it exists (so a later fire can abort it). */
export function attachController(userId: number, issuedAt: number, fireId: number, abort: AbortController): void {
  const e = registry.get(keyOf(userId, issuedAt));
  if (e && e.fireId === fireId && e.state === "in_flight") e.abort = abort;
}

/** Mark this fire as having produced a spoken reply (no-op if already superseded). */
export function markReplied(userId: number, issuedAt: number, fireId: number): void {
  const e = registry.get(keyOf(userId, issuedAt));
  if (e && e.fireId === fireId) {
    e.state = "replied";
    e.abort = null;
  }
}

/** Mark this fire as aborted / no full reply (no-op if already superseded). */
export function markAborted(userId: number, issuedAt: number, fireId: number): void {
  const e = registry.get(keyOf(userId, issuedAt));
  if (e && e.fireId === fireId) {
    e.state = "aborted";
    e.abort = null;
  }
}

/** Test-only: clear all state. */
export function __resetFireCoalescing(): void {
  registry.clear();
  fireSeq = 0;
}
