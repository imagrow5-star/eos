import { useEffect, useState } from "react";
import { RowList, LinkRow } from "@/components/ui/RowList";
import { useGetProfile, useGetMemoryFacts, useGetPersonalitySignals } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Sparkles, RotateCcw } from "lucide-react";
import { useLocation } from "wouter";
import { groupFacts, FEELINGS_ROW } from "@/lib/memoryCategories";
import { useFeelings } from "@/lib/useFeelings";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import ReflectionsSection from "@/components/ReflectionsSection";

export default function Memory() {
  const { data: profile } = useGetProfile();
  const { data: facts = [] } = useGetMemoryFacts();
  const { data: signals = [] } = useGetPersonalitySignals();
  const [, navigate] = useLocation();

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
            ? "You just reset. Give it a moment before trying again."
            : "Couldn't reset your memory. Please try again.",
        );
        setResetBusy(false);
        return;
      }
      // Wiped — reload so every memory view reflects the empty state.
      window.location.reload();
    } catch {
      setResetError("Couldn't reset your memory. Please try again.");
      setResetBusy(false);
    }
  };

  const { data: feelings = [] } = useFeelings();

  const companionName = profile?.companionName || "Eos";

  // One row per category, each with its count and its most recent entry.
  // The five categories extraction files but the old page never showed
  // (interest, routine, work, value, soother) fold into the nearest row, or
  // stand alone once there are enough of them — see lib/memoryCategories.
  const rows = groupFacts(facts);

  const hasNoData = facts.length === 0 && signals.length === 0 && feelings.length === 0;

  // ── "When we met" — the promise ("it remembers you") kept from minute one.
  // On day one the memory lists are empty, but the person already told us who
  // they are and why they came. Reflect that back, honestly framed as what
  // they SAID at the start (not inferred from conversation), so the page shows
  // something being held instead of only "still getting to know you". Built
  // from the onboarding profile fields; always present as the origin of the
  // record. The companion-name line shows only if they actually chose one
  // (setup is deferred now, so most day-one users keep the default).
  const pathLine: Record<string, string> = {
    breakup: "You came here going through a breakup.",
    bereavement: "You came here after losing someone.",
    lonely: "You came here feeling lonely.",
    support: "You came here looking for support.",
  };
  const metLines: string[] = [];
  // The name line is the ORIGIN record: the name they gave when we met, held
  // even after a rename in Settings (originalUserName is captured once and
  // never overwritten; null only for profiles that haven't been captured yet,
  // which fall back to the live name). A rename adds one honest line beneath,
  // so the card reads as a record rather than a stale bug.
  const originalName = profile?.originalUserName || profile?.userName;
  if (originalName) metLines.push(`You told me your name is ${originalName}.`);
  if (originalName && profile?.userName && profile.userName !== originalName) {
    metLines.push(`You go by ${profile.userName} now.`);
  }
  if (profile?.userPath && pathLine[profile.userPath]) metLines.push(pathLine[profile.userPath]!);
  if (profile?.companionName && profile.companionName !== "Eos") {
    metLines.push(`You chose to call me ${profile.companionName}.`);
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-12">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide">
          What {companionName} remembers
        </h1>
        <div className="h-px bg-primary/20" />
        <p className="text-sm text-muted-foreground/70 font-serif italic">
          The pieces of you it holds.
        </p>
      </div>

      {/* ── When we met — the onboarding facts, held from day one ──────────── */}
      {metLines.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-serif text-[19px] text-foreground/85">When we met</h2>
          <div className="bg-card border border-primary/15 rounded-2xl p-6 space-y-2.5">
            {metLines.map((line, i) => (
              <p key={i} className="flex gap-2.5 text-sm text-muted-foreground/90 leading-relaxed">
                <span className="text-primary-strong/50 select-none">·</span>
                <span>{line}</span>
              </p>
            ))}
            <p className="pt-1.5 text-xs text-muted-foreground/50 italic">
              The start of what {companionName} holds. It grows as you talk.
            </p>
          </div>
        </div>
      )}

      {/* ── Reflections — first thing on the page, above memories/feelings ──── */}
      <ReflectionsSection />

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {hasNoData ? (
        <div className="bg-card border border-primary/15 rounded-2xl p-10 text-center flex flex-col items-center gap-5">
          <div className="w-11 h-11 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary-strong/50" />
          </div>
          <p className="text-sm text-muted-foreground font-serif italic max-w-[240px] leading-relaxed">
            Beyond what you told me at the start, there's nothing here yet. The more you share, the more {companionName} holds.
          </p>
        </div>
      ) : (
        // ── The categories — one quiet row each, tap to open its screen ────
        // No heading count: the rows carry their own. No "still learning"
        // line: the facts below it said otherwise.
        <div className="space-y-4">
          <h2 className="font-serif text-xl text-foreground/85">Things {companionName} knows</h2>
          <RowList>
            {rows.map((row) => (
              <LinkRow
                key={row.id}
                title={row.label}
                count={row.count}
                preview={row.preview ?? undefined}
                onClick={() => navigate(`/memory/${row.id}`)}
              />
            ))}
            {feelings.length > 0 && (
              <LinkRow
                title={FEELINGS_ROW.label}
                count={feelings.length}
                preview={feelings[0]?.feeling}
                onClick={() => navigate(`/memory/${FEELINGS_ROW.id}`)}
              />
            )}
          </RowList>
        </div>
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
