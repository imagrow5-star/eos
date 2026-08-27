/**
 * Dodo Payments checkout (stage 4 — replaces the Paddle overlay).
 *
 * Redirect flow, no client SDK and no client token: the SERVER creates the
 * checkout session (POST /api/billing/checkout-session) so metadata.user_id
 * is always set from the authenticated session — that's what lets the
 * billing webhook attach the subscription to this account — and the browser
 * simply navigates to the hosted checkout URL. Dodo redirects back to
 * /pricing?checkout=return afterwards, where the page polls /billing/me
 * until the webhook lands.
 *
 * All prices/tiers come from GET /api/billing/config (whose source of truth
 * is the server tier config) — nothing money-related is hardcoded here.
 */

import { apiFetch } from "@/lib/api";

export interface BillingTier {
  id: "companion" | "closer" | "always";
  displayName: string;
  monthlyPriceCents: number;
  voiceMinutesPerMonth: number;
  trialDays: number;
  priceId: string | null; // the tier's Dodo product id (null until configured)
}

export interface BillingConfig {
  checkoutAvailable: boolean;
  tiers: BillingTier[];
}

/**
 * Asks the server for a checkout URL for one tier and navigates to it.
 * Resolves only on failure paths — on success the browser leaves the page.
 */
export async function startCheckout(tierId: BillingTier["id"]): Promise<void> {
  const r = await apiFetch(`${import.meta.env.BASE_URL}api/billing/checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier: tierId }),
  });
  const body = (await r.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!r.ok || !body?.url) {
    throw new Error(body?.error ?? "Could not start checkout");
  }
  window.location.assign(body.url);
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
