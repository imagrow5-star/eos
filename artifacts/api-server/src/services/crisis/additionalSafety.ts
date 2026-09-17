/**
 * Additional safety floors beyond the suicide/self-harm crisis detector:
 *   • harm to others — a stated intent to hurt another person;
 *   • self-endangerment that isn't suicide — eating-disorder behaviour and
 *     substance misuse.
 *
 * Like the crisis floor, a conservative regex runs on the user's message and,
 * on a hit, a reinforcement block is appended to THAT turn's systemExtra
 * (never persisted, never cached into the stable prefix). Unlike the crisis
 * floor, nothing is recorded (no event row) and no resource card is appended —
 * the reinforcement points to help in words. The crisis (suicide/self-harm)
 * check runs first and independently; a message can trip both.
 *
 * Deliberately tight: both detectors require an unambiguous construction, so
 * hyperbole ("this deadline is killing me", "I could kill for a coffee") does
 * not fire. What the regex misses falls through to the always-on safety lines
 * in the base prompt — over-firing a reinforcement is worse than relying on
 * the floor, so these stay narrow.
 */

// ─── Harm to others ──────────────────────────────────────────────────────────
// An intent marker AND a violent verb aimed at a person (not "myself") must
// both be present. Either alone is not enough.
const HARM_INTENT = /\b(i(?:['’ ]?m| am)? (?:going to|gonna|about to)|i (?:want|'?d like|plan|intend) to|i(?:['’ ]?ll| will))\b/i;
const HARM_TARGET =
  /\b(kill|hurt|stab|shoot|beat|strangle|attack|murder|jump|smash|hit)\s+(him|her|them|his|their|my (?:ex|boss|dad|father|mother|mum|mom|brother|sister|wife|husband|partner|neighbou?r|coworker|colleague|roommate|flatmate)|everyone|people|somebody|someone)\b/i;

export function detectHarmToOthers(text: string): boolean {
  const t = text ?? "";
  if (/\bmyself\b/i.test(t) && !HARM_TARGET.test(t)) return false;
  return HARM_INTENT.test(t) && HARM_TARGET.test(t);
}

// ─── Self-endangerment (not suicide) ─────────────────────────────────────────
const EATING_DISORDER =
  /\b(mak(?:e|ing|es) (?:myself|meself) (?:throw up|sick|vomit)|made (?:myself|meself) (?:throw up|sick|vomit)|purg(?:e|ed|ing)|binge(?:d|ing)?|starv(?:e|ing) myself|restrict(?:ing)? (?:what i eat|my (?:food|eating|calories|intake))|haven'?t eaten (?:in|for) \w+ (?:days?|weeks?))\b/i;
const SUBSTANCE_MISUSE =
  /\b(can'?t stop (?:drinking|using|taking)|drinking (?:to (?:cope|forget|numb)|myself to)|using again|relapsed|high to (?:cope|forget|numb)|took (?:a bunch|too many) (?:pills|of))\b/i;

export function detectSelfEndangerment(text: string): boolean {
  const t = text ?? "";
  return EATING_DISORDER.test(t) || SUBSTANCE_MISUSE.test(t);
}

// ─── Reinforcement blocks (approved copy) ────────────────────────────────────
export const HARM_TO_OTHERS_REINFORCEMENT = `
THEY'VE TALKED ABOUT HURTING SOMEONE ELSE — FOR THIS REPLY:
- Take it seriously; don't laugh it off and don't match the heat.
- Don't help plan anything and don't ask for the details of a plan.
- Stay with the feeling under it — rage, humiliation, helplessness — and name it, because that's usually what actually needs air.
- Pull gently toward the brakes: stepping away, telling someone, not doing the thing they'd never undo.
- If it sounds immediate and specific — a real person, a means, a plan — be honest that when someone's in danger the fastest help is emergency services, and encourage that.
- Never give instructions, never rehearse it with them.`.trim();

export const SELF_ENDANGERMENT_REINFORCEMENT = `
THEY'VE DESCRIBED HURTING THEMSELVES THROUGH FOOD, DRINK, OR DRUGS — FOR THIS REPLY:
- Receive it without flinching and without judgment.
- Never give or ask for numbers, amounts, weights, or "how long," and never frame any of it as impressive, disciplined, or a good idea.
- Stay with what it's doing FOR them — the control, the numbness, the quiet — before anything else.
- When the moment is calm, name gently that this is the kind of thing that deserves someone trained, and that wanting that help isn't failure.
- Don't diagnose it, don't set them a recovery task, don't rush them.`.trim();

/**
 * The additional-safety reinforcement for a turn: whichever of the two floors
 * the message trips, joined; "" when neither. Callers append it to
 * systemExtra. Voice and text share one block (no resource card is referenced,
 * so there is no voice variant to keep apart).
 */
export function additionalSafetyReinforcement(userMessage: string): string {
  const blocks: string[] = [];
  if (detectHarmToOthers(userMessage)) blocks.push(HARM_TO_OTHERS_REINFORCEMENT);
  if (detectSelfEndangerment(userMessage)) blocks.push(SELF_ENDANGERMENT_REINFORCEMENT);
  return blocks.join("\n");
}
