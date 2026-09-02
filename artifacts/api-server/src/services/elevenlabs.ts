import crypto from "node:crypto";

/**
 * ElevenLabs webhook signature verification.
 *
 * Scheme confirmed against BOTH the official SDK source
 * (@elevenlabs/elevenlabs-js dist/wrapper/webhooks.js, constructEvent) and
 * two real captured post-call deliveries (2026-09-02):
 *
 *   ElevenLabs-Signature: t=<unix seconds>,v0=<hex hmac>
 *
 *  - signed message is `${t}.${rawBody}` — the raw request BYTES, so the
 *    route must be mounted with express.raw() (same trap as the Dodo
 *    webhook);
 *  - HMAC-SHA256, hex digest; the secret string is used AS-IS (no whsec_
 *    base64 decode — this differs from Dodo's Standard Webhooks scheme);
 *  - deliveries older than 30 minutes are rejected (the SDK's tolerance).
 *
 * Comparison is timing-safe, unlike the SDK's string equality.
 */
export function verifyElevenLabsWebhookSignature(
  rawBody: Buffer,
  sigHeader: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!sigHeader || !secret) return false;
  const entries = sigHeader.split(",");
  const timestamp = entries.find((e) => e.startsWith("t="))?.substring(2);
  const signature = entries.find((e) => e.startsWith("v0="))?.substring(3);
  if (!timestamp || !signature) return false;

  const tsMs = Number(timestamp) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  if (tsMs < nowMs - 30 * 60 * 1000) return false; // stale — outside tolerance

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isElevenLabsWebhookConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_WEBHOOK_SECRET?.trim());
}

/** Test helper: produce the header value ElevenLabs would send for a body. */
export function signElevenLabsPayloadForTests(
  rawBody: string,
  secret: string,
  timestampSecs: number = Math.floor(Date.now() / 1000),
): string {
  const hex = crypto
    .createHmac("sha256", secret)
    .update(`${timestampSecs}.${rawBody}`)
    .digest("hex");
  return `t=${timestampSecs},v0=${hex}`;
}
