import { Feather } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Example chapter (cold start only) ────────────────────────────────────────
// The weekly chapter is the strongest idea in the product, but a new user can't
// see one for weeks — so the Chapters tab used to greet them with nothing but a
// "not ready yet" note. This renders a REAL-LOOKING sample so a newcomer
// understands what Chapters is before they've earned theirs. It is purely
// presentational: unmistakably labelled as an example, and completely inert
// (deliberately NOT built on ChapterReader / QuoteBlock / OfferCard, whose
// dismiss / accept / seal buttons carry live mutations — an example must never
// fire one). The small visual duplication is the price of that safety.

/** One then/now quote, styled like the real QuoteBlock but static (no dismiss). */
function ExampleQuote({ when, text, dimmed }: { when: string; text: string; dimmed?: boolean }) {
  return (
    <div className="pl-4 border-l border-primary/25">
      <div className="text-[9px] uppercase tracking-[0.2em] text-primary-strong/60 mb-1">{when}</div>
      <p
        className={cn(
          "font-serif text-[15px] leading-relaxed italic",
          dimmed ? "text-foreground/55" : "text-foreground/85",
        )}
      >
        “{text}”
      </p>
    </div>
  );
}

export function ExampleChapter() {
  return (
    <section aria-label="An example chapter" className="space-y-3">
      {/* Label — can never be mistaken for the reader's own letter. */}
      <div className="space-y-2">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-secondary/40 bg-secondary/8 text-[9px] font-medium tracking-[0.22em] uppercase text-secondary/80">
          Example
        </span>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          This is the kind of letter Eos writes you — every Sunday, from your own words. The lines
          below are a sample, not from your conversations.
        </p>
      </div>

      {/* The sample letter — styled like a real revealed chapter, set apart by a
          secondary-tinted frame. */}
      <div className="bg-card border border-secondary/25 rounded-2xl p-6 space-y-8">
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Feather className="w-3.5 h-3.5 text-primary-strong/70" />
            <span className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">An example week</span>
          </div>
          <p className="font-serif text-[17px] leading-relaxed text-foreground/90">
            You started the week saying you were fine, and ended it admitting you weren't. That
            honesty, with yourself, is the whole thing.
          </p>
        </div>

        <div className="space-y-8">
          <div className="h-px bg-primary/12" />

          {/* Theme — On the evenings */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">On the evenings</span>
            </div>
            <div className="space-y-4">
              <ExampleQuote when="Earlier" text="The evenings are the hardest. The flat is too quiet." dimmed />
              <ExampleQuote when="This week" text="I put music on tonight before it got dark. Small, but it helped." />
            </div>
            <p className="font-serif text-[15px] leading-relaxed text-foreground/75">
              You found a way to meet the quiet instead of bracing against it. That isn't small.
            </p>
          </div>

          {/* Theme — On reaching out (still true) */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">On reaching out</span>
              <span className="text-[9px] px-2 py-0.5 rounded-full border border-primary/25 text-primary-strong/70 tracking-wide">
                still true
              </span>
            </div>
            <div className="space-y-4">
              <ExampleQuote when="Earlier" text="I don't want to be a burden to anyone." dimmed />
              <ExampleQuote when="This week" text="I texted my sister back. She just said 'finally.'" />
            </div>
            <p className="font-serif text-[15px] leading-relaxed text-foreground/75">
              The story that you're a burden keeps getting quieter. The evidence keeps disagreeing
              with it.
            </p>
          </div>

          <div className="h-px bg-primary/12" />
          <p className="font-serif text-[15px] leading-relaxed text-foreground/80">
            Nothing here is a score. It's just you, seen clearly, one week at a time.
          </p>
        </div>
      </div>

      {/* Rituals teaser — static, never a button. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground/70 px-1">
        Real chapters also hand back the promises you made — and let you seal a note to a future
        you, kept sealed until Eos hands it back weeks later.
      </p>
    </section>
  );
}
