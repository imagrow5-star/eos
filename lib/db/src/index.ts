import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// node-postgres only speaks TLS when asked, so DATABASE_SSL makes the choice
// explicit and auditable instead of buried in connection-string params:
//   "require"          — encrypt the connection, skip certificate verification
//                        (libpq sslmode=require semantics; defeats network
//                        sniffing even when the host's cert chain can't be
//                        verified, e.g. managed-Postgres internal endpoints)
//   "verify" / "verify-full" — encrypt AND verify the server certificate
//   unset / anything else    — connection-string params (sslmode=…) decide
// The api-server verifies the resulting state at boot via pg_stat_ssl and
// refuses to run unencrypted in production.
export function poolSslConfig(
  env: NodeJS.ProcessEnv = process.env,
): pg.PoolConfig["ssl"] {
  const mode = (env.DATABASE_SSL ?? "").trim().toLowerCase();
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode === "verify" || mode === "verify-full") return true;
  return undefined;
}

const poolConfig: pg.PoolConfig = { connectionString: process.env.DATABASE_URL };
const ssl = poolSslConfig();
if (ssl !== undefined) poolConfig.ssl = ssl;

export const pool = new Pool(poolConfig);
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./crypto";
