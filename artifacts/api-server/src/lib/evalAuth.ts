/**
 * Bearer-key authentication for the evaluation endpoint (routes/eval.ts).
 *
 * The key is EVAL_API_KEY, set on the web service and handed to the
 * evaluator out of band. It is compared in constant time, never logged, and
 * never derived from anything else: when it is unset the route answers 404,
 * so a deployment that has not opted in exposes nothing at all. Rotating it
 * is changing the one variable.
 */
import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";

/** At least this many characters, so a short or empty value can never be a key. */
export const EVAL_KEY_MIN_LENGTH = 32;

export function evalKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.EVAL_API_KEY?.trim() ?? "";
  return raw.length >= EVAL_KEY_MIN_LENGTH ? raw : null;
}

export function bearerFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

export function keysMatch(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 404 when no key is configured; 401 on a missing or wrong key. */
export const requireEvalKey: RequestHandler = (req, res, next) => {
  const expected = evalKeyFromEnv();
  if (!expected) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!keysMatch(bearerFrom(req), expected)) {
    res.status(401).json({ error: "Invalid or missing evaluation key", code: "EVAL_UNAUTHORIZED" });
    return;
  }
  next();
};
