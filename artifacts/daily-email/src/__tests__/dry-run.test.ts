/**
 * Run-level dry-run guarantee test.
 *
 * Executes the job's real main loop (run()) with DAILY_EMAIL_DRY_RUN set and
 * proves the dry-run contract holds end to end:
 *   • zero calls to api.resend.com (no email can go out)
 *   • zero UPDATE/INSERT statements (no state writes)
 *   • zero calls to the api-server's internal chapters/push trigger endpoints
 *   • zero Anthropic generations
 *   • exactly one "dry-run decision" log per eligible user
 *
 * The DB layer is replaced by a chainable recorder (mirrors the api-server's
 * suppress-resend philosophy: side effects are intercepted, never real), and
 * global fetch records every outbound call. If a future edit adds any side
 * effect outside the DRY_RUN gates, this test fails.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { hashUserIdForLog } from "../logHash";

// ─── Shared recorder state (hoisted so the vi.mock factory can see it) ───────

const h = vi.hoisted(() => {
  /** Every non-select statement the job attempts: { kind, table } */
  const writes: Array<{ kind: string; table: string }> = [];
  /** Rows returned per table name for select queries. */
  const rowsByTable: Record<string, unknown[]> = {};

  // A column stub that satisfies drizzle-orm's eq/gte/sql builders at
  // construction time (they only need mapToDriverValue on the column).
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

  // Chainable, thenable query builder. Selects resolve to fixture rows;
  // inserts/updates are recorded and resolve to [].
  function builder(kind: "select" | "insert" | "update", table?: any) {
    const state = { kind, table };
    const resolveRows = () =>
      kind === "select" ? (rowsByTable[tableName(state.table)] ?? []) : [];
    const b: any = {};
    for (const m of [
      "from", "innerJoin", "leftJoin", "where", "orderBy", "limit",
      "set", "values", "returning", "onConflictDoUpdate", "onConflictDoNothing",
    ]) {
      b[m] = (...args: unknown[]) => {
        if (m === "from" && args[0]) state.table = args[0];
        return b;
      };
    }
    b.then = (onOk: any, onErr: any) => Promise.resolve(resolveRows()).then(onOk, onErr);
    b.catch = (onErr: any) => Promise.resolve(resolveRows()).catch(onErr);
    b.finally = (fn: any) => Promise.resolve(resolveRows()).finally(fn);
    if (kind !== "select") writes.push({ kind, table: tableName(state.table) });
    return b;
  }

  const db = {
    select: (..._args: unknown[]) => builder("select"),
    insert: (table: any) => builder("insert", table),
    update: (table: any) => builder("update", table),
  };

  const anthropicCreate = vi.fn(async () => {
    throw new Error("Anthropic must never be called in dry run");
  });

  return { writes, rowsByTable, makeTable, db, anthropicCreate };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

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

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: h.anthropicCreate };
  },
}));

// ─── Fetch recorder — no network call may escape this test ──────────────────

const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

// ─── Timezone fixtures — pick zones relative to the CURRENT wall clock so the
// "inside 6–9 AM" and "outside window" branches are both exercised whenever
// the test runs. Uses the same Intl mechanism as the job's localHour().
function hourIn(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
      .format(new Date()),
    10,
  ) % 24;
}
function findZone(predicate: (hour: number) => boolean): string {
  for (let off = -12; off <= 14; off++) {
    // Etc/GMT sign convention is inverted: Etc/GMT+3 means UTC-3.
    const tz = off === 0 ? "Etc/GMT" : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
    try {
      if (predicate(hourIn(tz))) return tz;
    } catch {
      /* unsupported zone — keep scanning */
    }
  }
  throw new Error("no matching Etc/GMT zone found");
}

const inWindowZone = findZone((hh) => hh >= 6 && hh <= 9);
const outsideWindowZone = findZone((hh) => hh >= 12 && hh <= 23);

// ─── Fixture users ────────────────────────────────────────────────────────────

