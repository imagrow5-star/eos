/**
 * Password policy for every place a password is SET: signup, reset-password,
 * change-password. (Login never validates shape — it only compares.)
 *
 * Length: at least 8 characters, at most 72 BYTES. bcrypt silently ignores
 * everything after byte 72, so a longer password would give a false sense of
 * strength and, worse, any string sharing the first 72 bytes would log in.
 * Bytes, not characters: a passphrase of multi-byte characters can pass a
 * character count and still overflow.
 *
 * Breach check: Have I Been Pwned's range API with k-anonymity. Only the first
 * five hex characters of the SHA-1 are sent; the password never leaves the
 * server and HIBP cannot tell which of the ~500 suffixes in the range we hold.
 * Fails OPEN — HIBP being slow or down must never stop someone choosing a
 * password — and is switched off entirely with PASSWORD_BREACH_CHECK=off
 * (the test suite does this: no network in CI).
 */
import { createHash } from "node:crypto";
import { logger } from "./logger";

export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_BYTES = 72;

/** Returns the user-facing problem with a candidate password, or null when it's acceptable. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_CHARS) {
    return `Password must be at least ${PASSWORD_MIN_CHARS} characters.`;
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return `Password must be ${PASSWORD_MAX_BYTES} characters or fewer.`;
  }
  return null;
}

export const BREACHED_PASSWORD_MESSAGE =
  "That password has appeared in a known data breach. Please choose a different one.";

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const HIBP_TIMEOUT_MS = 2500;

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Test seam: swap the HTTP call (never used in production). */
export function _setBreachFetchForTests(fn: FetchLike | null): void {
  fetchImpl = fn ?? ((url, init) => fetch(url, init));
}

export function breachCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PASSWORD_BREACH_CHECK ?? "").trim().toLowerCase() !== "off";
}

/**
 * True when the password appears in HIBP's breach corpus. False when it does
 * not, when the check is disabled, and on ANY error (timeout, network, bad
 * response) — the error is logged without the password or its hash.
 */
export async function isBreachedPassword(password: string): Promise<boolean> {
  if (!breachCheckEnabled()) return false;
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(HIBP_RANGE_URL + prefix, {
      // Padding makes every response the same rough size, so a network
      // observer can't infer the range from the byte count.
      headers: { "Add-Padding": "true", "User-Agent": "eos-companion-password-check" },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "password breach check: unexpected HIBP status — allowing password");
      return false;
    }
    const body = await res.text();
    for (const line of body.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      if (line.slice(0, colon).trim().toUpperCase() !== suffix) continue;
      // Padded entries carry a count of 0 and are not real matches.
      return Number(line.slice(colon + 1).trim()) > 0;
    }
    return false;
  } catch (err) {
    logger.warn({ err }, "password breach check unavailable — allowing password");
    return false;
  } finally {
    clearTimeout(timer);
  }
}
