/**
 * Preview — unlinked route (/week/preview) so the story shell and the two
 * marker states can be checked on a real phone, on any account, without
 * waiting for a story to be generated. Hardcoded prototype content; nothing
 * here is generated from conversations.
 */

import { useCallback, useState } from "react";
import { WeekStory } from "@/components/week/WeekStory";
import { PROTOTYPE_STORY } from "@/components/week/prototypeStory";

export default function WeekPreview() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20">
      <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">Preview</p>
      <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide">Your week</h1>
      <p className="text-sm text-muted-foreground/70 mt-2 leading-relaxed max-w-prose">
        Prototype content, hardcoded. Nothing on this screen is generated from your conversations.
      </p>

      {/* The two marker states side by side: unviewed (ring) and viewed (outline). */}
      <div className="week-markers -mx-6 px-6 pt-8 pb-7" role="group" aria-label="Marker states">
        <button type="button" className="week-marker is-new" onClick={() => setOpen(true)} aria-label="Unviewed marker">
          <span className="week-disc is-new"><em>“she just said finally”</em></span>
          <span>Unviewed</span>
        </button>
        <button type="button" className="week-marker" onClick={() => setOpen(true)} aria-label="Viewed marker">
          <span className="week-disc is-seen"><em>“the flat is too quiet”</em></span>
          <span>Viewed</span>
        </button>
        <button type="button" className="week-marker" onClick={() => setOpen(true)} aria-label="Viewed goal marker">
          <span className="week-disc is-seen"><em>Goals</em></span>
          <span>Goals</span>
        </button>
      </div>
      <div className="week-rule" />

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-6 h-11 px-5 rounded-full bg-primary/15 border border-primary/25 text-primary-strong text-sm font-medium"
      >
        Open the story
      </button>
      <p className="text-[12px] text-muted-foreground/60 mt-3 leading-relaxed max-w-prose">
        In the story: tap the right side to go forward, the left edge to go back, and touch and hold anywhere to pause.
      </p>

      {open && <WeekStory story={PROTOTYPE_STORY} onClose={close} />}
    </div>
  );
}
