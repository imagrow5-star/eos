/**
 * Privacy audit Tier 1 — crisis-context observability (services/crisis/events.ts).
 *
 * checkDismissalReviewFlag still returns the review flag (routes surface it),
 * but it must NEVER emit a per-user log line — the mere existence of such a line
 * reveals a user's crisis state. Deterministic: @workspace/db and drizzle-orm
 * are stubbed so the dismissal count comes back above threshold without a DB.
 */

import { describe, it, expect, vi } from "vitest";

// crisis/events.ts imports only { db, crisisEventsTable, messagesTable } from
// @workspace/db. Stub the select→from→where chain to resolve to a high count.
vi.mock("@workspace/db", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => Promise.resolve([{ count: "999" }]);
  return {
    db: chain,
    crisisEventsTable: { userId: {}, blockDismissed: {}, dismissedAt: {} },
    messagesTable: {},
  };
});

// The query builders are only fed into the stubbed chain (which ignores them),
// so trivial pass-throughs are enough and avoid needing real Column objects.
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  gte: (...a: unknown[]) => ({ gte: a }),
  desc: (...a: unknown[]) => ({ desc: a }),
  sql: (...a: unknown[]) => ({ sql: a }),
}));

import { logger } from "../lib/logger.js";
import { checkDismissalReviewFlag } from "../services/crisis/events.js";

describe("crisis dismissal review flag — no per-user log line (privacy Tier 1)", () => {
  it("returns the flag at/above threshold WITHOUT logging (no userId anywhere)", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const error = vi.spyOn(logger, "error");

    const flagged = await checkDismissalReviewFlag(4242);

    // Behavior preserved: the flag still surfaces for routes/tests.
    expect(flagged).toBe(true);

    // No log line is emitted on the crisis path at all...
    expect(warn).not.toHaveBeenCalled();
    // ...and the userId appears in NO log call, in any form.
    const everything = JSON.stringify([warn.mock.calls, info.mock.calls, error.mock.calls]);
    expect(everything).not.toContain("4242");

    warn.mockRestore();
    info.mockRestore();
    error.mockRestore();
  });
});