const baseUser = {
  userName: "Maya",
  companionName: "Eos",
  userPath: "breakup",
  userGender: null as string | null,
  userGenderCustom: null as string | null,
  birthYear: 1994,
  country: "IN",
  ageBand: "",
  createdAt: new Date("2026-06-01T00:00:00Z"),
  lastEmailDate: null as string | null,
  dailyEmailOptOut: false,
};

beforeAll(() => {
  process.env.DAILY_EMAIL_DRY_RUN = "1";
  process.env.RESEND_API_KEY = "test-key-never-used";
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
  process.env.SESSION_SECRET = "test-secret";
  // Tier 3: per-user decision logs now emit a salted `uh` and are dropped
  // without a salt — set one so the decisions are observable to this test.
  process.env.LOG_HASH_SALT = "dry-run-test-salt-0123456789abcd";
  delete process.env.DAILY_EMAIL_ONLY_USER;

  globalThis.fetch = ((input: any, ..._rest: any[]) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ id: "intercepted-in-dry-run-test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  // Eligible users returned by the main query (from profileTable):
  h.rowsByTable["profile"] = [
    // 1 — in 6–9 AM window, has data → "would-send-daily-note"
    { ...baseUser, userId: 1, email: "one@example.invalid", timezone: inWindowZone },
    // 2 — opted out → "opted-out"
    { ...baseUser, userId: 2, email: "two@example.invalid", timezone: inWindowZone, dailyEmailOptOut: true },
    // 3 — placeholder tz + no country → "held"
    { ...baseUser, userId: 3, email: "three@example.invalid", timezone: "UTC", country: "" },
    // 4 — valid zone but outside the morning window → "outside-window"
    { ...baseUser, userId: 4, email: "four@example.invalid", timezone: outsideWindowZone },
  ];
  // Context data so user 1 clears the "not enough data" bar.
  h.rowsByTable["memory_facts"] = [{ fact: "started a pottery class" }];
  h.rowsByTable["wins"] = [{ content: "went a full day without checking his profile" }];
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.DAILY_EMAIL_DRY_RUN;
  delete process.env.LOG_HASH_SALT;
});

// ─── The test ────────────────────────────────────────────────────────────────

describe("DAILY_EMAIL_DRY_RUN run-level guarantee", () => {
  it("never sends, never writes, never triggers — and logs one decision per eligible user", async () => {
    const logSpy = vi.spyOn(console, "log");

    const { run } = await import("../run");
    await run();

    // Zero outbound email — no call to api.resend.com at all.
    expect(fetchCalls.filter((u) => u.includes("api.resend.com"))).toEqual([]);

    // Zero calls to the api-server's internal trigger endpoints.
    expect(fetchCalls.filter((u) => u.includes("/api/internal/"))).toEqual([]);

    // In fact: zero outbound HTTP of any kind.
    expect(fetchCalls).toEqual([]);

    // Zero UPDATE / INSERT statements against any table.
    expect(h.writes).toEqual([]);

    // Zero Anthropic generations.
    expect(h.anthropicCreate).not.toHaveBeenCalled();

    // Parse the structured log lines.
    const logs = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0]));
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);

    // The run announced dry-run mode and completed with dryRun flagged.
    expect(logs.some((l) => String(l.msg).startsWith("DRY RUN"))).toBe(true);
    const complete = logs.find((l) => l.msg === "Daily email job complete");
    expect(complete).toBeDefined();
    expect(complete!.dryRun).toBe(true);
    expect(complete!.sent).toBe(0);
    expect(complete!.nudged).toBe(0);
    expect(complete!.failed).toBe(0);

    // Exactly one dry-run decision per eligible user, with the right verdicts.
    const decisions = logs.filter((l) => l.msg === "dry-run decision");
    expect(decisions).toHaveLength(4);
    // Tier 3: decisions are keyed by the salted `uh`, not a raw userId.
    const byUh = Object.fromEntries(decisions.map((d) => [d.uh, d.decision]));
    expect(byUh).toEqual({
      [hashUserIdForLog(1)!]: "would-send-daily-note",
      [hashUserIdForLog(2)!]: "opted-out",
      [hashUserIdForLog(3)!]: "held",
      [hashUserIdForLog(4)!]: "outside-window",
    });

    logSpy.mockRestore();
  });
});
