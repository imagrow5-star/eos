/**
 * Unit tests: VoiceSessionPrefetcher (lib/voiceSessionPrefetch.ts).
 *
 * Fake fetcher + fake clock pin every rule:
 *  - a fresh prefetch is handed over instantly and consumed (signed URLs are
 *    never given out twice);
 *  - staleness (>60s) forces a fresh fetch — signed URLs expire;
 *  - errors / 429s / unavailable sessions are never cached;
 *  - hover + press don't double-fetch (in-flight dedup).
 */

import { describe, it, expect } from "vitest";
import {
  VoiceSessionPrefetcher,
  SESSION_FRESH_MS,
  type SessionFetchResult,
} from "../lib/voiceSessionPrefetch";

const OK: SessionFetchResult = {
  status: 200,
  body: { available: true, mode: "signed", signedUrl: "wss://x", userToken: "t" },
};

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function makeFetcher(results: Array<SessionFetchResult | Error>) {
  let calls = 0;
  const fn = async (): Promise<SessionFetchResult> => {
    const r = results[Math.min(calls, results.length - 1)]!;
    calls++;
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, callCount: () => calls };
}

describe("VoiceSessionPrefetcher", () => {
  it("hands a fresh prefetch over instantly, without a second fetch", async () => {
    const clock = makeClock();
    const fetcher = makeFetcher([OK]);
    const p = new VoiceSessionPrefetcher(fetcher.fn, clock.now);

    p.prefetch();
    await Promise.resolve(); // let the prefetch settle
    clock.advance(5_000);

    const taken = await p.take();
    expect(taken.source).toBe("prefetched");
    expect(taken.waitMs).toBe(0);
    expect(taken.result).toBe(OK);
    expect(fetcher.callCount()).toBe(1);
  });

  it("consumes the cache — a second take() fetches fresh", async () => {
    const clock = makeClock();
    const fetcher = makeFetcher([OK, OK]);
    const p = new VoiceSessionPrefetcher(fetcher.fn, clock.now);

    p.prefetch();
    await Promise.resolve();
    await p.take();
    const second = await p.take();
    expect(second.source).toBe("fresh");
    expect(fetcher.callCount()).toBe(2);
  });

  it("treats a prefetch older than the freshness window as stale", async () => {
    const clock = makeClock();
    const fetcher = makeFetcher([OK, OK]);
    const p = new VoiceSessionPrefetcher(fetcher.fn, clock.now);

    p.prefetch();
    await Promise.resolve();
    clock.advance(SESSION_FRESH_MS + 1);

    const taken = await p.take();
    expect(taken.source).toBe("fresh");
    expect(fetcher.callCount()).toBe(2);
  });

  it("never caches an error, a 429, or an unavailable session", async () => {
    const clock = makeClock();
    for (const bad of [
      { status: 429, body: { available: false, error: "limit" } } as SessionFetchResult,
      { status: 500, body: null } as SessionFetchResult,
      { status: 200, body: { available: false, reason: "disabled" } } as SessionFetchResult,
      new Error("network down"),
    ]) {
      const fetcher = makeFetcher([bad, OK]);
      const p = new VoiceSessionPrefetcher(fetcher.fn, clock.now);
      p.prefetch();
      await new Promise((r) => setTimeout(r, 0)); // settle incl. rejection path
      const taken = await p.take();
      // The press-time fetch happens live and returns the CURRENT truth.
      expect(taken.source).toBe("fresh");
      expect(taken.result).toBe(OK);
      expect(fetcher.callCount()).toBe(2);
    }
  });

  it("dedupes hover-spam: repeated prefetch() while one is in flight fetches once", async () => {
    const clock = makeClock();
    let resolveFetch!: (r: SessionFetchResult) => void;
    let calls = 0;
    const p = new VoiceSessionPrefetcher(
      () =>
        new Promise<SessionFetchResult>((resolve) => {
          calls++;
          resolveFetch = resolve;
        }),
      clock.now,
    );

    p.prefetch();
    p.prefetch();
    p.prefetch();
    expect(calls).toBe(1);

    resolveFetch(OK);
    await Promise.resolve();
    await Promise.resolve();

    p.prefetch(); // fresh cache exists — still no new fetch
    expect(calls).toBe(1);
  });

  it("take() during an in-flight prefetch waits for it instead of double-fetching", async () => {
    const clock = makeClock();
    let resolveFetch!: (r: SessionFetchResult) => void;
    let calls = 0;
    const p = new VoiceSessionPrefetcher(
      () =>
        new Promise<SessionFetchResult>((resolve) => {
          calls++;
          resolveFetch = resolve;
        }),
      clock.now,
    );

    p.prefetch();
    const taking = p.take();
    resolveFetch(OK);
    const taken = await taking;
    expect(taken.source).toBe("prefetched");
    expect(taken.result).toBe(OK);
    expect(calls).toBe(1);
  });
});
