import { useState } from "react";
import { format, parseISO } from "date-fns";
import { motion } from "framer-motion";
import { Flame, Check, Plus, Trophy, Lock, Heart, Star, Map } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";

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
          setIsOpen(false);
          setName("");
          setWhenThen("");
          setReason("");
        },
      }
    );
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm btn-action"
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
      <Input
        placeholder="Routine name (e.g. Morning walk)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50"
      />
      <Input
        placeholder="When/Then (e.g. After waking up, I will...)"
        value={whenThen}
        onChange={(e) => setWhenThen(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50"
      />
      <Input
        placeholder="Why this matters to you"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm h-9 text-foreground/80 placeholder:text-muted-foreground/50"
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsOpen(false)}
          className="text-muted-foreground h-8 text-xs"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-8 text-xs bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25"
          disabled={createHabit.isPending}
        >
          {createHabit.isPending ? "Saving..." : "Commit"}
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
          setIsOpen(false);
          setContent("");
        },
      }
    );
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full py-4 rounded-xl border border-dashed border-primary/20 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm btn-action"
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
      className="bg-card/60 border border-primary/15 rounded-xl p-4 space-y-3 flex gap-2 items-start"
    >
      <Input
        placeholder="What small thing did you do or feel today?"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="bg-background/50 border-primary/15 text-sm text-foreground/80 placeholder:text-muted-foreground/50"
      />
      <Button
        type="submit"
        className="bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25 shrink-0 btn-action"
        disabled={createWin.isPending}
      >
        {createWin.isPending ? "Saving" : "Save"}
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
      }
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
    .map((entry) => ({
      name: format(parseISO(entry.date), "MMM d"),
      score: entry.score,
      fullDate: entry.date,
    }))
    .reverse();

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-12">
      {/* ── Header & Stats ─────────────────────────────────────────────────── */}
      <div className="space-y-6">
        <div>
          <h1 className="font-serif text-[28px] text-foreground/90 tracking-wide mb-3">
            Your Journey
          </h1>
          {/* Gold hairline + stage badge */}
          <div className="h-px bg-primary/20 mb-4" />
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/25 bg-primary/8 text-[10px] font-medium tracking-[0.2em] uppercase text-secondary/80">
            <Map className="w-3 h-3 text-primary/70" />
            Chapter {journey.stage} — {journey.stageLabel}
          </div>
        </div>

        {/* Stat cards — champagne numbers in serif */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Day", value: journey.dayCounter },
            {
              label: "Streak",
              value: journey.streak,
              icon: <Flame className="w-3 h-3 text-primary/70" />,
            },
            {
              label: "Wins",
              value: journey.winCount,
              icon: <Trophy className="w-3 h-3 text-primary/70" />,
            },
          ].map(({ label, value, icon }) => (
            <div
              key={label}
              className="bg-card border border-primary/15 rounded-2xl p-4 flex flex-col items-center justify-center gap-1"
            >
              <span className="text-muted-foreground text-[9px] uppercase tracking-[0.2em] flex items-center gap-1">
                {icon}
                {label}
              </span>
              <span className="font-serif text-[26px] text-secondary/90 leading-none">
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Mood chart ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/85">
          How you've been feeling
        </h2>

        <div className="bg-card/50 border border-primary/15 rounded-2xl p-5 h-[210px] relative">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 10, right: 8, left: -24, bottom: 0 }}
              >
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "hsl(37 20% 50%)", fontSize: 10 }}
                  dy={8}
                />
                <YAxis
                  domain={[1, 10]}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "hsl(37 20% 50%)", fontSize: 10 }}
                />
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "hsl(222 47% 14%)",
                    border: "1px solid hsl(40 30% 28%)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  itemStyle={{ color: "hsl(43 50% 80%)" }}
                  labelStyle={{
                    color: "hsl(37 20% 58%)",
                    marginBottom: "3px",
                  }}
                />
                {/* Gold mood line */}
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="hsl(40 56% 50%)"
                  strokeWidth={1.5}
                  dot={{
                    fill: "hsl(220 50% 11%)",
                    stroke: "hsl(40 56% 50%)",
                    strokeWidth: 1.5,
                    r: 3,
                  }}
                  activeDot={{ r: 5, fill: "hsl(40 56% 50%)" }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground font-serif italic">
              Checking in with you soon...
            </div>
          )}
        </div>

        {journey.moodCaption && (
          <p className="text-sm text-secondary/60 italic font-serif px-1">
            "{journey.moodCaption}"
          </p>
        )}
      </section>

      {/* Gold hairline section divider */}
      <div className="h-px bg-primary/12" />

      {/* ── Habits ─────────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/85">Anchors</h2>
        <div className="space-y-3">
          {habits.map((habit) => {
            const isCompletedToday =
              habit.lastCompleted &&
              format(parseISO(habit.lastCompleted), "yyyy-MM-dd") ===
                format(new Date(), "yyyy-MM-dd");

            return (
              <div
                key={habit.id}
                className="bg-card border border-primary/15 rounded-2xl p-4 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium text-foreground/85 text-sm truncate">
                      {habit.name}
                    </h3>
                    {habit.streak > 0 && (
                      <span className="flex items-center text-[10px] text-primary/80 font-medium shrink-0">
                        <Flame className="w-3 h-3 mr-0.5" />
                        {habit.streak}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground/70 leading-relaxed">
                    {habit.whenThen}
                  </p>

                  {/* 7-day completion dots — gold fill */}
                  <div className="flex gap-1.5 mt-3">
                    {Array.from({ length: 7 }).map((_, i) => {
                      const dateStr = format(
                        new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000),
                        "yyyy-MM-dd"
                      );
                      const done = habit.recentCompletions.some((c) =>
                        c.startsWith(dateStr)
                      );
                      return (
                        <div
                          key={i}
                          className={cn(
                            "w-1.5 h-1.5 rounded-full transition-all",
                            done
                              ? "bg-primary/70"
                              : "bg-foreground/10"
                          )}
                        />
                      );
                    })}
                  </div>
                </div>

                <Button
                  size="icon"
                  className={cn(
                    "rounded-full w-10 h-10 shrink-0 transition-all btn-action",
                    isCompletedToday
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "bg-card border border-primary/20 text-muted-foreground hover:bg-primary/10 hover:text-primary hover:border-primary/30"
                  )}
                  onClick={() =>
                    !isCompletedToday && handleCompleteHabit(habit.id)
                  }
                  disabled={!!isCompletedToday || completeHabit.isPending}
                >
                  <Check
                    className="w-4 h-4"
                    strokeWidth={isCompletedToday ? 3 : 2}
                  />
                </Button>
              </div>
            );
          })}

          <AddHabitCard />
        </div>
      </section>

      {/* Gold hairline */}
      <div className="h-px bg-primary/12" />

      {/* ── Milestones ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/85">Pathways</h2>
        <div className="grid grid-cols-2 gap-3">
          {journey.milestones.map((milestone) => (
            <div
              key={milestone.id}
              className={cn(
                "p-4 rounded-xl border flex flex-col items-center justify-center text-center gap-2 transition-all",
                milestone.isUnlocked
                  ? "bg-card border-primary/25"
                  : "bg-card/30 border-primary/10 opacity-45 grayscale"
              )}
            >
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center",
                  milestone.isUnlocked
                    ? "bg-primary/15 text-primary"
                    : "bg-foreground/5 text-muted-foreground"
                )}
              >
                {milestone.isUnlocked ? (
                  <Star className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
              </div>
              <span
                className={cn(
                  "text-[11px] font-medium tracking-wide leading-snug",
                  milestone.isUnlocked
                    ? "text-foreground/80"
                    : "text-muted-foreground"
                )}
              >
                {milestone.label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Gold hairline */}
      <div className="h-px bg-primary/12" />

      {/* ── Small Wins ─────────────────────────────────────────────────────── */}
      <section className="space-y-4 pb-8">
        <h2 className="font-serif text-xl text-foreground/85">Small Wins</h2>
        <div className="space-y-3">
          {wins.map((win, i) => (
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              key={win.id}
              className="bg-card border border-primary/15 rounded-xl p-4 flex gap-3"
            >
              <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                <Heart className="w-3.5 h-3.5 text-primary/60" />
              </div>
              <div>
                <p className="text-sm text-foreground/80 leading-relaxed">
                  {win.content}
                </p>
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
