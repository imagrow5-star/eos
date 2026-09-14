/**
 * Eos — the hourly scheduler.
 *
 * Runs as a Render Cron Job every hour on the hour (render.yaml) and does one
 * thing: it calls the api-server's internal sweep endpoints, in order. The
 * api-server owns all the logic — who is inside their local window, what is
 * idempotent per (user, day/week), what gets written — so calling every hour
 * is safe and this file never touches the database or the model.
 *
 *   1. /api/internal/chapters/run         weekly chapter (Sunday evening window)
 *   2. /api/internal/reflection/weekly-run weekly reflection (one per rolling week)
 *   3. /api/internal/stories/run          Journey stories: daily Goals / Routines
 *                                         cards, the Sunday weekly story — AFTER
 *                                         chapters, because the weekly story's
 *                                         then/now card reads this week's chapter
 *
 * Nothing here reaches a person directly. Eos has no outbound channel: no
 * emails, no push notifications. Everything the sweeps produce waits in the
 * app until the person opens it.
 *
 * Auth: each call carries an HMAC-SHA256 of "<prefix>:<YYYY-MM-DDTHH>:<sha256(body)>"
 * under INTERNAL_SWEEP_SECRET (the api-server accepts the previous hour too,
 * so clock edges are safe). The body is signed, so a captured token is good
 * for exactly one request. Until INTERNAL_SWEEP_SECRET is set on both
 * services, the key is derived from SESSION_SECRET with HKDF — the same
 * derivation as api-server lib/secrets.ts — so the two deployments agree
 * either way. The sweep secret is the ONLY thing shared with the web service.
 *
 * Env:
 *   APP_URL                — the api-server's public origin (required in production)
 *   INTERNAL_SWEEP_SECRET  — must match the api-server's (preferred)
 *   SESSION_SECRET         — fallback: derives the sweep key; remove once the above is set
 *   SCHEDULER_DRY_RUN    — "1"/"true": log what would be called, call nothing
 *   SCHEDULER_ONLY_USER  — <id>: scope every sweep to one user (local runs)
 *   DAILY_EMAIL_DRY_RUN / DAILY_EMAIL_ONLY_USER — the old names, still honoured
 */

import { createHash, createHmac, hkdfSync } from "node:crypto";

// ─── Logging ──────────────────────────────────────────────────────────────────
// Structured one-liners. Never log a user id: the guardrail test in
// api-server walks this tree too.

export const log = (msg: string, data?: Record<string, unknown>): void =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...data }));

export const logErr = (msg: string, err: unknown, data?: Record<string, unknown>): void =>
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      msg,
      err: err instanceof Error ? err.message : String(err),
      ...data,
    }),
  );

// ─── Config (read at run time so tests can set env and import once) ──────────

export interface SchedulerConfig {
  appUrl: string;
  /** The internal sweep key: INTERNAL_SWEEP_SECRET, or derived from SESSION_SECRET. */
  sweepSecret: string;
  dryRun: boolean;
  onlyUser: number | null;
}

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  // In production APP_URL must be explicit: a silent default would call the
  // wrong deployment's internal endpoints.
  if (!env.APP_URL?.trim() && env.NODE_ENV === "production") {
    throw new Error("APP_URL must be set in production — the scheduler would otherwise target the wrong host.");
  }
  const onlyRaw = (env.SCHEDULER_ONLY_USER ?? env.DAILY_EMAIL_ONLY_USER)?.trim();
  // Strict: parseInt("4x2") is 4, which would quietly scope to the wrong person.
  const onlyParsed = onlyRaw && /^\d+$/.test(onlyRaw) ? Number(onlyRaw) : NaN;
  return {
    appUrl: (env.APP_URL ?? "https://eoscompanion.com").replace(/\/$/, ""),
    sweepSecret: resolveSweepSecret(env),
    dryRun: truthy(env.SCHEDULER_DRY_RUN) || truthy(env.DAILY_EMAIL_DRY_RUN),
    // A typo'd id must never silently widen to "everyone": NaN → no scope, and
    // the run refuses below rather than fanning out.
    onlyUser: onlyRaw ? (Number.isInteger(onlyParsed) && onlyParsed > 0 ? onlyParsed : -1) : null,
  };
}

