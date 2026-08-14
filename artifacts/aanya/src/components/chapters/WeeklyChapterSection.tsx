import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { format, parseISO } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Feather, X, ChevronDown, ChevronUp } from "lucide-react";
import { getGetJourneyQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Types (mirror api-server routes/chapters.ts jsonb shapes) ────────────────

interface ChapterQuote {
  messageId: number;
  text: string;
  date: string; // YYYY-MM-DD
  kind: "then" | "now";
}

interface ChapterTheme {
  key: string;
  title: string;
  kind: "standard" | "social-expectation";
  stillTrue: boolean;
  quotes: ChapterQuote[];
  reflection: string;
  eraNote?: string;
}

interface ReviewItem {
  refKind: "goal" | "habit";
  refId: number;
  title: string;
  verdict: "working" | "wobbly" | "resting";
  text: string;
}

interface MicroOffer {
  seedMessageId: number;
  seedQuote: string;
  seedDate: string;
  text: string;
  goalTitle: string;
  goalDescription: string;
  status: "pending" | "accepted" | "declined";
}

interface NoteInvite {
  prompt: string;
}

interface SealResolutionShape {
  noteId: number;
  noteKind: string;
  notePrompt: string | null;
  noteText: string | null; // null for crisis-flagged notes — never quoted back
  crisisFlagged: boolean;
  text: string;
}

interface WorkingThroughEntryShape {
  weekLabel: string;
  text: string;
  verbatim: boolean;
  date?: string;
}

interface WorkingThroughShape {
  label: string;
  entries: WorkingThroughEntryShape[];
  reflection: string;
}

interface Chapter {
  id: number;
  weekStart: string;
  weekEnd: string;
  status: "ready" | "revealed";
  threadOpening: string;
  thresholdQuestion: string;
  thresholdAnswer: string | null;
  thresholdSkipped: boolean;
  themes: ChapterTheme[];
  goalReview: { items: ReviewItem[] } | null;
  microOffer: MicroOffer | null;
  noteInvite: NoteInvite | null;
  sealResolution: SealResolutionShape | null;
  workingThrough: WorkingThroughShape | null;
  noteSealed?: boolean;
  generatedAt: string;
  revealedAt: string | null;
}

interface ArchiveEntry {
  id: number;
  weekStart: string;
  weekEnd: string;
  status: string;
  generatedAt: string;
  revealedAt: string | null;
}

interface ChaptersResponse {
  coldStart: boolean;
  weeksTogether: number;
  unread: boolean;
  current: Chapter | null;
  archive: ArchiveEntry[];
}

const base = () => `${import.meta.env.BASE_URL}api/chapters`;

// ─── Small pieces ─────────────────────────────────────────────────────────────

function weekLabel(weekStart: string, weekEnd: string): string {
  const s = parseISO(weekStart);
  const e = parseISO(weekEnd);
  const sameMonth = s.getMonth() === e.getMonth();
  return `${format(s, "MMMM d")} – ${format(e, sameMonth ? "d" : "MMMM d")}`;
}

/** One-tap 1–10 scale rendered as a row of dots. */
function DotScale({
  label,
  lowHint,
  highHint,
  value,
  onChange,
}: {
  label: string;
  lowHint: string;
  highHint: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="flex items-center justify-between gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${label}: ${n} of 10`}
            onClick={() => onChange(value === n ? null : n)}
            className={cn(
              "w-6 h-6 rounded-full border transition-all duration-200 flex-shrink-0",
              value !== null && n <= value
                ? "bg-primary/70 border-primary/70"
                : "bg-transparent border-primary/25 hover:border-primary/50",
            )}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground/50 tracking-wide">
        <span>{lowHint}</span>
        <span>{highHint}</span>
      </div>
    </div>
  );
}

function QuoteBlock({
  quote,
  chapterId,
  dimmed,
}: {
  quote: ChapterQuote;
  chapterId: number;
  dimmed?: boolean;
}) {
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () =>
      apiFetch(`${base()}/${chapterId}/quotes/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: quote.messageId }),
      }).then((r) => {
        if (!r.ok) throw new Error("dismiss failed");
        return r.json();
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["chapters"] }),
  });

  return (
    <div className="group relative pl-4 border-l border-primary/25">
      <div className="text-[9px] uppercase tracking-[0.2em] text-primary-strong/60 mb-1">
        {format(parseISO(quote.date), "MMMM d")}
      </div>
      <p
        className={cn(
          "font-serif text-[15px] leading-relaxed italic",
          dimmed ? "text-foreground/55" : "text-foreground/85",
        )}
      >
        “{quote.text}”
      </p>
      <button
        type="button"
        onClick={() => dismiss.mutate()}
        disabled={dismiss.isPending}
        title="Never show me this line again"
        aria-label="Dismiss this quote permanently"
        className="absolute top-0 right-0 p-1 rounded-full text-foreground/20 hover:text-foreground/60 hover:bg-foreground/5 transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function ThemeBlock({ theme, chapterId }: { theme: ChapterTheme; chapterId: number }) {
  const then = theme.quotes.find((q) => q.kind === "then");
  const now = theme.quotes.find((q) => q.kind === "now");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">{theme.title}</span>
        {theme.stillTrue && (
          <span className="text-[9px] px-2 py-0.5 rounded-full border border-primary/25 text-primary-strong/70 tracking-wide">
            still true
          </span>
        )}
      </div>
      <div className="space-y-4">
        {then && <QuoteBlock quote={then} chapterId={chapterId} dimmed />}
        {now && <QuoteBlock quote={now} chapterId={chapterId} />}
      </div>
      <p className="font-serif text-[15px] leading-relaxed text-foreground/75">{theme.reflection}</p>
      {theme.eraNote && (
        <p className="font-serif text-[13px] leading-relaxed italic text-foreground/45">{theme.eraNote}</p>
      )}
    </div>
  );
}

const VERDICT_DOT: Record<ReviewItem["verdict"], string> = {
  working: "bg-primary/70",
  wobbly: "bg-primary/30",
  resting: "bg-transparent border border-primary/30",
};

function OfferCard({ offer, chapterId }: { offer: MicroOffer; chapterId: number }) {
  const queryClient = useQueryClient();
  const respond = useMutation({
    mutationFn: (action: "accept" | "decline") =>
      apiFetch(`${base()}/${chapterId}/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).then((r) => {
        if (!r.ok) throw new Error("offer response failed");
        return r.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chapters"] });
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      queryClient.invalidateQueries({ queryKey: getGetJourneyQueryKey() });
    },
  });

  if (offer.status === "accepted") {
    return (
      <div className="rounded-2xl border border-primary/30 bg-primary/8 p-5">
        <p className="font-serif text-[14px] leading-relaxed text-foreground/80">
          Added to your goals — I'll walk with you on it.
        </p>
      </div>
    );
  }
  if (offer.status === "declined") {
    return (
      <div className="rounded-2xl border border-primary/15 bg-card p-5">
        <p className="font-serif text-[14px] leading-relaxed text-foreground/60">
          Okay — not this week. That's a fine answer too.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 space-y-4">
      <div className="text-[10px] uppercase tracking-[0.22em] text-primary-strong/70">From your own words</div>
      <div className="pl-4 border-l border-primary/25">
        <div className="text-[9px] uppercase tracking-[0.2em] text-primary-strong/60 mb-1">
          {format(parseISO(offer.seedDate), "MMMM d")}
        </div>
        <p className="font-serif text-[15px] leading-relaxed italic text-foreground/85">“{offer.seedQuote}”</p>
      </div>
      <p className="font-serif text-[15px] leading-relaxed text-foreground/80">{offer.text}</p>
      <div className="flex gap-3 pt-1">
        <Button
          size="sm"
          disabled={respond.isPending}
          onClick={() => respond.mutate("accept")}
          className="rounded-full px-5"
        >
          I'll promise
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={respond.isPending}
          onClick={() => respond.mutate("decline")}
          className="rounded-full px-5 text-foreground/50"
        >
          Not this week
        </Button>
      </div>
    </div>
  );
}

// ─── Working it through — evolving story timeline ─────────────────────────────

function WorkingThroughBlock({ wt }: { wt: WorkingThroughShape }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">Working it through</span>
        <span className="text-[11px] tracking-wide text-foreground/45">{wt.label}</span>
      </div>
      <div className="space-y-4">
        {wt.entries.map((e, i) => (
          <div key={i} className="pl-4 border-l border-primary/25">
            <div className="text-[9px] uppercase tracking-[0.2em] text-primary-strong/60 mb-1">{e.weekLabel}</div>
            <p
              className={cn(
                "font-serif text-[15px] leading-relaxed",
                e.verbatim ? "italic text-foreground/85" : "text-foreground/65",
              )}
            >
              {e.verbatim ? <>“{e.text}”</> : e.text}
            </p>
          </div>
        ))}
      </div>
      <p className="font-serif text-[15px] leading-relaxed text-foreground/75">{wt.reflection}</p>
    </div>
  );
}

