import { useState } from "react";
import { RowList, Row, DisclosureSection, DisclosurePreview } from "@/components/ui/RowList";
import { apiFetch } from "@/lib/api";
import { format, parseISO } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Flame, Check, Plus, Trophy, Heart, Star, Map, Target,
  Trash2, ChevronDown, ChevronUp, CircleDot, CheckCircle2,
  XCircle, Clock, TrendingUp, Zap,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip as RechartsTooltip,
} from "recharts";

import {
  useGetJourney,
  useGetMoodHistory,
  useGetHabits,
  useGetWins,
  useGetProfile,
  useCompleteHabit,
  useCreateHabit,
  useCreateWin,
  getGetHabitsQueryKey,
  getGetWinsQueryKey,
  getGetJourneyQueryKey,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { WeekMarkers } from "@/components/week/WeekMarkers";

// ─── Day label helpers ────────────────────────────────────────────────────────

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

function getLast7Dates(): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    format(new Date(Date.now() - (6 - i) * 86400000), "yyyy-MM-dd"),
  );
}

function getDayOfWeekIndex(dateStr: string): number {
  // getDay() returns 0=Sun…6=Sat; convert to Mon-first (0=Mon…6=Sun)
  const d = new Date(dateStr + "T12:00:00");
  return (d.getDay() + 6) % 7;
}

// ─── Commitment types & section ───────────────────────────────────────────────

interface Commitment {
  id: number;
  content: string;
  cue: string;
  state: "open" | "done" | "partial" | "missed";
  missCount: number;
  qualityNote: string | null;
  scheduledFollowupDate: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  createdAt: string;
  updatedAt: string;
}

function formatClockTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m ?? 0).padStart(2, "0")} ${suffix}`;
}

const STATE_META = {
  open:    { label: "In progress",  icon: CircleDot,    color: "text-secondary/70",  bg: "bg-secondary/8 border-secondary/20" },
  done:    { label: "Done",         icon: CheckCircle2, color: "text-emerald-700 dark:text-emerald-400/80", bg: "bg-emerald-500/8 border-emerald-500/20" },
  partial: { label: "Partial",      icon: Clock,        color: "text-primary-strong/80",     bg: "bg-primary/8 border-primary/20" },
  missed:  { label: "Not this time", icon: Clock,        color: "text-muted-foreground",  bg: "bg-foreground/5 border-foreground/10" },
};

function CommitmentsSection() {
  const queryClient = useQueryClient();

  const { data: commitments = [], isLoading } = useQuery<Commitment[]>({
    queryKey: ["commitments"],
    queryFn: () => apiFetch(`${import.meta.env.BASE_URL}api/commitments`).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const updateCommitment = useMutation({
    mutationFn: ({ id, state }: { id: number; state: string }) =>
      apiFetch(`${import.meta.env.BASE_URL}api/commitments/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["commitments"] }),
  });

  const deleteCommitment = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`${import.meta.env.BASE_URL}api/commitments/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["commitments"] }),
  });

  const total = commitments.length;
  const open = commitments.filter((c) => c.state === "open");
  const closed = commitments.filter((c) => c.state !== "open");

  if (isLoading) return (
    <DisclosureSection title={<>What you&rsquo;re working on</>}>
      <div className="h-20 flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border border-primary/40 border-t-transparent animate-spin" />
      </div>
    </DisclosureSection>
  );

  // Preview: the newest open commitment, else the newest closed one.
  const latest = open[0] ?? closed[0];
  const LatestIcon = latest ? STATE_META[latest.state].icon : null;

  return (
    <DisclosureSection
      title={<>What you&rsquo;re working on</>}
      count={total}
      preview={
        latest && LatestIcon ? (
          <DisclosurePreview
            icon={<LatestIcon className={cn("w-3.5 h-3.5", STATE_META[latest.state].color)} />}
            text={latest.content}
            meta={
              latest.state === "done"
                ? "done"
                : latest.scheduledDate
                  ? format(parseISO(latest.scheduledDate), "MMM d")
                  : undefined
            }
          />
        ) : undefined
      }
    >
      <p className="text-[12px] text-muted-foreground">
        Your own next steps, in your own time. Nothing here is graded.
      </p>

      {total === 0 ? (
        <div className="bg-card/40 border border-primary/10 rounded-2xl p-5 text-center">
          <TrendingUp className="w-7 h-7 text-primary-strong/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground/60 font-serif italic">
            No commitments yet. When you and your companion agree on a next step in chat, it'll show up here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {open.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.2em] pl-1">In progress</p>
              <RowList>
                {open.map((c) => {
                  const meta = STATE_META[c.state];
                  const Icon = meta.icon;
                  const hasDetail = Boolean(c.cue || c.scheduledDate || c.scheduledFollowupDate || c.missCount > 0);
                  return (
                    <Row
                      key={c.id}
                      icon={<Icon className={cn("w-3.5 h-3.5", meta.color)} />}
                      title={c.content}
                      meta={c.scheduledDate ? format(parseISO(c.scheduledDate), "MMM d") : undefined}
                      actions={
                        <>
                          {/* 44px (w-11) hit boxes around the 14px glyphs —
                              Done and Remove sit side by side, so 28px
                              buttons here meant thumbs hit the wrong one. */}
                          <Button variant="ghost" size="icon" className="w-11 h-11 text-emerald-700 dark:text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-full"
                            onClick={() => updateCommitment.mutate({ id: c.id, state: "done" })} title="Mark done">
                            <Check className="w-3.5 h-3.5" strokeWidth={3} />
                          </Button>
                          <Button variant="ghost" size="icon" className="w-11 h-11 text-muted-foreground/40 hover:text-red-400/70 hover:bg-red-500/8 rounded-full"
                            onClick={() => deleteCommitment.mutate(c.id)} title="Remove">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </>
                      }
                    >
                      {hasDetail ? (
                        <div className="space-y-1">
                          {c.cue && <p className="text-[11px] text-muted-foreground/55">{c.cue}</p>}
                          {c.scheduledDate && (
                            <p className="text-[10px] text-secondary/70 uppercase tracking-wide">
                              Planned for {format(parseISO(c.scheduledDate), "MMM d")}
                              {c.scheduledTime && ` · ${formatClockTime(c.scheduledTime)}`}
                            </p>
                          )}
                          {c.scheduledFollowupDate && (
                            <p className="text-[10px] text-primary-strong/60 uppercase tracking-wide">
                              Follow-up {format(parseISO(c.scheduledFollowupDate), "MMM d")}
                            </p>
                          )}
                          {c.missCount > 0 && (
                            <p className="text-[10px] text-foreground/35">
                              {c.missCount === 1 ? "Missed once" : `Missed ${c.missCount}×`}. Your companion will suggest something smaller
                            </p>
                          )}
                        </div>
                      ) : // No detail beyond the text itself — Row un-truncates
                        // the title on tap when it's long, so no panel needed.
                        null}
                    </Row>
                  );
                })}
              </RowList>
            </div>
          )}

          {closed.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] pl-1 mt-4">Earlier</p>
              <RowList>
                {closed.slice(0, 6).map((c) => {
                  const meta = STATE_META[c.state];
                  const Icon = meta.icon;
                  return (
                    <Row
                      key={c.id}
                      dim={c.state !== "done"}
                      icon={<Icon className={cn("w-3.5 h-3.5", meta.color)} />}
                      title={c.content}
                      meta={c.state === "done" ? "done" : undefined}
                    >
                      {c.qualityNote ? (
                        <p className="text-[11px] text-muted-foreground/55 italic">"{c.qualityNote}"</p>
                      ) : null}
                    </Row>
                  );
                })}
              </RowList>
            </div>
          )}
        </div>
      )}
    </DisclosureSection>
  );
}

// ─── Goals section ────────────────────────────────────────────────────────────

interface GoalTask { id: number; content: string; isComplete: boolean; order: number; }
interface Goal { id: number; title: string; description: string; isComplete: boolean; letGoAt: string | null; tasks: GoalTask[]; createdAt: string; }

function GoalsSection({ openRequest }: { openRequest?: number }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [goalTitle, setGoalTitle] = useState("");
  const [goalDesc, setGoalDesc] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["goals"],
    queryFn: () => apiFetch(`${import.meta.env.BASE_URL}api/goals`).then((r) => r.json()),
  });

  const createGoal = useMutation({
    mutationFn: (body: { title: string; description: string }) =>
      apiFetch(`${import.meta.env.BASE_URL}api/goals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["goals"] }); setAddOpen(false); setGoalTitle(""); setGoalDesc(""); },
  });

  const deleteGoal = useMutation({
    mutationFn: (id: number) => apiFetch(`${import.meta.env.BASE_URL}api/goals/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["goals"] }),
  });

  // Letting go is a real, unpenalised option: the goal stays here, dimmed
  // and retrievable, and stops speaking in the Goals story.
  const letGo = useMutation({
    mutationFn: ({ id, back }: { id: number; back: boolean }) =>
      apiFetch(`${import.meta.env.BASE_URL}api/goals/${id}/${back ? "bring-back" : "let-go"}`, { method: "POST" }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["goals"] }),
  });

  const toggleTask = useMutation({
    mutationFn: ({ goalId, taskId, isComplete }: { goalId: number; taskId: number; isComplete: boolean }) =>
      apiFetch(`${import.meta.env.BASE_URL}api/goals/${goalId}/tasks/${taskId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isComplete }) }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["goals"] }),
  });

  const activeGoals = goals.filter((g) => !g.isComplete && !g.letGoAt);
  const doneGoals = goals.filter((g) => g.isComplete && !g.letGoAt);
  const letGoGoals = goals.filter((g) => !!g.letGoAt);

  // Preview: the newest active goal, else the newest completed one.
  const latestGoal = activeGoals[0] ?? doneGoals[0];
  const latestGoalMeta = !latestGoal
    ? undefined
    : latestGoal.isComplete
      ? "done"
      : latestGoal.tasks.length > 0
        ? `${latestGoal.tasks.filter((t) => t.isComplete).length} / ${latestGoal.tasks.length} steps`
        : undefined;

  return (
    <DisclosureSection
      title="Goals"
      count={goals.length}
      openRequest={openRequest}
      preview={
        latestGoal ? (
          <DisclosurePreview
            icon={<Target className="w-3.5 h-3.5 text-primary-strong/60" />}
            text={latestGoal.title}
            meta={latestGoalMeta}
          />
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="h-20 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full border border-primary/40 border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {activeGoals.map((goal) => {
            const doneCount = goal.tasks.filter((t) => t.isComplete).length;
            const isExpanded = expandedId === goal.id;
            return (
              <div key={goal.id} className="bg-card border border-primary/15 rounded-2xl overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <Target className="w-3.5 h-3.5 text-primary-strong/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground/85 leading-snug">{goal.title}</p>
                    {goal.tasks.length > 0 && (
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">{doneCount} / {goal.tasks.length} steps done</p>
                    )}
                  </div>
                  {/* 44px hit boxes (see the commitment rows above) — expand
                      and delete are adjacent, and delete is destructive. */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="w-11 h-11 text-muted-foreground/50 hover:text-foreground rounded-full"
                      onClick={() => setExpandedId(isExpanded ? null : goal.id)}>
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="w-11 h-11 text-muted-foreground/50 hover:text-red-400 rounded-full"
                      onClick={() => deleteGoal.mutate(goal.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                {goal.tasks.length > 0 && (
                  <div className="mx-4 mb-2 h-0.5 bg-foreground/5 rounded-full overflow-hidden">
                    <div className="h-full bg-primary/50 rounded-full transition-all duration-500"
                      style={{ width: `${(doneCount / goal.tasks.length) * 100}%` }} />
                  </div>
                )}
                <AnimatePresence>
                  {isExpanded && goal.tasks.length > 0 && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} className="border-t border-primary/10 overflow-hidden">
                      {/* The WHOLE row is the toggle (role=checkbox), not the
                          16px circle alone — that circle was a 16px tap
                          target. The circle stays a small glyph; the full-
                          width row, py-3 (≥44px tall), is what a thumb hits. */}
                      {goal.tasks.sort((a, b) => a.order - b.order).map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          role="checkbox"
                          aria-checked={task.isComplete}
                          onClick={() => toggleTask.mutate({ goalId: goal.id, taskId: task.id, isComplete: !task.isComplete })}
                          className="group w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-primary/5 transition-colors"
                        >
                          <span aria-hidden="true"
                            className={cn("mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all",
                              task.isComplete ? "bg-primary/20 border-primary/50" : "border-foreground/20 group-hover:border-primary/50")}>
                            {task.isComplete && <Check className="w-2.5 h-2.5 text-primary-strong" strokeWidth={3} />}
                          </span>
                          <span className={cn("text-[13px] leading-relaxed",
                            task.isComplete ? "text-muted-foreground/50 line-through" : "text-foreground/75")}>
                            {task.content}
                          </span>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
                {isExpanded && (
                  <div className="border-t border-primary/10 px-4 py-2 flex justify-end">
                    <Button variant="ghost" size="sm" className="h-9 text-[12px] text-muted-foreground/70 hover:text-foreground"
                      onClick={() => letGo.mutate({ id: goal.id, back: false })} disabled={letGo.isPending}>
                      Let this one go
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          {letGoGoals.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.2em] pl-1">Let go</p>
              {letGoGoals.map((goal) => (
                <div key={goal.id} className="bg-card/40 border border-primary/8 rounded-xl px-4 py-2 flex items-center gap-3 opacity-60">
                  <p className="flex-1 min-w-0 text-sm text-foreground/60 truncate">{goal.title}</p>
                  <Button variant="ghost" size="sm" className="h-9 text-[12px] text-muted-foreground/70 hover:text-foreground shrink-0"
                    onClick={() => letGo.mutate({ id: goal.id, back: true })} disabled={letGo.isPending}>
                    Bring it back
                  </Button>
                </div>
              ))}
            </div>
          )}
          {doneGoals.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.2em] pl-1">Completed</p>
              {doneGoals.map((goal) => (
                <div key={goal.id} className="bg-card/40 border border-primary/8 rounded-xl px-4 py-3 flex items-center gap-3 opacity-50">
                  <Check className="w-3.5 h-3.5 text-primary-strong/60 shrink-0" />
                  <p className="text-sm text-foreground/60 line-through">{goal.title}</p>
                </div>
              ))}
            </div>
          )}
          {addOpen ? (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
              className="bg-card/60 border border-primary/15 rounded-xl p-4 space-y-3">
              <Input placeholder="What's your goal?" value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)}
                className="bg-background/50 border-primary/15 text-sm text-foreground/80 placeholder:text-muted-foreground/50" autoFocus />
              <Input placeholder="A bit more context (optional)" value={goalDesc} onChange={(e) => setGoalDesc(e.target.value)}
                className="bg-background/50 border-primary/15 text-sm text-foreground/80 placeholder:text-muted-foreground/50" />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" className="text-muted-foreground h-8 text-xs" onClick={() => setAddOpen(false)}>Cancel</Button>
                <Button size="sm" className="h-8 text-xs bg-primary/15 text-primary-strong hover:bg-primary/25 border border-primary/25"
                  disabled={!goalTitle.trim() || createGoal.isPending}
                  onClick={() => createGoal.mutate({ title: goalTitle, description: goalDesc })}>
                  {createGoal.isPending ? "Breaking it down…" : "Set goal"}
                </Button>
              </div>
              {createGoal.isPending && (
                <p className="text-[11px] text-muted-foreground/60 italic text-center">Breaking your goal into steps…</p>
              )}
            </motion.div>
          ) : (
            <button onClick={() => setAddOpen(true)}
              className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm">
              <Plus className="w-4 h-4" />Set a new goal
            </button>
          )}
        </div>
      )}
    </DisclosureSection>
  );
}

