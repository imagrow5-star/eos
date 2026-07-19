import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

// SESSION_SECRET is required — fail fast rather than silently use a weak fallback
if (!process.env.SESSION_SECRET) {
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

// Allow credentials (cookies) for same-origin requests through the Replit proxy
app.use(cors({ origin: true, credentials: true }));

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
    secret: process.env.SESSION_SECRET ?? "dev-secret-please-set-SESSION_SECRET",
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

// 1mb: ElevenLabs custom-LLM requests carry the full call transcript, which can
// exceed the 100kb default on long voice calls.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
