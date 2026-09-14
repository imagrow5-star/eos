/**
 * The scheduler's contract, end to end through the real run():
 *   • dry run calls nothing;
 *   • a live run calls exactly the three sweeps, in order (chapters before
 *     stories), each with a valid hour-stamped HMAC for its own prefix, signed
 *     over the exact body sent;
 *   • INTERNAL_SWEEP_SECRET is used when set; otherwise the key is derived
 *     from SESSION_SECRET exactly as the api-server derives it;
 *   • the single-user hook scopes every call, and a malformed one refuses to
 *     run rather than silently fanning out to everyone;
 *   • no secret at all → nothing is called;
 *   • one failing endpoint never stops the next sweep.
 */

import { describe, it, expect } from "vitest";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { run, sweepToken, resolveSweepSecret, SWEEPS } from "../run";

interface Call {
  url: string;
  token: string;
  body: unknown;
}

function fakeFetch(handler?: (url: string) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, token: headers["x-internal-token"], body: JSON.parse(String(init?.body ?? "{}")) });
    const r = handler?.(url) ?? { status: 200, body: { ok: true } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const BASE = { APP_URL: "https://app.example.invalid/", INTERNAL_SWEEP_SECRET: "test-sweep-secret" };

describe("scheduler", () => {
  it("dry run calls nothing", async () => {
    const f = fakeFetch();
    const out = await run({ fetchImpl: f.impl, env: { ...BASE, SCHEDULER_DRY_RUN: "1" } });
    expect(out).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("the old DAILY_EMAIL_DRY_RUN name still means dry run", async () => {
    const f = fakeFetch();
    await run({ fetchImpl: f.impl, env: { ...BASE, DAILY_EMAIL_DRY_RUN: "true" } });
    expect(f.calls).toHaveLength(0);
  });

  it("a live run calls the three sweeps in order with a valid HMAC each", async () => {
    const f = fakeFetch();
    const out = await run({ fetchImpl: f.impl, env: BASE });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://app.example.invalid/api/internal/chapters/run",
      "https://app.example.invalid/api/internal/reflection/weekly-run",
      "https://app.example.invalid/api/internal/stories/run",
    ]);
    const stamp = new Date().toISOString().slice(0, 13);
    const digest = createHash("sha256").update("{}").digest("hex");
    for (const [i, s] of SWEEPS.entries()) {
      const expected = createHmac("sha256", "test-sweep-secret").update(`${s.tokenPrefix}:${stamp}:${digest}`).digest("hex");
      expect(f.calls[i]!.token).toBe(expected);
      expect(f.calls[i]!.token).toBe(sweepToken("test-sweep-secret", s.tokenPrefix, "{}"));
      expect(f.calls[i]!.body).toEqual({});
    }
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it("the single-user hook scopes every call, and the token signs that body", async () => {
    const f = fakeFetch();
    await run({ fetchImpl: f.impl, env: { ...BASE, SCHEDULER_ONLY_USER: "42" } });
    expect(f.calls.map((c) => c.body)).toEqual([{ userId: 42 }, { userId: 42 }, { userId: 42 }]);
    expect(f.calls[0]!.token).toBe(sweepToken("test-sweep-secret", "chapters-run", '{"userId":42}'));
    expect(f.calls[0]!.token).not.toBe(sweepToken("test-sweep-secret", "chapters-run", "{}"));
  });

  it("without INTERNAL_SWEEP_SECRET the key is derived from SESSION_SECRET (HKDF, api-server's label)", async () => {
    const derived = Buffer.from(hkdfSync("sha256", "session-only", "", "eos-internal-sweep-v1", 32)).toString("hex");
    expect(resolveSweepSecret({ SESSION_SECRET: "session-only" })).toBe(derived);
    expect(resolveSweepSecret({ SESSION_SECRET: "session-only", INTERNAL_SWEEP_SECRET: "dedicated" })).toBe("dedicated");
    expect(resolveSweepSecret({})).toBe("");

    const f = fakeFetch();
    await run({ fetchImpl: f.impl, env: { APP_URL: BASE.APP_URL, SESSION_SECRET: "session-only" } });
    expect(f.calls[0]!.token).toBe(sweepToken(derived, "chapters-run", "{}"));
  });

  it("a malformed single-user hook refuses to run instead of fanning out", async () => {
    const f = fakeFetch();
    const out = await run({ fetchImpl: f.impl, env: { ...BASE, SCHEDULER_ONLY_USER: "4x2" } });
    expect(out).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("no SESSION_SECRET → nothing is called", async () => {
    const f = fakeFetch();
    const out = await run({ fetchImpl: f.impl, env: { APP_URL: BASE.APP_URL } });
    expect(out).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("one failing endpoint does not stop the next sweep, and the run reports it", async () => {
    const f = fakeFetch((url) => (url.includes("/reflection/") ? new Error("connection reset") : { status: 200 }));
    const out = await run({ fetchImpl: f.impl, env: BASE });
    expect(f.calls).toHaveLength(3);
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
  });

  it("production without APP_URL refuses to start", async () => {
    const f = fakeFetch();
    await expect(run({ fetchImpl: f.impl, env: { SESSION_SECRET: "x", NODE_ENV: "production" } })).rejects.toThrow(/APP_URL/);
    expect(f.calls).toHaveLength(0);
  });
});
