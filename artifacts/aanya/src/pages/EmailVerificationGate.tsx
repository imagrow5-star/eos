import { useState } from "react";
import { motion } from "framer-motion";
import { ChangeEmailForm } from "@/components/ChangeEmailForm";

interface Props {
  email: string;
  onVerified: () => void;
}

export function EmailVerificationGate({ email, onVerified }: Props) {
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [showChangeEmail, setShowChangeEmail] = useState(false);

  const handleResend = async () => {
    setResendStatus("sending");
    setError(null);
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}api/auth/resend-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!r.ok) {
        const data = await r.json();
        setError(data.error ?? "Something went wrong. Please try again.");
        setResendStatus("error");
        return;
      }
      setResendStatus("sent");
    } catch {
      setError("Network error. Please check your connection and try again.");
      setResendStatus("error");
    }
  };

  const handleLogout = async () => {
    await fetch(`${import.meta.env.BASE_URL}api/auth/logout`, { method: "POST" });
    onVerified(); // triggers re-check of /auth/me → will show auth screen
  };

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center px-6 py-12">
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
        <p className="font-serif italic text-muted-foreground text-sm tracking-wider">
          a new dawn
        </p>
      </motion.div>

      <motion.div
        className="w-full max-w-sm"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
      >
        <div className="bg-card/70 backdrop-blur-xl border border-primary/20 rounded-2xl p-8 shadow-2xl text-center">
          {/* Icon */}
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <svg
              className="w-8 h-8 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>

          <h2 className="font-serif text-2xl text-foreground mb-3">
            Verify your email
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed mb-2">
            We sent a verification link to
          </p>
          <p className="text-sm font-medium text-foreground mb-6 break-all">
            {email}
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed mb-8">
            Click the link in that email to activate your account. Check your spam folder if you don't see it.
          </p>

          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3 mb-4">
              {error}
            </p>
          )}

          {resendStatus === "sent" && (
            <p className="text-sm text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-4 py-3 mb-4">
              A new verification link is on its way. Check your inbox.
            </p>
          )}

          <button
            onClick={handleResend}
            disabled={resendStatus === "sending" || resendStatus === "sent"}
            className="w-full bg-primary text-background py-3.5 rounded-xl font-medium tracking-wide hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-3"
          >
            {resendStatus === "sending" ? "Sending…" : resendStatus === "sent" ? "Email sent ✓" : "Resend verification email"}
          </button>

          {/* Wrong email? Let the user change it — the core recovery path for
              a mistyped signup address they can't receive mail on. */}
          <div className="mt-4 pt-4 border-t border-primary/10">
            {!showChangeEmail ? (
              <button
                onClick={() => setShowChangeEmail(true)}
                className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
              >
                Entered the wrong email? Change it
              </button>
            ) : (
              <div className="space-y-3">
                <ChangeEmailForm currentEmail={email} />
                <button
                  onClick={() => setShowChangeEmail(false)}
                  className="w-full text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors py-1"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          <button
            onClick={handleLogout}
            className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-2 mt-1"
          >
            Sign in with a different account
          </button>
        </div>
      </motion.div>
    </div>
  );
}
