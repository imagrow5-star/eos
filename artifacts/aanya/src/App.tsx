import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route, Switch, Router as WouterRouter } from "wouter";
import { Shell } from "@/components/layout/Shell";
import Chat from "@/pages/Chat";
import Journey from "@/pages/Journey";
import Memory from "@/pages/Memory";
import { AuthScreen } from "@/pages/AuthScreen";
import { EmailVerificationGate } from "@/pages/EmailVerificationGate";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

// ─── Main app (shown when authenticated + verified) ───────────────────────────

function AppRouter() {
  // Sync browser timezone to profile once after login
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz) return;
      fetch(`${import.meta.env.BASE_URL}api/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: tz }),
      }).catch(() => {});
    } catch {}
  }, []);

  return (
    <Shell>
      <Switch>
        <Route path="/" component={Chat} />
        <Route path="/journey" component={Journey} />
        <Route path="/memory" component={Memory} />
        <Route>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Page not found
          </div>
        </Route>
      </Switch>
    </Shell>
  );
}

// ─── Auth gate — sits between QueryClientProvider and the main app ────────────

function AuthGate() {
  const qc = useQueryClient();
  const [verifying, setVerifying] = useState(false);

  // Handle ?verifyToken= in the URL — consume it immediately on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("verifyToken");
    if (!token) return;

    // Clean the token from the URL right away so it isn't replayed
    const url = new URL(window.location.href);
    url.searchParams.delete("verifyToken");
    window.history.replaceState({}, "", url.toString());

    setVerifying(true);
    fetch(`${import.meta.env.BASE_URL}api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.ok) {
          // Invalidate /auth/me so the gate re-fetches and shows the app
          await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
        }
        // On failure we silently fall through — the AuthScreen will show an error
        // if the user still isn't verified.
      })
      .catch(() => {})
      .finally(() => setVerifying(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useQuery({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const r = await fetch(`${import.meta.env.BASE_URL}api/auth/me`);
      if (!r.ok) throw new Error("Not authenticated");
      return r.json() as Promise<{ user: { id: number; email: string }; emailVerified: boolean }>;
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // Loading state (initial fetch or verifying token)
  if (isLoading || verifying) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  // Not authenticated — show sign-in / sign-up screen
  if (!data) {
    return <AuthScreen />;
  }

  // Authenticated but email not yet verified
  if (!data.emailVerified) {
    return (
      <EmailVerificationGate
        email={data.user.email}
        onVerified={() => qc.invalidateQueries({ queryKey: ["/api/auth/me"] })}
      />
    );
  }

  // Authenticated + verified — show the companion app inside the router
  return (
    <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
      <AppRouter />
    </WouterRouter>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  );
}

export default App;