// ─── Habit section (prominent) ────────────────────────────────────────────────

// The pattern, never the chain: "Every day this week", "Most days this
// week", "Four of the last seven". No consecutive-day count anywhere on the
// row — a missed day has no measurable effect on forming a habit, so the row
// never shows one.
const NUMBER_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];
function patternPhrase(recentCompletions: string[]): string | null {
  const n = new Set(recentCompletions).size;
  if (n === 0) return null;
  if (n >= 7) return "Every day this week";
  if (n >= 5) return "Most days this week";
  return `${NUMBER_WORDS[n]} of the last seven`;
}

function HabitsSection({ openRequest }: { openRequest?: number }) {
  const queryClient = useQueryClient();
  const { data: habits = [], isLoading } = useGetHabits();
  const completeHabit = useCompleteHabit();
  const createHabit = useCreateHabit();

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [whenThen, setWhenThen] = useState("");
  const [reason, setReason] = useState("");

  const handleComplete = (id: number) => {
    completeHabit.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetHabitsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJourneyQueryKey() });
      },
    });
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !whenThen.trim() || !reason.trim()) return;
    createHabit.mutate({ data: { name, whenThen, reason } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetHabitsQueryKey() });
        setAddOpen(false); setName(""); setWhenThen(""); setReason("");
      },
    });
  };

  // Preview: the newest routine and whether it's been done today.
  const today = format(new Date(), "yyyy-MM-dd");
  const latestHabit = habits[habits.length - 1];
  const latestHabitDoneToday = Boolean(
    latestHabit?.lastCompleted && format(parseISO(latestHabit.lastCompleted), "yyyy-MM-dd") === today,
  );

  return (
    <DisclosureSection
      title="Daily Routines"
      count={habits.length}
      openRequest={openRequest}
      preview={
        latestHabit ? (
          <DisclosurePreview
            icon={
              <Check
                className={cn("w-3.5 h-3.5", latestHabitDoneToday ? "text-primary-strong/70" : "text-foreground/25")}
                strokeWidth={latestHabitDoneToday ? 3 : 2}
              />
            }
            text={latestHabit.name}
            meta={latestHabitDoneToday ? "done today" : "not yet today"}
          />
        ) : undefined
      }
    >
      {habits.length > 0 && (
        <p className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.15em]">
          {habits.filter((h) => {
            const today = format(new Date(), "yyyy-MM-dd");
            return h.lastCompleted && format(parseISO(h.lastCompleted), "yyyy-MM-dd") === today;
          }).length} / {habits.length} done today
        </p>
      )}

      {/* Science note */}
      <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-primary/5 border border-primary/12">
        <Zap className="w-3.5 h-3.5 text-primary-strong/50 shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          Habits become automatic after <span className="text-secondary/70 font-medium">~66 days</span>, not 21. Missing one day costs nothing. Just pick it back up tomorrow. Your companion will never push you to do more than one new thing at a time.
        </p>
      </div>

      {isLoading ? (
        <div className="h-20 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full border border-primary/40 border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {habits.length === 0 && !addOpen && (
            <div className="bg-card/40 border border-primary/10 rounded-2xl p-5 text-center">
              <p className="text-sm text-muted-foreground/60 font-serif italic">
                No routines yet. Start with something tiny: one minute, once a day, attached to something you already do.
              </p>
              <p className="text-[11px] text-muted-foreground/40 mt-2">
                Your companion can also suggest habits based on your conversations.
              </p>
            </div>
          )}

          {habits.map((habit) => {
            const today = format(new Date(), "yyyy-MM-dd");
            const isCompletedToday = habit.lastCompleted &&
              format(parseISO(habit.lastCompleted), "yyyy-MM-dd") === today;
            const pattern = patternPhrase(habit.recentCompletions);

            return (
              <motion.div
                key={habit.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "bg-card border rounded-2xl p-4 transition-all",
                  isCompletedToday ? "border-primary/30 bg-primary/5" : "border-primary/15",
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={cn(
                        "font-medium text-sm leading-tight",
                        isCompletedToday ? "text-foreground/90" : "text-foreground/80",
                      )}>
                        {habit.name}
                      </h3>
                      {isCompletedToday && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700 dark:text-emerald-400/80 font-medium">
                          <Check className="w-2.5 h-2.5" strokeWidth={3} />
                          Done today
                        </span>
                      )}
                    </div>

                    {/* When/then cue */}
                    <p className="text-[12px] text-muted-foreground/60 mt-1 leading-relaxed italic">
                      {habit.whenThen}
                    </p>

                    {/* The pattern, never a chain */}
                    {pattern && (
                      <p className="text-[11px] text-muted-foreground/60 mt-2">{pattern}</p>
                    )}
                  </div>

                  {/* Complete button */}
                  <Button
                    size="icon"
                    className={cn(
                      "rounded-full w-10 h-10 shrink-0 transition-all",
                      isCompletedToday
                        ? "bg-primary/15 text-primary-strong border border-primary/30 cursor-default"
                        : "bg-card border border-primary/20 text-muted-foreground hover:bg-primary/10 hover:text-primary-strong hover:border-primary/30",
                    )}
                    onClick={() => !isCompletedToday && handleComplete(habit.id)}
                    disabled={!!isCompletedToday || completeHabit.isPending}
                  >
                    <Check className="w-4 h-4" strokeWidth={isCompletedToday ? 3 : 2} />
                  </Button>
                </div>
              </motion.div>
            );
          })}

          {/* Add habit form */}
          {addOpen ? (
            <motion.form initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
              onSubmit={handleCreate} className="bg-card/60 border border-primary/15 rounded-xl p-4 space-y-3">
              <div>
                <Input placeholder="Habit name (e.g. Morning walk)" value={name} onChange={(e) => setName(e.target.value)}
                  className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50" />
              </div>
              <div>
                <Input placeholder="When/Then cue (After waking up, I will…)" value={whenThen} onChange={(e) => setWhenThen(e.target.value)}
                  className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50" />
                <p className="text-[10px] text-muted-foreground/40 mt-1 pl-1">
                  Attach to something you already do every day
                </p>
              </div>
              <Input placeholder="Why this matters to you" value={reason} onChange={(e) => setReason(e.target.value)}
                className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50" />
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)} className="text-muted-foreground h-8 text-xs">Cancel</Button>
                <Button type="submit" size="sm" className="h-8 text-xs bg-primary/15 text-primary-strong hover:bg-primary/25 border border-primary/25"
                  disabled={!name.trim() || !whenThen.trim() || !reason.trim() || createHabit.isPending}>
                  {createHabit.isPending ? "Saving…" : "Start this routine"}
                </Button>
              </div>
            </motion.form>
          ) : (
            <button onClick={() => setAddOpen(true)}
              className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm">
              <Plus className="w-4 h-4" />
              Begin a new small routine
            </button>
          )}
        </div>
      )}
    </DisclosureSection>
  );
}

