/**
 * Weekly review — stage 1 fixture.
 *
 * The six cards from the prototype (eos-week-v2.html), verbatim, so the
 * interaction and the feel can be judged before any generation exists. Stage 3
 * replaces this with real content; the shapes are the same.
 */

import type { WeekStory } from "./types";

export const PROTOTYPE_STORY: WeekStory = {
  id: "prototype-2026-09-08",
  label: "This week",
  fragment: "“she just said finally”",
  range: "2–8 September",
  cards: [
    // 1 · a specific moment he named
    { kind: "moment", eyebrow: "2–8 September", text: "You talked about your dad’s garden again on Tuesday." },
    // 2 · something he did
    { kind: "did", eyebrow: "And on Thursday", text: "You went for the walk you’d been putting off since Sunday." },
    // 3 · then and now — the core
    {
      kind: "thenNow",
      eyebrow: "Your words",
      then: { stamp: "Three weeks ago", quote: "“I don’t want to be a burden to anyone.”" },
      now: { stamp: "Friday", quote: "“I texted my sister back. She just said finally.”" },
    },
    // 4 · the honest middle
    { kind: "open", eyebrow: "Still sitting there", text: "You said you wanted to call your brother. You haven’t yet." },
    // 5 · a pattern, in his own words
    { kind: "pattern", eyebrow: "Something you keep saying", phrase: "“steady”", said: "Four times this month." },
    // 6 · forward
    {
      kind: "forward",
      text: "You’re not who you were in August.",
      sub: "There’s a note here you wrote to yourself on the 14th. It isn’t time yet.",
    },
  ],
};
