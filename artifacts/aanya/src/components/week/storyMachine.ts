/**
 * Weekly review — the story's state, as a pure reducer.
 *
 * Everything the shell needs to decide lives here so it can be unit-tested
 * without a DOM: which card is showing, whether the timer is paused (tap and
 * hold), whether the story is over, and how a pointer release is interpreted
 * (a tap in the back zone, a tap forward, or the end of a hold — which is
 * never a navigation).
 *
 *  - forward on the last card closes the story (nothing renders after it);
 *  - the TIMER on the last card does nothing: the last card waits for a tap,
 *    never closes on its own;
 *  - back on the first card is a no-op;
 *  - `run` bumps on every card change so the shell can restart the bar
 *    animation, including when someone goes back to a card already seen.
 */

export interface StoryState {
  index: number;
  count: number;
  /** Tap-and-hold in progress: the live bar's timer is frozen. */
  paused: boolean;
  closed: boolean;
  /** Increments on every card change — a key for restarting animations. */
  run: number;
}

export type StoryAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "timerDone" }
  | { type: "holdStart" }
  | { type: "holdEnd" }
  | { type: "close" };

export function createStoryState(count: number): StoryState {
  return { index: 0, count: Math.max(0, count), paused: false, closed: false, run: 0 };
}

export function storyReducer(s: StoryState, a: StoryAction): StoryState {
  switch (a.type) {
    case "next":
      if (s.index >= s.count - 1) return { ...s, closed: true };
      return { ...s, index: s.index + 1, run: s.run + 1, paused: false };
    case "prev":
      if (s.index <= 0) return s;
      return { ...s, index: s.index - 1, run: s.run + 1, paused: false };
    case "timerDone":
      // The last card waits for a tap.
      if (s.index >= s.count - 1) return s;
      return { ...s, index: s.index + 1, run: s.run + 1, paused: false };
    case "holdStart":
      return s.paused ? s : { ...s, paused: true };
    case "holdEnd":
      return s.paused ? { ...s, paused: false } : s;
    case "close":
      return s.closed ? s : { ...s, closed: true };
  }
}

/** A press longer than this is a hold (pause), not a tap. */
export const HOLD_THRESHOLD_MS = 200;

/** Left 28% of the stage goes back; the rest goes forward (as the prototype). */
export const BACK_ZONE_FRACTION = 0.28;

export type Zone = "back" | "forward";

export function zoneForX(x: number, width: number): Zone {
  if (width <= 0) return "forward";
  return x < width * BACK_ZONE_FRACTION ? "back" : "forward";
}

/** What a pointer release means. A hold's release only ends the pause — it
 *  never navigates, so pausing to read can't accidentally skip a card. */
export function resolveRelease(held: boolean, zone: Zone): StoryAction {
  if (held) return { type: "holdEnd" };
  return zone === "back" ? { type: "prev" } : { type: "next" };
}

export type BarState = "done" | "live" | "todo";

export function barState(i: number, index: number): BarState {
  if (i < index) return "done";
  if (i === index) return "live";
  return "todo";
}