// ─── Sealed-note resolution — the seal-breaking ritual ────────────────────────

function SealResolutionCard({ chapterId, seal }: { chapterId: number; seal: SealResolutionShape }) {
  const queryClient = useQueryClient();
  const storageKey = `eos-seal-broken-${chapterId}`;
  const [broken, setBroken] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const [deferred, setDeferred] = useState(false);

  const defer = useMutation({
    mutationFn: () =>
      apiFetch(`${base()}/${chapterId}/seal/defer`, { method: "POST" }).then((r) => {
        if (!r.ok) throw new Error("could not defer");
        return r.json();
      }),
    onSuccess: () => {
      setDeferred(true);
      queryClient.invalidateQueries({ queryKey: ["chapters"] });
    },
  });

  const breakSeal = () => {
    setBroken(true);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* private mode — the ritual just won't persist across reloads */
    }
  };

  if (deferred) {
    return (
      <div className="rounded-2xl border border-primary/15 bg-card p-5">
        <p className="font-serif text-[14px] leading-relaxed text-foreground/60">
          Kept sealed. It'll be waiting in next week's chapter — there's no hurry at all.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-secondary/30 bg-primary/5 overflow-hidden">
      <AnimatePresence mode="wait">
        {!broken ? (
          <motion.div
            key="sealed"
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.3 }}
            className="p-6 text-center space-y-4"
          >
            <motion.div
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 2.4, repeat: Infinity, repeatDelay: 2 }}
              className="w-14 h-14 mx-auto rounded-full bg-gradient-to-br from-secondary/85 to-secondary/50 border border-secondary/60 shadow-[0_0_24px_hsl(var(--primary)/0.25)] flex items-center justify-center"
            >
              <Feather className="w-5 h-5 text-background/80" />
            </motion.div>
            <div>
              <p className="font-serif text-[16px] text-foreground/90">A note from a past you is waiting.</p>
              <p className="text-[11px] text-muted-foreground/60 mt-1 tracking-wide">
                You sealed it at the end of an earlier chapter.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-1 flex-wrap">
              <Button onClick={breakSeal} className="rounded-full px-6">
                Break the seal
              </Button>
              <Button
                variant="ghost"
                disabled={defer.isPending}
                onClick={() => defer.mutate()}
                className="rounded-full px-4 text-foreground/50"
              >
                Not yet — keep it sealed
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="open"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="p-6 space-y-4"
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">The note you sealed</div>
            {seal.notePrompt && !seal.crisisFlagged && (
              <p className="text-[12px] leading-relaxed italic text-foreground/50">{seal.notePrompt}</p>
            )}
            {seal.noteText && (
              <div className="pl-4 border-l border-secondary/40">
                <p className="font-serif text-[16px] leading-relaxed italic text-foreground/90">“{seal.noteText}”</p>
              </div>
            )}
            <p className="font-serif text-[15px] leading-relaxed text-foreground/80">{seal.text}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── End-of-chapter note invite — write & seal ────────────────────────────────

