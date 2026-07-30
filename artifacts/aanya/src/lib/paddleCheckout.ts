/**
 * Paddle.js v2 loader + overlay checkout (phase 2).
 *
 * The script loads from Paddle's official CDN ON DEMAND (only when the
 * pricing page needs it — the rest of the app never pays the bytes), and
 * initializes with the client-side token from VITE_PADDLE_CLIENT_TOKEN.
 * That token is a PUBLIC client token (Paddle dashboard → Developer Tools →
 * Authentication → Client-side tokens), safe to embed at build time — it can
 * only open checkouts, never read account data. LIVE environment: Paddle.js
 * defaults to live; we never call Environment.set("sandbox").
 *
 * All prices/tiers come from GET /api/billing/config (whose source of truth
 * is the server tier config) — nothing money-related is hardcoded here.
 */

export interface BillingTier {
  id: "companion" | "closer" | "always";
  displayName: string;
  monthlyPriceCents: number;
  voiceMinutesPerMonth: number;
  trialDays: number;
  priceId: string | null;
}

export interface BillingConfig {
  checkoutAvailable: boolean;
  tiers: BillingTier[];
}

type PaddleGlobal = {
  Initialized?: boolean;
  Initialize: (opts: {
    token: string;
    eventCallback?: (event: { name?: string }) => void;
  }) => void;
  Checkout: {
    open: (opts: Record<string, unknown>) => void;
  };
};

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

const PADDLE_JS_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js";

export function paddleClientToken(): string | null {
  const token = (import.meta.env.VITE_PADDLE_CLIENT_TOKEN as string | undefined)?.trim();
  return token || null;
}

let loadPromise: Promise<PaddleGlobal> | null = null;

/**
 * Loads + initializes Paddle.js once. `onEvent` receives Paddle's checkout
 * events (we watch for "checkout.completed"). Throws when the client token
 * is missing — callers hide checkout in that case.
 */
export function loadPaddle(onEvent: (name: string) => void): Promise<PaddleGlobal> {
  const token = paddleClientToken();
  if (!token) return Promise.reject(new Error("VITE_PADDLE_CLIENT_TOKEN is not set"));

  if (!loadPromise) {
    loadPromise = new Promise<PaddleGlobal>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PADDLE_JS_SRC;
      script.async = true;
      script.onload = () => {
        const paddle = window.Paddle;
        if (!paddle) {
          reject(new Error("Paddle.js loaded but window.Paddle is missing"));
          return;
        }
        paddle.Initialize({
          token,
          eventCallback: (event) => {
            if (typeof event?.name === "string") onEvent(event.name);
          },
        });
        resolve(paddle);
      };
      script.onerror = () => {
        loadPromise = null; // allow a retry on the next click
        reject(new Error("Could not load Paddle.js"));
      };
      document.head.appendChild(script);
    });
  }
  return loadPromise;
}

/**
 * Opens the overlay checkout for one tier. custom_data.user_id is what lets
 * the billing webhook attach the subscription to this account — keep it in
 * sync with the server's matcher (routes/billingWebhook.ts).
 */
export async function openCheckout(opts: {
  priceId: string;
  email: string;
  userId: number;
  onEvent: (name: string) => void;
}): Promise<void> {
  const paddle = await loadPaddle(opts.onEvent);
  paddle.Checkout.open({
    items: [{ priceId: opts.priceId, quantity: 1 }],
    customer: { email: opts.email },
    customData: { user_id: opts.userId },
    settings: {
      displayMode: "overlay",
      theme: "dark",
      allowLogout: false, // keep the checkout bound to the signed-in email
    },
  });
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
