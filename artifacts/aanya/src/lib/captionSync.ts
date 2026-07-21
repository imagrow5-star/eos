// ─── Realtime live-caption sync engine ────────────────────────────────────────
// Reveals the in-call caption word-by-word IN SYNC with the companion's actual
// speech during realtime (ElevenLabs agent) voice calls — like TV captions.
//
// Why this exists: the agent streams audio chunks much faster than realtime
// (a 20-second reply arrives in ~2 seconds), and the full reply text
// (agent_response) can arrive while she is still mid-sentence. Showing text
// the moment it arrives lets the user read the whole paragraph ahead of her
// voice, which kills the conversational feel — and after a barge-in it would
// reveal words she never actually spoke.
//
// How it works:
//   • Caption text is built from the ALIGNMENT stream (per-chunk character
//     timings riding on audio events) — i.e. from exactly what she will
//     speak, in speech order. The agent_response full text is only a pacing
//     fallback for the (defensive) case where alignment is absent.
//   • A playback clock accumulates time ONLY while the SDK reports mode
//     "speaking" (the SDK's mode is driven by the actual audio worklet, so
//     the clock pauses whenever audio pauses/stalls) — never by chunk arrival.
//   • A word is revealed only once the clock passes its alignment start time
//     (+ a small lag), so the caption trails her voice and is never ahead.
//   • On interruption the turn freezes instantly — the unspoken remainder is
//     never revealed. A later agent_response_correction can only clamp the
//     reveal further (the server's estimate of "heard" audio is generous
//     because it counts SENT chunks; our playback clock is the authority).
//
// The engine is pure and UI-free: callers feed it SDK events and poll
// snapshot() on an interval. Chat history persistence is server-side and
// completely unaffected by anything here.

export type AlignmentChunk = {
  chars: string[];
  char_start_times_ms: number[];
  char_durations_ms: number[];
};

export type CaptionSnapshot = {
  /** Caption text — alignment-derived while alignment exists, else agent text. */
  text: string;
  /** How many words of `text` may be shown (monotonic within a turn). */
  revealedWords: number;
};

/** Reveal a word slightly AFTER her voice starts it — trailing, never leading. */
const REVEAL_LAG_MS = 100;
/** Max clock advance per tick — guards against background-tab timer throttling. */
const TICK_CLAMP_MS = 1200;
/** Clock-vs-received-audio tolerance for treating a drained turn as complete. */
const COMPLETE_EPSILON_MS = 400;
/**
 * Safety valve: sustained "listening" with NO interruption event means the
 * turn is over even if the clock fell behind (missed ticks, timing drift) —
 * snap to full so the caption can't stick half-revealed forever. Interruptions
 * always arrive as explicit events BEFORE the mode flips, so this can never
 * reveal words cut off by a barge-in.
 */
const STALL_SNAP_MS = 2500;
/** Fallback (no alignment): conservative pace, slightly slower than speech. */
const FALLBACK_CHARS_PER_SEC = 15;
/** Fallback: small delay before the first word appears. */
const FALLBACK_START_DELAY_MS = 250;
/** Fallback: sustained listening after speech ⇒ turn done, show everything. */
const FALLBACK_SNAP_MS = 1500;
/**
 * A real chunk's alignment and audio callbacks fire back-to-back in the SAME
 * synchronous SDK task (gap ≈ 0 ms). A parked alignment older than this when
 * the audio arrives is a post-interrupt straggler from a PREVIOUS turn — the
 * next turn is always seconds away (user speech + LLM + TTS) — and must never
 * be promoted, or stale text would caption the new turn.
 */
const ALIGN_PAIR_WINDOW_MS = 250;

type Word = { startMs: number; text: string };

export class CaptionSyncEngine {
  private readonly now: () => number;

  /** ms of playback per audio byte; null = unknown format (use alignment spans). */
  private msPerByte: number | null = 1 / 32; // default pcm_16000: 2 bytes × 16 kHz

  private phase: "idle" | "active" | "done" = "idle";
  private mode: "speaking" | "listening" = "listening";
  private listeningSince: number | null = null;
  private lastNow: number | null = null;