function NoteInviteCard({ chapterId, prompt }: { chapterId: number; prompt: string }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"prediction" | "free">("prediction");
  const [sealed, setSealed] = useState(false);
  const [care, setCare] = useState<{ message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sealNote = useMutation({
    mutationFn: () =>
      apiFetch(`${base()}/${chapterId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: mode, text: text.trim() }),
      }).then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { error?: string; care?: { message: string } | null };
        if (!r.ok) throw new Error(body?.error || "Could not seal your note — try again.");
        return body;
      }),
    onSuccess: (body) => {
      setSealed(true);
      setCare(body.care ?? null);
      queryClient.invalidateQueries({ queryKey: ["chapters"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (sealed) {
    return (
      <div className="rounded-2xl border border-secondary/35 bg-card p-6">
        {care ? (
          <p className="font-serif text-[15px] leading-relaxed text-foreground/85 whitespace-pre-line">{care.message}</p>
        ) : (
          <div className="text-center space-y-3">
            <motion.div
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 14 }}
              className="w-12 h-12 mx-auto rounded-full bg-gradient-to-br from-secondary/85 to-secondary/55 border border-secondary/60 shadow-[0_0_20px_hsl(var(--primary)/0.3)] flex items-center justify-center"
            >
              <Feather className="w-4 h-4 text-background/80" />
            </motion.div>
            <p className="font-serif text-[15px] text-foreground/85">Sealed. I'll hand it back in a future chapter.</p>
            <p className="text-[11px] text-muted-foreground/55 tracking-wide">Not even I will peek before then.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-primary/25 bg-card p-6 space-y-4">
      <div className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">
        Before you go — a note to a future you
      </div>
      <div className="flex gap-1.5">
        {(
          [
            ["prediction", "Answer the question"],
            ["free", "Write anything"],
          ] as const
        ).map(([val, label]) => (
          <button
            key={val}
            type="button"
            onClick={() => setMode(val)}
            className={cn(
              "px-3 py-1 rounded-full text-[10.5px] font-medium tracking-wide border transition-all",
              mode === val
                ? "bg-primary/20 border-primary/50 text-primary-strong"
                : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="font-serif text-[15px] leading-relaxed italic text-foreground/75">
        {mode === "prediction" ? prompt : "Anything you'd like a future you to open — one sentence is plenty."}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={280}
        placeholder="One honest sentence…"
        className="w-full rounded-xl bg-background/60 border border-primary/20 px-4 py-3 text-[14px] text-foreground/85 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/45 resize-none font-serif"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground/40 tracking-wide">{text.trim().length}/280</span>
        <Button
          size="sm"
          disabled={sealNote.isPending || text.trim().length < 3}
          onClick={() => {
            setError(null);
            sealNote.mutate();
          }}
          className="rounded-full px-6"
        >
          Seal it
        </Button>
      </div>
      {error && <p className="text-[11px] text-amber-700 dark:text-amber-400/80 leading-relaxed">{error}</p>}
      <p className="text-[10px] text-muted-foreground/45 leading-relaxed">
        It stays sealed — even from me — until I hand it back inside a future chapter.
      </p>
    </div>
  );
}

// ─── Threshold (sealed) state ─────────────────────────────────────────────────

function SealedChapter({ chapter }: { chapter: Chapter }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [mood, setMood] = useState<number | null>(null);
  const [loneliness, setLoneliness] = useState<number | null>(null);

  const open = useMutation({
    mutationFn: (skip: boolean) =>
      apiFetch(`${base()}/${chapter.id}/threshold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          skip
            ? { skip: true }
            : { answer: answer.trim() || undefined, mood: mood ?? undefined, loneliness: loneliness ?? undefined },
        ),
      }).then((r) => {
        if (!r.ok) throw new Error("could not open chapter");
        return r.json();
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["chapters"] }),
  });

  return (
    <div className="bg-card border border-primary/25 rounded-2xl p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-primary/15 border border-primary/40 flex items-center justify-center">
          <Feather className="w-4 h-4 text-primary-strong/80" />
        </div>
        <div>
          <div className="font-serif text-[18px] text-foreground/90">A new chapter is ready</div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-0.5">
            {weekLabel(chapter.weekStart, chapter.weekEnd)}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="font-serif text-[16px] leading-relaxed italic text-foreground/80">
          {chapter.thresholdQuestion}
        </p>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="A few words, if you feel like it…"
          className="w-full rounded-xl bg-background/60 border border-primary/20 px-4 py-3 text-[14px] text-foreground/85 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/45 resize-none font-serif"
        />
      </div>

      <div className="space-y-5">
        <DotScale label="Your mood this week" lowHint="heavy" highHint="light" value={mood} onChange={setMood} />
        <DotScale
          label="How alone did it feel?"
          lowHint="not at all"
          highHint="very"
          value={loneliness}
          onChange={setLoneliness}
        />
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button disabled={open.isPending} onClick={() => open.mutate(false)} className="rounded-full px-6">
          Open my chapter
        </Button>
        <Button
          variant="ghost"
          disabled={open.isPending}
          onClick={() => open.mutate(true)}
          className="rounded-full px-4 text-foreground/50"
        >
          Skip & open
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground/50 tracking-wide">
        No rush — this letter keeps. Your answer appears inside the chapter.
      </p>
    </div>
  );
}

