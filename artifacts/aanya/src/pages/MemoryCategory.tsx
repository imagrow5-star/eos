/**
 * Memory — one category's dedicated screen (/memory/:category).
 *
 * A back chevron, the category's name and count, then quiet rows: one fact
 * per row, newest first, un-truncating on tap. A starred fact carries a
 * small star glyph and nothing else. One "Edit" affordance, top right,
 * reveals the star toggle and the two-tap forget on every row; "Done" puts
 * them away. The feelings screen is read-only (no API to star or forget a
 * feeling), so it has no Edit.
 */

import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Star, X } from "lucide-react";
import { useGetMemoryFacts, getGetMemoryFactsQueryKey } from "@workspace/api-client-react";
import { RowList, Row } from "@/components/ui/RowList";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { factsForCategory, categoryLabel, FEELINGS_ROW } from "@/lib/memoryCategories";
import { useFeelings } from "@/lib/useFeelings";

export default function MemoryCategory() {
  const { category = "" } = useParams<{ category: string }>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { data: facts = [], isLoading: factsLoading } = useGetMemoryFacts();
  const { data: feelings = [], isLoading: feelingsLoading } = useFeelings();

  const isFeelings = category === FEELINGS_ROW.id;
  const label = categoryLabel(category);
  const row = isFeelings ? null : factsForCategory(facts, category);
  const loading = isFeelings ? feelingsLoading : factsLoading;

  const [editing, setEditing] = useState(false);
  const [armedFactId, setArmedFactId] = useState<number | null>(null);
  const [busyFactId, setBusyFactId] = useState<number | null>(null);
  const [starError, setStarError] = useState<string | null>(null);

  const back = () => navigate("/memory");

  // "Remember this" star — optimistic toggle; on failure revert and say so once.
  const toggleImportant = async (fact: (typeof facts)[number]) => {
    const key = getGetMemoryFactsQueryKey();
    const next = !fact.userMarkedImportant;
    const prev = queryClient.getQueryData<typeof facts>(key);
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
      queryClient.setQueryData(key, prev);
      setStarError("Couldn't save that, try again");
      window.setTimeout(() => setStarError(null), 2500);
    }
  };

  // "Forget this" — first tap arms, second tap deletes.
  const forgetFact = async (id: number) => {
    setBusyFactId(id);
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/memory/facts/${id}`, { method: "DELETE" });
      if (r.ok) await queryClient.invalidateQueries({ queryKey: getGetMemoryFactsQueryKey() });
    } finally {
      setBusyFactId(null);
      setArmedFactId(null);
    }
  };

  const count = isFeelings ? feelings.length : row?.count ?? 0;

  return (
    <div className="h-full overflow-y-auto px-6 py-6 pb-20 space-y-6">
      {starError && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-card border border-primary/20 rounded-full px-4 py-2 text-xs text-foreground/80 shadow-lg">
          {starError}
        </div>
      )}

      {/* ── Header: back, title + count, Edit ─────────────────────────────── */}
      <div className="flex items-center gap-1 -ml-3">
        <button
          type="button"
          onClick={back}
          aria-label="Back to Memory"
          className="w-11 h-11 flex items-center justify-center rounded-full text-foreground/60 hover:text-foreground"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          <h1 className="font-serif text-[24px] text-foreground/90 tracking-wide truncate">{label ?? "Memory"}</h1>
          {count > 0 && (
            <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground/55 tabular-nums">{count}</span>
          )}
        </div>
        {!isFeelings && count > 0 && (
          <button
            type="button"
            onClick={() => {
              setEditing((v) => !v);
              setArmedFactId(null);
            }}
            className="h-11 px-3 text-[13px] text-muted-foreground hover:text-foreground font-serif"
          >
            {editing ? "Done" : "Edit"}
          </button>
        )}
      </div>

      {/* ── The list ──────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="h-20 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full border border-primary/40 border-t-transparent animate-spin" />
        </div>
      ) : label == null ? (
        <p className="text-sm text-muted-foreground font-serif italic px-1">There's no such category.</p>
      ) : count === 0 ? (
        <p className="text-sm text-muted-foreground font-serif italic px-1">Nothing here yet.</p>
      ) : isFeelings ? (
        // The feeling sentence carries the emotion in the user's own frame —
        // no category tag. Long ones tap open to un-truncate; short ones are
        // static (Row handles it).
        <RowList>
          {feelings.map((f) => (
            <Row key={f.id} title={f.feeling} />
          ))}
        </RowList>
      ) : (
        <RowList>
          {row!.facts.map((fact) => (
            <Row
              key={fact.id}
              title={fact.fact}
              icon={
                fact.userMarkedImportant && !editing ? (
                  <Star className="w-3.5 h-3.5 text-primary-strong fill-primary" aria-label="Marked important" />
                ) : undefined
              }
              actions={
                editing ? (
                  <>
                    <button
                      type="button"
                      aria-label={fact.userMarkedImportant ? `Unmark "${fact.fact}" as important` : `Mark "${fact.fact}" as important`}
                      aria-pressed={fact.userMarkedImportant}
                      onClick={() => toggleImportant(fact)}
                      className="w-11 h-11 flex items-center justify-center rounded-full transition-colors"
                    >
                      <Star
                        className={cn(
                          "w-3.5 h-3.5 transition-colors",
                          fact.userMarkedImportant ? "text-primary-strong fill-primary" : "text-foreground/30 hover:text-primary-strong/60",
                        )}
                      />
                    </button>
                    {armedFactId === fact.id ? (
                      <button
                        type="button"
                        onClick={() => forgetFact(fact.id)}
                        disabled={busyFactId === fact.id}
                        className="h-11 px-2 inline-flex items-center text-[11px] uppercase tracking-[0.15em] text-amber-700 dark:text-amber-400/90 font-sans transition-colors disabled:opacity-50"
                      >
                        {busyFactId === fact.id ? "…" : "forget?"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Forget "${fact.fact}"`}
                        onClick={() => setArmedFactId(fact.id)}
                        className="w-11 h-11 flex items-center justify-center rounded-full text-foreground/40 hover:text-foreground/80 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                ) : undefined
              }
            />
          ))}
        </RowList>
      )}
    </div>
  );
}
