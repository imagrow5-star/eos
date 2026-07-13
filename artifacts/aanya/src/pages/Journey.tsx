import { useState } from "react";
import { format, parseISO } from "date-fns";
import { motion } from "framer-motion";
import { Flame, Check, Plus, Trophy, Lock, Heart, Star, Calendar, ArrowRight } from "lucide-react";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  ResponsiveContainer, 
  Tooltip as RechartsTooltip 
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
  getGetJourneyQueryKey
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
        }
      }
    );
  };

  if (!isOpen) {
    return (
      <button 
        onClick={() => setIsOpen(true)}
        className="w-full py-4 rounded-xl border border-dashed border-white/10 text-muted-foreground hover:text-primary hover:border-primary/30 hover:bg-primary/5 transition-all flex items-center justify-center gap-2 text-sm"
      >
        <Plus className="w-4 h-4" />
        Start a new tiny habit
      </button>
    );
  }

  return (
    <motion.form 
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      onSubmit={handleSubmit}
      className="bg-card/40 border border-white/5 rounded-xl p-4 space-y-3"
    >
      <Input 
        placeholder="Habit name (e.g. Drink water)" 
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="bg-background/50 border-white/5 text-sm h-9"
      />
      <Input 
        placeholder="When/Then (e.g. After waking up, I will...)" 
        value={whenThen}
        onChange={(e) => setWhenThen(e.target.value)}
        className="bg-background/50 border-white/5 text-sm h-9"
      />
      <Input 
        placeholder="Why this matters to you" 
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="bg-background/50 border-white/5 text-sm h-9"
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => setIsOpen(false)} className="text-muted-foreground h-8 text-xs">
          Cancel
        </Button>
        <Button type="submit" size="sm" className="h-8 text-xs bg-primary/20 text-primary hover:bg-primary/30" disabled={createHabit.isPending}>
          {createHabit.isPending ? "Adding..." : "Commit"}
        </Button>
      </div>
    </motion.form>
  );
}

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
        }
      }
    );
  };

  if (!isOpen) {
    return (
      <button 
        onClick={() => setIsOpen(true)}
        className="w-full py-4 rounded-xl border border-dashed border-white/10 text-muted-foreground hover:text-secondary hover:border-secondary/30 hover:bg-secondary/5 transition-all flex items-center justify-center gap-2 text-sm"
      >
        <Plus className="w-4 h-4" />
        Log a win today
      </button>
    );
  }

  return (
    <motion.form 
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      onSubmit={handleSubmit}
      className="bg-card/40 border border-white/5 rounded-xl p-4 space-y-3 flex gap-2 items-start"
    >
      <Input 
        placeholder="What small thing did you achieve?" 
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="bg-background/50 border-white/5 text-sm"
      />
      <Button type="submit" className="bg-secondary/20 text-secondary hover:bg-secondary/30 shrink-0" disabled={createWin.isPending}>
        {createWin.isPending ? "Saving" : "Save"}
      </Button>
    </motion.form>
  );
}

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
        }
      }
    );
  };

  if (journeyLoading || !journey) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  const chartData = moodHistory.map(entry => ({
    name: format(parseISO(entry.date), 'MMM d'),
    score: entry.score,
    fullDate: entry.date
  })).reverse(); // Assuming API might send newest first, we want chronological for chart

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-12">
      {/* Header & Stats */}
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-serif text-3xl text-foreground tracking-wide mb-2">Your Journey</h1>
            <div className="inline-flex items-center px-3 py-1 rounded-full bg-secondary/15 border border-secondary/20 text-secondary-foreground text-xs font-medium tracking-widest uppercase">
              Chapter {journey.stage}: {journey.stageLabel}
            </div>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="flex-1 bg-card/40 border border-white/5 rounded-2xl p-4 flex flex-col items-center justify-center">
            <span className="text-muted-foreground text-[10px] uppercase tracking-widest mb-1">Day</span>
            <span className="font-serif text-2xl text-foreground">{journey.dayCounter}</span>
          </div>
          <div className="flex-1 bg-card/40 border border-white/5 rounded-2xl p-4 flex flex-col items-center justify-center">
            <span className="text-muted-foreground text-[10px] uppercase tracking-widest mb-1 flex items-center gap-1">
              <Flame className="w-3 h-3 text-secondary" /> Streak
            </span>
            <span className="font-serif text-2xl text-foreground">{journey.streak}</span>
          </div>
          <div className="flex-1 bg-card/40 border border-white/5 rounded-2xl p-4 flex flex-col items-center justify-center">
            <span className="text-muted-foreground text-[10px] uppercase tracking-widest mb-1 flex items-center gap-1">
              <Trophy className="w-3 h-3 text-primary" /> Wins
            </span>
            <span className="font-serif text-2xl text-foreground">{journey.winCount}</span>
          </div>
        </div>
      </div>

      {/* Mood Chart */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/90">How you've been feeling</h2>
        
        <div className="bg-card/20 border border-white/5 rounded-3xl p-6 h-[220px] relative">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <XAxis 
                  dataKey="name" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  dy={10}
                />
                <YAxis 
                  domain={[1, 10]} 
                  axisLine={false} 
                  tickLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px' }}
                  itemStyle={{ color: 'hsl(var(--primary))' }}
                  labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
                />
                <Line 
                  type="monotone" 
                  dataKey="score" 
                  stroke="hsl(var(--primary))" 
                  strokeWidth={2}
                  dot={{ fill: 'hsl(var(--background))', stroke: 'hsl(var(--primary))', strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6, fill: 'hsl(var(--primary))' }}
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
          <p className="text-sm text-primary/80 italic px-2">"{journey.moodCaption}"</p>
        )}
      </section>

      {/* Habits */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/90">Anchors</h2>
        <div className="space-y-3">
          {habits.map(habit => {
            const isCompletedToday = habit.lastCompleted && format(parseISO(habit.lastCompleted), 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
            
            return (
              <div key={habit.id} className="bg-card/40 border border-white/5 rounded-2xl p-4 flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium text-foreground">{habit.name}</h3>
                    {habit.streak > 0 && (
                      <span className="flex items-center text-[10px] text-secondary font-medium tracking-wide">
                        <Flame className="w-3 h-3 mr-0.5" /> {habit.streak}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{habit.whenThen}</p>
                  
                  {/* Mini recent dots */}
                  <div className="flex gap-1.5 mt-3">
                    {/* Render last 7 days slots, filled if date matches recent completions */}
                    {Array.from({length: 7}).map((_, i) => {
                      const dateStr = format(new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000), 'yyyy-MM-dd');
                      const done = habit.recentCompletions.some(c => c.startsWith(dateStr));
                      return (
                        <div 
                          key={i} 
                          className={cn(
                            "w-1.5 h-1.5 rounded-full transition-all",
                            done ? "bg-primary/80 shadow-[0_0_5px_rgba(157,113,232,0.5)]" : "bg-white/10"
                          )} 
                        />
                      );
                    })}
                  </div>
                </div>
                
                <Button
                  size="icon"
                  className={cn(
                    "rounded-full w-10 h-10 transition-all",
                    isCompletedToday 
                      ? "bg-primary/20 text-primary border border-primary/30" 
                      : "bg-card border border-white/10 text-muted-foreground hover:bg-primary/10 hover:text-primary hover:border-primary/30"
                  )}
                  onClick={() => !isCompletedToday && handleCompleteHabit(habit.id)}
                  disabled={!!isCompletedToday || completeHabit.isPending}
                >
                  <Check className="w-5 h-5" strokeWidth={isCompletedToday ? 3 : 2} />
                </Button>
              </div>
            );
          })}
          
          <AddHabitCard />
        </div>
      </section>

      {/* Milestones */}
      <section className="space-y-4">
        <h2 className="font-serif text-xl text-foreground/90">Pathways</h2>
        <div className="grid grid-cols-2 gap-3">
          {journey.milestones.map(milestone => (
            <div 
              key={milestone.id} 
              className={cn(
                "p-4 rounded-2xl border flex flex-col items-center justify-center text-center gap-2 transition-all",
                milestone.isUnlocked 
                  ? "bg-primary/10 border-primary/20 shadow-[0_0_15px_rgba(157,113,232,0.05)]" 
                  : "bg-card/20 border-white/5 opacity-50 grayscale"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center",
                milestone.isUnlocked ? "bg-primary/20 text-primary" : "bg-white/5 text-muted-foreground"
              )}>
                {milestone.isUnlocked ? <Star className="w-4 h-4 fill-primary/20" /> : <Lock className="w-4 h-4" />}
              </div>
              <span className={cn(
                "text-xs font-medium",
                milestone.isUnlocked ? "text-foreground" : "text-muted-foreground"
              )}>
                {milestone.label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Wins */}
      <section className="space-y-4 pb-8">
        <h2 className="font-serif text-xl text-foreground/90">Small Wins</h2>
        <div className="space-y-3">
          {wins.map((win, i) => (
            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
              key={win.id} 
              className="bg-card/40 border border-white/5 rounded-2xl p-4 flex gap-3"
            >
              <div className="w-8 h-8 rounded-full bg-secondary/10 flex items-center justify-center shrink-0">
                <Heart className="w-4 h-4 text-secondary/70" />
              </div>
              <div>
                <p className="text-sm text-foreground/90 leading-relaxed">{win.content}</p>
                <span className="text-[10px] text-muted-foreground mt-1.5 block uppercase tracking-wider">
                  {format(parseISO(win.createdAt), 'MMM d, yyyy')}
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
