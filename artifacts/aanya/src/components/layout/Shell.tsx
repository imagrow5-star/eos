import { Link, useLocation } from "wouter";
import { MessageSquare, Sparkles, Map } from "lucide-react";
import { cn } from "@/lib/utils";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", icon: MessageSquare, label: "Chat" },
    { href: "/journey", icon: Map, label: "Journey" },
    { href: "/memory", icon: Sparkles, label: "Memory" },
  ];

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden relative">
      <main className="flex-1 overflow-hidden relative z-10 pb-[72px]">
        {children}
      </main>

      {/* Bottom Navigation */}
      <nav className="absolute bottom-0 left-0 right-0 h-[72px] bg-card/80 backdrop-blur-xl border-t border-white/5 z-20 px-6 flex items-center justify-around pb-safe">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href} className="flex flex-col items-center justify-center w-16 h-full gap-1 group">
              <div className={cn(
                "p-2 rounded-full transition-all duration-300",
                isActive 
                  ? "bg-primary/20 text-primary shadow-[0_0_15px_rgba(157,113,232,0.3)]" 
                  : "text-muted-foreground group-hover:text-primary/70"
              )}>
                <item.icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
              </div>
              <span className={cn(
                "text-[10px] tracking-wide transition-colors",
                isActive ? "text-primary font-medium" : "text-muted-foreground"
              )}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
