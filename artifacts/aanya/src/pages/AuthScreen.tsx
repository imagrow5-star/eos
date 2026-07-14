import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

type Tab = "login" | "signup";

export function AuthScreen() {
  const [tab, setTab] = useState<Tab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const queryClient = useQueryClient();

  const switchTab = (t: Tab) => {
    setTab(t);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
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

          {/* Tab switcher */}
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
                {t === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
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

            {/* Password */}
            <div>
              <label className="block text-[10px] text-muted-foreground tracking-widest uppercase mb-2">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tab === "signup" ? "Minimum 8 characters" : "Your password"}
                autoComplete={tab === "signup" ? "new-password" : "current-password"}
                required
                className="w-full bg-background/50 border border-primary/20 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
              />
            </div>

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
                  : "Create account"}
            </button>
          </form>

          {/* Tab toggle link */}
          <p className="text-center text-xs text-muted-foreground mt-6">
            {tab === "login" ? "New here? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => switchTab(tab === "login" ? "signup" : "login")}
              className="text-primary/80 hover:text-primary transition-colors underline underline-offset-2"
            >
              {tab === "login" ? "Create an account" : "Sign in instead"}
            </button>
          </p>
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
