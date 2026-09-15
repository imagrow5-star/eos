/**
 * Per-call crisis reinforcement flag (voice audit, PR 4).
 *
 * On voice calls the semantic crisis classifier no longer sits on the
 * critical path: the reply starts generating while the classifier is still
 * running. A late "yes" records the crisis event (the helpline card reaches
 * the screen through the status poll) and ARMS this flag, so the NEXT turn of
 * the same call carries the reinforcement block the current one couldn't.
 * The flag is consumed by that turn; a further detection re-arms it.
 *
 * Keyed like the frozen prompt (`userId:issuedAt` = one call), in process,
 * swept on a TTL. Losing it (restart) costs one reinforcement block, never a
 * card: the event row is the durable record.
 */

const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map<string, { pattern: string; at: number }>();

function key(userId: number, issuedAt: number): string {
  return `${userId}:${issuedAt}`;
}

function sweep(now: number): void {
  for (const [k, v] of pending) {
    if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  }
}

/** A late detection on this call: the next turn gets the reinforcement block. */
export function armCallCrisis(userId: number, issuedAt: number, pattern: string, now = Date.now()): void {
  sweep(now);
  pending.set(key(userId, issuedAt), { pattern, at: now });
}

/** Take (and clear) the pending pattern for this call, if any. */
export function takeCallCrisis(userId: number, issuedAt: number, now = Date.now()): string | null {
  sweep(now);
  const k = key(userId, issuedAt);
  const hit = pending.get(k);
  if (!hit) return null;
  pending.delete(k);
  return hit.pattern;
}

/** Tests only. */
export function clearCallCrisisFlags(): void {
  pending.clear();
}
