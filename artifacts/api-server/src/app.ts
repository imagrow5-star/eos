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

// Ensure the session table exists before the server starts accepting requests.
// connect-pg-simple's createTableIfMissing option is unreliable on cold starts,
// so we create the table explicitly here.
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
