import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CaptionSyncEngine, type AlignmentChunk } from "../lib/captionSync";

// ─── Fixture: a REAL production event stream ─────────────────────────────────
// Captured from a live audio-mode conversation with the production ElevenLabs
// agent (raw WebSocket probe): a long storytelling turn interrupted mid-speech
// by a barge-in (interruption + agent_response_correction), followed by a
// short second turn that completes naturally. Audio chunks arrived ~9× faster
// than realtime — exactly the condition the caption engine exists for.

type FixtureEvent = {
  ms: number;
  type: string;
  bytes?: number;
  alignment?: AlignmentChunk | null;
  text?: string;
  corrected?: string;
  event_id?: number;
};

const fixture: FixtureEvent[] = JSON.parse(
  readFileSync(new URL("./fixtures/realtime-call-events.json", import.meta.url), "utf8"),
);

const BYTES_PER_MS = 32; // pcm_16000: 2 bytes × 16 samples per ms

/**
 * Independent re-implementation of word-start extraction (byte-offset
 * accumulation), used to check the engine's reveal against ground truth.
 */
function wordStartsForTurn(turnEventId: number): number[] {
  const starts: number[] = [];
  let offsetMs = 0;
  let inWord = false;
  for (const e of fixture) {
    if (e.type !== "audio" || e.event_id !== turnEventId || !e.alignment) continue;
    const a = e.alignment;
    for (let i = 0; i < a.chars.length; i++) {
      if (/\s/.test(a.chars[i])) {
        inWord = false;
        continue;
      }
      if (!inWord) {
        inWord = true;
        starts.push(offsetMs + a.char_start_times_ms[i]);
      }
    }
    offsetMs += (e.bytes ?? 0) / BYTES_PER_MS;
  }
  return starts;
}

// Key fixture timestamps
const FIRST_AUDIO_MS = fixture.find((e) => e.type === "audio")!.ms;
const INTERRUPTION_MS = fixture.find((e) => e.type === "interruption")!.ms;
const TURN2_AUDIO = fixture.filter((e) => e.type === "audio").find((e) => e.event_id === 2)!;
const TURN2_DURATION_MS = (TURN2_AUDIO.bytes ?? 0) / BYTES_PER_MS;

describe("CaptionSyncEngine — production event stream replay", () => {
  it("caption trails the voice, freezes on interruption, and recovers for the next turn", () => {
    let simNow = 0;
    const engine = new CaptionSyncEngine({ now: () => simNow });
    engine.setAudioFormat("pcm_16000");

    const t1Starts = wordStartsForTurn(1);
    const t2Starts = wordStartsForTurn(2);
    expect(t1Starts.length).toBeGreaterThan(40); // long storytelling turn
    expect(t2Starts.length).toBeGreaterThan(2);

    // Deliver fixture events exactly the way the SDK surfaces them:
    // per played chunk: onAudioAlignment → onAudio → onModeChange("speaking");
    // interruption: onInterruption → onModeChange("listening").
    const queue = [...fixture].sort((a, b) => a.ms - b.ms);
    let qi = 0;
    const deliverDue = () => {
      while (qi < queue.length && queue[qi].ms <= simNow) {
        const e = queue[qi++];
        if (e.type === "audio") {
          if (e.alignment) engine.addAlignment(e.alignment);
          engine.addAudioChunk(e.bytes ?? 0);
          engine.setMode("speaking");
        } else if (e.type === "agent_response") {
          engine.noteAgentResponse(e.text ?? "");
        } else if (e.type === "interruption") {
          engine.markInterrupted();
          engine.setMode("listening");
        } else if (e.type === "agent_response_correction") {
          engine.applyCorrection(e.corrected ?? "");
        }
      }
    };

    // Turn 2 plays out fully; the SDK flips to listening when the worklet drains.
    const turn2ListenAt = TURN2_AUDIO.ms + TURN2_DURATION_MS;
    let flippedTurn2 = false;

    let frozenAt: number | null = null; // revealed count captured at interruption
    let maxRevealedAfterFreeze = 0;
    let sawTurn2Text = false;

    for (simNow = 0; simNow <= turn2ListenAt + 4000; simNow += 20) {
      deliverDue();
      if (!flippedTurn2 && simNow >= turn2ListenAt) {
        engine.setMode("listening");
        flippedTurn2 = true;
      }
      const snap = engine.snapshot();

      // ── Invariant: NEVER ahead of the voice ──
      if (simNow > FIRST_AUDIO_MS && simNow < INTERRUPTION_MS) {
        const playbackPos = simNow - FIRST_AUDIO_MS;
        const audible = t1Starts.filter((s) => s <= playbackPos).length;
        expect(snap.revealedWords).toBeLessThanOrEqual(audible);
      }

      // ── Invariant: frozen after the barge-in ──
      if (simNow >= INTERRUPTION_MS && !sawTurn2Text) {
        if (frozenAt == null) frozenAt = snap.revealedWords;
        maxRevealedAfterFreeze = Math.max(maxRevealedAfterFreeze, snap.revealedWords);
      }

      if (snap.text.startsWith("I'm here")) sawTurn2Text = true;

      // Turn 2 must also trail its own playback
      if (sawTurn2Text && simNow < turn2ListenAt) {
        const playbackPos = simNow - TURN2_AUDIO.ms;
        const audible = t2Starts.filter((s) => s <= playbackPos).length;
        expect(snap.revealedWords).toBeLessThanOrEqual(audible);
      }
    }

    // The interruption happened ~2.7s into a ~22.5s reply: only the first
    // words were audible, and the unspoken remainder must never have shown.
    expect(frozenAt).not.toBeNull();
    expect(frozenAt!).toBeGreaterThan(0);
    expect(frozenAt!).toBeLessThan(Math.floor(t1Starts.length * 0.3));
    expect(maxRevealedAfterFreeze).toBeLessThanOrEqual(frozenAt!);

    // The second turn replaced the caption and completed naturally.
    expect(sawTurn2Text).toBe(true);
    const final = engine.snapshot();
    expect(final.text).toBe("I'm here — what's up?");
    expect(final.revealedWords).toBe(t2Starts.length);
  });
});

