import crypto from "node:crypto";
import { secretFor } from "./secrets";

// ─── Landing-page voice demo call tokens ─────────────────────────────────────
// The voice demo is a real Hume EVI call whose brain is our custom-LLM
// endpoint (routes/humeLlm.ts). Hume's servers call that endpoint directly,
// so each demo call carries a short-lived HMAC token — the same slot the
// per-user voice token rides in (session_settings.language_model_api_key →
// Authorization: Bearer). A demo token identifies a CALL, never a person:
// there is no account behind it.
//
// Format: "demo.<callId>.<issuedAt>.<expiresAt>.<env>.<signature>" — six
// parts, so lib/voiceToken.ts (which requires exactly five) can never read a
// demo token as a user token, and vice versa. Same signing secret, same env
// tag (dev and prod share SESSION_SECRET but not databases).
//
// issuedAt is the call's start; the token's TTL is the demo's hard stop plus
// a short grace so the reply already in flight at the cutoff can finish.
// After that, Hume's completion requests get a 401 and nothing more is
// spoken — the minute is enforced server-side, not only by the page.

function getSecret(): string {
  return secretFor("voice-token");
}

function envTag(): "prod" | "dev" {
  return process.env.REPLIT_DEPLOYMENT ? "prod" : "dev";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export interface DemoVoiceTokenClaims {
  callId: number;
  issuedAt: number;
  expiresAt: number;
}

export function mintDemoVoiceToken(callId: number, ttlMs: number, now = Date.now()): string {
  const payload = `demo.${callId}.${now}.${now + ttlMs}.${envTag()}`;
  return `${payload}.${sign(payload)}`;
}

/** Signature, environment and expiry all enforced — the live request path. */
export function verifyDemoVoiceToken(token: string, now = Date.now()): DemoVoiceTokenClaims | null {
  const claims = checkDemoVoiceToken(token);
  if (!claims || now > claims.expiresAt) return null;
  return claims;
}

/**
 * Signature and environment only — for the call-end report, which arrives
 * after the token has expired by design (the page reports once the last
 * sentence has finished). Never use this to authorize a completion.
 */
export function parseDemoVoiceToken(token: string): DemoVoiceTokenClaims | null {
  return checkDemoVoiceToken(token);
}

function checkDemoVoiceToken(token: string): DemoVoiceTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "demo") return null;
  const [, idStr, iatStr, expStr, env, sig] = parts;
  const callId = Number(idStr);
  const issuedAt = Number(iatStr);
  const expiresAt = Number(expStr);
  if (!Number.isInteger(callId) || callId <= 0 || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return null;
  }
  if (env !== envTag()) return null;
  const expected = sign(`demo.${idStr}.${iatStr}.${expStr}.${env}`);
  const a = Buffer.from(sig ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { callId, issuedAt, expiresAt };
}
