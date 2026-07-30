/**
 * Paddle Billing integration helpers (phase 2).
 *
 * Two concerns live here:
 *
 * 1. WEBHOOK SIGNATURE VERIFICATION — Paddle signs every webhook with
 *    `Paddle-Signature: ts=<unix seconds>;h1=<hex hmac>` where h1 is
 *    HMAC-SHA256(secret, `${ts}:${rawBody}`). Verification needs the RAW
 *    request body byte-for-byte (see app.ts's raw-body mount for the webhook
 *    route — the global JSON parser must never touch it first). A timestamp
 *    older than MAX_EVENT_AGE_SECONDS is rejected to stop replays of captured
 *    deliveries. Pure function, clock-injectable for tests.
 *
 * 2. PADDLE API CALLS — the minimal set this phase needs: cancel a
 *    subscription (billing management + account deletion) and fetch a
 *    customer's email (webhook fallback matching when checkout custom_data
 *    is missing). PADDLE_API_KEY is read at call time; both throw on
 *    failure and callers decide how loud to be.
 */

import crypto from "node:crypto";
import { logger } from "../lib/logger.js";

/** Reject webhook deliveries older than this (replay defense). */
export const MAX_EVENT_AGE_SECONDS = 5 * 60;

const PADDLE_API_BASE = "https://api.paddle.com";

export function isPaddleWebhookConfigured(): boolean {
  return Boolean(process.env.PADDLE_WEBHOOK_SECRET?.trim());
}

/**
 * Verifies a Paddle-Signature header against the raw request body.
 * Returns true only when the timestamp is fresh AND an h1 entry matches the
 * HMAC — comparison is timing-safe.
 */
export function verifyPaddleSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || !secret) return false;

  let ts: string | null = null;
  const h1s: string[] = [];
  for (const part of signatureHeader.split(";")) {
    const [k, v] = part.split("=", 2).map((s) => s?.trim());
    if (k === "ts" && v) ts = v;
    if (k === "h1" && v) h1s.push(v);
  }
  if (!ts || h1s.length === 0) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(nowSeconds - tsNum) > MAX_EVENT_AGE_SECONDS) return false;

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}:`)
    .update(body)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");

  return h1s.some((h1) => {
    const candidate = Buffer.from(h1, "utf8");
    return candidate.length === expectedBuf.length && crypto.timingSafeEqual(candidate, expectedBuf);
  });
}

/** Builds a Paddle-Signature header — used by tests to sign fixture bodies. */
export function signPaddlePayloadForTests(
  rawBody: string,
  secret: string,
  tsSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const h1 = crypto.createHmac("sha256", secret).update(`${tsSeconds}:${rawBody}`).digest("hex");
  return `ts=${tsSeconds};h1=${h1}`;
}

// ─── Paddle REST API (live) ───────────────────────────────────────────────────

function apiKey(): string {
  const key = process.env.PADDLE_API_KEY?.trim();
  if (!key) throw new Error("PADDLE_API_KEY is not set");
  return key;
}

async function paddleFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PADDLE_API_BASE}${pathname}`, {
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
 * Schedules a subscription cancellation at the end of the current billing
 * period (Paddle then emits subscription.updated/canceled webhooks, which are
 * what actually mutate our subscriptions row).
 */
export async function cancelPaddleSubscription(paddleSubscriptionId: string): Promise<void> {
  const res = await paddleFetch(`/subscriptions/${encodeURIComponent(paddleSubscriptionId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ effective_from: "next_billing_period" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Paddle cancel failed (${res.status}): ${body.slice(0, 300)}`);
  }
  logger.info({ paddleSubscriptionId }, "paddle: cancellation scheduled at period end");
}

/**
 * Fetches a Paddle customer's email — the webhook's fallback for matching a
 * subscription to a user when checkout custom_data is missing.
 */
export async function getPaddleCustomerEmail(paddleCustomerId: string): Promise<string | null> {
  const res = await paddleFetch(`/customers/${encodeURIComponent(paddleCustomerId)}`);
  if (!res.ok) {
    logger.warn({ paddleCustomerId, status: res.status }, "paddle: customer lookup failed");
    return null;
  }
  const body = (await res.json().catch(() => null)) as { data?: { email?: string } } | null;
  const email = body?.data?.email;
  return typeof email === "string" && email ? email.toLowerCase().trim() : null;
}
