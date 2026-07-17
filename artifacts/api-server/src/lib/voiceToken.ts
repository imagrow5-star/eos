import crypto from "node:crypto";

// ─── Per-call voice tokens ────────────────────────────────────────────────────
// ElevenLabs' servers call our custom-LLM endpoint directly (no browser session
// cookie), so each voice call carries a short-lived HMAC token identifying the
// logged-in user. Signed with SESSION_SECRET — no new secret required.
//
// Format: "<userId>.<issuedAt>.<expiresAt>.<signature>"
//
// issuedAt doubles as the call-start marker: the custom-LLM endpoint only loads
// chat history from BEFORE the call started, so turns persisted DURING the call
// never appear twice in the model context.

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for voice tokens");
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function mintVoiceToken(userId: number, ttlMs = 2 * 60 * 60 * 1000): string {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const payload = `${userId}.${issuedAt}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyVoiceToken(
  token: string,
): { userId: number; issuedAt: number } | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userIdStr, iatStr, expStr, sig] = parts;
  const userId = Number(userIdStr);
  const issuedAt = Number(iatStr);
  const expiresAt = Number(expStr);
  if (!Number.isInteger(userId) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return null;
  }
  if (Date.now() > expiresAt) return null;
  const expected = sign(`${userIdStr}.${iatStr}.${expStr}`);
  const a = Buffer.from(sig ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { userId, issuedAt };
}
