import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { PasswordInput } from "@/components/PasswordInput";

interface Props {
  /** The account's current email address, shown for context. */
  currentEmail: string;
  /** Optional: rendered compact (smaller text) for the settings panel. */
  compact?: boolean;
}

/**
 * Lets an authenticated user request a change to a new email address.
 * A confirmation link is sent to the *new* address; the current address stays
 * active until the user clicks that link. Works for both verified users
 * (settings) and users still stuck on an unverified/mistyped address (the gate).
 */
export function ChangeEmailForm({ currentEmail, compact }: Props) {
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = newEmail.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (!password) {
      setError("Please enter your current password.");
      return;
    }

    setStatus("sending");
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/change-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail: trimmed, password }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError((data as any)?.error ?? "Something went wrong. Please try again.");
        setStatus("idle");
        return;
      }
      const data = await r.json().catch(() => ({}));
      setPendingEmail((data as any)?.pendingEmail ?? trimmed);
      setStatus("sent");
      setNewEmail("");
      setPassword("");
    } catch {
      setError("Network error. Please check your connection and try again.");
      setStatus("idle");
    }
  };

  if (status === "sent") {
    return (
      <p
        className={
          "text-emerald-700 dark:text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-4 py-3 leading-relaxed " +
          (compact ? "text-[12px]" : "text-sm")
        }
      >
        Confirmation link sent to <span className="font-medium break-all">{pendingEmail}</span>.
        Click it to finish switching. Your current address stays active until then.
      </p>
    );
  }

  const inputCls =
    "w-full bg-background/60 border border-primary/20 rounded-xl px-4 py-2.5 text-foreground/85 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors " +
    (compact ? "text-[13px]" : "text-sm");

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5 text-left">
      <p className={"text-muted-foreground/60 " + (compact ? "text-[11px]" : "text-xs")}>
        Currently <span className="text-foreground/70 break-all">{currentEmail}</span>
      </p>
      <input
        type="email"
        autoComplete="email"
        value={newEmail}
        onChange={(e) => { setNewEmail(e.target.value); setError(null); }}
        placeholder="New email address"
        className={inputCls}
        disabled={status === "sending"}
      />
      <PasswordInput
        autoComplete="current-password"
        value={password}
        onChange={(e) => { setPassword(e.target.value); setError(null); }}
        placeholder="Current password"
        className={inputCls}
        disabled={status === "sending"}
      />
      {error && (
        <p className={"text-red-700 dark:text-red-400 " + (compact ? "text-[12px]" : "text-sm")}>{error}</p>
      )}
      <button
        type="submit"
        disabled={status === "sending"}
        className={
          "w-full bg-primary/15 text-primary-strong border border-primary/25 rounded-xl font-medium tracking-wide hover:bg-primary/25 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed " +
          (compact ? "py-2.5 text-[13px]" : "py-3")
        }
      >
        {status === "sending" ? "Sending…" : "Send confirmation link"}
      </button>
    </form>
  );
}
