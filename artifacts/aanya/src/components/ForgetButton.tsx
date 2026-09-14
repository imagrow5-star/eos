import { useState } from "react";
import { X } from "lucide-react";

/**
 * The two-tap forget, as one control: an × that arms into "forget?", which
 * deletes on the second tap. Same shape as the facts screen's forget so
 * every memory list on the app forgets the same way. Disarms itself when
 * the row's Edit mode closes (the parent unmounts it).
 */
export function ForgetButton({
  label,
  onConfirm,
}: {
  /** What the aria-label names, e.g. the row's text. */
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (armed) {
    return (
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setArmed(false);
          }
        }}
        disabled={busy}
        className="h-11 px-2 inline-flex items-center text-[11px] uppercase tracking-[0.15em] text-amber-700 dark:text-amber-400/90 font-sans transition-colors disabled:opacity-50"
      >
        {busy ? "…" : "forget?"}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Forget "${label}"`}
      onClick={() => setArmed(true)}
      className="w-11 h-11 flex items-center justify-center rounded-full text-foreground/40 hover:text-foreground/80 transition-colors"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  );
}

/** The quiet Edit / Done toggle the lists share. */
export function EditToggle({ editing, onToggle }: { editing: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="h-9 px-2 text-[13px] text-muted-foreground hover:text-foreground font-serif"
    >
      {editing ? "Done" : "Edit"}
    </button>
  );
}
