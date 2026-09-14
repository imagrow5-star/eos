/**
 * The voice demo's minute, as a pure rule.
 *
 * The page draws a thin line that fills over the minute. When it fills, the
 * microphone goes quiet — but Eos is not cut off mid-word: if she is
 * speaking, the call waits for the end of that reply (with a ceiling, so a
 * dropped assistant_end can't hold the call open), then ends. If she is
 * listening when the minute is up, the call ends at once.
 *
 * No DOM, no timers — the caller feeds it the clock and Eos's mode and
 * acts on what comes back. Tested in demoVoiceCutoff.test.ts.
 */

export type CallMode = "speaking" | "listening";
export type CutoffPhase = "live" | "finishing" | "done";
/** What the caller must do now. */
export type CutoffAction = "none" | "stop-input" | "end";

export const DEMO_VOICE_LIMIT_MS = 60_000;
/** The most a reply may run past the minute before the call ends anyway. */
export const FINISH_CEILING_MS = 15_000;

export class CallCutoff {
  phase: CutoffPhase = "live";
  mode: CallMode = "listening";
  private readonly startedAt: number;
  private stoppedAt: number | null = null;

  constructor(startedAt: number, private readonly limitMs = DEMO_VOICE_LIMIT_MS, private readonly ceilingMs = FINISH_CEILING_MS) {
    this.startedAt = startedAt;
  }

  /** 0 → 1 over the minute; the line's fill. */
  progress(now: number): number {
    return Math.min(1, Math.max(0, (now - this.startedAt) / this.limitMs));
  }

  /** Whole seconds left before the microphone stops (never below 0). */
  secondsLeft(now: number): number {
    return Math.max(0, Math.ceil((this.startedAt + this.limitMs - now) / 1000));
  }

  /** Eos's turn state, from the call events. May end the call: after the
   *  minute, the reply finishing is what we were waiting for. */
  noteMode(mode: CallMode): CutoffAction {
    this.mode = mode;
    if (this.phase === "finishing" && mode === "listening") {
      this.phase = "done";
      return "end";
    }
    return "none";
  }

  /** Called on every animation frame / timer tick. */
  tick(now: number): CutoffAction {
    if (this.phase === "done") return "none";
    if (this.phase === "live") {
      if (now - this.startedAt < this.limitMs) return "none";
      this.stoppedAt = now;
      if (this.mode === "speaking") {
        this.phase = "finishing";
        return "stop-input";
      }
      this.phase = "done";
      return "end";
    }
    // finishing: waiting for the sentence — but not forever.
    if (now - (this.stoppedAt ?? now) >= this.ceilingMs) {
      this.phase = "done";
      return "end";
    }
    return "none";
  }

  /** The person hung up, or the socket closed. */
  finish(): void {
    this.phase = "done";
  }

  /** How the call ended, for the end report: the minute ran out, or not. */
  hitLimit(): boolean {
    return this.stoppedAt !== null;
  }
}
