import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import path from "node:path";
import fs from "node:fs";

// SESSION_SECRET is required — fail fast rather than silently use a weak fallback
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required but not set.");
}

// Safety-net: ensure user_sessions exists even if drizzle-kit push hasn't run yet.
// The authoritative definition lives in lib/db/src/schema/userSessions.ts so
// `drizzle-kit push` creates and maintains it across fresh environments.
pool
  .query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid varchar NOT NULL COLLATE "default" PRIMARY KEY,
      sess json NOT NULL,
      expire timestamp(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON user_sessions (expire);
  `)
  .catch((err) => logger.error({ err }, "Failed to ensure user_sessions table"));

// Safety-net: add email_verified_at to users if the column was added after initial deploy.
pool
  .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamp;`)
  .catch((err) => logger.error({ err }, "Failed to ensure email_verified_at column"));

// Safety-net: ensure email_verification_tokens exists.
pool
  .query(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
  `)
  .catch((err) => logger.error({ err }, "Failed to ensure email_verification_tokens table"));

// Safety-net: ensure the new_email column exists (staging column for email changes).
pool
  .query(`ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS new_email text;`)
  .catch((err) => logger.error({ err }, "Failed to ensure new_email column"));

// Safety-net: collapse duplicate profile rows for the same user. A race in
// getOrCreateProfileForUser (fixed with an advisory lock, but prod data may
// predate the fix) could insert two rows for one user_id. Keep the row the
// app actually reads — completed onboarding first, then the oldest id — and
// drop the rest. No-op when there are no duplicates. Legacy rows with a NULL
// user_id are intentionally left untouched.
pool
  .query(
    `DELETE FROM profile WHERE id IN (
       SELECT id FROM (
         SELECT id, row_number() OVER (
           PARTITION BY user_id
           ORDER BY is_onboarding_complete DESC, id ASC
         ) AS rn
         FROM profile
         WHERE user_id IS NOT NULL
       ) ranked
       WHERE rn > 1
     )`,
  )
  .then((r) => {
    if (r.rowCount) logger.warn({ removed: r.rowCount }, "Removed duplicate profile rows");
  })
  .catch((err) => logger.error({ err }, "Failed to dedupe profile rows"));

// One-time repair: the voice custom-LLM endpoint used to persist the same
// spoken turn more than once (ElevenLabs fires several completion requests per
// turn — fixed with since-call-start dedup + per-user serialization in
// voice-llm.ts). Collapse the rows it already wrote: same user, same role,
// identical content, created within 8 seconds of the previous copy — keep the
// earliest. Scope is deliberately narrow: the window is evidence-based (the
// largest gap among the known duplicates is 6.3s), morning notes are excluded
// (voice rows never are), and the date gate (< 2026-07-23, just after the fix
// shipped) means rows written later can NEVER be touched — a legit rapid
// "yes" "yes" in text chat must not be collapsed by future boots. No-op once
// the old duplicates are gone.
pool
  .query(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM (
         SELECT id,
                created_at - lag(created_at) OVER (
                  PARTITION BY user_id, role, content
                  ORDER BY created_at, id
                ) AS gap
         FROM messages
         WHERE created_at < '2026-07-23 00:00:00'
           AND is_morning_note = false
       ) ranked
       WHERE gap IS NOT NULL AND gap <= interval '8 seconds'
     )`,
  )
  .then((r) => {
    if (r.rowCount) logger.warn({ removed: r.rowCount }, "Removed duplicate voice-call message rows");
  })
  .catch((err) => logger.error({ err }, "Failed to dedupe voice-call message rows"));

// Safety-net: daily email opt-out and last-sent tracking columns.
pool
  .query(`
    ALTER TABLE profile ADD COLUMN IF NOT EXISTS daily_email_opt_out boolean NOT NULL DEFAULT false;
    ALTER TABLE profile ADD COLUMN IF NOT EXISTS last_email_date text;
    ALTER TABLE profile ADD COLUMN IF NOT EXISTS last_greeting_at timestamp;
  `)
  .catch((err) => logger.error({ err }, "Failed to ensure daily email columns"));

