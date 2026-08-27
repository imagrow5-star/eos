/**
 * Dodo Payments integration helpers (migration stage 2 — replaces paddle.ts).
 *
 * Two concerns live here:
 *
 * 1. WEBHOOK SIGNATURE VERIFICATION — Dodo implements the Standard Webhooks
 *    spec: every delivery carries `webhook-id`, `webhook-timestamp` (unix
 *    seconds) and `webhook-signature` headers, where the signature value is
 *    a space-delimited list of `v1,<base64 hmac>` entries and each hmac is
 *    HMAC-SHA256(key, `${webhook-id}.${webhook-timestamp}.${rawBody}`).
 *    The key is the webhook secret base64-DECODED after stripping its
 *    `whsec_` prefix. Verification needs the RAW request body byte-for-byte
 *    (see app.ts's raw-body mount for the webhook route). A timestamp outside
 *    MAX_EVENT_AGE_SECONDS is rejected to stop replays. Pure function,
 *    clock-injectable for tests. (Scheme confirmed against the official
 *    `dodopayments` SDK v2.48.0, which delegates to `standardwebhooks`.)
 *
 * 2. DODO API CALLS — the minimal set this phase needs: cancel a subscription
 *    at the next billing date (billing management + account deletion) and
 *    fetch a customer's email (webhook fallback matching when checkout
 *    metadata is missing). DODO_API_KEY is read at call time; both throw on
 *    failure and callers decide how loud to be. DODO_API_BASE overrides the
 *    live base URL (set it to https://test.dodopayments.com in test mode).
 */

import crypto from "node:crypto";
import { logger } from "../lib/logger.js";

/** Reject webhook deliveries older (or newer) than this (replay defense). */
export const MAX_EVENT_AGE_SECONDS = 5 * 60;

function apiBase(): string {
  return process.env.DODO_API_BASE?.trim() || "https://live.dodopayments.com";
}

export function isDodoWebhookConfigured(): boolean {
  return Boolean(process.env.DODO_WEBHOOK_SECRET?.trim());
}

/** The Standard Webhooks secret is base64, optionally prefixed `whsec_`. */
function decodeWebhookSecret(secret: string): Buffer {
  const trimmed = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(trimmed, "base64");
}

/** The three Standard Webhooks headers, as read from the request. */
export interface DodoSignatureHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Verifies a Standard Webhooks signature against the raw request body.
 * Returns true only when the timestamp is fresh AND one of the header's
 * `v1,<sig>` entries matches the HMAC — comparison is timing-safe.
 */
export function verifyDodoWebhookSignature(
  rawBody: Buffer | string,
  headers: DodoSignatureHeaders,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret) return false;

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(nowSeconds - tsNum) > MAX_EVENT_AGE_SECONDS) return false;

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = crypto
    .createHmac("sha256", decodeWebhookSecret(secret))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");

  // Header value: space-delimited versioned entries, e.g. "v1,abc= v1,def=".
  return signature.split(" ").some((entry) => {
    const commaAt = entry.indexOf(",");
    if (commaAt === -1) return false;
    const candidate = Buffer.from(entry.slice(commaAt + 1), "utf8");
    return candidate.length === expectedBuf.length && crypto.timingSafeEqual(candidate, expectedBuf);
  });
}

/** Builds a `webhook-signature` header value — used by tests to sign fixtures. */
export function signDodoPayloadForTests(
  rawBody: string,
  secret: string,
  msgId: string,
  tsSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const sig = crypto
    .createHmac("sha256", decodeWebhookSecret(secret))
    .update(`${msgId}.${tsSeconds}.${rawBody}`)
    .digest("base64");
  return `v1,${sig}`;
}

// ─── Dodo REST API (live) ─────────────────────────────────────────────────────

function apiKey(): string {
  const key = process.env.DODO_API_KEY?.trim();
  if (!key) throw new Error("DODO_API_KEY is not set");
  return key;
}

async function dodoFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Schedules a subscription cancellation at the next billing date (Dodo then
 * emits subscription webhooks, which are what actually mutate our
 * subscriptions row). PATCH /subscriptions/{id} with `status: cancelled` +
 * `cancel_at_next_billing_date: true` per the Dodo subscription API.
 */
export async function cancelDodoSubscription(dodoSubscriptionId: string): Promise<void> {
  const res = await dodoFetch(`/subscriptions/${encodeURIComponent(dodoSubscriptionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled", cancel_at_next_billing_date: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dodo cancel failed (${res.status}): ${body.slice(0, 300)}`);
  }
  logger.info({ dodoSubscriptionId }, "dodo: cancellation scheduled at next billing date");
}

/**
 * Creates a hosted checkout session (stage 4) and returns the URL to send
 * the customer to. POST /checkouts with:
 *  - product_cart: the one tier product;
 *  - metadata.user_id: what lets the billing webhook attach the resulting
 *    subscription to this account (keep in sync with routes/billingWebhook.ts);
 *  - customer.email: binds the session to the signed-in email (Dodo attaches
 *    to an existing customer by email by default);
 *  - subscription_data.trial_period_days: the tier's trial, passed explicitly
 *    so the trial length stays code-configured (overrides the product price);
 *  - return_url: where Dodo redirects after success OR failure.
 */
export async function createDodoCheckoutSession(opts: {
  productId: string;
  userId: number;
  email: string;
  trialPeriodDays: number;
  returnUrl: string;
}): Promise<string> {
  const res = await dodoFetch("/checkouts", {
    method: "POST",
    body: JSON.stringify({
      product_cart: [{ product_id: opts.productId, quantity: 1 }],
      customer: { email: opts.email },
      metadata: { user_id: String(opts.userId) },
      subscription_data: { trial_period_days: opts.trialPeriodDays },
      return_url: opts.returnUrl,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dodo checkout session failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { session_id?: string; checkout_url?: string | null }
    | null;
  if (!body?.checkout_url) {
    throw new Error("Dodo checkout session response has no checkout_url");
  }
  return body.checkout_url;
}

/**
 * Fetches a Dodo customer's email — the webhook's fallback for matching a
 * subscription to a user when checkout metadata is missing. GET
 * /customers/{id} returns the Customer object with a top-level `email`.
 */
export async function getDodoCustomerEmail(dodoCustomerId: string): Promise<string | null> {
  const res = await dodoFetch(`/customers/${encodeURIComponent(dodoCustomerId)}`);
  if (!res.ok) {
    logger.warn({ dodoCustomerId, status: res.status }, "dodo: customer lookup failed");
    return null;
  }
  const body = (await res.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email;
  return typeof email === "string" && email ? email.toLowerCase().trim() : null;
}
