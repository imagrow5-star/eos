import { useState } from "react";
import { motion } from "framer-motion";
import { apiFetch } from "@/lib/api";
import { CONSENT_VERSION } from "@/lib/consent";

/**
 * Consent screen (Phase A privacy).
 *
 * Shown once, full-screen, in two situations:
 *   • a brand-new user right after email verification — BEFORE any personal
 *     questions are asked, and
 *   • an existing user whose recorded consentVersion is older than the
 *     current copy (or who never had one) — a single, calm acknowledgement.
 *
 * Consent is unbundled from the terms of use: this screen only covers how
 * their words are handled, in plain language, with a link to the full page.
 */
export function ConsentGate({
  isReturningUser,
  onDone,
}: {
  isReturningUser: boolean;
  onDone: () => void | Promise<void>;
}) {
  const [sharingOptIn, setSharingOptIn] = useState(false); // default OFF, always
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agree = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/profile/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: CONSENT_VERSION, dataSharingOptIn: sharingOptIn }),
      });
      if (!r.ok) throw new Error("consent failed");
      // Wait for the parent to re-read the profile; the parent unmounts this
      // gate (or shows its own error UI) once the refetch settles.
      await onDone();
    } catch {
      setError("That didn't save — please try again.");
      setBusy(false);
    }
  };

  const points: Array<{ title: string; body: string }> = [
    {
      title: "What you share stays yours",
      body: "Your conversations, memories, and notes are stored securely so Eos can remember you between visits. They exist for you — there is no dashboard where anyone browses them.",
    },
    {
      title: "Two helpers make Eos work",
      body: "Anthropic provides the thinking and ElevenLabs provides the voice. Your words pass through them to generate each reply — that's the only reason, and they don't use your words to train their models.",
    },
    {
      title: "You can always take it back",
      body: "Export everything, delete a single message or memory, or delete your whole account — anytime, in Settings. Deleting is real deletion, not hiding.",
    },
    {
      title: "Eos is an AI, not a person",
      body: "Eos is an AI companion, here to listen anytime, but it isn't a person or a substitute for professional help. If things ever feel like an emergency, it will always point you to real people who can help right away.",
    },
  ];

  return (
    <div className="min-h-[100dvh] bg-background flex items-center justify-center px-5 py-10 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <div className="bg-card border border-primary/20 rounded-3xl p-7 sm:p-8 space-y-6">
          <div className="space-y-2.5">
            <h1 className="font-serif text-[26px] text-foreground/90 tracking-wide">
              {isReturningUser ? "One small thing" : "Before we begin"}
            </h1>
            <div className="h-px bg-primary/20" />
            <p className="text-[13.5px] text-muted-foreground/80 leading-relaxed">
              {isReturningUser
                ? "We've written down, in plain words, how Eos treats what you share. It takes a minute to read — and then we'll pick up right where you left off."
                : "Eos is a private space. Here is exactly how your words are treated — in plain language, before you share anything."}
            </p>
          </div>

          <div className="space-y-4">
            {points.map((p) => (
              <div key={p.title} className="flex gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-primary/70 mt-2 shrink-0" />
                <div>
                  <p className="text-[13.5px] text-foreground/85 font-medium">{p.title}</p>
                  <p className="text-[12.5px] text-muted-foreground/70 leading-relaxed mt-0.5">
                    {p.body}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <a
            href={`${import.meta.env.BASE_URL}privacy`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-[12px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
          >
            Read the full privacy page →
          </a>

          {/* Future data-sharing placeholder — nothing shares today; default OFF */}
          <div className="flex items-start justify-between gap-3 border-t border-primary/10 pt-5">
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] text-foreground/70">
                Share anonymized insights in the future
              </p>
              <p className="text-[11px] text-muted-foreground/50 mt-0.5 leading-relaxed">
                Nothing is shared today. If that ever changes, it will only apply if this is on —
                and you can flip it anytime.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={sharingOptIn}
              aria-label="Future data sharing"
              onClick={() => setSharingOptIn((v) => !v)}
              className={
                "relative w-11 h-6 rounded-full border transition-all shrink-0 " +
                (sharingOptIn
                  ? "bg-primary/40 border-primary/60"
                  : "bg-background/60 border-primary/25")
              }
            >
              <span
                className={
                  "absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform duration-200 " +
                  (sharingOptIn ? "translate-x-5 bg-primary" : "translate-x-0 bg-foreground/30")
                }
              />
            </button>
          </div>

          {error && <p className="text-[12px] text-amber-700 dark:text-amber-400/80">{error}</p>}

          <button
            onClick={agree}
            disabled={busy}
            className="w-full py-3.5 rounded-2xl bg-primary/20 border border-primary/50 text-primary-strong font-medium text-[14px] tracking-wide hover:bg-primary/30 transition-all disabled:opacity-50"
          >
            {busy ? "Saving…" : "I understand — continue"}
          </button>

          <p className="text-[10.5px] text-muted-foreground/40 text-center leading-relaxed">
            Consent version {CONSENT_VERSION} · You can re-read this anytime on the privacy page.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