// Safety-net: commitment scheduling columns (conversation-captured plans with a
// concrete day/time, plus the timed-email-nudge dedup marker).
pool
  .query(`
    ALTER TABLE commitments ADD COLUMN IF NOT EXISTS scheduled_date text;
    ALTER TABLE commitments ADD COLUMN IF NOT EXISTS scheduled_time text;
    ALTER TABLE commitments ADD COLUMN IF NOT EXISTS nudge_sent_at timestamp;
  `)
  .catch((err) => logger.error({ err }, "Failed to ensure commitment scheduling columns"));

// Safety-net: per-user personalization state (anti-repetition phrase tracking).
pool
  .query(`
    CREATE TABLE IF NOT EXISTS personalization_state (
      user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      recent_phrases text[] NOT NULL DEFAULT '{}',
      updated_at timestamp NOT NULL DEFAULT now()
    );
  `)
  .catch((err) => logger.error({ err }, "Failed to ensure personalization_state table"));

// Safety-net: billing foundation tables (phase 1 — Paddle integration comes
// in phase 2; nothing writes these in normal operation yet). Idempotent by
// construction, same pattern as every safety-net above; the authoritative
// definitions live in lib/db/src/schema/billing.ts for drizzle-kit push.
pool
  .query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id),
      dodo_customer_id text,
      dodo_subscription_id text,
      tier text NOT NULL,
      status text NOT NULL,
      trial_ends_at timestamp,
      current_period_started_at timestamp,
      current_period_ends_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_started_at timestamp;
    CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);
    CREATE TABLE IF NOT EXISTS billing_events (
      id serial PRIMARY KEY,
      event_id text NOT NULL,
      event_type text NOT NULL,
      processed_at timestamp NOT NULL DEFAULT now(),
      payload_summary text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_events_event_idx ON billing_events (event_id);
    CREATE TABLE IF NOT EXISTS voice_usage (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id),
      call_started_at timestamp NOT NULL,
      call_ended_at timestamp,
      duration_seconds integer,
      source text NOT NULL DEFAULT 'client_report',
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS voice_usage_user_started_idx ON voice_usage (user_id, call_started_at);
  `)
  .catch((err) => logger.error({ err }, "Failed to ensure billing foundation tables"));

// ─── Cleanup job health tracking ─────────────────────────────────────────────
// Exported so the health route can expose it without a database query.
export const cleanupJobState = {
  lastSuccessAt: null as Date | null,
  lastErrorAt: null as Date | null,
  consecutiveFailures: 0,
  deletedLastRun: 0,
};

const CLEANUP_DEAD_MAN_MS = 48 * 60 * 60 * 1000; // 48 hours

// ─── Periodic cleanup: expired tokens ────────────────────────────────────────
async function runTokenCleanup() {
  try {
    const [prt, evt] = await Promise.all([
      pool.query(`
        DELETE FROM password_reset_tokens
        WHERE expires_at < NOW()
           OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '7 days')
      `),
      pool.query(`
        DELETE FROM email_verification_tokens
        WHERE expires_at < NOW()
      `),
    ]);

    const deleted = (prt.rowCount ?? 0) + (evt.rowCount ?? 0);

    cleanupJobState.lastSuccessAt = new Date();
    cleanupJobState.consecutiveFailures = 0;
    cleanupJobState.deletedLastRun = deleted;

    if (deleted > 0) {
      logger.info(
        {
          deletedPasswordResetTokens: prt.rowCount,
          deletedVerificationTokens: evt.rowCount,
        },
        "Cleaned up expired/used tokens",
      );
    }
  } catch (err) {
    cleanupJobState.consecutiveFailures += 1;
    cleanupJobState.lastErrorAt = new Date();
    logger.error(
      { err, consecutiveFailures: cleanupJobState.consecutiveFailures },
      "Token cleanup job failed",
    );
  }

  // Dead-man's switch: warn loudly if no successful run in 48 hours
  if (
    cleanupJobState.lastSuccessAt === null ||
    Date.now() - cleanupJobState.lastSuccessAt.getTime() > CLEANUP_DEAD_MAN_MS
  ) {
    logger.warn(
      {
        lastSuccessAt: cleanupJobState.lastSuccessAt,
        consecutiveFailures: cleanupJobState.consecutiveFailures,
        lastErrorAt: cleanupJobState.lastErrorAt,
      },
      "TOKEN_CLEANUP_STALE: token cleanup has not succeeded in over 48 hours — expired tokens may be accumulating",
    );
  }
}

// Run once at startup, then every 24 hours
runTokenCleanup();
setInterval(runTokenCleanup, 24 * 60 * 60 * 1000);

const app: Express = express();

// Trust Replit's reverse proxy so cookie secure-flag and X-Forwarded-* work
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ─── Security headers (Phase A privacy hardening) ─────────────────────────────
// The API serves JSON plus one self-contained HTML page (the account report),
// so the CSP here is locked down hard. frame-ancestors 'self' keeps the
// in-app report iframe working while blocking third-party embedding. The
// frontend bundle gets its own CSP via a <meta> tag injected at build time
// (see artifacts/aanya/vite.config.ts) because it is served as static files.
app.use(
  helmet({
    // The strict API CSP is applied per-route to /api below (apiCsp). It is NOT
    // set globally, because this server now also serves the frontend SPA, which
    // ships its own (looser) CSP via a <meta> tag injected at build time. A
    // global default-src 'none' header would combine with the SPA's meta CSP and
    // block its own scripts/styles, breaking the app.
    contentSecurityPolicy: false,
    // CSP frame-ancestors (in apiCsp) covers embedding; X-Frame-Options can't say "self + nothing else" cleanly
    frameguard: false,
    // Don't break same-origin audio blob playback in the app
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    // HSTS only in production — the workspace preview domain rotates
    strictTransportSecurity: process.env.NODE_ENV === "production" ? undefined : false,
  }),
);

// Strict CSP for API responses only (incl. the self-contained account-report
// HTML page). Mounted on /api below so it never touches the SPA's static files.
const apiCsp = helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'none'"],
    styleSrc: ["'unsafe-inline'"], // the account report page uses one inline <style> block
    imgSrc: ["'self'", "data:"],
    frameAncestors: ["'self'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    // ElevenLabs Conversational AI SDK inlines the rawAudioProcessor and
    // audioConcatProcessor worklet source, then loads it via
    // URL.createObjectURL (blob:) with a data: base64 fallback for Safari.
    // Chrome enforces script-src-elem (not worker-src) for AudioWorklet
    // module scripts loaded from a blob: URL. Without an explicit
    // script-src-elem Chrome falls back to script-src 'self', which blocks
    // the blob: worklet. Setting script-src-elem explicitly here prevents
    // that fallback and keeps script-src tight.
    scriptSrcElem: ["'self'", "blob:", "data:"],
    workerSrc: ["'self'", "blob:", "data:"],
  },
});

// ─── CORS allow-list (Phase A) ─────────────────────────────────────────────────
// Replaces the previous reflect-any-origin policy. Requests WITHOUT an Origin
// header (same-origin navigations, curl, ElevenLabs custom-LLM and scheduler
// server-to-server calls) pass through untouched; cross-origin browser
// requests only get CORS headers when the origin is one of ours.
const CORS_ALLOWED_HOSTS = new Set(
  [
    "eoscompanion.com",
    "www.eoscompanion.com",
    "eos-companion.replit.app", // published fallback domain
    process.env.REPLIT_DEV_DOMAIN ?? "", // workspace preview (dev only)
    "localhost",
    "127.0.0.1",
  ]
    .filter(Boolean)
    .map((h) => h.toLowerCase()),
);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header — not a cross-origin browser request
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // EXACT hosts only. No wildcard suffixes: any repl gets a *.replit.dev
    // domain, so a suffix rule would let attacker-controlled repls become
    // trusted origins for credentialed requests (review finding). The
    // workspace's own preview host is covered exactly via REPLIT_DEV_DOMAIN.
    return CORS_ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
    credentials: true,
  }),
);

// ─── Rate limiting for auth endpoints ─────────────────────────────────────────
// Keyed on req.ip (trust proxy is set above, so this is the real client IP on
// Render). GET/HEAD/OPTIONS are exempt from the general limiter so normal app
// traffic (/auth/me on every load, verify-email link clicks, CORS preflights)
// can never lock a user out — the credential-carrying POSTs are what need
// throttling, and the tokens themselves are 256-bit so GET brute force is moot.
// Limits are env-overridable so the test suite can exercise the 429 path
// deterministically without waiting out a 15-minute window.
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20);
const FORGOT_RATE_LIMIT_MAX = Number(process.env.FORGOT_RATE_LIMIT_MAX ?? 5);
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const skipReads = (req: express.Request): boolean =>
  req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";

// Stricter limiter for forgot-password: each request fans out to two emails
// (reset link + security alert), so it is the cheapest email-bombing vector.
// Mounted BEFORE the general limiter so its rejects don't consume the shared
// general budget.
app.use(
  "/api/auth/forgot-password",
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: FORGOT_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipReads,
    handler: (_req, res) => {
      res.status(429).json({
        error: "Too many password reset requests. Please wait a few minutes and try again.",
      });
    },
  }),
);

app.use(
  "/api/auth",
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: AUTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipReads,
    handler: (_req, res) => {
      res.status(429).json({
        error: "Too many attempts. Please wait a few minutes and try again.",
      });
    },
  }),
);

// ─── Session store (Postgres-backed, survives restarts) ───────────────────────
const PgStore = connectPgSimple(session);

app.use(
  session({
    store: new PgStore({
      pool,
      createTableIfMissing: true,
      tableName: "user_sessions",
    }),
    name: "sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // In production (behind Replit's HTTPS proxy), trust proxy is set above so
      // Express reads X-Forwarded-Proto and correctly marks cookies Secure.
      // In development and test the server is hit directly over HTTP, so keep
      // secure:false there or the browser / test runner never receives the cookie.
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }),
);

// ─── Billing webhook — RAW body, ahead of the global JSON parser ─────────────
// Dodo signs the exact body bytes (Standard Webhooks: HMAC over
// `${webhook-id}.${webhook-timestamp}.${rawBody}`); once
// express.json() has parsed the body the original bytes are gone and the
// signature can never verify. This was flagged as the classic integration
// trap in the payment-readiness review. The raw reader is scoped to exactly
// this one path: it stores the untouched Buffer on req.body and marks the
// body as consumed, so the global express.json() below skips it — every
// other route parses JSON exactly as before.
app.use("/api/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }));

// TEMPORARY (delete with routes/elevenLabsCapture.ts): the ElevenLabs
// post-call capture needs the raw bytes too — its signature is an HMAC over
// the exact byte layout, so the capture must preserve them.
app.use("/api/elevenlabs/capture-e9723ffc8e1e5e50", express.raw({ type: "*/*", limit: "2mb" }));

// 1mb: ElevenLabs custom-LLM requests carry the full call transcript, which can
// exceed the 100kb default on long voice calls.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", apiCsp, router);

// JSON 404 for any /api path no route matched. Without this, unmatched API
// requests fall through to Express's default HTML 404 page, which API clients
// (the SPA does res.json() on everything) misreport as a network error.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Serve the built frontend (single-origin deployment) ──────────────────────
// This server also serves the compiled Aanya SPA so the whole app lives on ONE
// origin. That is what the frontend expects: it calls /api/* with relative URLs
// and relies on same-site session cookies. Splitting the SPA onto a separate
// host breaks both (the relative calls hit the static host, and the lax cookie
// is not sent cross-site). The SPA is built to artifacts/aanya/dist/public.
//
// FRONTEND_DIR can override the location; otherwise resolve it relative to the
// server's working directory (artifacts/api-server when started via pnpm).
const frontendDir = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.resolve(process.cwd(), "../aanya/dist/public");

const frontendIndex = path.join(frontendDir, "index.html");

if (fs.existsSync(frontendIndex)) {
  // Hashed assets are safe to cache hard; index.html must stay fresh so new
  // deploys are picked up.
  app.use(
    express.static(frontendDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  // ─── Landing page at the root for new visitors ──────────────────────────────
  // A brand-new visitor opening eoscompanion.com should meet the marketing
  // landing page (public/welcome.html), not the sign-in screen. The app (SPA)
  // still owns "/" whenever it matters:
  //   - any query string (e.g. ?verifyToken=…, ?resetToken=…, ?cancelReset=…,
  //     ?enter=1) → SPA, so emailed token links keep working, and the landing
  //     page's own "Enter Eos" buttons link to /?enter=1 to reach sign-in;
  //   - an existing session cookie ("sid") → SPA, so returning users land
  //     straight in the app.
  // ─── Standalone legal pages (/terms, /refunds) ─────────────────────────────
  // Static files beside welcome.html in the same bundle — the marketing
  // page's footer already links here. Served at the clean path (no .html);
  // if a file is missing the request falls through to the SPA, whose router
  // shows its not-found state instead of a raw 404 page.
  for (const legal of ["terms", "refunds"] as const) {
    const legalFile = path.join(frontendDir, `${legal}.html`);
    app.get(`/${legal}`, (_req, res, next) => {
      if (!fs.existsSync(legalFile)) return next();
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(legalFile);
    });
  }

  const landingPage = path.join(frontendDir, "welcome.html");
  app.get("/", (req, res, next) => {
    const hasQuery = req.originalUrl.includes("?");
    const hasSession = (req.headers.cookie ?? "").includes("sid=");
    if (!hasQuery && !hasSession && fs.existsSync(landingPage)) {
      res.setHeader("Cache-Control", "no-cache");
      return res.sendFile(landingPage);
    }
    next();
  });

  // SPA fallback: any non-/api GET that didn't match a static file returns
  // index.html so client-side routing (wouter) can take over.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(frontendIndex);
  });

  logger.info({ frontendDir }, "Serving frontend static bundle");
} else {
  logger.warn(
    { frontendDir },
    "Frontend bundle not found — serving API only (set FRONTEND_DIR or build @workspace/aanya)",
  );
}

// ─── JSON error handler for the API (must be registered last) ─────────────────
// Catches errors thrown anywhere on an /api request — including body-parser
// JSON syntax errors raised by the global express.json() middleware — and
// answers in JSON. Express's default handler returns an HTML page, which the
// SPA's unconditional res.json() turns into a misleading "Network error"
// message. Non-/api paths (the SPA itself) keep the default handler.
const apiErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    typeof err?.status === "number" ? err.status
    : typeof err?.statusCode === "number" ? err.statusCode
    : 500;
  if (status >= 500) {
    logger.error({ err }, "Unhandled API error");
    res.status(status).json({ error: "Something went wrong. Please try again." });
    return;
  }
  const message =
    err?.type === "entity.parse.failed" ? "Invalid JSON in request body."
    : err?.type === "entity.too.large" ? "Request body is too large."
    : typeof err?.message === "string" && err.message ? err.message
    : "Bad request.";
  res.status(status).json({ error: message });
};
app.use("/api", apiErrorHandler);

export default app;
