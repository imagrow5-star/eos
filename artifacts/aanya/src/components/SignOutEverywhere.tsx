import { useState } from "react";
import { apiFetch } from "@/lib/api";

/**
 * "Sign out everywhere": revokes every other session of this account and
 * keeps this one. For a shared computer left signed in, or the worry that a
 * cookie was taken.
 */
export function SignOutEverywhere({ compact }: { compact?: boolean }) {
  const [status, setStatus] = useState<"idle" | "working" | "done">("idle");
  const [signedOut, setSignedOut] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setStatus("working");
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/logout-all`, { method: "POST" });
      const data = (await r.json().catch(() => ({}))) as { error?: string; signedOut?: number };
      if (!r.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setStatus("idle");
        return;
      }
      setSignedOut(data.signedOut ?? 0);
      setStatus("done");
    } catch {
      setError("Network error. Please check your connection and try again.");
      setStatus("idle");
    }
  };

  const small = compact ? "text-[12px]" : "text-sm";
  if (status === "done") {
    return (
      <p className={"text-emerald-700 dark:text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-4 py-3 leading-relaxed " + small}>
        {signedOut === 0
          ? "No other devices were signed in. This one stays signed in."
          : `${signedOut === 1 ? "One other device was" : `${signedOut} other devices were`} signed out. This one stays signed in.`}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className={"text-foreground/70 leading-relaxed " + (compact ? "text-[13px]" : "text-sm")}>
          Signed in somewhere you don't recognise, or left a shared computer open?
        </p>
        <button
          type="button"
          onClick={run}
          disabled={status === "working"}
          className="shrink-0 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors disabled:opacity-50"
        >
          {status === "working" ? "Working…" : "Sign out everywhere else"}
        </button>
      </div>
      {error && <p className={"text-red-700 dark:text-red-400 " + small}>{error}</p>}
    </div>
  );
}
