/**
 * The per-call frozen system prompt (voice), and the one way to drop it.
 *
 * A live call hits the voice brain every few seconds; rebuilding the system
 * prompt per turn would void Anthropic's prompt cache every turn, so the
 * prompt is built once per call — keyed by the person and the call's start
 * (the token's issuedAt) — and reused with a sliding TTL (routes/voice-llm.ts).
 *
 * That freeze was also why a forgotten memory outlived the tap during a
 * call (memory audit, item 3). Every memory write that changes what a
 * prompt should hold — forget, star, reset, an in-conversation update or
 * retire — now calls invalidateFrozenSystem for that person: the next
 * spoken turn rebuilds the prompt from the database, one uncached turn,
 * and the cached prefix resumes after it. Text chat needs nothing: it
 * builds the prompt fresh on every message.
 *
 * Lives in its own module because both the voice route and the memory
 * writers (routes/memory.ts, services/ai.ts) need it, and the voice route
 * already imports from ai.ts.
 */

import type { SystemPromptParts } from "./systemPrompt.js";

export interface FrozenSystemEntry {
  parts: SystemPromptParts;
  toneExtra: string;
  at: number;
}

export const FROZEN_SYSTEM_TTL_MS = 15 * 60 * 1000;

const frozenSystems = new Map<string, FrozenSystemEntry>();

function key(userId: number, issuedAt: number): string {
  return `${userId}:${issuedAt}`;
}

/** The live entry for this call, sliding its TTL; null when absent or expired. */
export function getFrozenSystem(userId: number, issuedAt: number, now = Date.now()): FrozenSystemEntry | null {
  for (const [k, v] of frozenSystems) {
    if (now - v.at > FROZEN_SYSTEM_TTL_MS) frozenSystems.delete(k);
  }
  const hit = frozenSystems.get(key(userId, issuedAt));
  if (!hit) return null;
  hit.at = now; // sliding TTL — keep the frozen prompt alive for the whole call
  return hit;
}

export function setFrozenSystem(userId: number, issuedAt: number, entry: Omit<FrozenSystemEntry, "at">, now = Date.now()): FrozenSystemEntry {
  const stored = { ...entry, at: now };
  frozenSystems.set(key(userId, issuedAt), stored);
  return stored;
}

/**
 * Drop every frozen prompt this person has — every live call rebuilds on
 * its next turn. Returns how many entries were dropped (tests).
 */
export function invalidateFrozenSystem(userId: number): number {
  const prefix = `${userId}:`;
  let dropped = 0;
  for (const k of frozenSystems.keys()) {
    if (k.startsWith(prefix)) {
      frozenSystems.delete(k);
      dropped++;
    }
  }
  return dropped;
}

/** Read without touching the TTL (tests). */
export function peekFrozenSystem(userId: number, issuedAt: number): FrozenSystemEntry | null {
  return frozenSystems.get(key(userId, issuedAt)) ?? null;
}
