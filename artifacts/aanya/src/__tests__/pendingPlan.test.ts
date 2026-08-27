/**
 * Pending-plan stash — the funnel that carries a pricing-tier choice from
 * the landing page (or signed-out /pricing) across signup into checkout.
 * A dropped or forged plan must never crash signup or auto-open checkout
 * for a tier that doesn't exist.
 */

import { describe, it, expect } from "vitest";
import {
  PENDING_PLAN_KEY,
  consumePendingPlan,
  isPendingPlan,
  stashPendingPlan,
  stashPendingPlanFromSearch,
} from "../lib/pendingPlan";

function fakeStore(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

describe("pendingPlan", () => {
  it("stashes a valid ?plan= from the arrival URL", () => {
    const store = fakeStore();
    stashPendingPlanFromSearch("?enter=1&plan=closer", store);
    expect(store.dump()).toEqual({ [PENDING_PLAN_KEY]: "closer" });
  });

  it("ignores unknown or missing plans in the URL", () => {
    const store = fakeStore();
    stashPendingPlanFromSearch("?enter=1&plan=platinum", store);
    stashPendingPlanFromSearch("?enter=1", store);
    expect(store.dump()).toEqual({});
  });

  it("consume returns the plan exactly once", () => {
    const store = fakeStore();
    stashPendingPlan("companion", store);
    expect(consumePendingPlan(store)).toBe("companion");
    expect(consumePendingPlan(store)).toBeNull(); // one shot
  });

  it("consume clears (and refuses) garbage someone wrote to the key", () => {
    const store = fakeStore({ [PENDING_PLAN_KEY]: "free-everything" });
    expect(consumePendingPlan(store)).toBeNull();
    expect(store.dump()).toEqual({}); // cleared, cannot linger
  });

  it("tolerates missing storage entirely", () => {
    expect(() => stashPendingPlanFromSearch("?plan=always", null)).not.toThrow();
    expect(consumePendingPlan(null)).toBeNull();
  });

  it("isPendingPlan accepts exactly the three tier ids", () => {
    expect(isPendingPlan("companion")).toBe(true);
    expect(isPendingPlan("closer")).toBe(true);
    expect(isPendingPlan("always")).toBe(true);
    expect(isPendingPlan("essential")).toBe(false); // display name, not id
    expect(isPendingPlan(null)).toBe(false);
  });
});
