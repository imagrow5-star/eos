/**
 * Weekly review — data shapes.
 *
 * A story is 3–6 cards, one thought per screen. The shell renders exactly the
 * array it is given and never invents a card, so the spec's minimum-content
 * rule (fewer than three real cards → no story) and the grief/crisis
 * guardrail (suppress "did" and "forward") are purely the generator's job
 * (stage 3): they shape this array, nothing else has to know.
 *
 * Voice rules the generator must obey live with the generator, not here — but
 * the shapes enforce one thing structurally: "thenNow" has NO interpretation
 * field. Two verbatim quotes and two stamps. There is nowhere to put "what it
 * means".
 */

export type WeekCard =
  /** 1 — a specific moment the person named: a person, a place, an event. */
  | { kind: "moment"; eyebrow: string; text: string }
  /** 2 — something they did, stated as an action. Suppressed under the crisis guardrail. */
  | { kind: "did"; eyebrow: string; text: string }
  /** 3 — then and now: two verbatim quotes on one theme, older above at reduced weight. */
  | {
      kind: "thenNow";
      eyebrow: string;
      then: { stamp: string; quote: string };
      now: { stamp: string; quote: string };
    }
  /** 4 — the honest middle: something still open, named as open, never as failure. */
  | { kind: "open"; eyebrow: string; text: string }
  /** 5 — a word or phrase they keep using, with how often. Their words only. */
  | { kind: "pattern"; eyebrow: string; phrase: string; said: string }
  /** 6 — forward: a continuity line; `sub` names the existence of a sealed note, or null. Suppressed under the crisis guardrail. */
  | { kind: "forward"; text: string; sub: string | null };

export interface WeekStory {
  id: string;
  /** Marker label under the circle: "This week", "Last week", "August", "14 Aug". */
  label: string;
  /** The verbatim fragment inside the marker — something they said that week. */
  fragment: string;
  /** The week's date range, e.g. "2–8 September" (the first card's eyebrow). */
  range: string;
  /** 3–6 cards, in the order they are shown. */
  cards: WeekCard[];
}

export const WEEK_CARD_MIN = 3;
export const WEEK_CARD_MAX = 6;

/** Each card's progress bar is a real timer: it fills over this long, then
 *  the story advances. Tap-and-hold pauses it. The last card never advances
 *  on its own — it waits for a tap. */
export const CARD_DURATION_MS = 7000;
