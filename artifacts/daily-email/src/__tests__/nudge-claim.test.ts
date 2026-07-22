/**
 * Timed-nudge double-send guarantee test.
 *
 * The daily-email job claims a nudge atomically (conditional UPDATE of
 * nudgeSentAt WHERE nudgeSentAt IS NULL) before sending, and releases the
 * claim if the send fails so the catch-up hour can retry. This test proves
 * both halves of that contract at the run() level:
 *
 *   1. Two overlapping runs both see the same unclaimed nudge (a barrier in
 *      the DB stub holds each run's due-nudge SELECT until both have read),
 *      both race to claim it — exactly ONE email goes out.
 *   2. A failed send releases the claim, a later run retries successfully,
 *      and a further run sends nothing more — exactly one delivered email,
 *      never two.
 *
 * The DB stub is stateful: the conditional claim really flips row state, so
 * the "loser" of the race genuinely gets zero rows back — the same semantics
 * Postgres gives the real conditional UPDATE.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Shared stateful stub (hoisted so vi.mock factories can see it) ──────────

const h = vi.hoisted(() => {
  interface CommitmentRow {
    id: number;
    content: string;
    scheduledTime: string;
    nudgeSentAt: Date | null;
  }

  const state = {
    profiles: [] as unknown[],
    commitments: [] as CommitmentRow[],
    /** claim / release attempts, in order: "claim-won" | "claim-lost" | "release" */
    claimEvents: [] as string[],
    /** when set, the due-nudge SELECT blocks until `target` selects arrived */
    barrier: null as null | { target: number; count: number; waiters: Array<() => void> },
  };

  const waitBarrier = (): Promise<void> =>
    new Promise((resolve) => {
      const b = state.barrier;
      if (!b) return resolve();
      b.count++;
      b.waiters.push(resolve);
      if (b.count >= b.target) {
        const ws = b.waiters;
        state.barrier = null;
        ws.forEach((w) => w());
      }
    });

  // Column stub that satisfies drizzle's eq/gte/sql builders at construction.
  const makeTable = (name: string) =>
    new Proxy(
      { __table: name },
      {
        get(target, prop) {
          if (prop === "__table") return name;
          if (typeof prop === "symbol") return undefined;
          return { mapToDriverValue: (v: unknown) => v, name: prop, table: target };
        },
      },
    ) as any;

  const tableName = (t: any): string => t?.__table ?? "unknown";

  async function exec(q: { kind: string; table: any; setArg: any }): Promise<unknown[]> {
    const t = tableName(q.table);
    if (q.kind === "select") {
      if (t === "profile") return state.profiles as unknown[];
      if (t === "commitments") {
        // Both overlapping runs must read BEFORE either claims — worst case.
        await waitBarrier();
        return state.commitments
          .filter((c) => c.nudgeSentAt === null)
          .map((c) => ({ id: c.id, content: c.content, scheduledTime: c.scheduledTime }));
      }
      return [];
    }
    if (q.kind === "update" && t === "commitments") {
      const set = (q.setArg ?? {}) as { nudgeSentAt?: Date | null };
      if ("nudgeSentAt" in set && set.nudgeSentAt === null) {
        // Release path (unconditional by id — single fixture row per test)
        for (const c of state.commitments) c.nudgeSentAt = null;
        state.claimEvents.push("release");
        return [];
      }
      // Atomic claim: UPDATE ... WHERE nudgeSentAt IS NULL RETURNING id.
      // This callback runs synchronously once scheduled — exactly the
      // one-winner semantics of the real conditional UPDATE.
      const claimed: Array<{ id: number }> = [];
      for (const c of state.commitments) {
        if (c.nudgeSentAt === null) {
          c.nudgeSentAt = set.nudgeSentAt ?? new Date();
          claimed.push({ id: c.id });
        }
      }
      state.claimEvents.push(claimed.length > 0 ? "claim-won" : "claim-lost");
      return claimed;
    }
    return [];
  }

  // Chainable, thenable query builder over the stateful exec().
  function builder(kind: "select" | "insert" | "update", table?: any) {
    const q = { kind, table, setArg: undefined as unknown };
    const b: any = {};
    for (const m of [
      "from", "innerJoin", "leftJoin", "where", "orderBy", "limit",
      "set", "values", "returning", "onConflictDoUpdate", "onConflictDoNothing",
    ]) {
      b[m] = (...args: unknown[]) => {
        if (m === "from" && args[0]) q.table = args[0];
        if (m === "set") q.setArg = args[0];
        return b;
      };
    }
    b.then = (ok: any, err: any) => exec(q).then(ok, err);
    b.catch = (err: any) => exec(q).catch(err);
    b.finally = (fn: any) => exec(q).finally(fn);
    return b;
  }

  const db = {
    select: (..._a: unknown[]) => builder("select"),
    insert: (table: any) => builder("insert", table),
    update: (table: any) => builder("update", table),
  };

  return { state, makeTable, db };
});

