import { Feather } from "lucide-react";
import { WeeklyChapterSection } from "@/components/chapters/WeeklyChapterSection";

// ─── Chapters — the weekly letters Eos writes from the user's own words ──────
// Deliberately its own top-level tab (not inside Journey): Journey stays
// focused on goals/habits/commitments; this page is the quiet reading room.

export default function Chapters() {
  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-8">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide mb-3">Chapters</h1>
        <div className="h-px bg-primary/20 mb-4" />
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/25 bg-primary/8 text-[10px] font-medium tracking-[0.2em] uppercase text-secondary/80">
          <Feather className="w-3 h-3 text-primary-strong/70" />
          Letters from our weeks
        </div>
      </div>

      <WeeklyChapterSection />
    </div>
  );
}
