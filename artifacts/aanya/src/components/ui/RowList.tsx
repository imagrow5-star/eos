import { useCallback, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── RowList / Row — the app-wide compact list pattern ───────────────────────
// One bordered group (bg-card, rounded corners) whose items are tight,
// scannable rows divided by hairlines: small height, one-line truncated
// title, quiet right-aligned meta, chevron when expandable. Tap a row to
// expand fuller detail in place; tap again to collapse. Replaces the old
// one-big-card-per-item pattern so many items fit on screen at once, and is
// shared by Journey (wins, commitments), Memory (feelings, reflections) and
// Chapters (past chapters) so the whole app scans the same way.

// ─── DisclosureSection — a whole section behind its headline ─────────────────
// One more layer above RowList: the section renders as JUST its headline
// (plus a quiet count and chevron) and nothing else until tapped. Tap the
// headline to reveal the content (typically a RowList whose rows then expand
// individually); tap again to put it away. Keeps long pages scannable —
// headlines first, lists on demand.
export function DisclosureSection({
  title,
  count,
  children,
  defaultOpen = false,
  className,
}: {
  /** Section headline — styled like the page's h2s. */
  title: string;
  /** Quiet item count shown beside the headline. */
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn("space-y-4", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 text-left cursor-pointer group focus-visible:outline-none"
      >
        <h2 className="font-serif text-xl text-foreground/85 group-hover:text-foreground transition-colors">
          {title}
        </h2>
        {typeof count === "number" && count > 0 && (
          <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground/55 tabular-nums mt-1">
            {count}
          </span>
        )}
        <ChevronDown
          className={cn(
            "w-4 h-4 shrink-0 text-foreground/30 group-hover:text-foreground/50 transition-transform duration-200 mt-1",
            open && "rotate-180",
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export function RowList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card border border-primary/15 rounded-2xl divide-y divide-border/60 overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface RowProps {
  /** Small leading icon, optional. */
  icon?: React.ReactNode;
  /** One-line title; truncated while collapsed. */
  title: React.ReactNode;
  /** Quiet right-aligned meta (a date, a count). */
  meta?: React.ReactNode;
  /** Expanded detail — only what the collapsed row does NOT already show.
   *  The title un-truncates on open, so never repeat the title text here.
   *  When absent, the row still expands if (and only if) its title is
   *  actually truncated: opening reveals the full title, nothing else. */
  children?: React.ReactNode;
  /** Always-visible trailing controls (kept OUTSIDE the expand button so a
   *  Done/Delete tap never toggles the row). */
  actions?: React.ReactNode;
  /** Muted row for earlier/closed items. */
  dim?: boolean;
  defaultOpen?: boolean;
  /** Fires on expand/collapse — lets callers lazy-load detail on open. */
  onOpenChange?: (open: boolean) => void;
}

export function Row({
  icon,
  title,
  meta,
  children,
  actions,
  dim = false,
  defaultOpen = false,
  onOpenChange,
}: RowProps) {
  const [open, setOpen] = useState(defaultOpen);

  // A row with no detail children is still worth a tap when its one-line
  // title is cut off — opening un-truncates it. Measure actual overflow so
  // short titles stay static (no chevron promising nothing).
  // Callback ref, not useEffect: flipping static↔expandable swaps the header's
  // parent (div↔button), which REMOUNTS the title span — an effect-scoped
  // observer would keep watching the detached old span, whose final 0×0
  // ResizeObserver callback un-set the flag again (rows stuck static). The
  // callback ref re-attaches to each new span; isConnected guards the
  // detached element's parting callback. `open` keeps an open row
  // collapsible while its title is temporarily un-truncated (measures 0).
  const [titleClipped, setTitleClipped] = useState(false);
  const titleObserver = useRef<ResizeObserver | null>(null);
  const titleRef = useCallback((el: HTMLSpanElement | null) => {
    titleObserver.current?.disconnect();
    titleObserver.current = null;
    if (!el) return;
    const check = () => {
      if (!el.isConnected) return;
      if (el.scrollWidth > el.clientWidth + 1) setTitleClipped(true);
      else if (el.classList.contains("truncate")) setTitleClipped(false);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    titleObserver.current = ro;
  }, []);

  const hasDetail = children != null;
  const expandable = hasDetail || titleClipped || open;

  const header = (
    <>
      {icon && <span className="shrink-0 flex items-center">{icon}</span>}
      <span
        ref={titleRef}
        className={cn(
          "flex-1 min-w-0 text-[13.5px] leading-snug text-foreground/85",
          !open && "truncate",
        )}
      >
        {title}
      </span>
      {meta && (
        <span className="shrink-0 text-[10.5px] uppercase tracking-wider text-muted-foreground/55 tabular-nums">
          {meta}
        </span>
      )}
      {expandable && (
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 shrink-0 text-foreground/30 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      )}
    </>
  );

  return (
    <div className={cn(dim && "opacity-60")}>
      <div className="flex items-center">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => {
              const next = !open;
              setOpen(next);
              onOpenChange?.(next);
            }}
            className="flex-1 min-w-0 flex items-center gap-2.5 px-4 py-2.5 text-left cursor-pointer transition-colors hover:bg-primary/5 active:bg-primary/10 focus-visible:outline-none focus-visible:bg-primary/8"
          >
            {header}
          </button>
        ) : (
          <div className="flex-1 min-w-0 flex items-center gap-2.5 px-4 py-2.5">{header}</div>
        )}
        {actions && <div className="flex items-center gap-1 pr-3 shrink-0">{actions}</div>}
      </div>
      <AnimatePresence initial={false}>
        {hasDetail && open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3.5 pt-0.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
