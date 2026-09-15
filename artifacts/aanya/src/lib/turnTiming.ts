/**
 * Per-turn timing on a Hume call, as a pure rule (voice audit, PR 1).
 *
 * The call screen feeds it the socket events with a wall clock; it hands back
 * one timing per assistant turn, at the moment the first audio of the reply
 * is accepted for playback:
 *   • finalToFirstAudioMs — from Hume's FINAL transcript of what the person
 *     said to the reply's first audio: the wait the person actually feels;
 *   • textToFirstAudioMs — from the reply's text (assistant_message) to its
 *     first audio: Hume's TTS on its own;
 *   • userEndToFinalMs — from the end of the person's speech (Hume's own
 *     utterance timestamp) to the final transcript: the end-of-turn silence
 *     as Hume applied it. Only when the timestamp is wall-clock (epoch ms);
 *     null otherwise.
 * The greeting turn has no user speech, so its first two fields are null and
 * `greeting` is true. Barge-in or the end of a reply closes the turn so a late
 * audio chunk can't attach to the next one. Tested in turnTiming.test.ts.
 */

export interface TurnTiming {
  turn: number;
  greeting: boolean;
  finalToFirstAudioMs: number | null;
  textToFirstAudioMs: number | null;
  userEndToFinalMs: number | null;
}

/** A Hume `time.end` that is a real Unix-millisecond timestamp. */
function isEpochMs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 1e12;
}

export class TurnTimer {
  private turn = 0;
  private userFinalAt: number | null = null;
  private userEndToFinalMs: number | null = null;
  private assistantTextAt: number | null = null;
  private reported = false;

  /** A final (non-interim) user transcript arrived. */
  onUserFinal(now: number, utteranceEnd?: unknown): void {
    this.userFinalAt = now;
    this.userEndToFinalMs = isEpochMs(utteranceEnd) ? Math.max(0, Math.round(now - utteranceEnd)) : null;
    // A new user turn means the previous reply is over, however it ended.
    this.assistantTextAt = null;
    this.reported = false;
  }

  /** The reply's text arrived (first one of this reply wins). */
  onAssistantText(now: number): void {
    if (this.assistantTextAt === null) this.assistantTextAt = now;
  }

  /** An audio chunk was accepted for playback. Returns a timing once per reply. */
  onAudio(now: number): TurnTiming | null {
    if (this.reported) return null;
    this.reported = true;
    this.turn += 1;
    const greeting = this.userFinalAt === null;
    const timing: TurnTiming = {
      turn: this.turn,
      greeting,
      finalToFirstAudioMs: this.userFinalAt === null ? null : Math.max(0, Math.round(now - this.userFinalAt)),
      textToFirstAudioMs: this.assistantTextAt === null ? null : Math.max(0, Math.round(now - this.assistantTextAt)),
      userEndToFinalMs: greeting ? null : this.userEndToFinalMs,
    };
    return timing;
  }

  /** The reply ended (assistant_end) or was cut off (user_interruption). */
  onReplyEnd(): void {
    this.userFinalAt = null;
    this.userEndToFinalMs = null;
    this.assistantTextAt = null;
    this.reported = false;
  }
}
