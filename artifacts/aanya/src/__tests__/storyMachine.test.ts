/**
 * Weekly review — story state (components/week/storyMachine.ts).
 *
 * Pins the interaction rules the shell relies on:
 *  - forward on the last card closes; the TIMER on the last card does not
 *    (the last card waits for a tap);
 *  - back on the first card is a no-op;
 *  - a hold pauses, its release only resumes — never navigates;
 *  - every card change bumps `run` so the bar animation restarts, including
 *    on the way back to a card already seen.
 */

import { describe, it, expect } from "vitest";
import {
  barState,
  BACK_ZONE_FRACTION,
  createStoryState,
  resolveRelease,
  storyReducer,
  zoneForX,
  type StoryAction,
  type StoryState,
} from "../components/week/storyMachine";

const run = (s: StoryState, ...actions: StoryAction[]) => actions.reduce(storyReducer, s);

describe("storyReducer", () => {
  it("starts on the first card, unpaused, open", () => {
    expect(createStoryState(6)).toEqual({ index: 0, count: 6, paused: false, closed: false, run: 0 });
  });

  it("next advances and bumps run; forward on the last card closes", () => {
    let s = createStoryState(3);
    s = run(s, { type: "next" });
    expect(s.index).toBe(1);
    expect(s.run).toBe(1);
    s = run(s, { type: "next" });
    expect(s.index).toBe(2);
    expect(s.closed).toBe(false);
    s = run(s, { type: "next" });
    expect(s.closed).toBe(true);
    expect(s.index).toBe(2); // nothing renders after the last card
  });

  it("prev goes back and bumps run; prev on the first card is a no-op", () => {
    const start = createStoryState(3);
    expect(run(start, { type: "prev" })).toBe(start);
    const s = run(start, { type: "next" }, { type: "next" }, { type: "prev" });
    expect(s.index).toBe(1);
    expect(s.run).toBe(3); // three changes — the bar restarts on the way back too
  });

  it("the timer advances mid-story but never closes the last card", () => {
    let s = createStoryState(3);
    s = run(s, { type: "timerDone" });
    expect(s.index).toBe(1);
    s = run(s, { type: "timerDone" });
    expect(s.index).toBe(2);
    const afterTimer = run(s, { type: "timerDone" });
    expect(afterTimer).toBe(s); // waits for a tap
    expect(afterTimer.closed).toBe(false);
  });

  it("hold pauses, release resumes, and a card change clears a pause", () => {
    let s = createStoryState(3);
    s = run(s, { type: "holdStart" });
    expect(s.paused).toBe(true);
    s = run(s, { type: "holdEnd" });
    expect(s.paused).toBe(false);
    s = run(s, { type: "holdStart" }, { type: "next" });
    expect(s.paused).toBe(false);
    expect(s.index).toBe(1);
  });

  it("close is idempotent", () => {
    const s = run(createStoryState(3), { type: "close" });
    expect(s.closed).toBe(true);
    expect(run(s, { type: "close" })).toBe(s);
  });
});

describe("tap zones and release", () => {
  it("the left 28% goes back, the rest forward", () => {
    const w = 390;
    expect(zoneForX(0, w)).toBe("back");
    expect(zoneForX(w * BACK_ZONE_FRACTION - 1, w)).toBe("back");
    expect(zoneForX(w * BACK_ZONE_FRACTION, w)).toBe("forward");
    expect(zoneForX(w - 1, w)).toBe("forward");
  });

  it("a tap navigates by zone; a hold's release only ends the pause", () => {
    expect(resolveRelease(false, "back")).toEqual({ type: "prev" });
    expect(resolveRelease(false, "forward")).toEqual({ type: "next" });
    expect(resolveRelease(true, "forward")).toEqual({ type: "holdEnd" });
    expect(resolveRelease(true, "back")).toEqual({ type: "holdEnd" });
  });

  it("a hold released over the forward zone does not skip the card", () => {
    const s = run(createStoryState(3), { type: "holdStart" }, resolveRelease(true, "forward"));
    expect(s.index).toBe(0);
    expect(s.paused).toBe(false);
  });
});

describe("barState", () => {
  it("done before, live at, todo after the current card", () => {
    expect([0, 1, 2, 3].map((i) => barState(i, 2))).toEqual(["done", "done", "live", "todo"]);
  });
});
