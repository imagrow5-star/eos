/**
 * Weekly review — the six card renderers.
 *
 * Type scale, spacing and colour are the prototype's (eos-week-v2.html),
 * carried over as exact pixel values; the story's own tokens (--wk-*) are
 * defined in index.css, light from the prototype and dark from the app's
 * night palette. Nothing here decides content — see types.ts.
 */

import type { WeekCard as WeekCardData } from "./types";

// leading-[normal]: the prototype leaves these at the font's natural line
// height; without it they'd inherit the app's 1.5 and sit 3–4px off.
const EYEBROW = "text-[13px] leading-[normal] text-[var(--wk-muted)] mb-[18px]";

export function WeekCard({ card }: { card: WeekCardData }) {
  switch (card.kind) {
    case "moment":
      return (
        <>
          <div className={EYEBROW}>{card.eyebrow}</div>
          <div className="text-[35px] leading-[1.22] tracking-[-0.02em]">{card.text}</div>
        </>
      );

    case "did":
    case "open":
      return (
        <>
          <div className={EYEBROW}>{card.eyebrow}</div>
          <div className="text-[26px] leading-[1.35]">{card.text}</div>
        </>
      );

    case "thenNow":
      // The older quote above at reduced weight, a hairline, the recent quote
      // below at full weight. Two stamps. No interpretation line — by design,
      // the type has no field for one.
      return (
        <>
          <div className={EYEBROW}>{card.eyebrow}</div>
          <div>
            <div className="text-[18.5px] leading-[1.45] italic text-[var(--wk-ink-40)] pb-[20px]">
              <span className="block not-italic text-[12px] text-[var(--wk-muted)] mb-[7px]">{card.then.stamp}</span>
              {card.then.quote}
            </div>
            <div className="text-[23px] leading-[1.4] italic pt-[20px] border-t border-[var(--wk-ink-14)]">
              <span className="block not-italic text-[12px] text-[var(--wk-muted)] mb-[7px]">{card.now.stamp}</span>
              {card.now.quote}
            </div>
          </div>
        </>
      );

    case "pattern":
      return (
        <>
          <div className={EYEBROW}>{card.eyebrow}</div>
          <div className="text-[29px] leading-[1.35] italic">{card.phrase}</div>
          <div className="mt-[20px] text-[14px] leading-[normal] text-[var(--wk-muted)]">{card.said}</div>
        </>
      );

    case "forward":
      return (
        <>
          <div aria-hidden="true" className="week-glow pointer-events-none absolute -right-[70px] -bottom-[70px] w-[290px] h-[290px] rounded-full" />
          <div className="text-[31px] leading-[1.28]">{card.text}</div>
          {card.sub && (
            <div className="mt-[16px] text-[15px] leading-[1.6] text-[var(--wk-muted)]">{card.sub}</div>
          )}
        </>
      );
  }
}
