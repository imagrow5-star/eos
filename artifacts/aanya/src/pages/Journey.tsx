import { useState } from "react";
import { format, parseISO } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Flame, Check, Plus, Trophy, Lock, Heart, Star, Map, Target,
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
  createdAt: string;
  updatedAt: string;
}

const STATE_META = {
  open:    { label: "In progress",  icon: CircleDot,    color: "text-secondary/70",  bg: "bg-secondary/8 border-secondary/20" },
  done:    { label: "Done",         icon: CheckCircle2, color: "text-emerald-400/80", bg: "bg-emerald-500/8 border-emerald-500/20" },
  partial: { label: "Partial",      icon: Clock,        color: "text-primary/80",     bg: "bg-primary/8 border-primary/20" },
  missed:  { label: "Missed",       icon: XCircle,      color: "text-foreground/30",  bg: "bg-foreground/5 border-foreground/10" },
};

function CommitmentsSection() {
  const queryClient = useQueryClient();

  const { data: commitments = [], isLoading } = useQuery<Commitment[]>({
    queryKey: ["commitments"],
    queryFn: () => fetch(`${import.meta.env.BASE_URL}api/commitments`).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const updateCommitment = useMutation({
    mutationFn: ({ id, state }: { id: number; state: string }) =>
      fetch(`${import.meta.env.BASE_URL}api/commitments/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["commitments"] }),
  });

  const deleteCommitment = useMutation({
    mutationFn: (id: number) =>
      fetch(`${import.meta.env.BASE_URL}api/commitments/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["commitments"] }),
  });

  const total = commitments.length;
  const done = commitments.filter((c) => c.state === "done").length;
  const partial = commitments.filter((c) => c.state === "partial").length;
  const missed = commitments.filter((c) => c.state === "missed").length;
  const open = commitments.filter((c) => c.state === "open");
  const closed = commitments.filter((c) => c.state !== "open");
  const rate = total > 0 ? Math.round(((done + partial * 0.5) / total) * 100) : null;

  if (isLoading) return (
    <section className="space-y-4">
      <h2 className="font-serif text-xl text-foreground/85">Follow-through</h2>
      <div className="h-20 flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border border-primary/40 border-t-transparent animate-spin" />
      </div>
    </section>
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-xl text-foreground/85">Follow-through</h2>
        {rate !== null && (
          <span className="text-[11px] text-primary/80 font-medium tracking-wide">{rate}% rate</span>
        )}
      </div>

      {total === 0 ? (
        <div className="bg-card/40 border border-primary/10 rounded-2xl p-5 text-center">
          <TrendingUp className="w-7 h-7 text-primary/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground/60 font-serif italic">
            No commitments yet. When you and your companion agree on a next step in chat, it'll show up here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {total >= 2 && (
            <div className="bg-card border border-primary/15 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span className="uppercase tracking-[0.15em]">Completion rate</span>
                <span className="font-serif text-lg text-foreground/80">{rate}%</span>
              </div>
              <div className="h-1.5 bg-foreground/8 rounded-full overflow-hidden">
                <motion.div className="h-full bg-primary/60 rounded-full" initial={{ width: 0 }}
                  animate={{ width: `${rate}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
              </div>
              <div className="flex gap-4 text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                <span>{done} done</span>
                {partial > 0 && <span>{partial} partial</span>}
                {missed > 0 && <span>{missed} missed</span>}
                {open.length > 0 && <span>{open.length} open</span>}
              </div>
            </div>
          )}

          {open.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.2em] pl-1">In progress</p>
              {open.map((c) => {
                const meta = STATE_META[c.state];
                const Icon = meta.icon;
                return (
                  <motion.div key={c.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                    className={cn("bg-card border rounded-xl p-4 flex items-start gap-3", meta.bg)}>
                    <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", meta.color)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground/85 leading-snug">{c.content}</p>
                      {c.cue && <p className="text-[11px] text-muted-foreground/55 mt-0.5">{c.cue}</p>}
                      {c.scheduledFollowupDate && (
                        <p className="text-[10px] text-primary/60 mt-1 uppercase tracking-wide">
                          Follow-up {format(parseISO(c.scheduledFollowupDate), "MMM d")}
                        </p>
                      )}
                      {c.missCount > 0 && (
                        <p className="text-[10px] text-foreground/35 mt-0.5">
                          {c.missCount === 1 ? "Missed once" : `Missed ${c.missCount}×`} — your companion will suggest something smaller
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="w-7 h-7 text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-full"
                        onClick={() => updateCommitment.mutate({ id: c.id, state: "done" })} title="Mark done">
                        <Check className="w-3.5 h-3.5" strokeWidth={3} />
                      </Button>
                      <Button variant="ghost" size="icon" className="w-7 h-7 text-muted-foreground/40 hover:text-red-400/70 hover:bg-red-500/8 rounded-full"
                        onClick={() => deleteCommitment.mutate(c.id)} title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}

          {closed.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.2em] pl-1 mt-4">History</p>
              {closed.slice(0, 6).map((c) => {
                const meta = STATE_META[c.state];
                const Icon = meta.icon;
                return (
                  <div key={c.id} className={cn(
                    "border rounded-xl px-4 py-3 flex items-start gap-3",
                    c.state === "done" ? "bg-emerald-500/5 border-emerald-500/15" : "bg-foreground/3 border-foreground/8 opacity-55",
                  )}>
                    <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", meta.color)} />
                    <div className="min-w-0">
                      <p className={cn("text-sm leading-snug",
                        c.state === "done" ? "text-foreground/75" : "text-foreground/40 line-through")}>
                        {c.content}
                      </p>
                      {c.qualityNote && (
                        <p className="text-[11px] text-muted-foreground/55 mt-1 italic">"{c.qualityNote}"</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Goals section ────────────────────────────────────────────────────────────

interface GoalTask { id: number; content: string; isComplete: boolean; order: number; }
interface Goal { id: number; title: string; description: string; isComplete: boolean; tasks: GoalTask[]; createdAt: string; }

function GoalsSection() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [goalTitle, setGoalTitle] = useState("");
  const [goalDesc, setGoalDesc] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["goals"],
    queryFn: () => fetch(`${import.meta.env.BASE_URL}api/goals`).then((r) => r.json()),
  });

  const createGoal = useMutation({
    mutationFn: (body: { title: string; description: string }) =>
      fetch(`${import.meta.env.BASE_URL}api/goals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["goals"] }); setAddOpen(false); setGoalTitle(""); setGoalDesc(""); },
  });

  const deleteGoal = useMutation({
    mutationFn: (id: number) => fetch(`${import.meta.env.BASE_URL}api/goals/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["goals"] }),
  });

  const toggleTask = useMutation({
    mutationFn: ({ goalId, taskId, isComplete }: { goalId: number; taskId: number; isComplete: boolean }) =>
      fetch(`${import.meta.env.BASE_URL}api/goals/${goalId}/tasks/${taskId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isComplete }) }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["goals"] }),
  });

  const activeGoals = goals.filter((g) => !g.isComplete);
  const doneGoals = goals.filter((g) => g.isComplete);

  return (
    <section className="space-y-4">
      <h2 className="font-serif text-xl text-foreground/85">Goals</h2>
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
                    <Target className="w-3.5 h-3.5 text-primary/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground/85 leading-snug">{goal.title}</p>
                    {goal.tasks.length > 0 && (
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">{doneCount} / {goal.tasks.length} steps done</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="w-7 h-7 text-muted-foreground/50 hover:text-foreground rounded-full"
                      onClick={() => setExpandedId(isExpanded ? null : goal.id)}>
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="w-7 h-7 text-muted-foreground/50 hover:text-red-400 rounded-full"
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
                      {goal.tasks.sort((a, b) => a.order - b.order).map((task) => (
                        <div key={task.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors">
                          <button onClick={() => toggleTask.mutate({ goalId: goal.id, taskId: task.id, isComplete: !task.isComplete })}
                            className={cn("mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all",
                              task.isComplete ? "bg-primary/20 border-primary/50" : "border-foreground/20 hover:border-primary/50")}>
                            {task.isComplete && <Check className="w-2.5 h-2.5 text-primary" strokeWidth={3} />}
                          </button>
                          <p className={cn("text-[13px] leading-relaxed",
                            task.isComplete ? "text-muted-foreground/50 line-through" : "text-foreground/75")}>
                            {task.content}
                          </p>
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
          {doneGoals.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.2em] pl-1">Completed</p>
              {doneGoals.map((goal) => (
                <div key={goal.id} className="bg-card/40 border border-primary/8 rounded-xl px-4 py-3 flex items-center gap-3 opacity-50">
                  <Check className="w-3.5 h-3.5 text-primary/60 shrink-0" />
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
                <Button size="sm" className="h-8 text-xs bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25"
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
    </section>
  );
}

// ─── Habit section (prominent) ────────────────────────────────────────────────

function HabitsSection() {
  const queryClient = useQueryClient();
  const { data: habits = [], isLoading } = useGetHabits();
  const completeHabit = useCompleteHabit();
  const createHabit = useCreateHabit();

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [whenThen, setWhenThen] = useState("");
  const [reason, setReason] = useState("");

  const last7 = getLast7Dates();

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

  return (
    <section className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-xl text-foreground/85">Daily Routines</h2>
        {habits.length > 0 && (
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.15em]">
            {habits.filter((h) => {
              const today = format(new Date(), "yyyy-MM-dd");
              return h.lastCompleted && format(parseISO(h.lastCompleted), "yyyy-MM-dd") === today;
            }).length} / {habits.length} done today
          </span>
        )}
      </div>

      {/* Science note */}
      <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-primary/5 border border-primary/12">
        <Zap className="w-3.5 h-3.5 text-primary/50 shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          Habits become automatic after <span className="text-secondary/70 font-medium">~66 days</span>, not 21. Missing one day costs nothing — just pick it back up tomorrow. Your companion will never push you to do more than one new thing at a time.
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
                No routines yet. Start with something tiny — one minute, once a day, attached to something you already do.
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

            const completedSet = new Set(habit.recentCompletions);
            const last7Rate = Math.round((last7.filter((d) => completedSet.has(d)).length / 7) * 100);

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
                {/* Name + streak + complete button */}
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={cn(
                        "font-medium text-sm leading-tight",
                        isCompletedToday ? "text-foreground/90" : "text-foreground/80",
                      )}>
                        {habit.name}
                      </h3>
                      {habit.streak > 0 && (
                        <span className={cn(
                          "inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border",
                          habit.streak >= 7
                            ? "bg-primary/15 border-primary/30 text-primary"
                            : "bg-primary/8 border-primary/20 text-primary/80",
                        )}>
                          <Flame className="w-2.5 h-2.5" />
                          {habit.streak}d streak
                        </span>
                      )}
                      {isCompletedToday && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400/80 font-medium">
                          <Check className="w-2.5 h-2.5" strokeWidth={3} />
                          Done today
                        </span>
                      )}
                    </div>

                    {/* When/then cue */}
                    <p className="text-[12px] text-muted-foreground/60 mt-1 leading-relaxed italic">
                      {habit.whenThen}
                    </p>
                  </div>

                  {/* Complete button */}
                  <Button
                    size="icon"
                    className={cn(
                      "rounded-full w-10 h-10 shrink-0 transition-all",
                      isCompletedToday
                        ? "bg-primary/15 text-primary border border-primary/30 cursor-default"
                        : "bg-card border border-primary/20 text-muted-foreground hover:bg-primary/10 hover:text-primary hover:border-primary/30",
                    )}
                    onClick={() => !isCompletedToday && handleComplete(habit.id)}
                    disabled={!!isCompletedToday || completeHabit.isPending}
                  >
                    <Check className="w-4 h-4" strokeWidth={isCompletedToday ? 3 : 2} />
                  </Button>
                </div>

                {/* 7-day dot grid */}
                <div className="mt-4">
                  <div className="flex items-center gap-1.5">
                    {last7.map((dateStr, i) => {
                      const done = completedSet.has(dateStr);
                      const isToday = dateStr === today;
                      const dayLabel = DAY_LABELS[getDayOfWeekIndex(dateStr)];
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                          <div className={cn(
                            "w-full aspect-square max-w-[28px] rounded-md transition-all",
                            done
                              ? "bg-primary/60 shadow-[0_0_6px_hsl(40_56%_50%/0.3)]"
                              : isToday
                                ? "bg-foreground/8 border border-primary/20 border-dashed"
                                : "bg-foreground/6",
                          )} />
                          <span className={cn(
                            "text-[9px] font-medium uppercase",
                            isToday ? "text-primary/70" : "text-muted-foreground/40",
                          )}>
                            {dayLabel}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Completion rate + forgiving streak note */}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] text-muted-foreground/45">
                      {last7Rate}% this week
                    </span>
                    {habit.streak > 0 && (
                      <span className="text-[10px] text-muted-foreground/40 italic">
                        missing one day won't break it
                      </span>
                    )}
                  </div>
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
                <Button type="submit" size="sm" className="h-8 text-xs bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25"
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
    </section>
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
      <Button type="submit" className="bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25 shrink-0" disabled={createWin.isPending}>
        {createWin.isPending ? "…" : "Save"}
      </Button>
    </motion.form>
  );
}

// ─── Growth indicator card ────────────────────────────────────────────────────
// The "1% better" compounding score. Never decreases — just plateaus on rest
// days. Framed as progress, never as performance.

function GrowthIndicatorCard({ score }: { score: number }) {
  const label =
    score < 10 ? "just beginning" :
    score < 25 ? "roots taking hold" :
    score < 45 ? "momentum building" :
    score < 65 ? "noticeably stronger" :
    score < 80 ? "real growth" :
    "deep roots";

  return (
    <div className="bg-card border border-primary/20 rounded-2xl p-5 space-y-4 relative overflow-hidden">
      {/* Subtle background glow */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/4 to-transparent pointer-events-none" />

      <div className="relative">
        <div className="flex items-start justify-between mb-1">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">Growth</p>
            <p className="font-serif text-[11px] text-secondary/70 italic mt-0.5">{label}</p>
          </div>
          <div className="text-right">
            <span className="font-serif text-[40px] text-secondary/90 leading-none tabular-nums">{score}</span>
            <span className="text-[14px] text-secondary/50 ml-0.5">%</span>
          </div>
        </div>

        {/* Progress bar — soft, never harsh */}
        <div className="h-1.5 bg-foreground/8 rounded-full overflow-hidden mt-3">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-primary/50 to-secondary/70"
            initial={{ width: 0 }}
            animate={{ width: `${score}%` }}
            transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>

        <p className="text-[10px] text-muted-foreground/45 mt-2.5 leading-relaxed">
          Compounds with every routine, win, and check-in. Never goes down — rest days just pause the clock.
        </p>
      </div>
    </div>
  );
}

// ─── Main Journey page ────────────────────────────────────────────────────────

export default function Journey() {
  const { data: journey, isLoading: journeyLoading } = useGetJourney();
  const { data: moodHistory = [] } = useGetMoodHistory();
  const { data: habits = [] } = useGetHabits();
  const { data: wins = [] } = useGetWins();

  if (journeyLoading || !journey) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-7 h-7 rounded-full border border-primary/40 border-t-transparent animate-spin" />
      </div>
    );
  }

  // Cast to access new fields before types regenerate
  const growthScore = (journey as any).growthScore as number ?? 1;
  const habitMoodInsight = (journey as any).habitMoodInsight as string | null ?? null;

  const chartData = moodHistory
    .map((entry) => ({ name: format(parseISO(entry.date), "MMM d"), score: entry.score }))
    .reverse();

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

  const bestStreak = habits.reduce((max, h) => Math.max(max, h.streak ?? 0), 0);

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-12">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div>
          <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide mb-3">My Progress</h1>
          <div className="h-px bg-primary/20 mb-4" />
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/25 bg-primary/8 text-[10px] font-medium tracking-[0.2em] uppercase text-secondary/80">
            <Map className="w-3 h-3 text-primary/70" />
            Chapter {journey.stage} — {journey.stageLabel}
          </div>
        </div>

        {/* ── 1% Better growth indicator — the centrepiece ─────────────────── */}
        <GrowthIndicatorCard score={growthScore} />

        {/* ── Stat grid ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Day", value: journey.dayCounter, sub: "since you started" },
            { label: "Streak", value: journey.streak, icon: <Flame className="w-3 h-3 text-primary/70" />, sub: "days in a row" },
          ].map(({ label, value, icon, sub }) => (
            <div key={label} className="bg-card border border-primary/15 rounded-2xl p-4 flex flex-col items-center justify-center gap-1 text-center">
              <span className="text-muted-foreground text-[9px] uppercase tracking-[0.2em] flex items-center gap-1">{icon}{label}</span>
              <span className="font-serif text-[32px] text-secondary/90 leading-none">{value}</span>
              <span className="text-[9px] text-muted-foreground/50 tracking-wide">{sub}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Wins", value: journey.winCount, icon: <Trophy className="w-3 h-3 text-primary/70" /> },
            { label: "Routines", value: journey.habitCount ?? 0, icon: <Zap className="w-3 h-3 text-primary/70" /> },
            { label: "Best streak", value: bestStreak > 0 ? `${bestStreak}d` : "—", icon: <Flame className="w-3 h-3 text-primary/70" /> },
          ].map(({ label, value, icon }) => (
            <div key={label} className="bg-card border border-primary/15 rounded-2xl p-3 flex flex-col items-center justify-center gap-1 text-center">
              <span className="text-muted-foreground text-[9px] uppercase tracking-[0.15em] flex items-center gap-1">{icon}{label}</span>
              <span className="font-serif text-[22px] text-secondary/90 leading-none">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Daily Routines / Habits ─────────────────────────────────────────── */}
      <HabitsSection />

      <div className="h-px bg-primary/12" />

      {/* ── Mood chart ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/85">How you've been feeling</h2>
        <div className="bg-card/50 border border-primary/15 rounded-2xl p-5 h-[210px] relative">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 8, left: -24, bottom: 0 }}>
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "hsl(37 20% 50%)", fontSize: 10 }} dy={8} />
                <YAxis domain={[1, 10]} axisLine={false} tickLine={false} tick={{ fill: "hsl(37 20% 50%)", fontSize: 10 }} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: "hsl(257 15% 18%)", border: "1px solid rgba(200,180,150,0.15)", borderRadius: "8px", fontSize: "12px" }}
                  itemStyle={{ color: "hsl(38 44% 89%)" }}
                  labelStyle={{ color: "hsl(268 8% 54%)", marginBottom: "3px" }}
                />
                <Line type="monotone" dataKey="score" stroke="hsl(35 49% 57%)" strokeWidth={1.5}
                  dot={{ fill: "hsl(253 15% 12%)", stroke: "hsl(35 49% 57%)", strokeWidth: 1.5, r: 3 }}
                  activeDot={{ r: 5, fill: "hsl(35 49% 57%)" }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground font-serif italic">
              Checking in with you soon…
            </div>
          )}
        </div>

        {journey.moodCaption && (
          <p className="text-sm text-secondary/60 italic font-serif px-1">"{journey.moodCaption}"</p>
        )}

        {/* Habit-mood insight — server-computed correlation or client fallback */}
        {habitCorrelation && (
          <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-emerald-500/6 border border-emerald-500/15">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400/70 shrink-0 mt-0.5" />
            <p className="text-[12px] text-muted-foreground/70 leading-relaxed">
              {habitCorrelation.text}
            </p>
          </div>
        )}
      </section>

      <div className="h-px bg-primary/12" />

      {/* ── Small Wins ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/85">Small Wins</h2>
        <div className="space-y-3">
          {wins.map((win, i) => (
            <motion.div key={win.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }} className="bg-card border border-primary/15 rounded-xl p-4 flex gap-3">
              <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                <Heart className="w-3.5 h-3.5 text-primary/60" />
              </div>
              <div>
                <p className="text-sm text-foreground/80 leading-relaxed">{win.content}</p>
                <span className="text-[10px] text-muted-foreground/60 mt-1.5 block uppercase tracking-wider">
                  {format(parseISO(win.createdAt), "MMM d, yyyy")}
                </span>
              </div>
            </motion.div>
          ))}
          <AddWinCard />
        </div>
      </section>

      <div className="h-px bg-primary/12" />

      {/* ── Follow-through / Commitments ───────────────────────────────────── */}
      <CommitmentsSection />

      <div className="h-px bg-primary/12" />

      {/* ── Goals ──────────────────────────────────────────────────────────── */}
      <GoalsSection />

      <div className="h-px bg-primary/12" />

      {/* ── Milestones ─────────────────────────────────────────────────────── */}
      <section className="space-y-4 pb-8">
        <h2 className="font-serif text-xl text-foreground/85">Milestones</h2>
        <div className="grid grid-cols-2 gap-3">
          {journey.milestones.map((milestone) => (
            <div key={milestone.id} className={cn(
              "p-4 rounded-xl border flex flex-col items-center justify-center text-center gap-2 transition-all",
              milestone.isUnlocked ? "bg-card border-primary/25" : "bg-card/30 border-primary/10 opacity-45 grayscale",
            )}>
              <div className={cn("w-7 h-7 rounded-full flex items-center justify-center",
                milestone.isUnlocked ? "bg-primary/15 text-primary" : "bg-foreground/5 text-muted-foreground")}>
                {milestone.isUnlocked ? <Star className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
              </div>
              <span className={cn("text-[11px] font-medium tracking-wide leading-snug",
                milestone.isUnlocked ? "text-foreground/80" : "text-muted-foreground")}>
                {milestone.label}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
