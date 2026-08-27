/**
 * Pending-plan stash — carries a pricing-tier choice across the signup flow.
 *
 * A visitor who clicks a specific plan on the landing page (or the signed-out
 * /pricing cards) arrives at the auth screen with ?plan=<tier id>. The choice
 * is stashed in sessionStorage because the trip through signup loses the URL:
 * Google OAuth round-trips through accounts.google.com and redirects back to
 * "/", and email signup detours through the verification gate. sessionStorage
 * survives both (same tab), and dies with the tab — a stale plan never
 * ambushes a later visit.
 *
 * Consumption happens exactly once, after the user is fully in (verified +
 * consented): AppRouter routes them to /pricing?plan=<id>, where the page
 * auto-starts checkout for that tier. See App.tsx and Pricing.tsx.
 *
 * All functions take an injectable storage so the pure logic stays testable,
 * and every touch is try/caught — blocked storage must never break signup.
 */

export const PENDING_PLAN_KEY = "eos-pending-plan";

const VALID_PLANS = ["companion", "closer", "always"] as const;
export type PendingPlan = (typeof VALID_PLANS)[number];

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function isPendingPlan(v: unknown): v is PendingPlan {
  return (VALID_PLANS as readonly string[]).includes(v as string);
}

/** Stash a plan choice directly (signed-out /pricing card click). */
export function stashPendingPlan(plan: PendingPlan, store: StorageLike | null = defaultStore()): void {
  try {
    store?.setItem(PENDING_PLAN_KEY, plan);
  } catch {
    /* blocked storage must never break signup */
  }
}

/** Stash the ?plan= from an arrival URL, ignoring anything unrecognized. */
export function stashPendingPlanFromSearch(search: string, store: StorageLike | null = defaultStore()): void {
  try {
    const plan = new URLSearchParams(search).get("plan");
    if (isPendingPlan(plan)) store?.setItem(PENDING_PLAN_KEY, plan);
  } catch {
    /* blocked storage must never break signup */
  }
}

/**
 * Read AND clear the stashed plan — one shot, so a consumed (or garbage)
 * value can never re-trigger checkout on a later navigation.
 */
export function consumePendingPlan(store: StorageLike | null = defaultStore()): PendingPlan | null {
  try {
    const v = store?.getItem(PENDING_PLAN_KEY) ?? null;
    if (v !== null) store?.removeItem(PENDING_PLAN_KEY);
    return isPendingPlan(v) ? v : null;
  } catch {
    return null;
  }
}
