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
 * Auth: each call carries an HMAC-SHA256 of "<prefix>:<YYYY-MM-DDTHH>" under
 * SESSION_SECRET (the api-server accepts the previous hour too, so clock edges
 * are safe). The secret must be the web service's — nothing else is shared.
 *
 * Env:
 *   APP_URL              — the api-server's public origin (required in production)
 *   SESSION_SECRET       — must match the api-server's
 *   SCHEDULER_DRY_RUN    — "1"/"true": log what would be called, call nothing
 *   SCHEDULER_ONLY_USER  — <id>: scope every sweep to one user (local runs)
 *   DAILY_EMAIL_DRY_RUN / DAILY_EMAIL_ONLY_USER — the old names, still honoured
 */

import { createHmac } from "node:crypto";

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
  sessionSecret: string;
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
    sessionSecret: env.SESSION_SECRET ?? "",
    dryRun: truthy(env.SCHEDULER_DRY_RUN) || truthy(env.DAILY_EMAIL_DRY_RUN),
    // A typo'd id must never silently widen to "everyone": NaN → no scope, and
    // the run refuses below rather than fanning out.
    onlyUser: onlyRaw ? (Number.isInteger(onlyParsed) && onlyParsed > 0 ? onlyParsed : -1) : null,
  };
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

export function sweepToken(secret: string, prefix: string, d: Date = new Date()): string {
  const stamp = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return createHmac("sha256", secret).update(`${prefix}:${stamp}`).digest("hex");
}

export interface SweepOutcome {
  name: string;
  status: number | null;
  ok: boolean;
}

async function callSweep(sweep: Sweep, cfg: SchedulerConfig, fetchImpl: typeof fetch): Promise<SweepOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sweep.timeoutMs);
  try {
    const resp = await fetchImpl(`${cfg.appUrl}${sweep.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": sweepToken(cfg.sessionSecret, sweep.tokenPrefix) },
      // The single-user hook scopes the sweep so local runs never fan out.
      body: JSON.stringify(cfg.onlyUser !== null ? { userId: cfg.onlyUser } : {}),
      signal: controller.signal,
    });
    const body: unknown = await resp.json().catch(() => null);
    log(`${sweep.name} triggered`, { status: resp.status, result: body as Record<string, unknown> | null });
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
  if (!cfg.sessionSecret) {
    log("SESSION_SECRET not set — nothing can be triggered");
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