vi.mock("@workspace/db", () => ({
  db: h.db,
  pool: { end: vi.fn(), query: vi.fn() },
  usersTable: h.makeTable("users"),
  profileTable: h.makeTable("profile"),
  memoryFactsTable: h.makeTable("memory_facts"),
  winsTable: h.makeTable("wins"),
  moodScoresTable: h.makeTable("mood_scores"),
  habitsTable: h.makeTable("habits"),
  habitCompletionsTable: h.makeTable("habit_completions"),
  commitmentsTable: h.makeTable("commitments"),
  personalizationStateTable: h.makeTable("personalization_state"),
  goalsTable: h.makeTable("goals"),
  goalTasksTable: h.makeTable("goal_tasks"),
  weeklyChaptersTable: h.makeTable("weekly_chapters"),
}));

// No ANTHROPIC_API_KEY in this test → nudge text uses the local fallback;
// the SDK must never be constructed into a live call anyway.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = {
      create: async () => {
        throw new Error("Anthropic must not be called (no API key set)");
      },
    };
  },
}));

// ─── Fetch recorder — Resend calls are intercepted, failures injectable ─────

const realFetch = globalThis.fetch;
const resendCalls: string[] = [];
let resendFailNext = 0;

// ─── Timezone fixture — a zone whose CURRENT local hour is a valid nudge hour
// (0–11), so a commitment scheduled at that exact hour is due right now.
function hourIn(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
      .format(new Date()),
    10,
  ) % 24;
}
function findMorningZone(): string {
  for (let off = -12; off <= 14; off++) {
    const tz = off === 0 ? "Etc/GMT" : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
    try {
      const hh = hourIn(tz);
      if (hh >= 0 && hh <= 11) return tz;
    } catch {
      /* unsupported zone — keep scanning */
    }
  }
  throw new Error("no Etc/GMT zone currently in hours 0–11");
}

const zone = findMorningZone();
const nudgeHour = hourIn(zone);
const scheduledTime = `${String(nudgeHour).padStart(2, "0")}:00`;
const todayInZone = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());

// ─── Fixtures ────────────────────────────────────────────────────────────────

function seedUser() {
  h.state.profiles = [{
    userId: 1,
    email: "maya@example.invalid",
    userName: "Maya",
    companionName: "Eos",
    timezone: zone,
    userPath: "breakup",
    userGender: null,
    userGenderCustom: null,
    birthYear: 1994,
    country: "IN",
    ageBand: "",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    // Daily note already sent today → run() goes straight to the nudge pass.
    lastEmailDate: todayInZone,
    dailyEmailOptOut: false,
  }];
}

function seedNudge(id: number) {
  h.state.commitments = [{
    id,
    content: "call the physio about my shoulder",
    scheduledTime,
    nudgeSentAt: null,
  }];
}

let run: () => Promise<void>;

