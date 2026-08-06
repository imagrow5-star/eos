import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route, Switch, Router as WouterRouter } from "wouter";
import { Shell } from "@/components/layout/Shell";
import { SplashScreen } from "@/components/SplashScreen";
import { CONSENT_VERSION } from "@/lib/consent";

// Every page is code-split so first paint only ships the shell + the one
// screen the visitor actually lands on. Chat alone drags in the ElevenLabs/
// LiveKit voice stack and Journey drags in recharts — neither belongs in the
// entry bundle that logged-out visitors (and every first-time tester on a
// mid-range phone) must download before anything renders.
const Chat = lazy(() => import("@/pages/Chat"));
const Journey = lazy(() => import("@/pages/Journey"));
const Chapters = lazy(() => import("@/pages/Chapters"));
const Memory = lazy(() => import("@/pages/Memory"));
const AuthScreen = lazy(() =>
  import("@/pages/AuthScreen").then((m) => ({ default: m.AuthScreen })),
);
const Pricing = lazy(() =>
  import("@/pages/Pricing").then((m) => ({ default: m.Pricing })),
);
const EmailVerificationGate = lazy(() =>
  import("@/pages/EmailVerificationGate").then((m) => ({ default: m.EmailVerificationGate })),
);
const ConsentGate = lazy(() =>
  import("@/pages/ConsentGate").then((m) => ({ default: m.ConsentGate })),
);
const Privacy = lazy(() =>
  import("@/pages/Privacy").then((m) => ({ default: m.Privacy })),
);
const LandingPage = lazy(() =>
  import("@/pages/LandingPage").then((m) => ({ default: m.LandingPage })),
);

// Same centered spinner the auth/consent gates already use, so a suspended
// chunk load is visually indistinguishable from the existing loading states.
function PageLoader() {
  return (
    <div className="min-h-[100dvh] bg-background flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}

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
      {/* Inner boundary: switching tabs swaps only the page area while the
          shell (bottom nav) stays mounted. */}
      <Suspense fallback={<PageLoader />}>
      <Switch>
        <Route path="/" component={Chat} />
        <Route path="/journey" component={Journey} />
        <Route path="/chapters" component={Chapters} />
        <Route path="/memory" component={Memory} />
        <Route path="/pricing">{() => <Pricing />}</Route>
        <Route>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Page not found
          </div>
        </Route>
      </Switch>
      </Suspense>
    </Shell>
  );
}

// ─── Auth gate — sits between QueryClientProvider and the main app ────────────

// View shown to logged-out visitors before they touch the auth flow.
// "landing" = marketing homepage; "login" / "signup" = auth screen.
type UnauthView = "landing" | "login" | "signup";

// Outcome of consuming a ?verifyToken link — drives the feedback banner so an
// expired/invalid link is never a silent dead-end.
type VerifyNotice = { kind: "ok" | "failed"; message: string };

function AuthGate() {
  const qc = useQueryClient();
  const [verifying, setVerifying] = useState(false);
  const [verifyNotice, setVerifyNotice] = useState<VerifyNotice | null>(null);

  // Landing page → auth screen navigation (no URL change needed; the
  // public landing page IS the root, so we just switch React state).
  // A ?googleError= redirect (failed/cancelled Google sign-in) must land on
  // the AUTH screen where the friendly message renders — never the landing
  // page, which would swallow it.
  const [unauthView, setUnauthView] = useState<UnauthView>(() =>
    new URLSearchParams(window.location.search).has("googleError") ? "login" : "landing",
  );

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
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        if (r.ok) {
          setVerifyNotice({ kind: "ok", message: "Email verified — you can sign in." });
          await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
        } else {
          setVerifyNotice({
            kind: "failed",
            message: body?.error ?? "This verification link is invalid or has expired.",
          });
        }
      })
      .catch(() => {
        setVerifyNotice({
          kind: "failed",
          message: "We couldn't verify your email. Please check your connection and try again.",
        });
      })
      .finally(() => setVerifying(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The banner dismisses itself; failures linger longer so the user can read
  // why the link didn't work before the resend option in front of them.
  useEffect(() => {
    if (!verifyNotice) return;
    const t = setTimeout(
      () => setVerifyNotice(null),
      verifyNotice.kind === "ok" ? 8000 : 15000,
    );
    return () => clearTimeout(t);
  }, [verifyNotice]);

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

  // Feedback for a consumed ?verifyToken link, overlaid on whichever screen
  // the user lands on (landing page, auth screen, or the verification gate).
  const verifyBanner = verifyNotice && (
    <div
      role="status"
      className={
        "fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-sm rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur-md " +
        (verifyNotice.kind === "ok"
          ? "bg-emerald-400/10 border-emerald-400/30 text-emerald-400"
          : "bg-red-400/10 border-red-400/30 text-red-400")
      }
    >
      <div className="flex items-start gap-3">
        <p className="flex-1 leading-relaxed">{verifyNotice.message}</p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setVerifyNotice(null)}
          className="opacity-60 hover:opacity-100 transition-opacity"
        >
          ✕
        </button>
      </div>
    </div>
  );

  // Not authenticated — landing page for the root, auth screen for login/signup
  if (!data) {
    // /pricing works signed-out too: same cards, but choosing a plan routes
    // into account creation first (checkout requires a verified account).
    if (window.location.pathname.endsWith("/pricing")) {
      return (
        <>
          {verifyBanner}
          <Pricing
            signedOut
            onCreateAccount={() => {
              const url = new URL(window.location.href);
              url.pathname = url.pathname.replace(/\/pricing$/, "/") || "/";
              window.history.replaceState({}, "", url.toString());
              setUnauthView("signup");
            }}
          />
        </>
      );
    }
    if (unauthView === "landing") {
      return (
        <>
          {verifyBanner}
          <LandingPage
            onLogin={() => setUnauthView("login")}
            onSignup={() => setUnauthView("signup")}
          />
        </>
      );
    }
    return (
      <>
        {verifyBanner}
        <AuthScreen initialTab={unauthView === "signup" ? "signup" : "login"} />
      </>
    );
  }

  // Authenticated but email not yet verified
  if (!data.emailVerified) {
    return (
      <>
        {verifyBanner}
        <EmailVerificationGate
          email={data.user.email}
          onVerified={() => qc.invalidateQueries({ queryKey: ["/api/auth/me"] })}
        />
      </>
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
          className="px-6 py-2.5 rounded-xl border border-primary/40 text-primary-strong text-sm hover:bg-primary/10 transition-colors"
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
    return (
      <Suspense fallback={<PageLoader />}>
        <Privacy />
      </Suspense>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/*
       * AuthGate always renders — it fires /api/auth/me immediately so the
       * auth check runs in the background while the splash plays.  By the
       * time the splash is gone the correct screen (login or chat) is already
       * ready underneath.
       */}
      <Suspense fallback={<PageLoader />}>
        <AuthGate />
      </Suspense>

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
