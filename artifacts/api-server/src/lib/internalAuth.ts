/**
 * Authentication for the internal sweep endpoints (chapters, reflection,
 * stories), which the hourly scheduler calls with no session.
 *
 * Token = HMAC-SHA256( INTERNAL_SWEEP_SECRET, "<prefix>:<YYYY-MM-DDTHH>:<sha256(body)>" )
 * sent as `x-internal-token`. The current and the previous UTC hour are
 * accepted, so a call on the hour boundary is never refused.
 *
 * The BODY is part of what is signed. The earlier scheme signed only the
 * prefix and the hour, so a token captured in flight could be replayed for
 * up to two hours with any body the attacker liked — and the body chooses
 * the target user, the scope and the operator flags. Now a token is good
 * for exactly one request body. The digest is over the raw bytes as sent
 * (app.ts keeps them on req.rawBody), so parsing can't change what is
 * verified; an absent body digests as the empty string.
 *
 * Every route also whitelists its body keys: an unknown key is a 400, so a
 * mistyped operator flag is refused rather than silently ignored.
 */
import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import { secretFor } from "./secrets";

export type InternalPrefix = "chapters-run" | "reflection-run" | "stories-run";

export function hourStamp(d: Date): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

export function bodyDigest(raw: Buffer | string | undefined | null): string {
  return crypto.createHash("sha256").update(raw ?? "").digest("hex");
}

/** Mints a token for one prefix, hour and exact body. Shared with the tests. */
export function mintInternalToken(
  secret: string,
  prefix: InternalPrefix,
  body: Buffer | string | undefined,
  d: Date = new Date(),
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${prefix}:${hourStamp(d)}:${bodyDigest(body)}`)
    .digest("hex");
}

/** The exact bytes the JSON parser consumed, stashed by app.ts's `verify` hook. */
export function rawBodyOf(req: Request): Buffer | undefined {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  return Buffer.isBuffer(raw) ? raw : undefined;
}

export function internalTokenMatches(
  provided: string,
  secret: string,
  prefix: InternalPrefix,
  rawBody: Buffer | undefined,
  now: Date = new Date(),
): boolean {
  const a = Buffer.from(provided);
  for (const d of [now, new Date(now.getTime() - 3_600_000)]) {
    const b = Buffer.from(mintInternalToken(secret, prefix, rawBody, d));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * Express middleware: 500 if no secret is configured, 401 on a missing or
 * wrong token, otherwise next(). Reads the secret per request so a test can
 * set the environment and the route follows.
 */
export function requireInternalToken(prefix: InternalPrefix): RequestHandler {
  return (req, res, next) => {
    let secret: string;
    try {
      secret = secretFor("internal-sweep");
    } catch {
      res.status(500).json({ error: "INTERNAL_SWEEP_SECRET not configured" });
      return;
    }
    const token = req.header("x-internal-token") ?? "";
    if (!token || !internalTokenMatches(token, secret, prefix, rawBodyOf(req))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/**
 * Returns a problem with an internal request body, or null. The body must be
 * a JSON object whose keys are all in `allowed`; `userId`, when present, must
 * be a positive integer.
 */
export function internalBodyProblem(body: unknown, allowed: readonly string[]): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.sort().join(", ")}`;
  const userId = (body as Record<string, unknown>).userId;
  if (userId !== undefined && !(Number.isInteger(userId) && (userId as number) > 0)) {
    return "userId must be a positive integer";
  }
  return null;
}

export const isProduction = (): boolean => process.env.NODE_ENV === "production";
