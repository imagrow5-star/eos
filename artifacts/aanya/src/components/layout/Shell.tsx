import { Link, useLocation } from "wouter";
import { apiFetch } from "@/lib/api";
import { clearSessionDrafts } from "@/lib/sessionDrafts";
import { requestOpenSettings } from "@/lib/settingsBus";
import { MessageSquare, Sparkles, Map, Feather, LogOut, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();

  const navItems = [
    { href: "/", icon: MessageSquare, label: "Private room" },
    { href: "/journey", icon: Map, label: "Journey" },
    { href: "/chapters", icon: Feather, label: "Chapters" },
    { href: "/memory", icon: Sparkles, label: "Memory" },
  ];

  // Settings lives inside the Private-room page (the panel under its header),
  // but must be reachable from EVERY page. The nav entry navigates there and
  // asks the page to open the panel (see lib/settingsBus.ts).
  const openSettings = () => {
    requestOpenSettings();
    if (location !== "/") navigate("/");
  };

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

          {/* Settings — an action, not a page, so it sits below a hairline and
              carries the soft green accent (same family as the header button):
              always visible, clearly a button, still calm. */}
          <div className="h-px bg-border/70 my-2 mx-1" />
          <button
            onClick={openSettings}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-primary/10 border border-primary/25 text-primary-strong hover:bg-primary/20 hover:border-primary/40 transition-all duration-200"
          >
            <Settings className="w-[18px] h-[18px]" strokeWidth={2} />
            <span className="text-[13px] tracking-wide font-medium">Settings</span>
          </button>
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

      {/* Bottom Navigation */}
      {/* Items size to their content (shrink-0, justify-around) rather than
          equal flex shares: six entries at 390px can't split evenly without
          clipping PRIVATE ROOM, but the natural widths fit down to ~360px. */}
      <nav className="md:hidden absolute bottom-0 left-0 right-0 h-[72px] bg-card/90 backdrop-blur-xl border-t border-primary/20 z-20 px-2 flex items-center justify-around pb-safe">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col items-center justify-center shrink-0 h-full gap-1 group"
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
                "text-[9px] tracking-wide uppercase whitespace-nowrap transition-colors",
                isActive ? "text-primary-strong font-medium" : "text-muted-foreground"
              )}>
                {item.label}
              </span>
            </Link>
          );
        })}

        {/* Settings — accented like the desktop rail entry so it reads as the
            one action among the tabs. */}
        <button
          onClick={openSettings}
          className="flex flex-col items-center justify-center shrink-0 h-full gap-1 group"
          aria-label="Settings"
        >
          <div className="p-2 rounded-full bg-primary/12 border border-primary/25 text-primary-strong transition-all duration-300 group-hover:bg-primary/20">
            <Settings className="w-5 h-5" strokeWidth={2} />
          </div>
          <span className="text-[9px] tracking-wide uppercase whitespace-nowrap text-primary-strong font-medium">
            Settings
          </span>
        </button>

        {/* Log out — subtle, far right, icon-only to give the six labelled
            entries their room. */}
        <button
          onClick={handleLogout}
          className="flex flex-col items-center justify-center shrink-0 w-10 h-full gap-1 group"
          title="Sign out"
          aria-label="Sign out"
        >
          <div className="p-2 rounded-full transition-all duration-300 text-muted-foreground/50 group-hover:text-muted-foreground">
            <LogOut className="w-4 h-4" strokeWidth={1.5} />
          </div>
        </button>
      </nav>
    </div>
  );
}