/**
 * Mirrors api-server lib/secrets.ts exactly: the dedicated secret wins; else
 * 32 bytes from HKDF-SHA256(SESSION_SECRET, info "eos-internal-sweep-v1") as
 * hex. Empty when neither is set.
 */
export function resolveSweepSecret(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env.INTERNAL_SWEEP_SECRET?.trim();
  if (dedicated) return dedicated;
  const session = env.SESSION_SECRET;
  if (!session) return "";
  return Buffer.from(hkdfSync("sha256", session, "", "eos-internal-sweep-v1", 32)).toString("hex");
}

// ─── The sweeps ───────────────────────────────────────────────────────────────

export interface Sweep {
  name: string;
  path: string;
  /** The HMAC stamp prefix the api-server expects for this endpoint. */
  tokenPrefix: string;
  timeoutMs: number;
}

export const SWEEPS: readonly Sweep[] = [
  { name: "Chapter sweep", path: "/api/internal/chapters/run", tokenPrefix: "chapters-run", timeoutMs: 240_000 },
  { name: "Reflection sweep", path: "/api/internal/reflection/weekly-run", tokenPrefix: "reflection-run", timeoutMs: 240_000 },
  { name: "Story sweeps", path: "/api/internal/stories/run", tokenPrefix: "stories-run", timeoutMs: 240_000 },
];

/** HMAC over the prefix, the UTC hour and the exact body string being sent. */
export function sweepToken(secret: string, prefix: string, body: string, d: Date = new Date()): string {
  const stamp = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${prefix}:${stamp}:${digest}`).digest("hex");
}

export interface SweepOutcome {
  name: string;
  status: number | null;
  ok: boolean;
}

async function callSweep(sweep: Sweep, cfg: SchedulerConfig, fetchImpl: typeof fetch): Promise<SweepOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sweep.timeoutMs);
  // The single-user hook scopes the sweep so local runs never fan out. The
  // token signs these exact bytes, so build the string once and send it as is.
  const body = JSON.stringify(cfg.onlyUser !== null ? { userId: cfg.onlyUser } : {});
  try {
    const resp = await fetchImpl(`${cfg.appUrl}${sweep.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": sweepToken(cfg.sweepSecret, sweep.tokenPrefix, body) },
      body,
      signal: controller.signal,
    });
    const result: unknown = await resp.json().catch(() => null);
    log(`${sweep.name} triggered`, { status: resp.status, result: result as Record<string, unknown> | null });
    return { name: sweep.name, status: resp.status, ok: resp.ok };
  } catch (err) {
    logErr(`${sweep.name} trigger failed (non-fatal)`, err);
    return { name: sweep.name, status: null, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<SweepOutcome[]> {
  const cfg = readConfig(opts.env);
  const fetchImpl = opts.fetchImpl ?? fetch;
  log("Scheduler starting", { dryRun: cfg.dryRun, scoped: cfg.onlyUser !== null });

  if (cfg.onlyUser === -1) {
    log("SCHEDULER_ONLY_USER is not a positive integer — refusing to run unscoped");
    return [];
  }
  if (!cfg.sweepSecret) {
    log("INTERNAL_SWEEP_SECRET (or SESSION_SECRET) not set — nothing can be triggered");
    return [];
  }
  if (cfg.dryRun) {
    for (const s of SWEEPS) log(`DRY RUN — would call ${s.name}`, { path: s.path });
    log("Scheduler complete", { dryRun: true, called: 0 });
    return [];
  }

  // Sequential on purpose: stories read what chapters wrote this hour.
  const outcomes: SweepOutcome[] = [];
  for (const s of SWEEPS) outcomes.push(await callSweep(s, cfg, fetchImpl));
  log("Scheduler complete", { called: outcomes.length, failed: outcomes.filter((o) => !o.ok).length });
  return outcomes;
}