// ─── Synthetic helpers for targeted unit cases ────────────────────────────────

/** Build an alignment chunk: each word starts at index × msPerWord. */
function mkAlign(text: string, msPerWord = 300): AlignmentChunk {
  const chars = text.split("");
  const starts: number[] = [];
  const durs: number[] = [];
  let wordIdx = -1;
  let prevWasSpace = true;
  for (const ch of chars) {
    const isSpace = /\s/.test(ch);
    if (!isSpace && prevWasSpace) wordIdx++;
    prevWasSpace = isSpace;
    starts.push(Math.max(0, wordIdx) * msPerWord);
    durs.push(50);
  }
  return { chars, char_start_times_ms: starts, char_durations_ms: durs };
}

function mkEngine() {
  let now = 0;
  const engine = new CaptionSyncEngine({ now: () => now });
  engine.setAudioFormat("pcm_16000");
  return {
    engine,
    tick(toMs: number, step = 40) {
      let snap = engine.snapshot();
      while (now < toMs) {
        now = Math.min(now + step, toMs);
        snap = engine.snapshot();
      }
      return snap;
    },
  };
}

describe("CaptionSyncEngine — unit behaviors", () => {
  it("reveals words strictly behind their alignment start times", () => {
    const { engine, tick } = mkEngine();
    engine.addAlignment(mkAlign("one two three four five", 400));
    engine.addAudioChunk(2400 * 32); // 2.4s of audio
    engine.setMode("speaking");
    // Word starts: 0, 400, 800, 1200, 1600 (+100ms reveal lag on each).
    expect(tick(300).revealedWords).toBe(1); // only word 1 (0+lag ≤ 300); word 2 needs 500
    expect(tick(450).revealedWords).toBe(1); // word 2 at 400+lag=500 still ahead
    expect(tick(950).revealedWords).toBe(3); // 0, 400, 800 audible; word 4 needs 1300
    const snap = tick(2000);
    expect(snap.revealedWords).toBeLessThanOrEqual(5);
    expect(snap.text).toBe("one two three four five");
  });

  it("freezes on interruption and lets a correction only clamp further", () => {
    const { engine, tick } = mkEngine();
    engine.addAlignment(mkAlign("a b c d e f g h i j", 200));
    engine.addAudioChunk(2000 * 32);
    engine.setMode("speaking");
    const before = tick(1100).revealedWords; // ~5 words audible
    expect(before).toBeGreaterThanOrEqual(4);
    engine.markInterrupted();
    engine.setMode("listening");
    // A generous server correction (more words than actually heard) must NOT extend
    engine.applyCorrection("a b c d e f g h");
    expect(tick(5000).revealedWords).toBe(before);
    // A stricter correction clamps down
    engine.applyCorrection("a b");
    expect(tick(5200).revealedWords).toBe(2);
  });

  it("ignores straggler alignments after an interrupt; next played chunk starts a clean turn", () => {
    const { engine, tick } = mkEngine();
    engine.addAlignment(mkAlign("alpha beta gamma", 300));
    engine.addAudioChunk(900 * 32);
    engine.setMode("speaking");
    tick(500);
    engine.markInterrupted();
    engine.setMode("listening");
    const frozen = tick(600).revealedWords;

    // Straggler: alignment WITHOUT audio (SDK drops stale chunks' playback)
    engine.addAlignment(mkAlign("leftover tail words", 300));
    const after = tick(1500);
    expect(after.text).toBe("alpha beta gamma"); // untouched
    expect(after.revealedWords).toBe(frozen);

    // Real next turn: alignment + audio + speaking
    engine.addAlignment(mkAlign("hello there", 300));
    engine.addAudioChunk(600 * 32);
    engine.setMode("speaking");
    const t2 = tick(1600);
    expect(t2.text).toBe("hello there");
    expect(t2.revealedWords).toBeLessThanOrEqual(1); // fresh turn, fresh clock
  });

  it("paces conservatively from agent text when no alignment exists, then snaps when the turn ends", () => {
    const { engine, tick } = mkEngine();
    engine.addAudioChunk(3000 * 32); // audio flows but carries no alignment
    engine.noteAgentResponse("this reply has exactly eight words in it total");
    engine.setMode("speaking");
    const early = tick(600).revealedWords;
    expect(early).toBeLessThanOrEqual(2); // ~350ms of budget at 15 cps ≈ 5 chars
    const mid = tick(2500).revealedWords;
    expect(mid).toBeGreaterThan(early);
    expect(mid).toBeLessThan(9);
    engine.setMode("listening"); // drained; no interruption event
    const done = tick(4200); // +1.7s sustained listening → snap to full
    expect(done.revealedWords).toBe(9);
  });

  it("stays empty before any turn starts", () => {
    const { engine } = mkEngine();
    expect(engine.snapshot()).toEqual({ text: "", revealedWords: 0 });
  });

  it("never promotes a stale straggler alignment into a later alignment-less turn", () => {
    // SDK-order replay of the degraded path: interrupted turn → straggler
    // alignment (parked, no audio) → seconds later a NEW turn whose chunks
    // carry NO alignment. The straggler's text must not caption the new turn.
    const { engine, tick } = mkEngine();
    engine.addAlignment(mkAlign("alpha beta gamma delta", 300));
    engine.addAudioChunk(1200 * 32);
    engine.setMode("speaking");
    tick(400);
    engine.markInterrupted();
    engine.setMode("listening");
    engine.addAlignment(mkAlign("unspoken remainder words here", 300)); // straggler
    tick(3000); // seconds pass — user speaks, LLM thinks

    engine.addAudioChunk(2000 * 32); // turn 2: audio WITHOUT alignment
    engine.setMode("speaking");
    engine.noteAgentResponse("fresh second reply");
    const snap = tick(4500);
    expect(snap.text).toBe("fresh second reply"); // fallback text, not straggler words
    expect(snap.text).not.toContain("unspoken");
    // ...while a same-task alignment+audio pair still promotes normally:
    engine.setMode("listening");
    tick(6300); // fallback snap completes turn 2
    engine.addAlignment(mkAlign("third turn", 300));
    engine.addAudioChunk(600 * 32); // same tick — gap 0ms
    engine.setMode("speaking");
    expect(tick(6500).text).toBe("third turn");
  });

  it("drops the interrupted turn's late agent_response instead of parking it for the next turn", () => {
    const fullText = "the entire long reply that was cut off midway through";
    const { engine, tick } = mkEngine();
    engine.addAlignment(mkAlign("the entire long", 300));
    engine.addAudioChunk(900 * 32);
    engine.setMode("speaking");
    tick(400);
    engine.markInterrupted();
    engine.setMode("listening");
    engine.applyCorrection("the entire", fullText);
    engine.noteAgentResponse(fullText); // late arrival AFTER the correction
    tick(2000);

    engine.addAudioChunk(1500 * 32); // next turn, no alignment, no text yet
    engine.setMode("speaking");
    const snap = tick(3500);
    expect(snap.text).toBe(""); // old turn's full text must NOT be the fallback
    engine.noteAgentResponse("second turn text");
    expect(tick(3600).text).toBe("second turn text");
  });
});
