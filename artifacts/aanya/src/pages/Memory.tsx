import { useState } from "react";
import { useGetProfile, useGetMemoryFacts, useGetPersonalitySignals, getGetMemoryFactsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Sparkles, BookOpen, Check, Eye, X } from "lucide-react";
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

  const companionName = profile?.companionName || "Asha";

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
          {/* ── Her read on you ─────────────────────────────────────────── */}
          {signals.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-2.5 mb-5">
                <BookOpen className="w-4 h-4 text-primary/60" />
                <h2 className="font-serif text-xl text-foreground/85">
                  Her read on you
                </h2>
              </div>

              <div className="grid gap-3">
                {signals.map((signal, i) => (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.08 }}
                    key={signal.id}
                    className="bg-card border border-primary/15 rounded-xl p-4 flex flex-col gap-3"
                  >
                    <p className="text-sm text-foreground/85 leading-relaxed">
                      {signal.signal}
                    </p>

                    <div className="flex items-center justify-between">
                      <span
                        className={cn(
                          "text-[9px] uppercase tracking-[0.2em] flex items-center gap-1.5 font-medium",
                          signal.isActive
                            ? "text-primary/80"
                            : "text-muted-foreground/70"
                        )}
                      >
                        {signal.isActive ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Eye className="w-3 h-3" />
                        )}
                        {signal.isActive ? "Confirmed" : "Observing"}
                      </span>

                      {/* Confidence dots — gold fill */}
                      <div className="flex gap-1.5">
                        {[1, 2, 3].map((dot) => (
                          <div
                            key={dot}
                            className={cn(
                              "w-1.5 h-1.5 rounded-full transition-all",
                              dot <= signal.observedCount
                                ? signal.isActive
                                  ? "bg-primary/70"
                                  : "bg-secondary/40"
                                : "bg-foreground/8"
                            )}
                          />
                        ))}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </section>
          )}

          {/* Gold hairline */}
          {signals.length > 0 && facts.length > 0 && (
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
    </div>
  );
}