beforeAll(async () => {
  delete process.env.DAILY_EMAIL_DRY_RUN;
  delete process.env.DAILY_EMAIL_ONLY_USER;
  delete process.env.ANTHROPIC_API_KEY; // fallback nudge text, zero AI calls
  process.env.RESEND_API_KEY = "test-key-intercepted";
  process.env.SESSION_SECRET = "test-secret";

  globalThis.fetch = (async (input: any, init?: any) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.resend.com")) {
      resendCalls.push(String(init?.body ?? ""));
      if (resendFailNext > 0) {
        resendFailNext--;
        return new Response("injected resend outage", { status: 500 });
      }
      return new Response(JSON.stringify({ id: "intercepted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // internal chapter/push triggers — swallow
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  ({ run } = await import("../run"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  seedUser();
  resendCalls.length = 0;
  resendFailNext = 0;
  h.state.claimEvents.length = 0;
  h.state.barrier = null;
});

// ─── The tests ───────────────────────────────────────────────────────────────

describe("timed nudge atomic claim", () => {
  it("two overlapping runs racing for the same nudge send exactly one email", async () => {
    seedNudge(101);
    // Hold each run's due-nudge SELECT until BOTH have read the unclaimed row —
    // the worst-case interleaving where the conditional claim is the only guard.
    h.state.barrier = { target: 2, count: 0, waiters: [] };

    const logSpy = vi.spyOn(console, "log");
    await Promise.all([run(), run()]);

    // Both runs saw the row and raced: one claim won, one lost, no release.
    expect(h.state.claimEvents.filter((e) => e === "claim-won")).toHaveLength(1);
    expect(h.state.claimEvents.filter((e) => e === "claim-lost")).toHaveLength(1);
    expect(h.state.claimEvents).not.toContain("release");

    // Exactly ONE email left the building.
    expect(resendCalls).toHaveLength(1);

    // The claim stayed consumed, so any later run sends nothing either.
    expect(h.state.commitments[0]!.nudgeSentAt).not.toBeNull();
    await run();
    expect(resendCalls).toHaveLength(1);

    // Across both runs: exactly one "Nudge sent", total nudged === 1.
    const logs = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((l): l is Record<string, unknown> => l !== null);
    expect(logs.filter((l) => l.msg === "Nudge sent")).toHaveLength(1);
    const totalNudged = logs
      .filter((l) => l.msg === "Daily email job complete")
      .reduce((s, l) => s + Number(l.nudged ?? 0), 0);
    expect(totalNudged).toBe(1);
    logSpy.mockRestore();
  });

  it("a failed send releases the claim, the catch-up run retries once — never twice", async () => {
    seedNudge(202);
    resendFailNext = 1; // first Resend call blows up mid-send, after the claim

    // Run 1: claims, send fails, claim released for the catch-up hour.
    await run();
    expect(resendCalls).toHaveLength(1); // the failed attempt
    expect(h.state.claimEvents).toEqual(["claim-won", "release"]);
    expect(h.state.commitments[0]!.nudgeSentAt).toBeNull(); // retryable again

    // Run 2 (catch-up): re-claims and delivers.
    const logSpy = vi.spyOn(console, "log");
    await run();
    expect(resendCalls).toHaveLength(2); // exactly one successful delivery
    expect(h.state.commitments[0]!.nudgeSentAt).not.toBeNull();
    const logs = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((l): l is Record<string, unknown> => l !== null);
    expect(logs.filter((l) => l.msg === "Nudge sent")).toHaveLength(1);
    logSpy.mockRestore();

    // Run 3: claim consumed — nothing more goes out. No double-send, ever.
    await run();
    expect(resendCalls).toHaveLength(2);
    expect(h.state.claimEvents.filter((e) => e === "claim-won")).toHaveLength(2);
    expect(h.state.claimEvents.filter((e) => e === "release")).toHaveLength(1);
  });
});
