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

// ─── Periodic cleanup: expired and used password reset tokens ─────────────────
async function cleanExpiredPasswordResetTokens() {
  try {
    const result = await pool.query(`
      DELETE FROM password_reset_tokens
      WHERE expires_at < NOW()
         OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '7 days')
    `);
    if (result.rowCount && result.rowCount > 0) {
      logger.info({ deleted: result.rowCount }, "Cleaned up expired/used password reset tokens");
    }
  } catch (err) {
    logger.error({ err }, "Failed to clean up password reset tokens");
  }
}

// Run once at startup, then every 24 hours
cleanExpiredPasswordResetTokens();
setInterval(cleanExpiredPasswordResetTokens, 24 * 60 * 60 * 1000);

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
      // The Replit proxy handles TLS — Express itself sees HTTP internally.
      // Setting secure:false ensures cookies are set correctly in this setup.
      secure: false,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
