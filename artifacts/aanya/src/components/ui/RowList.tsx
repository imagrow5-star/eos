import { useState } from "react";
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
  /** Expanded detail. When absent the row is static (no chevron, no tap). */
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
  const expandable = children != null;

  const header = (
    <>
      {icon && <span className="shrink-0 flex items-center">{icon}</span>}
      <span
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
        {expandable && open && (
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
