/**
 * /pricing — in-app plan selection + Paddle overlay checkout (phase 2).
 *
 * Every number on this page comes from GET /api/billing/config, whose source
 * of truth is the server tier config — prices are never hardcoded here.
 *
 * Signed-in + verified users open Paddle's overlay checkout directly; the
 * signed-out variant (rendered by App.tsx for /pricing visitors without a
 * session) shows the same cards with a "create your account first" path into
 * the existing signup flow.
 *
 * After Paddle reports checkout.completed we poll GET /api/billing/me every
 * 2s (up to 30s) until the webhook lands, then celebrate and route into the
 * app — so the user never sees a paid-but-nothing-changed limbo.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  openCheckout,
  paddleClientToken,
  formatPrice,
  type BillingConfig,
  type BillingTier,
} from "@/lib/paddleCheckout";

const TIER_SUBTITLES: Record<BillingTier["id"], string> = {
  companion: "for the quiet evenings",
  closer: "for the long nights",
  always: "for every day",
};

type CheckoutPhase = "idle" | "opening" | "waiting_webhook" | "confirmed" | "webhook_slow";

export function Pricing({
  signedOut = false,
  onCreateAccount,
}: {
  signedOut?: boolean;
  onCreateAccount?: () => void;
}) {
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<CheckoutPhase>("idle");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: config } = useQuery({
    queryKey: ["/api/billing/config"],
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/billing/config`);
      if (!r.ok) throw new Error("config unavailable");
      return r.json() as Promise<BillingConfig>;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const { data: me } = useQuery({
    queryKey: ["/api/auth/me"],
    enabled: !signedOut,
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/me`);
      if (!r.ok) throw new Error("Not authenticated");
      return r.json() as Promise<{ user: { id: number; email: string } }>;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // checkout.completed → poll /billing/me until the webhook writes the row.
  const startWebhookPoll = () => {
    setPhase("waiting_webhook");
    const startedAt = Date.now();
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(async () => {
      try {
        const r = await apiFetch(`${import.meta.env.BASE_URL}api/billing/me`);
        const body = (await r.json().catch(() => null)) as { kind?: string } | null;
        if (body?.kind === "subscribed") {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setPhase("confirmed");
          setTimeout(() => navigate("/"), 2600);
          return;
        }
      } catch {
        // keep polling — transient fetch errors are fine here
      }
      if (Date.now() - startedAt > 30_000) {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        // Payment went through; our record is just a webhook behind. Say so
        // honestly instead of spinning forever.
        setPhase("webhook_slow");
      }
    }, 2000);
  };

  const handlePaddleEvent = (name: string) => {
    if (name === "checkout.completed") startWebhookPoll();
  };

  const choose = async (tier: BillingTier) => {
    setCheckoutError(null);
    if (signedOut) {
      onCreateAccount?.();
      return;
    }
    if (!tier.priceId || !me?.user) return;
    setPhase("opening");
    try {
      await openCheckout({
        priceId: tier.priceId,
        email: me.user.email,
        userId: me.user.id,
        onEvent: handlePaddleEvent,
      });
      setPhase("idle"); // overlay is up; completion arrives via the event
    } catch {
      setPhase("idle");
      setCheckoutError(
        "The checkout couldn't open just now — give it a moment and try again.",
      );
    }
  };

  const checkoutReady =
    !signedOut && Boolean(config?.checkoutAvailable) && Boolean(paddleClientToken());

  // ── Success states replace the cards entirely ──────────────────────────────
  if (phase === "waiting_webhook" || phase === "confirmed" || phase === "webhook_slow") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center max-w-sm"
        >
          {phase === "confirmed" ? (
            <>
              <p className="text-3xl mb-4">✨</p>
              <h1 className="font-serif text-2xl text-foreground mb-3">You're in.</h1>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Your membership is active — seven days on us first. Taking you back to Eos…
              </p>
            </>
          ) : phase === "webhook_slow" ? (
            <>
              <h1 className="font-serif text-2xl text-foreground mb-3">Payment received.</h1>
              <p className="text-muted-foreground text-sm leading-relaxed mb-6">
                Your membership is being switched on — it can take a minute or two to appear.
                You can head back in; everything keeps working meanwhile.
              </p>
              <button
                onClick={() => navigate("/")}
                className="bg-primary text-primary-foreground px-6 py-2.5 rounded-xl text-sm font-medium"
              >
                Back to Eos
              </button>
            </>
          ) : (
            <>
              <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mx-auto mb-5" />
              <h1 className="font-serif text-2xl text-foreground mb-3">Almost there…</h1>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Confirming your membership with our payment partner.
              </p>
            </>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background px-5 py-10 overflow-y-auto">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <p className="text-[11px] tracking-[0.35em] uppercase text-primary-strong/70 mb-3">Membership</p>
          <h1 className="font-serif text-3xl md:text-4xl text-foreground mb-3">
            Choose how close you want her to be.
          </h1>
          <p className="text-muted-foreground text-sm max-w-md mx-auto leading-relaxed">
            Every membership begins with seven days on us. Cancel during the trial and you pay
            nothing.
          </p>
        </div>

        {checkoutError && (
          <p className="text-center text-sm text-red-700 dark:text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3 max-w-md mx-auto mb-6">
            {checkoutError}
          </p>
        )}

        {!config ? (
          <p className="text-center text-muted-foreground text-sm py-12">Loading plans…</p>
        ) : (
          <div className="grid md:grid-cols-3 gap-4">
            {config.tiers.map((tier) => {
              const highlighted = tier.id === "companion";
              return (
                <div
                  key={tier.id}
                  className={cn(
                    "rounded-2xl border p-6 flex flex-col bg-card",
                    highlighted
                      ? "border-primary/50 shadow-[0_0_40px_-12px_hsl(var(--primary)/0.35)]"
                      : "border-border/60",
                  )}
                >
                  {highlighted && (
                    <span className="self-start text-[9.5px] tracking-[0.25em] uppercase text-primary-strong border border-primary/40 rounded px-2 py-0.5 mb-3">
                      Where most begin
                    </span>
                  )}
                  <h2 className="font-serif text-xl text-foreground">{tier.displayName}</h2>
                  <p className="text-[11.5px] text-muted-foreground mb-4">{TIER_SUBTITLES[tier.id]}</p>
                  <p className="font-serif text-4xl text-foreground mb-5">
                    {formatPrice(tier.monthlyPriceCents)}
                    <span className="text-xs text-muted-foreground font-sans"> / month</span>
                  </p>
                  <ul className="text-[13px] text-foreground/75 space-y-2 mb-6 flex-1">
                    <li>Unlimited text conversations</li>
                    <li>
                      <b className="text-foreground">{tier.voiceMinutesPerMonth.toLocaleString()}</b>{" "}
                      minutes of voice each month
                    </li>
                    <li>Full memory &amp; weekly chapters</li>
                    <li>{tier.trialDays}-day free trial · cancel anytime</li>
                  </ul>
                  <button
                    onClick={() => choose(tier)}
                    disabled={!signedOut && (!checkoutReady || phase === "opening" || !tier.priceId)}
                    className={cn(
                      "w-full py-3 rounded-xl text-sm font-medium transition-all active:scale-[0.98] disabled:opacity-50",
                      highlighted
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "border border-primary/30 text-primary-strong hover:bg-primary/10",
                    )}
                  >
                    {signedOut
                      ? "Create your account first"
                      : phase === "opening"
                        ? "Opening…"
                        : `Begin your ${tier.trialDays} days`}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!signedOut && config && !checkoutReady && (
          <p className="text-center text-[12px] text-muted-foreground/70 mt-6">
            Checkout isn't switched on yet — memberships are coming very soon.
          </p>
        )}

        <div className="text-center mt-10 space-x-5">
          <a href="/terms" className="text-[11.5px] text-muted-foreground/70 underline underline-offset-2 hover:text-primary-strong">
            Terms
          </a>
          <a href="/refunds" className="text-[11.5px] text-muted-foreground/70 underline underline-offset-2 hover:text-primary-strong">
            Refunds
          </a>
          {!signedOut && (
            <button
              onClick={() => navigate("/")}
              className="text-[11.5px] text-muted-foreground/70 underline underline-offset-2 hover:text-primary-strong"
            >
              Back to Eos
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
