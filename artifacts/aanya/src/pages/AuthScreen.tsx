import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

type Tab = "login" | "signup" | "forgot" | "reset" | "cancelled";

export function AuthScreen() {
  const [tab, setTab] = useState<Tab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Detect reset token or cancel-reset token in the URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("resetToken");
    const cancelToken = params.get("cancelReset");

    if (token) {
      setResetToken(token);
      setTab("reset");
      // Clean the token from the URL so it isn't accidentally shared
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
      fetch(`${import.meta.env.BASE_URL}api/auth/cancel-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: cancelToken }),
      }).catch(() => {
        // Best-effort — we already switched the tab to show the message
      });
    }
  }, []);

  const switchTab = (t: Tab) => {
    setTab(t);
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      if (tab === "forgot") {
        const r = await fetch(`${import.meta.env.BASE_URL}api/auth/forgot-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        if (!r.ok) {
          const data = await r.json();
          setError(data.error ?? "Something went wrong. Please try again.");
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
        const r = await fetch(`${import.meta.env.BASE_URL}api/auth/reset-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: resetToken, password }),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error ?? "Something went wrong. Please try again.");
          return;
        }
        setSuccess("Your password has been updated. You can now sign in.");
        setResetToken(null);
        setPassword("");
        setConfirmPassword("");
        setTimeout(() => switchTab("login"), 2000);
        return;
      }

      // login / signup
      const endpoint = tab === "signup" ? "signup" : "login";
      const r = await fetch(`${import.meta.env.BASE_URL}api/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = await r.json();

      if (!r.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        return;
      }

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
        <h1 className="font-serif text-5xl text-primary tracking-[0.25em] uppercase mb-2">
          ASHA
        </h1>
        <p className="text-muted-foreground text-sm tracking-widest uppercase">
          Your companion, your story
        </p>
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
                      ? "bg-primary text-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tabLabels[t]}
                </button>
              ))}
            </div>
          )}

          {/* Sub-screen heading for forgot / reset */}
          {(tab === "forgot" || tab === "reset") && (
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
                className="w-full bg-primary text-background py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all mt-2"
              >
                Back to sign in
              </button>
            </motion.div>
          )}

          <AnimatePresence mode="wait">
          {tab !== "cancelled" && (
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
                    className="w-full bg-background/50 border border-primary/20 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
                  />
                </div>
              )}

              {/* Password — shown for login, signup, reset */}
              {tab !== "forgot" && (
                <div>
                  <label className="block text-[10px] text-muted-foreground tracking-widest uppercase mb-2">
                    {tab === "reset" ? "New password" : "Password"}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={tab === "login" ? "Your password" : "Minimum 8 characters"}
                    autoComplete={tab === "login" ? "current-password" : "new-password"}
                    required
                    className="w-full bg-background/50 border border-primary/20 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
                  />
                </div>
              )}

              {/* Confirm password — only for reset */}
              {tab === "reset" && (
                <div>
                  <label className="block text-[10px] text-muted-foreground tracking-widest uppercase mb-2">
                    Confirm new password
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat your new password"
                    autoComplete="new-password"
                    required
                    className="w-full bg-background/50 border border-primary/20 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
                  />
                </div>
              )}

              {/* Forgot password link — only on login tab */}
              {tab === "login" && (
                <div className="text-right -mt-1">
                  <button
                    type="button"
                    onClick={() => switchTab("forgot")}
                    className="text-[11px] text-muted-foreground hover:text-primary transition-colors underline underline-offset-2"
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
                    className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3"
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
                    className="text-sm text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-4 py-3"
                  >
                    {success}
                  </motion.p>
                )}
              </AnimatePresence>

              {/* Submit */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-primary text-background py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed mt-1"
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

          {/* Footer links */}
          <div className="mt-6 text-center space-y-2">
            {(tab === "login" || tab === "signup") && (
              <p className="text-xs text-muted-foreground">
                {tab === "login" ? "New here? " : "Already have an account? "}
                <button
                  type="button"
                  onClick={() => switchTab(tab === "login" ? "signup" : "login")}
                  className="text-primary/80 hover:text-primary transition-colors underline underline-offset-2"
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
                  className="text-primary/80 hover:text-primary transition-colors underline underline-offset-2"
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
        Your conversations and memories are completely private — visible only to you.
      </motion.p>
    </div>
  );
}
