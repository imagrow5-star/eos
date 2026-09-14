import crypto from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { db, demoSessionsTable } from "@workspace/db";
import { secretFor } from "../lib/secrets.js";
import { isHumeDisabledByEnv, isHumeVoiceConfigured } from "./hume.js";
import type { SystemPromptParts } from "./systemPrompt.js";
import type { HelplineBlockTier } from "./crisis/helplines.js";

/**
 * The landing-page voice demo — one minute of a real Hume call, no signup —
 * and the three protections around it.
 *
 *   1. One voice demo per browser per day: a cookie set when the call is
 *      minted, expiring at the next midnight UTC. Read here, never by the
 *      page (HttpOnly).
 *   2. One voice demo per IP per day: the visitor's address is hashed with a
 *      keyed HMAC (lib/secrets.ts "demo-ip") and stored on the demo_sessions
 *      row — the address itself is never written.
 *   3. A global daily spend cap: DEMO_VOICE_DAILY_CAP_USD (default $3) at
 *      DEMO_VOICE_USD_PER_MINUTE (default $0.07, Hume's EVI overage rate on
 *      the Starter plan) buys a budget of seconds per UTC day. Every voice
 *      call reserves the full minute when it starts and settles to its real
 *      length when it ends; a call that never reports its end keeps the full
 *      reservation. When the next call would exceed the budget the button
 *      is simply not shown — no error, no "come back tomorrow".
 *
 * All three reset at midnight UTC. Nothing said on the call is stored: the
 * row carries a timestamp, a kind, a duration, how it ended, and the hash.
 */

/** The hard stop, in seconds. Enforced by the page (mic off, last sentence
 *  finishes) AND by the server (the call token expires after this plus a
 *  short grace, so the brain answers nothing further). */
export const DEMO_VOICE_SECONDS = 60;
/** How long after the hard stop a reply already in flight may still be
 *  generated. The page stops the microphone at the stop, so only the
 *  sentence being spoken can land here. */
export const DEMO_VOICE_GRACE_MS = 15_000;
export const DEMO_VOICE_TOKEN_TTL_MS = DEMO_VOICE_SECONDS * 1000 + DEMO_VOICE_GRACE_MS;
export const DEMO_VOICE_COOKIE = "eos_voice_demo";

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function demoVoiceDailyCapUsd(): number {
  return envNumber("DEMO_VOICE_DAILY_CAP_USD", 3);
}

export function demoVoiceUsdPerMinute(): number {
  return envNumber("DEMO_VOICE_USD_PER_MINUTE", 0.07);
}

/** The day's budget in seconds of voice. */
export function demoVoiceCapSeconds(): number {
  return Math.floor((demoVoiceDailyCapUsd() / demoVoiceUsdPerMinute()) * 60);
}

/** DEMO_VOICE_ENABLED=off hides the button without touching Hume config. */
export function isDemoVoiceEnabled(): boolean {
  if (process.env.DEMO_VOICE_ENABLED?.trim().toLowerCase() === "off") return false;
  return isHumeVoiceConfigured() && !isHumeDisabledByEnv();
}

export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function utcNextMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Keyed hash of the visitor's address — what the row stores instead of the IP. */
export function hashDemoIp(ip: string): string {
  return crypto.createHmac("sha256", secretFor("demo-ip")).update(ip.trim()).digest("hex");
}

// ─── The browser cookie ──────────────────────────────────────────────────────

export function cookieMarksVoiceDemo(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => {
    const [name, value] = part.split("=", 2);
    return name?.trim() === DEMO_VOICE_COOKIE && (value ?? "").trim().length > 0;
  });
}

