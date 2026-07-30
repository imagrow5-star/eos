import { motion } from "framer-motion";
import { HeartHandshake, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Crisis helpline card ────────────────────────────────────────────────────
// Renders the helpline block the crisis floor appended to a reply — visually
// distinct from Eos's own words, in the app's warm cream/gold palette (soft
// and steady, never alarming red). Dismissible per-instance via the small ×;
// a future crisis turn shows a fresh card.

interface CrisisHelplineCardProps {
  /** Full block text (marker line, "- name — number — hours" lines, closing line). */
  blockText: string;
  onDismiss: () => void;
  dismissing?: boolean;
  className?: string;
}

export default function CrisisHelplineCard({
  blockText,
  onDismiss,
  dismissing,
  className,
}: CrisisHelplineCardProps) {
  const lines = blockText.split("\n");
  // Shape: "—", title line, one or more "- …" resource lines, closing line.
  const resourceLines = lines.filter((l) => l.startsWith("- "));
  const titleLine = lines.find((l) => l.startsWith("Someone who")) ?? lines[1] ?? "";
  const closingLine = lines[lines.length - 1] ?? "";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={cn(
        "relative bg-card border border-primary/25 rounded-2xl px-5 py-4 mt-2 shadow-[0_0_18px_hsl(35_49%_57%/0.10)]",
        className,
      )}
    >
      <button
        aria-label="Dismiss these resources"
        onClick={onDismiss}
        disabled={dismissing}
        className="absolute top-2.5 right-2.5 w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground/80 hover:bg-primary/10 transition-colors disabled:opacity-50"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="flex items-center gap-2 mb-2.5 pr-7">
        <HeartHandshake className="w-4 h-4 text-primary/70 shrink-0" />
        <p className="text-[13px] text-foreground/85 font-serif leading-snug">{titleLine}</p>
      </div>

      <ul className="space-y-1.5 mb-2.5">
        {resourceLines.map((l) => (
          <li key={l} className="text-[13px] leading-relaxed text-foreground/80 pl-1">
            {l.slice(2)}
          </li>
        ))}
      </ul>

      <p className="text-[12.5px] text-muted-foreground/70 font-serif italic">{closingLine}</p>
    </motion.div>
  );
}
