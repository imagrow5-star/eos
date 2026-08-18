import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { PasswordInput } from "@/components/PasswordInput";
import { resolveInitialAuthTab } from "@/lib/authEntry";
import {
  AUTH_DRAFT_KEY as DRAFT_KEY,
  RESET_TOKEN_KEY,
  clearSessionDrafts,
} from "@/lib/sessionDrafts";

type Tab = "login" | "signup" | "forgot" | "reset" | "cancelled" | "emailChangeCancelled";

// Non-sensitive in-progress auth state survives mobile tab discards and
// reloads via sessionStorage (per-tab, cleared when the tab closes).
// Passwords are NEVER persisted anywhere. The reset token is kept here too:
// we strip it from the URL for privacy, but mobile browsers routinely discard
// backgrounded tabs — without this, coming back from the email app reloaded
// the page tokenless and dumped the user on the login tab mid-reset.
function readDraft(): { tab?: Tab; email?: string } {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { tab?: string; email?: string };
    const restorable: Tab[] = ["login", "signup", "forgot", "reset"];
    return {
      tab: restorable.includes(parsed.tab as Tab) ? (parsed.tab as Tab) : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
    };
  } catch {
    return {};
  }
}

function readStoredResetToken(): string | null {
  try {
    return sessionStorage.getItem(RESET_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function AuthScreen({ initialTab = "login" }: { initialTab?: "login" | "signup" }) {
  const [tab, setTab] = useState<Tab>(() => {
    // Pure, unit-tested decision (lib/authEntry.ts): stored reset token wins;
    // explicit URL intent (?mode=login, ?enter=1) outranks a remembered
    // draft; mid-flow forgot-password drafts survive; reset is never
    // restored without a token.
    const draftTab = readDraft().tab;
    return resolveInitialAuthTab({
      search: window.location.search,
      hasStoredResetToken: readStoredResetToken() !== null,
      draftTab: draftTab === "cancelled" || draftTab === "emailChangeCancelled" ? undefined : draftTab,
      initialTab,
    });
  });
  const [email, setEmail] = useState(() => readDraft().email ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expiredToken, setExpiredToken] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(readStoredResetToken);
  // "Continue with Google" is shown only when the backend reports the OAuth
  // env vars are configured — otherwise the button doesn't exist at all.
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    apiFetch(`${import.meta.env.BASE_URL}api/auth/google/available`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { available?: boolean } | null) => {
        if (!cancelled && body?.available === true) setGoogleAvailable(true);
      })
      .catch(() => {}); // unreachable → keep the button hidden
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the draft current (tab + email only — never passwords).
  useEffect(() => {
    try {
      if (tab === "cancelled" || tab === "emailChangeCancelled") return;
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ tab, email }));
    } catch {}
  }, [tab, email]);

  // Detect reset token or cancel-reset token in the URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("resetToken");
    const cancelToken = params.get("cancelReset");
    const cancelEmailChangeToken = params.get("cancelEmailChange");
    const googleError = params.get("googleError");

    if (googleError) {
      // A failed/cancelled Google sign-in redirected back here — show a
      // friendly line, never a raw error. Strip the param immediately.
      const url = new URL(window.location.href);
      url.searchParams.delete("googleError");
      window.history.replaceState({}, "", url.toString());
      const messages: Record<string, string> = {
        cancelled: "Google sign-in was cancelled. Nothing was changed.",
        unavailable: "Google sign-in isn't available right now. Please use your email instead.",
        failed: "Google sign-in didn't go through. Please try again, or sign in with your email.",
      };
      setError(messages[googleError] ?? messages.failed!);
    }

    if (token) {
      setResetToken(token);
      setTab("reset");
      // Keep it in per-tab storage so a reload (mobile tab discard, back
      // button) doesn't strand the user without the token…
      try {
        sessionStorage.setItem(RESET_TOKEN_KEY, token);
      } catch {}
      // …and clean it from the URL so it isn't accidentally shared
      const url = new URL(window.location.href);
      url.searchParams.delete("resetToken");
      window.history.replaceState({}, "", url.toString());
    } else if (cancelToken) {
      // Clean the token from the URL immediately
      const url = new URL(window.location.href);
      url.searchParams.delete("cancelReset");
      window.history.replaceState({}, "", url.toString());

      // Fire cancel request
      setTab("cancelled");
      apiFetch(`${import.meta.env.BASE_URL}api/auth/cancel-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: cancelToken }),
      }).catch(() => {
        // Best-effort — we already switched the tab to show the message
      });
    } else if (cancelEmailChangeToken) {
      // Clean the token from the URL immediately
      const url = new URL(window.location.href);
      url.searchParams.delete("cancelEmailChange");
      window.history.replaceState({}, "", url.toString());

      // Fire cancel request
      setTab("emailChangeCancelled");
      apiFetch(`${import.meta.env.BASE_URL}api/auth/cancel-email-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: cancelEmailChangeToken }),
      }).catch(() => {
        // Best-effort — we already switched the tab to show the message
      });
    }
  }, []);

  const switchTab = (t: Tab) => {
    if (tab === "reset" && t !== "reset") {
      // Leaving the reset flow discards the locally-held link token.
      try {
        sessionStorage.removeItem(RESET_TOKEN_KEY);
      } catch {}
      setResetToken(null);
    }
    setTab(t);
    setError(null);
    setExpiredToken(false);
    setSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      if (tab === "forgot") {
        const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/forgot-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        if (!r.ok) {
          const data = (await r.json().catch(() => null)) as { error?: string } | null;
          setError(data?.error ?? "Something went wrong. Please try again.");
          return;
        }
        setSuccess(
          "If an account with that email exists, you'll receive a reset link shortly. Check your inbox (and spam folder).",
        );
        setEmail("");
        return;
      }

      if (tab === "reset") {
        if (password !== confirmPassword) {
          setError("Passwords don't match.");
          return;
        }
        const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/reset-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: resetToken, password }),
        });
        const data = (await r.json().catch(() => null)) as
          | { error?: string; code?: string }
          | null;
        if (!r.ok) {
          if (data?.code === "TOKEN_EXPIRED") {
            setExpiredToken(true);
            setError(null);
          } else {
            setError(data?.error ?? "Something went wrong. Please try again.");
          }
          return;
        }
        setSuccess("Your password has been updated. You can now sign in.");
        setResetToken(null);
        try {
          sessionStorage.removeItem(RESET_TOKEN_KEY);
        } catch {}
        setPassword("");
        setConfirmPassword("");
        setTimeout(() => switchTab("login"), 2000);
        return;
      }

      // login / signup
      const endpoint = tab === "signup" ? "signup" : "login";
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = (await r.json().catch(() => null)) as { error?: string } | null;

      if (!r.ok) {
        setError(data?.error ?? "Something went wrong. Please try again.");
        return;
      }

      // Fresh session: wipe per-tab drafts so nothing from the signed-out
      // context (auth-form email, a chat draft from another account, a
      // pending reset token) leaks into it — matters on shared devices.
      clearSessionDrafts();

      // Invalidate the /auth/me query — the AuthGate will re-fetch and show the app
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const tabLabels: Record<Tab, string> = {
    login: "Sign in",
    signup: "Create account",
    forgot: "Reset password",
    reset: "Set new password",
    cancelled: "Reset cancelled",
    emailChangeCancelled: "Email change cancelled",
  };

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center px-6 py-12">

      {/* Brand */}
      <motion.div
        className="mb-10 text-center"
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      >
        <h1 className="font-serif text-5xl text-foreground tracking-[0.3em] uppercase mb-3">
          EOS
        </h1>
        <div className="h-px w-10 bg-primary/55 mx-auto mb-2.5" />
      </motion.div>

      {/* Card */}
      <motion.div
        className="w-full max-w-sm"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
      >
        <div className="bg-card/70 backdrop-blur-xl border border-primary/20 rounded-2xl p-8 shadow-2xl">

          {/* Tab switcher (only for login/signup) */}
          {(tab === "login" || tab === "signup") && (
            <div className="flex rounded-xl bg-background/60 p-1 mb-8 gap-1">
              {(["login", "signup"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => switchTab(t)}
                  className={cn(
                    "flex-1 py-2.5 text-sm rounded-lg font-medium tracking-wide transition-all duration-200",
                    tab === t
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tabLabels[t]}
                </button>
              ))}
            </div>
          )}

          {/* Sub-screen heading for forgot / reset */}
          {(tab === "forgot" || tab === "reset") &&
            !expiredToken &&
            !(tab === "reset" && !resetToken && !success) && (
            <div className="mb-8">
              <h2 className="text-xl font-serif text-foreground mb-1">
                {tabLabels[tab]}
              </h2>
              <p className="text-xs text-muted-foreground tracking-wide">
                {tab === "forgot"
                  ? "Enter your email and we'll send you a reset link."
                  : "Choose a new password for your account."}
              </p>
            </div>
          )}

          {/* Expired token screen */}
          {tab === "reset" && expiredToken && (
            <motion.div
              key="expired"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="text-center space-y-5 py-2"
            >
              <div className="text-4xl">⏰</div>
              <h2 className="text-xl font-serif text-foreground">Link expired</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                This reset link has expired. Password reset links are only valid for a short time for your security.
              </p>
              <button
                type="button"
                onClick={() => {
                  setExpiredToken(false);
                  setResetToken(null);
                  setPassword("");
                  setConfirmPassword("");
                  switchTab("forgot");
                }}
                className="w-full bg-primary text-primary-foreground py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all mt-2"
              >
                Request a new link
              </button>
              <button
                type="button"
                onClick={() => switchTab("login")}
                className="w-full text-xs text-muted-foreground hover:text-primary-strong transition-colors underline underline-offset-2 pb-1"
              >
                ← Back to sign in
              </button>
            </motion.div>
          )}

          {/* Reset link no longer on hand (e.g. opened in a different tab or
              the stored token was cleared) — dead-end prevention: without this
              the form would submit token:null and fail with a generic error. */}
          {tab === "reset" && !expiredToken && !resetToken && !success && (
            <motion.div
              key="tokenMissing"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="text-center space-y-5 py-2"
            >
              <div className="text-4xl">🔗</div>
              <h2 className="text-xl font-serif text-foreground">Link not available</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                This reset link isn't available on this device anymore. Request a fresh
                one below. It only takes a moment.
              </p>
              <button
                type="button"
                onClick={() => switchTab("forgot")}
                className="w-full bg-primary text-primary-foreground py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all mt-2"
              >
                Request a new link
              </button>
              <button
                type="button"
                onClick={() => switchTab("login")}
                className="w-full text-xs text-muted-foreground hover:text-primary-strong transition-colors underline underline-offset-2 pb-1"
              >
                ← Back to sign in
              </button>
            </motion.div>
          )}

          {/* Cancelled reset screen */}
          {tab === "cancelled" && (
            <motion.div
              key="cancelled"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="text-center space-y-5 py-2"
            >
              <div className="text-4xl">🔒</div>
              <h2 className="text-xl font-serif text-foreground">Reset cancelled</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The password reset request has been cancelled. Any pending reset links are now invalid and your password remains unchanged.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                If you believe someone else requested this, consider updating your password as a precaution.
              </p>
              <button
                type="button"
                onClick={() => switchTab("login")}
                className="w-full bg-primary text-primary-foreground py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all mt-2"
              >
                Back to sign in
              </button>
            </motion.div>
          )}

          {/* Cancelled email-change screen */}
          {tab === "emailChangeCancelled" && (
            <motion.div
              key="emailChangeCancelled"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="text-center space-y-5 py-2"
            >
              <div className="text-4xl">🔒</div>
              <h2 className="text-xl font-serif text-foreground">Email change cancelled</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The request to change your account's email address has been cancelled. Your account keeps its current email, and nothing was changed.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                If you didn't request this, we recommend updating your password as a precaution.
              </p>
              <button
                type="button"
                onClick={() => switchTab("login")}
                className="w-full bg-primary text-primary-foreground py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all mt-2"
              >
                Back to sign in
              </button>
            </motion.div>
          )}

          <AnimatePresence mode="wait">
          {tab !== "cancelled" &&
            tab !== "emailChangeCancelled" &&
            !(tab === "reset" && expiredToken) &&
            !(tab === "reset" && !resetToken && !success) && (
            <motion.form
              key={tab}
              onSubmit={handleSubmit}
              className="space-y-5"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.2 }}
            >
              {/* Email — shown for login, signup, forgot */}
              {tab !== "reset" && (
                <div>
                  <label className="block text-[10px] text-muted-foreground tracking-widest uppercase mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                    className="w-full bg-background/50 border border-primary/20 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
                  />
                </div>
              )}

              {/* Password — shown for login, signup, reset */}
              {tab !== "forgot" && (
                <div>
                  <label className="block text-[10px] text-muted-foreground tracking-widest uppercase mb-2">
                    {tab === "reset" ? "New password" : "Password"}
                  </label>
                  <PasswordInput
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={tab === "login" ? "Your password" : "Minimum 8 characters"}
                    autoComplete={tab === "login" ? "current-password" : "new-password"}
                    required
                    className="w-full bg-background/50 border border-primary/20 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
                  />
                </div>
              )}

              {/* Confirm password — only for reset */}
              {tab === "reset" && (
                <div>
                  <label className="block text-[10px] text-muted-foreground tracking-widest uppercase mb-2">
                    Confirm new password
                  </label>
                  <PasswordInput
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat your new password"
                    autoComplete="new-password"
                    required
                    className="w-full bg-background/50 border border-primary/20 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
                  />
                </div>
              )}

              {/* Forgot password link — only on login tab */}
              {tab === "login" && (
                <div className="text-right -mt-1">
                  <button
                    type="button"
                    onClick={() => switchTab("forgot")}
                    className="text-[11px] text-muted-foreground hover:text-primary-strong transition-colors underline underline-offset-2"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {/* Error message */}
              <AnimatePresence mode="wait">
                {error && (
                  <motion.p
                    key="error"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-sm text-red-700 dark:text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3"
                  >
                    {error}
                  </motion.p>
                )}
                {success && (
                  <motion.p
                    key="success"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-4 py-3"
                  >
                    {success}
                  </motion.p>
                )}
              </AnimatePresence>

              {/* Submit */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-primary text-primary-foreground py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed mt-1"
              >
                {isSubmitting
                  ? "Please wait…"
                  : tab === "login"
                    ? "Sign in"
                    : tab === "signup"
                      ? "Create account"
                      : tab === "forgot"
                        ? "Send reset link"
                        : "Update password"}
              </button>
            </motion.form>
          )}
          </AnimatePresence>

          {/* ── "Continue with Google" — additional sign-in option ──
              Rendered only when the backend reports the feature configured;
              shown on both the sign-in and sign-up tabs. Full-page redirect
              into the server-side OAuth flow (GET /api/auth/google). */}
          {googleAvailable && (tab === "login" || tab === "signup") && (
            <div className="mt-5">
              <div className="flex items-center gap-3 mb-5">
                <div className="flex-1 h-px bg-border/60" />
                <span className="text-[11px] text-muted-foreground/60 uppercase tracking-[0.2em]">or</span>
                <div className="flex-1 h-px bg-border/60" />
              </div>
              <button
                type="button"
                onClick={() => {
                  window.location.href = `${import.meta.env.BASE_URL}api/auth/google`;
                }}
                // Neutral theme-aware surface (tracks light/dark) with the
                // official multicolor G — matches Google's light and dark
                // button specs closely enough in both modes.
                className="w-full flex items-center justify-center gap-3 bg-card border border-border text-foreground/90 py-3 rounded-xl font-medium text-[14.5px] hover:border-secondary/40 hover:bg-muted active:scale-[0.98] transition-all"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                  <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
                </svg>
                Continue with Google
              </button>
            </div>
          )}

          {/* Footer links */}
          <div className="mt-6 text-center space-y-2">
            {(tab === "login" || tab === "signup") && (
              <p className="text-xs text-muted-foreground">
                {tab === "login" ? "New here? " : "Already have an account? "}
                <button
                  type="button"
                  onClick={() => switchTab(tab === "login" ? "signup" : "login")}
                  className="text-primary-strong/80 hover:text-primary-strong transition-colors underline underline-offset-2"
                >
                  {tab === "login" ? "Create an account" : "Sign in instead"}
                </button>
              </p>
            )}
            {(tab === "forgot" || tab === "reset") && (
              <p className="text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => switchTab("login")}
                  className="text-primary-strong/80 hover:text-primary-strong transition-colors underline underline-offset-2"
                >
                  ← Back to sign in
                </button>
              </p>
            )}
          </div>
        </div>
      </motion.div>

      {/* Privacy note */}
      <motion.p
        className="text-muted-foreground/40 text-xs mt-8 text-center max-w-xs leading-relaxed"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
      >
        Your conversations are private and encrypted, never sold, never used to train AI.{" "}
        <a
          href={`${import.meta.env.BASE_URL}privacy`}
          className="text-primary-strong/60 hover:text-primary-strong underline underline-offset-2 transition-colors"
        >
          How your data is handled
        </a>
      </motion.p>
    </div>
  );
}
