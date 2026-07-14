import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/layout/Shell';
import Chat from '@/pages/Chat';
import Journey from '@/pages/Journey';
import Memory from '@/pages/Memory';

const queryClient = new QueryClient();

// ─── Timezone detection & sync ────────────────────────────────────────────────
// Runs once on app load. Detects the browser's IANA timezone and saves it to
// the profile so all date/time logic on the server uses the user's local time.

function useTimezoneSync() {
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz) return;

      // Fire-and-forget — we don't need to await this, and it's idempotent
      // (the server only writes if the value changed)
      fetch(`${import.meta.env.BASE_URL ?? ""}api/profile`.replace(/([^:])\/\//, "$1/"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: tz }),
      }).catch(() => {
        // Silently swallow — timezone sync is a best-effort operation
      });
    } catch {
      // Intl not available in some very old environments — safe to ignore
    }
  }, []); // runs once on mount
}

function Router() {
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

function App() {
  useTimezoneSync();

  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
        <Router />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
