/**
 * Prefetch for POST /api/voice-agent/session.
 *
 * The session bootstrap (voice token + ElevenLabs signed URL) is one network
 * round trip that used to sit on the call-connect critical path. This module
 * lets the UI fetch it QUIETLY on call intent (hovering/touching the Voice
 * button) and hand the result over instantly when the user actually presses.
 *
 * Freshness: signed URLs expire server-side, so a prefetched session is only
 * trusted for SESSION_FRESH_MS (60s — deliberately conservative) and is
 * consumed on use (a signed URL is treated as single-hand-out). Anything
 * stale, errored, or rate-limited is never cached — the press-time call
 * fetches fresh and surfaces the live error.
 *
 * Pure logic with injectable fetcher + clock so tests can pin every branch.
 */

import type { RealtimeSessionInfo } from "./realtimeVoice";

export const SESSION_FRESH_MS = 60_000;

export interface SessionFetchResult {
  /** HTTP status; 0 = network failure during a prefetch (never cached). */
  status: number;
  body: (RealtimeSessionInfo & { error?: string }) | null;
}

export interface TakenSession {
  result: SessionFetchResult;
  /** Where the result came from — reported in the connect-timing beacon. */
  source: "prefetched" | "fresh";
  /** How long the caller actually waited on this result, in ms. */
  waitMs: number;
}

interface CacheEntry {
  result: SessionFetchResult;
  fetchedAt: number;
}

export class VoiceSessionPrefetcher {
  private cache: CacheEntry | null = null;
  private inflight: Promise<SessionFetchResult> | null = null;

  constructor(
    private readonly doFetch: () => Promise<SessionFetchResult>,
    private readonly now: () => number = Date.now,
    private readonly freshMs: number = SESSION_FRESH_MS,
  ) {}

  /**
   * Fire-and-forget: start a background fetch unless a fresh result (or a
   * fetch already in flight) exists. Only a usable success (HTTP 200 with
   * available:true) is cached — errors and 429s must be re-fetched live at
   * press time so the user sees the CURRENT truth, not a stale failure.
   */
  prefetch(): void {
    if (this.inflight) return;
    if (this.cache && this.isFresh(this.cache)) return;
    // `inflight` must be cleared in the SAME microtask that settles the fetch
    // (two-arg then, not a trailing .finally) — otherwise a take() landing in
    // the window between "cache consumed" and "finally ran" would await the
    // already-settled promise and hand the same signed URL out twice.
    const job: Promise<SessionFetchResult> = this.doFetch().then(
      (result) => {
        if (this.inflight === job) this.inflight = null;
        if (result.status === 200 && result.body?.available === true) {
          this.cache = { result, fetchedAt: this.now() };
        }
        return result;
      },
      (): SessionFetchResult => {
        if (this.inflight === job) this.inflight = null;
        return { status: 0, body: null };
      },
    );
    this.inflight = job;
  }

  /**
   * The press-time path. Returns, in order of preference:
   *  1. a fresh cached prefetch (instant, consumed so a signed URL is never
   *     handed out twice);
   *  2. the in-flight prefetch (waits the remaining fraction);
   *  3. a brand-new fetch (may reject — callers already handle fetch errors).
   */
  async take(): Promise<TakenSession> {
    const t0 = this.now();
    if (this.cache && this.isFresh(this.cache)) {
      const { result } = this.cache;
      this.cache = null;
      return { result, source: "prefetched", waitMs: 0 };
    }
    this.cache = null; // stale — drop it
    if (this.inflight) {
      const result = await this.inflight;
      this.cache = null; // consume what the prefetch just cached
      return { result, source: "prefetched", waitMs: this.now() - t0 };
    }
    const result = await this.doFetch();
    return { result, source: "fresh", waitMs: this.now() - t0 };
  }

  private isFresh(entry: CacheEntry): boolean {
    return this.now() - entry.fetchedAt < this.freshMs;
  }
}
