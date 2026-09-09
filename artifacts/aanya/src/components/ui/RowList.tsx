import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronRight } from "lucide-react";
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
  preview,
  children,
  defaultOpen = false,
  small = false,
  className,
  openRequest,
}: {
  /** Section headline — styled like the page's h2s (or quiet uppercase
   *  labels with `small`). ReactNode so callers can interpolate names. */
  title: React.ReactNode;
  /** Quiet item count shown beside the headline. */
  count?: number;
  /** One quiet line under the headline while the section is CLOSED —
   *  typically the most recent entry (see DisclosurePreview), so a closed
   *  page still has content without being a wall. Hidden once open: the
   *  content itself shows the entry then. */
  preview?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** Bump this number to open the section from outside (a marker tap, say)
   *  and scroll it into view. */
  openRequest?: number;
  /** Sub-section variant: the small uppercase group label (e.g. the fact
   *  categories inside "Things … knows") instead of a full h2. */
  small?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!openRequest) return;
    setOpen(true);
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openRequest]);
  return (
    <section ref={sectionRef} className={cn(small ? "space-y-3" : "space-y-4", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "w-full text-left cursor-pointer group focus-visible:outline-none",
          small && "pl-1",
        )}
      >
        <div className={cn("flex items-center", small ? "gap-2" : "gap-2.5")}>
        {small ? (
          <h3 className="text-[9px] uppercase tracking-[0.25em] text-primary-strong/60 group-hover:text-primary-strong transition-colors">
            {title}
          </h3>
        ) : (
          <h2 className="font-serif text-xl text-foreground/85 group-hover:text-foreground transition-colors">
            {title}
          </h2>
        )}
        {typeof count === "number" && count > 0 && (
          <span
            className={cn(
              "uppercase tracking-wider text-muted-foreground/55 tabular-nums",
              small ? "text-[9px]" : "text-[10.5px] mt-1",
            )}
          >
            {count}
          </span>
        )}
        <ChevronDown
          className={cn(
            "shrink-0 text-foreground/30 group-hover:text-foreground/50 transition-transform duration-200",
            small ? "w-3 h-3" : "w-4 h-4 mt-1",
            open && "rotate-180",
          )}
        />
        </div>
        <AnimatePresence initial={false}>
          {preview != null && !open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className={small ? "pt-1.5" : "pt-2.5"}>{preview}</div>
            </motion.div>
          )}
        </AnimatePresence>
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
            {/* Restores the vertical rhythm the old static <section>'s
                space-y gave multi-element section bodies. */}
            <div className={small ? "space-y-3" : "space-y-4"}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

// ─── DisclosurePreview — the latest entry peeking out of a closed section ────
// Styled like a Row header (same size, icon slot and quiet meta) so the
// preview reads as the first row of the list the headline is hiding.
export function DisclosurePreview({
  icon,
  text,
  meta,
}: {
  icon?: React.ReactNode;
  text: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-2.5 min-w-0">
      {icon && <span className="shrink-0 flex items-center">{icon}</span>}
      <span className="flex-1 min-w-0 truncate text-[13.5px] leading-snug text-foreground/60 group-hover:text-foreground/75 transition-colors">
        {text}
      </span>
      {meta && (
        <span className="shrink-0 text-[10.5px] uppercase tracking-wider text-muted-foreground/55 tabular-nums">
          {meta}
        </span>
      )}
    </span>
  );
}

// ─── LinkRow — a quiet row that opens a dedicated screen ─────────────────────
// Title, a quiet count, the most recent entry as a one-line preview, and a
// right chevron: the same shape as a Row, but a tap navigates instead of
// expanding in place. Used by Memory's category rows.
export function LinkRow({
  title,
  count,
  preview,
  icon,
  onClick,
}: {
  title: React.ReactNode;
  count?: number;
  preview?: React.ReactNode;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors hover:bg-primary/5 active:bg-primary/10 focus-visible:outline-none focus-visible:bg-primary/8"
    >
      {icon && <span className="shrink-0 flex items-center">{icon}</span>}
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-[15px] leading-snug text-foreground/90 font-serif">{title}</span>
          {typeof count === "number" && count > 0 && (
            <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground/55 tabular-nums mt-0.5">{count}</span>
          )}
        </span>
        {preview && (
          <span className="block mt-1 text-[13.5px] leading-snug text-foreground/60 truncate">{preview}</span>
        )}
      </span>
      <ChevronRight className="w-4 h-4 shrink-0 text-foreground/30" />
    </button>
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
