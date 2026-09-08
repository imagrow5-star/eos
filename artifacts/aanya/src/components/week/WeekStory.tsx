/**
 * Weekly review — the full-screen story shell.
 *
 * One card per screen. Tap right to advance, tap left (the left 28%) to go
 * back, tap and hold to pause. Progress bars across the top, one per card,
 * each a real 7s timer: when it completes the story advances — except on the
 * last card, which waits for a tap. Close top right (44px hit area). Escape
 * and the arrow keys on desktop. Platform back (the app-wide edge swipe,
 * Android back, browser back) closes it, via the same history-entry pattern
 * the Settings panel uses, so "back" never leaves Journey by surprise.
 *
 * Each card rises 13px and fades in, nothing more (a fade alone under
 * prefers-reduced-motion). Nothing renders after the last card.
 *
 * All decisions are in storyMachine.ts (pure, unit-tested); this file wires
 * them to the DOM.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { WeekStory as WeekStoryData } from "./types";
import { CARD_DURATION_MS } from "./types";
import {
  barState,
  createStoryState,
  HOLD_THRESHOLD_MS,
  resolveRelease,
  storyReducer,
  zoneForX,
} from "./storyMachine";
import { WeekCard } from "./WeekCard";

interface Props {
  story: WeekStoryData;
  /** Called once when the story ends (forward on the last card, Close,
   *  Escape, or platform back). The parent unmounts the shell. */
  onClose: () => void;
}

export function WeekStory({ story, onClose }: Props) {
  const [s, dispatch] = useReducer(storyReducer, story.cards.length, createStoryState);

  // The machine decided the story is over → tell the parent exactly once.
  const closedRef = useRef(false);
  useEffect(() => {
    if (s.closed && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [s.closed, onClose]);

  // Platform back closes the story instead of leaving the page: push one
  // history entry on open; a popstate (edge swipe, Android back, browser
  // back) closes; closing any other way pops our own entry so history stays
  // clean. Same pattern as the Chat Settings panel.
  useEffect(() => {
    try {
      window.history.pushState({ eosWeekStory: true }, "", window.location.href);
    } catch { /* history unavailable — Close still works */ }
    const onPop = () => dispatch({ type: "close" });
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      try {
        if ((window.history.state as { eosWeekStory?: boolean } | null)?.eosWeekStory) {
          window.history.back();
        }
      } catch { /* no-op */ }
    };
  }, []);

  // Desktop keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") dispatch({ type: "next" });
      else if (e.key === "ArrowLeft") dispatch({ type: "prev" });
      else if (e.key === "Escape") dispatch({ type: "close" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Tap vs hold ─────────────────────────────────────────────────────────
  // A press that lasts past HOLD_THRESHOLD_MS pauses the timer; its release
  // only resumes (never navigates). A shorter press is a tap: back zone or
  // forward. Pointer events cover touch and mouse alike; touch-action:none
  // on the stage stops the browser from turning a hold into a scroll or a
  // text selection.
  const stageRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<number | null>(null);
  const heldRef = useRef(false);

  const clearHoldTimer = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    heldRef.current = false;
    clearHoldTimer();
    holdTimer.current = window.setTimeout(() => {
      heldRef.current = true;
      dispatch({ type: "holdStart" });
    }, HOLD_THRESHOLD_MS);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    clearHoldTimer();
    const rect = stageRef.current?.getBoundingClientRect();
    const zone = rect ? zoneForX(e.clientX - rect.left, rect.width) : "forward";
    const action = resolveRelease(heldRef.current, zone);
    heldRef.current = false;
    dispatch(action);
  }, []);

  const onPointerCancel = useCallback(() => {
    clearHoldTimer();
    if (heldRef.current) {
      heldRef.current = false;
      dispatch({ type: "holdEnd" });
    }
  }, []);

  useEffect(() => clearHoldTimer, []);

  const card = story.cards[s.index];
  if (!card) return null;

  // Portal to <body>: pages render inside Shell's <main>, which is
  // `relative z-10` and therefore its own stacking context — a fixed z-50
  // overlay INSIDE it still paints beneath the bottom nav (z-20 in the parent
  // context). Rendering at the body level is the only way to be truly on top.
  return createPortal(
    // Phones: the story IS the screen. From md up (tablet, desktop) a
    // full-bleed story would set 35px type across a 1372px measure — one
    // unreadable line — so it becomes the prototype's own desktop
    // presentation: a centred 390×820 panel (capped to the viewport), 38px
    // radius, on the prototype's #1a1714 backdrop. The backdrop is inert:
    // taps outside the panel do nothing; Escape and Close still close.
    <div className="fixed inset-0 z-50 flex items-center justify-center md:bg-[#1a1714]">
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Your week"
      className="week-story relative flex flex-col w-full h-full md:w-[390px] md:h-[min(820px,calc(100dvh-48px))] md:rounded-[38px] md:overflow-hidden md:shadow-[0_40px_90px_rgba(0,0,0,.5)] font-serif font-normal select-none pb-safe"
      style={{ WebkitTouchCallout: "none" }}
    >
      {/* Progress — one bar per card. The live bar's fill IS the timer. */}
      <div aria-hidden="true" className="flex gap-[4px] pt-[14px] px-[16px]">
        {story.cards.map((_, i) => {
          const st = barState(i, s.index);
          return (
            <div key={i} className="flex-1 h-[2px] rounded-[2px] bg-[var(--wk-ink-13)] overflow-hidden">
              <span
                // Re-keyed per run so going back to a seen card restarts its fill.
                key={st === "live" ? s.run : st}
                className={cn(
                  "block h-full w-0 bg-[var(--wk-ink)]",
                  st === "done" && "week-bar-done",
                  st === "live" && "week-bar-live",
                )}
                style={
                  st === "live"
                    ? { animationDuration: `${CARD_DURATION_MS}ms`, animationPlayState: s.paused ? "paused" : "running" }
                    : undefined
                }
                onAnimationEnd={st === "live" ? () => dispatch({ type: "timerDone" }) : undefined}
              />
            </div>
          );
        })}
      </div>

      {/* Close — reads as the prototype's quiet 15px label, but the hit area is
          44px (the prototype's 20px was sloppy, not a decision). */}
      <button
        type="button"
        onClick={() => dispatch({ type: "close" })}
        aria-label="Close"
        // Box offsets chosen so the LABEL lands where the prototype's does
        // (top 32px, right 20px) with the 44px box centred on it.
        className="absolute top-[18px] right-[15px] z-[6] w-11 h-11 flex items-center justify-center text-[15px] leading-[normal] text-[var(--wk-ink-40)] bg-transparent border-0 font-serif cursor-pointer"
      >
        Close
      </button>

      {/* Stage: the card, vertically centred, and the tap/hold surface over it. */}
      <div
        ref={stageRef}
        className="relative flex-1 min-h-0"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerCancel}
      >
        <div key={s.index} className="week-slide absolute inset-0 px-[34px] flex flex-col justify-center overflow-hidden">
          <WeekCard card={card} />
        </div>
      </div>
    </div>
    </div>,
    document.body,
  );
}