/** Set-Cookie value marking this browser as having used today's voice demo. */
export function voiceDemoCookie(now = new Date(), secure = process.env.NODE_ENV === "production"): string {
  const expires = utcNextMidnight(now).toUTCString();
  return `${DEMO_VOICE_COOKIE}=1; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Set-Cookie value that clears the mark (a call that never connected). */
export function clearVoiceDemoCookie(secure = process.env.NODE_ENV === "production"): string {
  return `${DEMO_VOICE_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// ─── Availability ────────────────────────────────────────────────────────────

export type VoiceDemoUnavailable = "disabled" | "cookie" | "ip" | "cap";
export type VoiceDemoAvailability =
  | { available: true }
  | { available: false; reason: VoiceDemoUnavailable };

/** Today's voice rows (UTC day). */
async function todaysVoiceRows(now: Date) {
  return db
    .select({
      ipHash: demoSessionsTable.ipHash,
      seconds: demoSessionsTable.seconds,
      endedReason: demoSessionsTable.endedReason,
    })
    .from(demoSessionsTable)
    .where(and(eq(demoSessionsTable.kind, "voice"), gte(demoSessionsTable.startedAt, utcDayStart(now))));
}

/**
 * Can this visitor start a voice demo right now? Checked when the page
 * loads (to decide whether the button exists at all) and again when the
 * call is minted. Fails closed: a database error means "not available".
 */
export async function voiceDemoAvailability(
  args: { ip: string; cookieHeader?: string },
  now = new Date(),
): Promise<VoiceDemoAvailability> {
  if (!isDemoVoiceEnabled()) return { available: false, reason: "disabled" };
  if (cookieMarksVoiceDemo(args.cookieHeader)) return { available: false, reason: "cookie" };

  const rows = await todaysVoiceRows(now);
  const ipHash = hashDemoIp(args.ip);
  // A call that never connected doesn't count against the person.
  if (rows.some((r) => r.ipHash === ipHash && r.endedReason !== "failed")) {
    return { available: false, reason: "ip" };
  }
  const spent = rows.reduce((sum, r) => sum + r.seconds, 0);
  if (spent + DEMO_VOICE_SECONDS > demoVoiceCapSeconds()) return { available: false, reason: "cap" };
  return { available: true };
}

// ─── The row: reserve at start, settle at end ────────────────────────────────

export async function startVoiceDemo(ip: string, now = new Date()): Promise<{ id: number; startedAt: Date }> {
  const [row] = await db
    .insert(demoSessionsTable)
    .values({ kind: "voice", startedAt: now, seconds: DEMO_VOICE_SECONDS, ipHash: hashDemoIp(ip) })
    .returning({ id: demoSessionsTable.id, startedAt: demoSessionsTable.startedAt });
  return row!;
}

export type DemoVoiceEndReason = "ended" | "limit" | "failed";

/**
 * Settle a call. The duration comes from the SERVER's clocks (row start →
 * now), capped at the minute — the page's report says only how it ended.
 * A report of "ended" at or past the minute is recorded as "limit".
 * Idempotent: a second report leaves the first settlement alone.
 */
export async function endVoiceDemo(
  callId: number,
  reported: DemoVoiceEndReason,
  now = new Date(),
): Promise<{ seconds: number; reason: DemoVoiceEndReason } | null> {
  const [row] = await db
    .select({
      startedAt: demoSessionsTable.startedAt,
      endedAt: demoSessionsTable.endedAt,
      seconds: demoSessionsTable.seconds,
      endedReason: demoSessionsTable.endedReason,
    })
    .from(demoSessionsTable)
    .where(and(eq(demoSessionsTable.id, callId), eq(demoSessionsTable.kind, "voice")));
  if (!row) return null;
  if (row.endedAt) return { seconds: row.seconds, reason: (row.endedReason ?? "ended") as DemoVoiceEndReason };

  const elapsed = Math.round((now.getTime() - row.startedAt.getTime()) / 1000);
  const seconds = Math.min(DEMO_VOICE_SECONDS, Math.max(1, elapsed));
  const reason: DemoVoiceEndReason =
    reported === "failed" ? "failed" : seconds >= DEMO_VOICE_SECONDS ? "limit" : reported;
  await db
    .update(demoSessionsTable)
    .set({ endedAt: now, seconds, endedReason: reason })
    .where(eq(demoSessionsTable.id, callId));
  return { seconds, reason };
}

// ─── Live call state (in process) ────────────────────────────────────────────
// What the brain needs to remember about a call while it runs: the frozen
// system prompt (built once per call, so every turn hits the prompt cache)
// and whether the crisis floor fired — the page polls for that to show the
// helpline card, since a spoken reply carries no numbers. Swept after the
// call could possibly still be alive. Nothing here is ever written down.

export interface LiveDemoCall {
  system: SystemPromptParts | null;
  crisisTier: HelplineBlockTier | null;
  at: number;
}

const LIVE_TTL_MS = 10 * 60 * 1000;
const liveCalls = new Map<number, LiveDemoCall>();

export function liveDemoCall(callId: number, now = Date.now()): LiveDemoCall {
  for (const [id, call] of liveCalls) {
    if (now - call.at > LIVE_TTL_MS) liveCalls.delete(id);
  }
  let call = liveCalls.get(callId);
  if (!call) {
    call = { system: null, crisisTier: null, at: now };
    liveCalls.set(callId, call);
  }
  call.at = now;
  return call;
}

/** A clear detection outranks an ambiguous one for the rest of the call. */
export function noteDemoCrisis(call: LiveDemoCall, tier: HelplineBlockTier): void {
  if (call.crisisTier === "clear") return;
  call.crisisTier = tier;
}