// ─── Revealed reader ──────────────────────────────────────────────────────────

function ChapterReader({ chapter, isCurrent }: { chapter: Chapter; isCurrent?: boolean }) {
  const review = chapter.goalReview?.items ?? [];
  return (
    <div className="bg-card border border-primary/20 rounded-2xl p-6 space-y-8">
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Feather className="w-3.5 h-3.5 text-primary-strong/70" />
          <span className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">
            Week of {weekLabel(chapter.weekStart, chapter.weekEnd)}
          </span>
        </div>
        <p className="font-serif text-[17px] leading-relaxed text-foreground/90">{chapter.threadOpening}</p>
      </div>

      {chapter.thresholdAnswer && (
        <div className="rounded-xl bg-primary/6 border border-primary/15 px-4 py-3">
          <div className="text-[9px] uppercase tracking-[0.2em] text-primary-strong/60 mb-1">You said</div>
          <p className="font-serif text-[14px] italic text-foreground/70">“{chapter.thresholdAnswer}”</p>
        </div>
      )}

      {chapter.themes.length > 0 && (
        <div className="space-y-8">
          <div className="h-px bg-primary/12" />
          {chapter.themes.map((t) => (
            <ThemeBlock key={t.key} theme={t} chapterId={chapter.id} />
          ))}
        </div>
      )}

      {review.length > 0 && (
        <div className="space-y-4">
          <div className="h-px bg-primary/12" />
          <div className="text-[10px] uppercase tracking-[0.22em] text-secondary/75">Your promises</div>
          {review.map((item) => (
            <div key={`${item.refKind}-${item.refId}`} className="flex gap-3">
              <div className={cn("w-2 h-2 rounded-full mt-2 flex-shrink-0", VERDICT_DOT[item.verdict])} />
              <div>
                <div className="text-[11px] tracking-wide text-foreground/50 mb-1">{item.title}</div>
                <p className="font-serif text-[14px] leading-relaxed text-foreground/75">{item.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {chapter.microOffer && (
        <div className="space-y-4">
          <div className="h-px bg-primary/12" />
          <OfferCard offer={chapter.microOffer} chapterId={chapter.id} />
        </div>
      )}

      {chapter.workingThrough && (
        <div className="space-y-4">
          <div className="h-px bg-primary/12" />
          <WorkingThroughBlock wt={chapter.workingThrough} />
        </div>
      )}

      {chapter.sealResolution && (
        <div className="space-y-4">
          <div className="h-px bg-primary/12" />
          <SealResolutionCard chapterId={chapter.id} seal={chapter.sealResolution} />
        </div>
      )}

      {isCurrent && chapter.noteInvite?.prompt && !chapter.noteSealed && (
        <div className="space-y-4">
          <div className="h-px bg-primary/12" />
          <NoteInviteCard chapterId={chapter.id} prompt={chapter.noteInvite.prompt} />
        </div>
      )}
    </div>
  );
}

// ─── Archive ──────────────────────────────────────────────────────────────────

function ArchiveItem({ entry }: { entry: ArchiveEntry }) {
  const [open, setOpen] = useState(false);
  const { data: chapter } = useQuery<Chapter>({
    queryKey: ["chapters", entry.id],
    queryFn: async () => {
      const r = await apiFetch(`${base()}/${entry.id}`);
      if (!r.ok) throw new Error("could not load chapter");
      return r.json();
    },
    enabled: open,
  });

  return (
    <div className="border border-primary/12 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-primary/5 transition-colors"
      >
        <span className="text-[12px] tracking-wide text-foreground/65">
          {weekLabel(entry.weekStart, entry.weekEnd)}
        </span>
        {open ? (
          <ChevronUp className="w-3.5 h-3.5 text-foreground/35" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-foreground/35" />
        )}
      </button>
      <AnimatePresence>
        {open && chapter && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="px-1 pb-1">
              {chapter.status === "revealed" ? (
                <ChapterReader chapter={chapter} />
              ) : (
                <SealedChapter chapter={chapter} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Main section ─────────────────────────────────────────────────────────────

export function WeeklyChapterSection() {
  const { data, isLoading } = useQuery<ChaptersResponse>({
    queryKey: ["chapters"],
    queryFn: () =>
      apiFetch(base()).then((r) => {
        if (!r.ok) throw new Error("could not load chapters");
        return r.json();
      }),
    staleTime: 60_000,
  });

  if (isLoading || !data) return null;

  const { coldStart, current, archive } = data;

  return (
    <div className="space-y-4">
      {coldStart && (
        <div className="bg-card border border-primary/20 rounded-2xl p-6 text-center space-y-3">
          <div className="w-10 h-10 mx-auto rounded-full bg-primary/12 border border-primary/35 flex items-center justify-center">
            <Feather className="w-4 h-4 text-primary-strong/70" />
          </div>
          <p className="font-serif text-[16px] text-foreground/85">Your letters aren't ready yet.</p>
          <p className="text-[12px] leading-relaxed text-muted-foreground max-w-[300px] mx-auto">
            Once we've talked for a few weeks, I'll start writing you a chapter each Sunday — built from your own
            words, so you can watch yourself change.
          </p>
        </div>
      )}

      {!coldStart && !current && (
        <div className="bg-card border border-primary/15 rounded-2xl px-5 py-4 flex items-center gap-3">
          <Feather className="w-3.5 h-3.5 text-primary-strong/60 flex-shrink-0" />
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Your next chapter arrives Sunday evening — a letter I write you from your own words.
          </p>
        </div>
      )}

      {current && (
        <AnimatePresence mode="wait">
          <motion.div
            key={`${current.id}-${current.status}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            {current.status === "ready" ? (
              <SealedChapter chapter={current} />
            ) : (
              <ChapterReader chapter={current} isCurrent />
            )}
          </motion.div>
        </AnimatePresence>
      )}

      {archive.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60 px-1">Past chapters</div>
          {archive.slice(0, 8).map((e) => (
            <ArchiveItem key={e.id} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}
