import { Link, useLocation } from "wouter";
import { apiFetch } from "@/lib/api";
import { MessageSquare, Sparkles, Map, Feather, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const queryClient = useQueryClient();

  const navItems = [
    { href: "/", icon: MessageSquare, label: "Chat" },
    { href: "/journey", icon: Map, label: "Journey" },
    { href: "/chapters", icon: Feather, label: "Chapters" },
    { href: "/memory", icon: Sparkles, label: "Memory" },
  ];

  const handleLogout = async () => {
    try {
      await apiFetch(`${import.meta.env.BASE_URL}api/auth/logout`, { method: "POST" });
    } catch {}
    // Invalidate auth query — AuthGate will redirect to login screen
    queryClient.setQueryData(["/api/auth/me"], null);
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  };

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden relative">
      <main className="flex-1 overflow-hidden relative z-10 pb-[72px]">
        {children}
      </main>

      {/* Bottom Navigation — gold hairline top border, deep navy base */}
      <nav className="absolute bottom-0 left-0 right-0 h-[72px] bg-card/90 backdrop-blur-xl border-t border-primary/20 z-20 px-4 flex items-center justify-around pb-safe">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col items-center justify-center w-16 h-full gap-1 group"
            >
              <div className={cn(
                "p-2 rounded-full transition-all duration-300",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground group-hover:text-secondary/70"
              )}>
                <item.icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 1.75} />
              </div>
              <span className={cn(
                "text-[10px] tracking-widest uppercase transition-colors",
                isActive ? "text-primary font-medium" : "text-muted-foreground"
              )}>
                {item.label}
              </span>
            </Link>
          );
        })}

        {/* Log out — subtle, far right */}
        <button
          onClick={handleLogout}
          className="flex flex-col items-center justify-center w-16 h-full gap-1 group"
          title="Sign out"
          aria-label="Sign out"
        >
          <div className="p-2 rounded-full transition-all duration-300 text-muted-foreground/50 group-hover:text-muted-foreground">
            <LogOut className="w-4 h-4" strokeWidth={1.5} />
          </div>
          <span className="text-[9px] tracking-widest uppercase text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors">
            Out
          </span>
        </button>
      </nav>
    </div>
  );
}
