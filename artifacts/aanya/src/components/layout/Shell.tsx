import { Link, useLocation } from "wouter";
import { apiFetch } from "@/lib/api";
import { clearSessionDrafts } from "@/lib/sessionDrafts";
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
    // Logout = "done on this device": wipe per-tab drafts (chat draft, auth
    // form state, any pending reset token) so nothing carries into the next
    // session — matters on shared devices.
    clearSessionDrafts();
    // Invalidate auth query — AuthGate will redirect to login screen
    queryClient.setQueryData(["/api/auth/me"], null);
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  };

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] w-full bg-background overflow-hidden relative">
      {/* ── Desktop left rail — replaces the bottom bar on md+ so the chat
           column isn't full-bleed on wide screens ─────────────────────── */}
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 h-full border-r border-border bg-card/40 px-4 py-6">
        <div className="flex flex-col items-start px-2 mb-8 select-none">
          <span className="font-serif text-xl font-medium tracking-[0.4em] text-foreground/90">E O S</span>
          <div className="h-px w-8 bg-primary/50 my-1.5" />
          <p className="font-serif italic text-[11px] tracking-[0.14em] text-muted-foreground">a new dawn</p>
        </div>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group",
                  isActive
                    ? "bg-primary/12 text-primary-strong"
                    : "text-muted-foreground hover:text-foreground/80 hover:bg-muted/60",
                )}
              >
                <item.icon className="w-4.5 h-4.5 w-[18px] h-[18px]" strokeWidth={isActive ? 2.4 : 1.75} />
                <span className={cn("text-[13px] tracking-wide", isActive && "font-medium")}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <button
          onClick={handleLogout}
          className="mt-auto flex items-center gap-3 px-3 py-2.5 rounded-xl text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/60 transition-all"
          title="Sign out"
        >
          <LogOut className="w-4 h-4" strokeWidth={1.5} />
          <span className="text-[13px] tracking-wide">Sign out</span>
        </button>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden relative z-10 pb-[72px] md:pb-0">
        {children}
      </main>

      {/* Bottom Navigation — gold hairline top border, deep navy base */}
      <nav className="md:hidden absolute bottom-0 left-0 right-0 h-[72px] bg-card/90 backdrop-blur-xl border-t border-primary/20 z-20 px-4 flex items-center justify-around pb-safe">
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
                  ? "bg-primary/15 text-primary-strong"
                  : "text-muted-foreground group-hover:text-secondary/70"
              )}>
                <item.icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 1.75} />
              </div>
              <span className={cn(
                "text-[10px] tracking-widest uppercase transition-colors",
                isActive ? "text-primary-strong font-medium" : "text-muted-foreground"
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