// ─── Add Win card ─────────────────────────────────────────────────────────────

function AddWinCard() {
  const queryClient = useQueryClient();
  const createWin = useCreateWin();
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    createWin.mutate({ data: { content } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWinsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJourneyQueryKey() });
        setIsOpen(false); setContent("");
      },
    });
  };

  if (!isOpen) return (
    <button onClick={() => setIsOpen(true)}
      className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm">
      <Plus className="w-4 h-4" />Note a win
    </button>
  );

  return (
    <motion.form initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
      onSubmit={handleSubmit} className="bg-card/60 border border-primary/15 rounded-xl p-4 flex gap-2 items-start">
      <Input placeholder="What small thing did you do or feel today?" value={content} onChange={(e) => setContent(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm text-foreground/80 placeholder:text-muted-foreground/50" />
      <Button type="submit" className="bg-primary/15 text-primary-strong hover:bg-primary/25 border border-primary/25 shrink-0" disabled={createWin.isPending}>
        {createWin.isPending ? "…" : "Save"}
      </Button>
    </motion.form>
  );
}

// ─── Main Journey page ────────────────────────────────────────────────────────

export default function Journey() {
  const { data: journey, isLoading: journeyLoading } = useGetJourney();
  const { data: moodHistory = [] } = useGetMoodHistory();
  const { data: habits = [] } = useGetHabits();
  const { data: wins = [] } = useGetWins();
  const { data: profile } = useGetProfile();
  // A Goals / Routines marker with nothing to say opens the row below instead.
  const [openRequests, setOpenRequests] = useState({ goals: 0, routines: 0 });

  if (journeyLoading || !journey) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-7 h-7 rounded-full border border-primary/40 border-t-transparent animate-spin" />
      </div>
    );
  }

  // Cast to access new fields before types regenerate
  const habitMoodInsight = (journey as any).habitMoodInsight as string | null ?? null;
  const userName = (profile as any)?.userName as string | undefined;

  // Time axis reads oldest LEFT → newest RIGHT, regardless of API order —
  // sort by date explicitly instead of trusting (and reversing) the payload.
  const chartData = [...moodHistory]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => ({ name: format(parseISO(entry.date), "MMM d"), score: entry.score }));

  // Closed-section previews: the most recent entry of each list, so the page
  // has content without being a wall. Sorted here rather than trusting API
  // order, same as the chart.
  const latestMood = [...moodHistory].sort((a, b) => b.date.localeCompare(a.date))[0];
  const latestWin = [...wins].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const unlockedMilestones = journey.milestones.filter((m) => m.isUnlocked);
  const latestMilestone = [...unlockedMilestones].sort((a, b) =>
    (b.unlockedAt ?? "").localeCompare(a.unlockedAt ?? ""),
  )[0];

  // Mood correlation — prefer server-computed insight, fall back to client calc
  const habitCorrelation = (() => {
    if (habitMoodInsight) return { text: habitMoodInsight };
    if (moodHistory.length < 3 || habits.length === 0) return null;
    const sorted = [...moodHistory].sort((a, b) => a.date.localeCompare(b.date));
    const firstScore = sorted[0]?.score;
    const lastScore = sorted[sorted.length - 1]?.score;
    if (!firstScore || !lastScore || lastScore <= firstScore) return null;
    const diff = lastScore - firstScore;
    const activeHabitNames = habits
      .filter((h) => h.recentCompletions.length >= 3)
      .map((h) => h.name);
    if (activeHabitNames.length === 0) return null;
    return {
      text: `Your mood is up ${diff} ${diff === 1 ? "point" : "points"} since you started keeping up with ${activeHabitNames.slice(0, 2).join(" and ")}. What you do shows up in how you feel.`,
    };
  })();

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-8">

      {/* ── Header — chip, heading, warm lede ─────────────────────────────── */}
      <div className="space-y-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/25 bg-primary/8 text-[10px] font-medium tracking-[0.2em] uppercase text-secondary mb-4">
            <Map className="w-3 h-3 text-primary-strong/70" />
            Chapter {journey.stage}: {journey.stageLabel}
          </div>
          <h1 className="font-display text-[34px] font-medium text-foreground tracking-wide leading-tight">
            Your journey
          </h1>
          {/* Warm lede — mirrors the user back instead of scoring them */}
          <p className="font-serif text-[15px] text-secondary italic leading-relaxed mt-2 max-w-md">
            {journey.dayCounter} {journey.dayCounter === 1 ? "day" : "days"} in{userName ? `, ${userName}` : ""}. You keep
            choosing yourself, quietly, even on the hard days.
          </p>
        </div>

        {/* ── Story markers — Goals, Routines, then the weeks ──────────────── */}
        <WeekMarkers onOpenSection={(section) => setOpenRequests((r) => ({ ...r, [section]: r[section] + 1 }))} />

      </div>

      {/* ── Mood chart ─────────────────────────────────────────────────────── */}
      <DisclosureSection
        title="How you've been feeling"
        preview={
          journey.moodCaption ? (
            <DisclosurePreview
              text={<span className="font-serif italic text-secondary">"{journey.moodCaption}"</span>}
              meta={latestMood ? format(parseISO(latestMood.date), "MMM d") : undefined}
            />
          ) : latestMood ? (
            <DisclosurePreview
              text={`Last check-in: ${latestMood.score} of 10`}
              meta={format(parseISO(latestMood.date), "MMM d")}
            />
          ) : undefined
        }
      >
        <div className="bg-card/50 border border-primary/15 rounded-2xl p-5 h-[210px] relative">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 8, left: -24, bottom: 0 }}>
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} dy={8} />
                <YAxis domain={[1, 10]} axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                  itemStyle={{ color: "hsl(var(--foreground))" }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))", marginBottom: "3px" }}
                />
                <Line type="monotone" dataKey="score" stroke="hsl(var(--chart-1))" strokeWidth={1.5}
                  dot={{ fill: "hsl(var(--card))", stroke: "hsl(var(--chart-1))", strokeWidth: 1.5, r: 3 }}
                  activeDot={{ r: 5, fill: "hsl(var(--chart-1))" }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground font-serif italic">
              Checking in with you soon…
            </div>
          )}
        </div>

        {journey.moodCaption && (
          <p className="text-sm text-secondary italic font-serif px-1">"{journey.moodCaption}"</p>
        )}

        {/* Validating caption — dips are data, not verdicts */}
        <p className="text-[12px] text-muted-foreground leading-relaxed px-1">
          The dips are part of it. Feeling low on a day isn't going backwards. It's a day, and you kept going.
        </p>

        {/* Habit-mood insight — server-computed correlation or client fallback */}
        {habitCorrelation && (
          <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-emerald-500/6 border border-emerald-500/15">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400/70 shrink-0 mt-0.5" />
            <p className="text-[12px] text-muted-foreground/70 leading-relaxed">
              {habitCorrelation.text}
            </p>
          </div>
        )}
      </DisclosureSection>

      <div className="h-px bg-primary/12" />

      {/* ── Small things you did for yourself ──────────────────────────────── */}
      <DisclosureSection
        title="Small things you did for yourself"
        count={wins.length}
        preview={
          latestWin ? (
            <DisclosurePreview
              icon={<Heart className="w-3.5 h-3.5 text-primary-strong/50" />}
              text={latestWin.content}
              meta={format(parseISO(latestWin.createdAt), "MMM d")}
            />
          ) : undefined
        }
      >
        <div className="space-y-3">
          {wins.length === 0 && (
            <p className="text-sm text-muted-foreground font-serif italic px-1">
              The small stuff counts here: a shower on a heavy day, a text you finally sent.
            </p>
          )}
          {wins.length > 0 && (
            <RowList>
              {wins.map((win) => (
                <Row
                  key={win.id}
                  icon={<Heart className="w-3.5 h-3.5 text-primary-strong/50" />}
                  title={win.content}
                  meta={format(parseISO(win.createdAt), "MMM d")}
                >
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
                    {format(parseISO(win.createdAt), "MMMM d, yyyy")}
                  </p>
                </Row>
              ))}
            </RowList>
          )}
          <AddWinCard />
        </div>
      </DisclosureSection>

      <div className="h-px bg-primary/12" />

      {/* ── What you're working on (commitments) ───────────────────────────── */}
      <CommitmentsSection />

      <div className="h-px bg-primary/12" />

      {/* ── Daily Routines ─────────────────────────────────────────────────── */}
      <HabitsSection openRequest={openRequests.routines} />

      <div className="h-px bg-primary/12" />

      {/* ── Goals ──────────────────────────────────────────────────────────── */}
      <GoalsSection openRequest={openRequests.goals} />

      <div className="h-px bg-primary/12" />

      {/* ── Milestones — only what's been reached; nothing locked or greyed
           out, no "not yet" states staring back at the user ─────────────── */}
      {journey.milestones.some((m) => m.isUnlocked) && (
        <DisclosureSection
          title="Milestones"
          count={unlockedMilestones.length}
          preview={
            latestMilestone ? (
              <DisclosurePreview
                icon={<Star className="w-3.5 h-3.5 text-primary-strong/50" />}
                text={latestMilestone.label}
                meta={latestMilestone.unlockedAt ? format(parseISO(latestMilestone.unlockedAt), "MMM d") : undefined}
              />
            ) : undefined
          }
          className="pb-8"
        >
          <div className="grid grid-cols-2 gap-3">
            {unlockedMilestones.map((milestone) => (
              <div key={milestone.id}
                className="p-4 rounded-xl border bg-card border-primary/25 flex flex-col items-center justify-center text-center gap-2">
                <div className="w-7 h-7 rounded-full flex items-center justify-center bg-primary/15 text-primary-strong">
                  <Star className="w-3.5 h-3.5" />
                </div>
                <span className="text-[11px] font-medium tracking-wide leading-snug text-foreground/80">
                  {milestone.label}
                </span>
              </div>
            ))}
          </div>
        </DisclosureSection>
      )}
    </div>
  );
}
