/**
 * The voice demo's minute (demo-voice/cutoff.ts): the line fills, the mic
 * stops at the minute, a reply being spoken finishes, and nothing runs on
 * past the ceiling.
 */

import { describe, it, expect } from "vitest";
import { CallCutoff, DEMO_VOICE_LIMIT_MS, FINISH_CEILING_MS } from "../demo-voice/cutoff";

describe("CallCutoff", () => {
  it("fills the line over the minute and counts down whole seconds", () => {
    const c = new CallCutoff(1000);
    expect(c.progress(1000)).toBe(0);
    expect(c.progress(31_000)).toBeCloseTo(0.5);
    expect(c.progress(61_000)).toBe(1);
    expect(c.progress(90_000)).toBe(1);
    expect(c.secondsLeft(1000)).toBe(60);
    expect(c.secondsLeft(1500)).toBe(60);
    expect(c.secondsLeft(60_500)).toBe(1);
    expect(c.secondsLeft(70_000)).toBe(0);
  });

  it("ends at once when the minute is up and Eos is listening", () => {
    const c = new CallCutoff(0);
    expect(c.tick(59_999)).toBe("none");
    expect(c.tick(DEMO_VOICE_LIMIT_MS)).toBe("end");
    expect(c.phase).toBe("done");
    expect(c.hitLimit()).toBe(true);
    expect(c.tick(70_000)).toBe("none"); // nothing after done
  });

  it("stops the mic and lets the sentence finish when Eos is speaking", () => {
    const c = new CallCutoff(0);
    c.noteMode("speaking");
    expect(c.tick(DEMO_VOICE_LIMIT_MS)).toBe("stop-input");
    expect(c.phase).toBe("finishing");
    expect(c.tick(DEMO_VOICE_LIMIT_MS + 3000)).toBe("none");
    expect(c.noteMode("listening")).toBe("end");
    expect(c.phase).toBe("done");
    expect(c.hitLimit()).toBe(true);
  });

  it("does not wait forever for a reply to end", () => {
    const c = new CallCutoff(0);
    c.noteMode("speaking");
    expect(c.tick(DEMO_VOICE_LIMIT_MS)).toBe("stop-input");
    expect(c.tick(DEMO_VOICE_LIMIT_MS + FINISH_CEILING_MS - 1)).toBe("none");
    expect(c.tick(DEMO_VOICE_LIMIT_MS + FINISH_CEILING_MS)).toBe("end");
  });

  it("a hang-up before the minute is not the limit", () => {
    const c = new CallCutoff(0);
    c.noteMode("speaking");
    c.noteMode("listening");
    expect(c.tick(20_000)).toBe("none");
    c.finish();
    expect(c.hitLimit()).toBe(false);
    expect(c.tick(DEMO_VOICE_LIMIT_MS)).toBe("none");
    expect(c.noteMode("listening")).toBe("none");
  });
});