  // Held while no turn is active. Alignment fires for EVERY incoming chunk —
  // including post-interrupt stragglers the SDK never plays — but onAudio only
  // fires for chunks that actually play. So an alignment chunk is parked here
  // and only "promoted" into a new turn when its audio callback follows it;
  // stragglers simply get overwritten and are never shown.
  private pendingAlign: AlignmentChunk | null = null;
  private pendingAlignAt = 0; // when it was parked — see ALIGN_PAIR_WINDOW_MS
  private pendingAgentText: string | null = null;
  // The interrupted turn's ORIGINAL text (from agent_response_correction).
  // The server can emit the full agent_response for a turn after its own
  // interruption; recognizing it by content keeps it from parking as the
  // NEXT turn's fallback text (which would resurrect unspoken words).
  private lastCorrectedOriginal: string | null = null;

  // ── Per-turn state ──
  private words: Word[] = [];
  private inWord = false;
  private turnAudioMs = 0; // total received audio duration for this turn
  private clockMs = 0; // accumulated PLAYBACK time (advances only while speaking)
  private revealed = 0;
  private interrupted = false;
  private agentText: string | null = null;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => performance.now());
  }

  /** From conversation metadata, e.g. "pcm_16000" | "ulaw_8000". */
  setAudioFormat(format: string): void {
    const pcm = /^pcm_(\d{4,6})$/.exec(format);
    if (pcm) {
      this.msPerByte = 1000 / (Number(pcm[1]) * 2); // 16-bit samples
      return;
    }
    if (format === "ulaw_8000") {
      this.msPerByte = 1000 / 8000; // 8-bit samples
      return;
    }
    this.msPerByte = null; // unknown — fall back to alignment-span offsets
  }

  /** onAudioAlignment: per-chunk char timings (times relative to chunk start). */
  addAlignment(chunk: AlignmentChunk): void {
    if (this.phase !== "active") {
      this.pendingAlign = chunk;
      this.pendingAlignAt = this.now();
      return;
    }
    this.applyAlignment(chunk);
  }

  /** onAudio: a chunk actually accepted for playback (length in bytes). */
  addAudioChunk(bytes: number): void {
    if (this.phase !== "active") this.startTurn();
    if (this.msPerByte != null) this.turnAudioMs += bytes * this.msPerByte;
  }

  /** onMessage(role=agent): full reply text — fallback pacing source only. */
  noteAgentResponse(text: string): void {
    if (this.phase === "active") {
      this.agentText = text;
      return;
    }
    // Parked for the next turn — unless it's the interrupted turn's own full
    // text arriving late (matches the correction's original), which must die
    // here rather than caption the next turn.
    if (this.lastCorrectedOriginal != null && text === this.lastCorrectedOriginal) return;
    this.pendingAgentText = text;
  }

  /** onModeChange — the SDK's mode tracks the real audio worklet state. */
  setMode(mode: "speaking" | "listening"): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.listeningSince = mode === "listening" ? this.now() : null;
  }

  /** onInterruption: freeze NOW — the unspoken remainder must never appear. */
  markInterrupted(): void {
    // Turn boundary: whatever was parked belongs to the turn that just died.
    this.pendingAlign = null;
    this.pendingAgentText = null;
    if (this.phase === "active") {
      this.interrupted = true;
      this.phase = "done";
    }
  }

  /**
   * onAgentResponseCorrection: the server's own truncation of what was spoken.
   * Only ever clamps the reveal — never extends it (the estimate counts SENT
   * audio, which can exceed what the user actually heard).
   */
  applyCorrection(correctedText: string, originalText?: string): void {
    this.pendingAlign = null;
    this.pendingAgentText = null;
    this.lastCorrectedOriginal = originalText ?? null;
    if (this.phase === "active") {
      this.interrupted = true;
      this.phase = "done";
    }
    const cap = correctedText.trim().split(/\s+/).filter(Boolean).length;
    if (this.revealed > cap) this.revealed = cap;
  }

  /** Poll on an interval (~80 ms). Advances the clock and computes the reveal. */
  snapshot(): CaptionSnapshot {
    const now = this.now();
    const dt = this.lastNow == null ? 0 : Math.min(Math.max(now - this.lastNow, 0), TICK_CLAMP_MS);
    this.lastNow = now;

    if (this.phase === "active" && this.mode === "speaking") {
      this.clockMs += dt;
    }

    if (this.phase === "active") {
      if (this.words.length > 0) {
        // ── Alignment-timed reveal (primary path) ──
        let target = 0;
        for (const w of this.words) {
          if (w.startMs + REVEAL_LAG_MS <= this.clockMs) target++;
          else break;
        }
        if (target > this.revealed) this.revealed = Math.min(target, this.words.length);

        if (this.mode === "listening") {
          const drained =
            this.turnAudioMs > 0 && this.clockMs >= this.turnAudioMs - COMPLETE_EPSILON_MS;
          const stalled =
            this.listeningSince != null && now - this.listeningSince >= STALL_SNAP_MS;
          if (drained || stalled) {
            // Natural end of the turn — she finished speaking; show everything.
            this.revealed = this.words.length;
            this.phase = "done";
          }
        }
      } else if (this.agentText) {
        // ── Fallback pacing (no alignment available) ──
        const words = this.agentText.trim().split(/\s+/).filter(Boolean);
        const budget =
          (Math.max(0, this.clockMs - FALLBACK_START_DELAY_MS) * FALLBACK_CHARS_PER_SEC) / 1000;
        let chars = 0;
        let target = 0;
        for (const w of words) {
          chars += w.length + 1;
          if (chars <= budget) target++;
          else break;
        }
        if (target > this.revealed) this.revealed = Math.min(target, words.length);

        if (
          this.mode === "listening" &&
          this.clockMs > 0 &&
          this.listeningSince != null &&
          now - this.listeningSince >= FALLBACK_SNAP_MS
        ) {
          this.revealed = words.length;
          this.phase = "done";
        }
      }
    }

    return { text: this.displayText(), revealedWords: this.revealed };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private startTurn(): void {
    this.phase = "active";
    this.words = [];
    this.inWord = false;
    this.turnAudioMs = 0;
    this.clockMs = 0;
    this.revealed = 0;
    this.interrupted = false;
    this.agentText = this.pendingAgentText;
    this.pendingAgentText = null;
    if (this.pendingAlign) {
      const chunk = this.pendingAlign;
      const age = this.now() - this.pendingAlignAt;
      this.pendingAlign = null;
      // Promote ONLY a same-task pair (alignment immediately followed by its
      // own audio). Older parked chunks are unplayed stragglers from a
      // previous turn — dropping them keeps their text off this turn.
      if (age <= ALIGN_PAIR_WINDOW_MS) this.applyAlignment(chunk);
    }
  }

  private applyAlignment(chunk: AlignmentChunk): void {
    // Offset = audio received BEFORE this chunk. onAudioAlignment fires before
    // this chunk's own onAudio, so turnAudioMs is exactly the prior total.
    const offset = this.turnAudioMs;
    const { chars, char_start_times_ms: starts, char_durations_ms: durs } = chunk;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i] ?? "";
      if (/\s/.test(ch) || ch === "") {
        this.inWord = false;
        continue;
      }
      if (!this.inWord) {
        this.inWord = true;
        this.words.push({ startMs: offset + (starts[i] ?? 0), text: ch });
      } else {
        const last = this.words[this.words.length - 1];
        if (last) last.text += ch;
      }
    }
    if (this.msPerByte == null && chars.length > 0) {
      // Unknown audio format: advance the received-audio total by the
      // alignment span instead of exact byte math.
      const lastIdx = chars.length - 1;
      this.turnAudioMs = offset + (starts[lastIdx] ?? 0) + (durs[lastIdx] ?? 0);
    }
  }

  private displayText(): string {
    if (this.words.length > 0) return this.words.map((w) => w.text).join(" ");
    return this.agentText ?? "";
  }
}
