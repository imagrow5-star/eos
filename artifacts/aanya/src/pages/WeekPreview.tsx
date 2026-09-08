/**
 * Stage 1 preview — unlinked route (/week/preview) so the story can be tapped
 * through on a real phone before any marker exists on Journey. Hardcoded
 * prototype content; nothing here is generated from conversations.
 */

import { useCallback, useState } from "react";
import { WeekStory } from "@/components/week/WeekStory";
import { PROTOTYPE_STORY } from "@/components/week/prototypeStory";

export default function WeekPreview() {
  const [open, setOpen] = useState(true);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20">
      <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">Preview</p>
      <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide">Your week</h1>
      <p className="text-sm text-muted-foreground/70 mt-2 leading-relaxed max-w-prose">
        Prototype content, hardcoded. Nothing on this screen is generated from your conversations yet.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-6 h-11 px-5 rounded-full bg-primary/15 border border-primary/25 text-primary-strong text-sm font-medium"
      >
        Open the story
      </button>

      {open && <WeekStory story={PROTOTYPE_STORY} onClose={close} />}
    </div>
  );
}
