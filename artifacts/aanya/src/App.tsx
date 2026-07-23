import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route, Switch, Router as WouterRouter } from "wouter";
import { Shell } from "@/components/layout/Shell";
import Chat from "@/pages/Chat";
import Journey from "@/pages/Journey";
import Chapters from "@/pages/Chapters";
import Memory from "@/pages/Memory";
import { AuthScreen } from "@/pages/AuthScreen";
import { EmailVerificationGate } from "@/pages/EmailVerificationGate";
import { ConsentGate } from "@/pages/ConsentGate";
import { Privacy } from "@/pages/Privacy";
import { LandingPage } from "@/pages/LandingPage";
import { SplashScreen } from "@/components/SplashScreen";
import { CONSENT_VERSION } from "@/lib/consent";

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
      apiFetch(`${import.meta.env.BASE_URL}api/profile`, {
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
        <Route path="/chapters" component={Chapters} />
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

// View shown to logged-out visitors before they touch the auth flow.
// "landing" = marketing homepage; "login" / "signup" = auth screen.
type UnauthView = "landing" | "login" | "signup";

function AuthGate() {
  const qc = useQueryClient();
  const [verifying, setVerifying] = useState(false);

  // Landing page → auth screen navigation (no URL change needed; the
  // public landing page IS the root, so we just switch React state).
  const [unauthView, setUnauthView] = useState<UnauthView>("landing");

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
    apiFetch(`${import.meta.env.BASE_URL}api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.ok) {
          await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
        }
      })
      .catch(() => {})
      .finally(() => setVerifying(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useQuery({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/me`);
      if (!r.ok) throw new Error("Not authenticated");
      return r.json() as Promise<{ user: { id: number; email: string }; emailVerified: boolean }>;
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // Consent check (Phase A privacy) — runs only once authenticated + verified.
  // New users see the consent screen BEFORE onboarding asks anything personal;
  // existing users see it once when the consent copy version changes.
  const authedAndVerified = Boolean(data?.emailVerified);
  const {
    data: consentProfile,
    isLoading: consentLoading,
    isError: consentError,
  } = useQuery({
    queryKey: ["/api/profile", "consent-gate"],
    enabled: authedAndVerified,
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/profile`);
      if (!r.ok) throw new Error("Profile unavailable");
      return r.json() as Promise<{ consentVersion?: string | null; userName?: string }>;
    },
    staleTime: Infinity,
  });

  // Loading state (initial fetch or verifying token)
  if (isLoading || verifying) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  // Not authenticated — landing page for the root, auth screen for login/signup
  if (!data) {
    if (unauthView === "landing") {
      return (
        <LandingPage
          onLogin={() => setUnauthView("login")}
          onSignup={() => setUnauthView("signup")}
        />
      );
    }
    return <AuthScreen initialTab={unauthView === "signup" ? "signup" : "login"} />;
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

  // Consent gate — resolve before any page can collect or show personal data.
  // Explicit error branch (review finding): never spinner-lock users when the
  // profile fetch fails — offer a reload, which also recovers dead sessions.
  if (consentError) {
    return (
      <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center gap-5 px-6">
        <p className="text-sm text-muted-foreground/70 text-center max-w-xs leading-relaxed">
          We couldn't load your profile. Please check your connection and try again.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2.5 rounded-xl border border-primary/40 text-primary text-sm hover:bg-primary/10 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }
  if (consentLoading || !consentProfile) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }
  if (consentProfile.consentVersion !== CONSENT_VERSION) {
    return (
      <ConsentGate
        isReturningUser={Boolean(consentProfile.userName)}
        onDone={async () => {
          // Resolves when the refetch settles; on failure the consentError
          // branch above takes over, so the gate can never hang silently.
          await qc.invalidateQueries({ queryKey: ["/api/profile", "consent-gate"] });
        }}
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
  // Public privacy page — reachable without an account so the sign-up screen
  // and the consent step can link to it. Plain pathname check (full-page
  // navigation) keeps it outside the authed router entirely.
  const isPrivacyPage =
    typeof window !== "undefined" &&
    window.location.pathname.replace(/\/+$/, "").endsWith("/privacy");

  // Show splash once per browser session — sessionStorage resets when the tab
  // is closed, so the user sees it on every fresh visit but not on in-app nav.
  const [showSplash, setShowSplash] = useState(() => {
    try {
      return !sessionStorage.getItem("eos-splash-shown");
    } catch {
      // If sessionStorage is blocked, skip the splash entirely rather than
      // risk blocking the user.
      return false;
    }
  });

  // ── Hard kill-switch ────────────────────────────────────────────────────────
  // This runs entirely at the App level — independent of SplashScreen's own
  // timers.  Even if SplashScreen's useEffect, onDone callback, or Framer
  // Motion internals stall (slow device, throttled RAF, JS error inside the
  // component), the splash will be gone by 3 s.
  const hardKillRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!showSplash) return; // already hidden, nothing to do
    hardKillRef.current = setTimeout(() => {
      setShowSplash(false);
    }, 3000);
    return () => {
      if (hardKillRef.current) clearTimeout(hardKillRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSplashDone = () => {
    if (hardKillRef.current) clearTimeout(hardKillRef.current);
    try {
      sessionStorage.setItem("eos-splash-shown", "1");
    } catch {}
    setShowSplash(false);
  };

  if (isPrivacyPage) {
    return <Privacy />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/*
       * AuthGate always renders — it fires /api/auth/me immediately so the
       * auth check runs in the background while the splash plays.  By the
       * time the splash is gone the correct screen (login or chat) is already
       * ready underneath.
       */}
      <AuthGate />

      {/*
       * Splash overlay — fixed z-50, sits on top of AuthGate.
       * We do NOT use AnimatePresence here: its exit transition relies on RAF
       * and can stall on slow devices, leaving an invisible but pointer-events-
       * blocking layer over the login screen.  SplashScreen itself handles the
       * CSS fade and calls onDone() only after the fade completes.
       */}
      {showSplash && <SplashScreen onDone={handleSplashDone} />}
    </QueryClientProvider>
  );
}

export default App;
