import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { PasswordInput } from "@/components/PasswordInput";

interface Props {
  /** Rendered compact (smaller text) for the settings panel. */
  compact?: boolean;
}

/**
 * Lets a signed-in person change their password. The server needs the current
 * password, applies the signup policy (8 characters to 72 bytes, not in a
 * known breach), and signs out every OTHER device — this browser stays in.
 */
export function ChangePasswordForm({ compact }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [signedOut, setSignedOut] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!current) {
      setError("Please enter your current password.");
      return;
    }
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    setStatus("saving");
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; signedOut?: number };
      if (!r.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setStatus("idle");
        return;
      }
      setSignedOut(data.signedOut ?? 0);
      setStatus("done");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch {
      setError("Network error. Please check your connection and try again.");
      setStatus("idle");
    }
  };

  if (status === "done") {
    return (
      <p
        className={
          "text-emerald-700 dark:text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-4 py-3 leading-relaxed " +
          (compact ? "text-[12px]" : "text-sm")
        }
      >
        Password changed.
        {signedOut > 0
          ? ` ${signedOut === 1 ? "One other device was" : `${signedOut} other devices were`} signed out.`
          : " No other devices were signed in."}
      </p>
    );
  }

  const inputCls =
    "w-full bg-background/60 border border-primary/20 rounded-xl px-4 py-2.5 text-foreground/85 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors " +
    (compact ? "text-[13px]" : "text-sm");
  const busy = status === "saving";

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5 text-left">
      <PasswordInput
        autoComplete="current-password"
        value={current}
        onChange={(e) => { setCurrent(e.target.value); setError(null); }}
        placeholder="Current password"
        className={inputCls}
        disabled={busy}
      />
      <PasswordInput
        autoComplete="new-password"
        value={next}
        onChange={(e) => { setNext(e.target.value); setError(null); }}
        placeholder="New password"
        className={inputCls}
        disabled={busy}
      />
      <PasswordInput
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => { setConfirm(e.target.value); setError(null); }}
        placeholder="Repeat new password"
        className={inputCls}
        disabled={busy}
      />
      {error && (
        <p className={"text-red-700 dark:text-red-400 " + (compact ? "text-[12px]" : "text-sm")}>{error}</p>
      )}
      <p className={"text-muted-foreground/50 leading-relaxed " + (compact ? "text-[11px]" : "text-xs")}>
        Other devices will be signed out. If you sign in with Google and never set a password, use
        "Forgot password" on the sign-in screen first.
      </p>
      <button
        type="submit"
        disabled={busy}
        className={
          "w-full bg-primary/15 text-primary-strong border border-primary/25 rounded-xl font-medium tracking-wide hover:bg-primary/25 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed " +
          (compact ? "py-2.5 text-[13px]" : "py-3")
        }
      >
        {busy ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
