import { useState } from "react";
import { format, parseISO } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Flame, Check, Plus, Trophy, Lock, Heart, Star, Map, Target, Trash2, ChevronDown, ChevronUp,
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

// ─── Goals types ──────────────────────────────────────────────────────────────

interface GoalTask { id: number; content: string; isComplete: boolean; order: number; }
interface Goal { id: number; title: string; description: string; isComplete: boolean; tasks: GoalTask[]; createdAt: string; }

// ─── Goals section ────────────────────────────────────────────────────────────

function GoalsSection() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [goalTitle, setGoalTitle] = useState("");
  const [goalDesc, setGoalDesc] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["goals"],
    queryFn: () => fetch("/api/goals").then((r) => r.json()),
  });

  const createGoal = useMutation({
    mutationFn: (body: { title: string; description: string }) =>
      fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      setAddOpen(false);
      setGoalTitle("");
      setGoalDesc("");
    },
  });

  const deleteGoal = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/goals/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["goals"] }),
  });

  const toggleTask = useMutation({
    mutationFn: ({ goalId, taskId, isComplete }: { goalId: number; taskId: number; isComplete: boolean }) =>
      fetch(`/api/goals/${goalId}/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isComplete }),
      }).then((r) => r.json()),
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
                {/* Goal header */}
                <div className="flex items-center gap-3 p-4">
                  <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <Target className="w-3.5 h-3.5 text-primary/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground/85 leading-snug">{goal.title}</p>
                    {goal.tasks.length > 0 && (
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                        {doneCount} / {goal.tasks.length} steps done
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-7 h-7 text-muted-foreground/50 hover:text-foreground rounded-full"
                      onClick={() => setExpandedId(isExpanded ? null : goal.id)}
                    >
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-7 h-7 text-muted-foreground/50 hover:text-red-400 rounded-full"
                      onClick={() => deleteGoal.mutate(goal.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Progress bar */}
                {goal.tasks.length > 0 && (
                  <div className="mx-4 mb-2 h-0.5 bg-foreground/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary/50 rounded-full transition-all duration-500"
                      style={{ width: `${(doneCount / goal.tasks.length) * 100}%` }}
                    />
                  </div>
                )}

                {/* Sub-tasks */}
                <AnimatePresence>
                  {isExpanded && goal.tasks.length > 0 && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="border-t border-primary/10 overflow-hidden"
                    >
                      {goal.tasks.sort((a, b) => a.order - b.order).map((task) => (
                        <div
                          key={task.id}
                          className="flex items-start gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors"
                        >
                          <button
                            onClick={() =>
                              toggleTask.mutate({
                                goalId: goal.id,
                                taskId: task.id,
                                isComplete: !task.isComplete,
                              })
                            }
                            className={cn(
                              "mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all",
                              task.isComplete
                                ? "bg-primary/20 border-primary/50"
                                : "border-foreground/20 hover:border-primary/50",
                            )}
                          >
                            {task.isComplete && <Check className="w-2.5 h-2.5 text-primary" strokeWidth={3} />}
                          </button>
                          <p className={cn(
                            "text-[13px] leading-relaxed",
                            task.isComplete ? "text-muted-foreground/50 line-through" : "text-foreground/75",
                          )}>
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

          {/* Completed goals (collapsed) */}
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

          {/* Add goal */}
          {addOpen ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="bg-card/60 border border-primary/15 rounded-xl p-4 space-y-3"
            >
              <Input
                placeholder="What's your goal?"
                value={goalTitle}
                onChange={(e) => setGoalTitle(e.target.value)}
                className="bg-background/50 border-primary/15 text-sm text-foreground/80 placeholder:text-muted-foreground/50"
                autoFocus
              />
              <Input
                placeholder="A bit more context (optional)"
                value={goalDesc}
                onChange={(e) => setGoalDesc(e.target.value)}
                className="bg-background/50 border-primary/15 text-sm text-foreground/80 placeholder:text-muted-foreground/50"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" className="text-muted-foreground h-8 text-xs" onClick={() => setAddOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25"
                  disabled={!goalTitle.trim() || createGoal.isPending}
                  onClick={() => createGoal.mutate({ title: goalTitle, description: goalDesc })}
                >
                  {createGoal.isPending ? "Breaking it down…" : "Set goal"}
                </Button>
              </div>
              {createGoal.isPending && (
                <p className="text-[11px] text-muted-foreground/60 italic text-center">
                  Breaking your goal into steps…
                </p>
              )}
            </motion.div>
          ) : (
            <button
              onClick={() => setAddOpen(true)}
              className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm"
            >
              <Plus className="w-4 h-4" />
              Set a new goal
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Add Habit card ───────────────────────────────────────────────────────────

function AddHabitCard() {
  const queryClient = useQueryClient();
  const createHabit = useCreateHabit();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [whenThen, setWhenThen] = useState("");
  const [reason, setReason] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !whenThen.trim() || !reason.trim()) return;
    createHabit.mutate(
      { data: { name, whenThen, reason } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetHabitsQueryKey() });
          setIsOpen(false); setName(""); setWhenThen(""); setReason("");
        },
      },
    );
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm"
      >
        <Plus className="w-4 h-4" />
        Begin a new small routine
      </button>
    );
  }

  return (
    <motion.form
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      onSubmit={handleSubmit}
      className="bg-card/60 border border-primary/15 rounded-xl p-4 space-y-3"
    >
      <Input placeholder="Routine name" value={name} onChange={(e) => setName(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50" />
      <Input placeholder="When/Then (After waking up, I will…)" value={whenThen} onChange={(e) => setWhenThen(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50" />
      <Input placeholder="Why this matters to you" value={reason} onChange={(e) => setReason(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50" />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => setIsOpen(false)} className="text-muted-foreground h-8 text-xs">Cancel</Button>
        <Button type="submit" size="sm" className="h-8 text-xs bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25" disabled={createHabit.isPending}>
          {createHabit.isPending ? "Saving…" : "Commit"}
        </Button>
      </div>
    </motion.form>
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
    createWin.mutate(
      { data: { content } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetWinsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetJourneyQueryKey() });
          setIsOpen(false); setContent("");
        },
      },
    );
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm"
      >
        <Plus className="w-4 h-4" />
        Note a win
      </button>
    );
  }

  return (
    <motion.form
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      onSubmit={handleSubmit}
      className="bg-card/60 border border-primary/15 rounded-xl p-4 flex gap-2 items-start"
    >
      <Input placeholder="What small thing did you do or feel today?" value={content} onChange={(e) => setContent(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm text-foreground/80 placeholder:text-muted-foreground/50" />
      <Button type="submit" className="bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25 shrink-0" disabled={createWin.isPending}>
        {createWin.isPending ? "…" : "Save"}
      </Button>
    </motion.form>
  );
}

// ─── Main Journey page ────────────────────────────────────────────────────────

export default function Journey() {
  const queryClient = useQueryClient();
  const { data: journey, isLoading: journeyLoading } = useGetJourney();
  const { data: moodHistory = [] } = useGetMoodHistory();
  const { data: habits = [] } = useGetHabits();
  const { data: wins = [] } = useGetWins();
  const completeHabit = useCompleteHabit();

  const handleCompleteHabit = (id: number) => {
    completeHabit.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetHabitsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetJourneyQueryKey() });
        },
      },
    );
  };

  if (journeyLoading || !journey) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-7 h-7 rounded-full border border-primary/40 border-t-transparent animate-spin" />
      </div>
    );
  }

  const chartData = moodHistory
    .map((entry) => ({ name: format(parseISO(entry.date), "MMM d"), score: entry.score }))
    .reverse();

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-12">
      {/* ── Header & Stats ─────────────────────────────────────────────────── */}
      <div className="space-y-6">
        <div>
          <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide mb-3">Your Journey</h1>
          <div className="h-px bg-primary/20 mb-4" />
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/25 bg-primary/8 text-[10px] font-medium tracking-[0.2em] uppercase text-secondary/80">
            <Map className="w-3 h-3 text-primary/70" />
            Chapter {journey.stage} — {journey.stageLabel}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Day", value: journey.dayCounter },
            { label: "Streak", value: journey.streak, icon: <Flame className="w-3 h-3 text-primary/70" /> },
            { label: "Wins", value: journey.winCount, icon: <Trophy className="w-3 h-3 text-primary/70" /> },
          ].map(({ label, value, icon }) => (
            <div key={label} className="bg-card border border-primary/15 rounded-2xl p-4 flex flex-col items-center justify-center gap-1">
              <span className="text-muted-foreground text-[9px] uppercase tracking-[0.2em] flex items-center gap-1">{icon}{label}</span>
              <span className="font-serif text-[26px] text-secondary/90 leading-none">{value}</span>
            </div>
          ))}
        </div>
      </div>

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
                  contentStyle={{ backgroundColor: "hsl(222 47% 14%)", border: "1px solid hsl(40 30% 28%)", borderRadius: "8px", fontSize: "12px" }}
                  itemStyle={{ color: "hsl(43 50% 80%)" }}
                  labelStyle={{ color: "hsl(37 20% 58%)", marginBottom: "3px" }}
                />
                <Line type="monotone" dataKey="score" stroke="hsl(40 56% 50%)" strokeWidth={1.5}
                  dot={{ fill: "hsl(220 50% 11%)", stroke: "hsl(40 56% 50%)", strokeWidth: 1.5, r: 3 }}
                  activeDot={{ r: 5, fill: "hsl(40 56% 50%)" }} />
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
      </section>

      <div className="h-px bg-primary/12" />

      {/* ── Goals ──────────────────────────────────────────────────────────── */}
      <GoalsSection />

      <div className="h-px bg-primary/12" />

      {/* ── Habits ─────────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/85">Anchors</h2>
        <div className="space-y-3">
          {habits.map((habit) => {
            const isCompletedToday = habit.lastCompleted &&
              format(parseISO(habit.lastCompleted), "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");

            return (
              <div key={habit.id} className="bg-card border border-primary/15 rounded-2xl p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium text-foreground/85 text-sm truncate">{habit.name}</h3>
                    {habit.streak > 0 && (
                      <span className="flex items-center text-[10px] text-primary/80 font-medium shrink-0">
                        <Flame className="w-3 h-3 mr-0.5" />{habit.streak}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground/70 leading-relaxed">{habit.whenThen}</p>
                  <div className="flex gap-1.5 mt-3">
                    {Array.from({ length: 7 }).map((_, i) => {
                      const dateStr = format(new Date(Date.now() - (6 - i) * 86400000), "yyyy-MM-dd");
                      const done = habit.recentCompletions.some((c) => c.startsWith(dateStr));
                      return (
                        <div key={i} className={cn("w-1.5 h-1.5 rounded-full transition-all", done ? "bg-primary/70" : "bg-foreground/10")} />
                      );
                    })}
                  </div>
                </div>
                <Button
                  size="icon"
                  className={cn(
                    "rounded-full w-10 h-10 shrink-0 transition-all",
                    isCompletedToday ? "bg-primary/15 text-primary border border-primary/30" : "bg-card border border-primary/20 text-muted-foreground hover:bg-primary/10 hover:text-primary hover:border-primary/30",
                  )}
                  onClick={() => !isCompletedToday && handleCompleteHabit(habit.id)}
                  disabled={!!isCompletedToday || completeHabit.isPending}
                >
                  <Check className="w-4 h-4" strokeWidth={isCompletedToday ? 3 : 2} />
                </Button>
              </div>
            );
          })}
          <AddHabitCard />
        </div>
      </section>

      <div className="h-px bg-primary/12" />

      {/* ── Milestones ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/85">Pathways</h2>
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

      <div className="h-px bg-primary/12" />

      {/* ── Small Wins ─────────────────────────────────────────────────────── */}
      <section className="space-y-4 pb-8">
        <h2 className="font-serif text-xl text-foreground/85">Small Wins</h2>
        <div className="space-y-3">
          {wins.map((win, i) => (
            <motion.div key={win.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
              className="bg-card border border-primary/15 rounded-xl p-4 flex gap-3">
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
    </div>
  );
}
