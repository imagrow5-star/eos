import { useEffect, useState } from "react";
import { useGetProfile, useGetMemoryFacts, useGetPersonalitySignals, getGetMemoryFactsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Sparkles, X, Star, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

export default function Memory() {
  const { data: profile } = useGetProfile();
  const { data: facts = [] } = useGetMemoryFacts();
  const { data: signals = [] } = useGetPersonalitySignals();
  const queryClient = useQueryClient();

  // "Forget this" (Phase A privacy) — first tap arms, second tap deletes.
  const [armedFactId, setArmedFactId] = useState<number | null>(null);
  const [busyFactId, setBusyFactId] = useState<number | null>(null);

  // "Remember this" star (Sprint 2B) — optimistic toggle; the promise is she
  // holds it, so there's no dialog and no "saved!" chirp. On failure we revert
  // the star and surface one small, quiet line (the app's inline-notice pattern).
  const [starError, setStarError] = useState<string | null>(null);
  const toggleImportant = async (fact: (typeof facts)[number]) => {
    const key = getGetMemoryFactsQueryKey();
    const next = !fact.userMarkedImportant;
    const prev = queryClient.getQueryData<typeof facts>(key);
    // Optimistic: flip the star now.
    queryClient.setQueryData<typeof facts>(key, (old) =>
      (old ?? []).map((f) => (f.id === fact.id ? { ...f, userMarkedImportant: next } : f)),
    );
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/memory/facts/${fact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userMarkedImportant: next }),
      });
      if (!r.ok) throw new Error("patch failed");
    } catch {
      queryClient.setQueryData(key, prev); // revert the star
      setStarError("Couldn't save that, try again");
      window.setTimeout(() => setStarError(null), 2500);
    }
  };
  const forgetFact = async (id: number) => {
    setBusyFactId(id);
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/memory/facts/${id}`, {
        method: "DELETE",
      });
      if (r.ok) {
        await queryClient.invalidateQueries({ queryKey: getGetMemoryFactsQueryKey() });
      }
    } finally {
      setBusyFactId(null);
      setArmedFactId(null);
    }
  };

  // ── "Reset my memory (dev)" — founder-gated (Sprint: dedup & reset) ─────────
  // The button only renders for allowlisted accounts; eligibility is decided
  // server-side (MEMORY_RESET_ALLOWLIST) and fetched once on load.
  const [resetEligible, setResetEligible] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`${import.meta.env.BASE_URL}api/memory/reset-eligible`);
        if (!r.ok) return;
        const data = (await r.json()) as { eligible?: boolean };
        if (!cancelled) setResetEligible(data.eligible === true);
      } catch {
        /* not eligible / offline — leave the button hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleResetMemory = async () => {
    setResetBusy(true);
    setResetError(null);
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/memory/reset`, { method: "POST" });
      if (!r.ok) {
        setResetError(
          r.status === 429
            ? "You just reset — give it a moment before trying again."
            : "Couldn't reset your memory — please try again.",
        );
        setResetBusy(false);
        return;
      }
      // Wiped — reload so every memory view reflects the empty state.
      window.location.reload();
    } catch {
      setResetError("Couldn't reset your memory — please try again.");
      setResetBusy(false);
    }
  };

  const companionName = profile?.companionName || "Eos";

  const categories = [
    { id: "preference", label: "Preferences" },
    { id: "person", label: "People" },
    { id: "event", label: "Moments" },
    { id: "goal", label: "Hopes" },
    { id: "life", label: "Life" },
  ];

  const hasNoData = facts.length === 0 && signals.length === 0;

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-12">
      {/* Quiet inline notice — only when a star toggle failed to save. */}
      {starError && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-card border border-primary/20 rounded-full px-4 py-2 text-xs text-foreground/80 shadow-lg">
          {starError}
        </div>
      )}
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide">
          What {companionName} remembers
        </h1>
        <div className="h-px bg-primary/20" />
        <p className="text-sm text-muted-foreground/70 font-serif italic">
          The pieces of you she holds.
        </p>
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {hasNoData ? (
        <div className="bg-card border border-primary/15 rounded-2xl p-10 text-center flex flex-col items-center gap-5">
          <div className="w-11 h-11 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary/50" />
          </div>
          <p className="text-sm text-muted-foreground font-serif italic max-w-[220px] leading-relaxed">
            {companionName} is still getting to know you. The more you share, the more she'll hold.
          </p>
        </div>
      ) : (
        <>
          {/* ── Personality read — hidden until Sprint 4 ─────────────────── */}
          {/* Hidden until Sprint 4 (Personality Synthesis) — raw personality signals aren't useful UX;
              they're the substrate that gets synthesized into durable traits. Data continues to
              extract + store + dedupe in the background. */}
          {/* Soft placeholder in the section's old slot, so existing users who saw
              "Her read on you" yesterday get a gentle transition rather than a
              vanished section. */}
          <section className="space-y-4">
            <p className="text-sm text-muted-foreground/70 font-serif italic leading-relaxed max-w-md">
              {companionName} is still learning who you are. As she gets to know you
              deeper, this section will show what she's understood.
            </p>
          </section>

          {/* Gold hairline */}
          {facts.length > 0 && (
            <div className="h-px bg-primary/15" />
          )}

          {/* ── Things she knows ─────────────────────────────────────────── */}
          {facts.length > 0 && (
            <section className="space-y-6 pb-4">
              <h2 className="font-serif text-xl text-foreground/85">
                Things she knows
              </h2>

              <div className="space-y-8">
                {categories.map((category) => {
                  const categoryFacts = facts.filter(
                    (f) => f.category === category.id
                  );
                  if (categoryFacts.length === 0) return null;

                  return (
                    <div key={category.id} className="space-y-3">
                      <h3 className="text-[9px] uppercase tracking-[0.25em] text-primary/60 pl-1">
                        {category.label}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {categoryFacts.map((fact) => (
                          <span
                            key={fact.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-card border border-primary/15 rounded-full text-[13px] text-foreground/75 font-serif"
                          >
                            <button
                              aria-label={
                                fact.userMarkedImportant
                                  ? `Unmark "${fact.fact}" as important`
                                  : `Mark "${fact.fact}" as important`
                              }
                              aria-pressed={fact.userMarkedImportant}
                              onClick={() => toggleImportant(fact)}
                              className="shrink-0 transition-colors"
                            >
                              <Star
                                className={cn(
                                  "w-3.5 h-3.5 transition-colors",
                                  fact.userMarkedImportant
                                    ? "text-primary fill-primary"
                                    : "text-foreground/25 hover:text-primary/60",
                                )}
                              />
                            </button>
                            {fact.fact}
                            {armedFactId === fact.id ? (
                              <button
                                onClick={() => forgetFact(fact.id)}
                                disabled={busyFactId === fact.id}
                                className="text-[9px] uppercase tracking-[0.15em] text-amber-400/90 hover:text-amber-300 font-sans transition-colors disabled:opacity-50"
                              >
                                {busyFactId === fact.id ? "…" : "forget?"}
                              </button>
                            ) : (
                              <button
                                aria-label={`Forget "${fact.fact}"`}
                                onClick={() => setArmedFactId(fact.id)}
                                className="opacity-35 hover:opacity-90 transition-opacity"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}

      {/* ── Reset my memory (dev, founder-gated) ───────────────────────────── */}
      {resetEligible && (
        <div className="pt-6 border-t border-destructive/10">
          <button
            onClick={() => { setResetError(null); setResetConfirmOpen(true); }}
            className="flex items-center gap-2 text-[11px] text-muted-foreground/50 hover:text-destructive/80 tracking-wider uppercase transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Reset my memory (dev)
          </button>
        </div>
      )}

      {resetConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6">
          <div className="bg-card border border-primary/20 rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-xl">
            <h2 className="font-serif text-[19px] text-foreground/90">Reset your memory?</h2>
            <p className="text-[13px] text-muted-foreground/85 leading-relaxed">
              This will delete all your memory facts, habits, goals, commitments, and
              mood scores. Your conversations and chapters are kept. Are you sure?
            </p>
            {resetError && <p className="text-[12px] text-destructive/80">{resetError}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setResetConfirmOpen(false)}
                disabled={resetBusy}
                className="text-[12px] text-muted-foreground/60 hover:text-foreground/80 px-3 py-2 tracking-wider uppercase transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleResetMemory}
                disabled={resetBusy}
                className="flex items-center gap-1.5 text-[12px] text-destructive tracking-wider uppercase font-medium rounded-lg border border-destructive/25 bg-destructive/10 hover:bg-destructive/20 px-3 py-2 transition-colors disabled:opacity-40"
              >
                {resetBusy ? (
                  <motion.div
                    className="w-3 h-3 border border-destructive/60 border-t-transparent rounded-full"
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                  />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5" />
                )}
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
