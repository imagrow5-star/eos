import { useGetProfile, useGetMemoryFacts, useGetPersonalitySignals } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Sparkles, Brain, Check, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Memory() {
  const { data: profile } = useGetProfile();
  const { data: facts = [] } = useGetMemoryFacts();
  const { data: signals = [] } = useGetPersonalitySignals();

  const companionName = profile?.companionName || "Aanya";

  const categories = [
    { id: "preference", label: "Preferences" },
    { id: "person", label: "People" },
    { id: "event", label: "Events" },
    { id: "goal", label: "Hopes & Goals" },
    { id: "life", label: "Life Facts" }
  ];

  const hasNoData = facts.length === 0 && signals.length === 0;

  return (
    <div className="h-full overflow-y-auto px-6 py-10 pb-20 space-y-12">
      <div className="space-y-2">
        <h1 className="font-serif text-3xl text-foreground tracking-wide">
          What {companionName} remembers
        </h1>
        <p className="text-sm text-muted-foreground">
          The pieces of you she holds onto.
        </p>
      </div>

      {hasNoData ? (
        <div className="bg-card/30 border border-white/5 rounded-3xl p-8 text-center flex flex-col items-center justify-center gap-4 h-64 mt-12">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-primary/50" />
          </div>
          <p className="text-sm text-muted-foreground font-serif italic max-w-[200px] leading-relaxed">
            {companionName} is still getting to know you. The more you share, the more she'll remember.
          </p>
        </div>
      ) : (
        <>
          {/* Her read on you */}
          {signals.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-2 mb-6">
                <Brain className="w-5 h-5 text-secondary" />
                <h2 className="font-serif text-xl text-foreground/90">Her read on you</h2>
              </div>
              
              <div className="grid gap-3">
                {signals.map((signal, i) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.1 }}
                    key={signal.id} 
                    className="bg-card/40 border border-white/5 rounded-2xl p-4 flex flex-col gap-3 relative overflow-hidden"
                  >
                    <div className="absolute top-0 right-0 w-24 h-24 bg-secondary/5 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2" />
                    
                    <p className="text-sm text-foreground/90 leading-relaxed relative z-10">{signal.signal}</p>
                    
                    <div className="flex items-center justify-between mt-1 relative z-10">
                      <span className={cn(
                        "text-[10px] uppercase tracking-widest flex items-center gap-1.5 font-medium",
                        signal.isActive ? "text-primary" : "text-muted-foreground"
                      )}>
                        {signal.isActive ? <Check className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        {signal.isActive ? "Confirmed" : "Still observing"}
                      </span>
                      
                      {/* Subtle confidence dots */}
                      <div className="flex gap-1">
                        {[1, 2, 3].map(dot => (
                          <div 
                            key={dot}
                            className={cn(
                              "w-1.5 h-1.5 rounded-full",
                              dot <= signal.observedCount 
                                ? (signal.isActive ? "bg-primary/80" : "bg-muted-foreground/60") 
                                : "bg-white/10"
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

          {/* Things she knows */}
          {facts.length > 0 && (
            <section className="space-y-6 pt-4">
              <h2 className="font-serif text-xl text-foreground/90 mb-6">Things she knows</h2>
              
              <div className="space-y-8">
                {categories.map(category => {
                  const categoryFacts = facts.filter(f => f.category === category.id);
                  if (categoryFacts.length === 0) return null;
                  
                  return (
                    <div key={category.id} className="space-y-3">
                      <h3 className="text-xs uppercase tracking-widest text-muted-foreground pl-2">{category.label}</h3>
                      <div className="flex flex-wrap gap-2">
                        {categoryFacts.map(fact => (
                          <span 
                            key={fact.id} 
                            className="inline-flex px-3 py-1.5 bg-card/60 border border-white/5 rounded-full text-sm text-foreground/80 shadow-sm"
                          >
                            {fact.fact}
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
