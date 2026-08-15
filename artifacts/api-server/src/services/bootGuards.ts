// ─── Boot security guards ─────────────────────────────────────────────────────
// Two checks that run once at startup, before the server takes traffic:
//
// 1. SESSION_SECRET strength. The secret signs login cookies, voice tokens,
//    unsubscribe links, and every internal HMAC sweep token — a short secret
//    makes all of them brute-forceable offline. app.ts already refuses to boot
//    when the secret is missing (any environment); production additionally
//    refuses a weak one here.
//
// 2. Database TLS. Field-level encryption protects stored content, but the
//    SQL stream itself (queries, session rows, metadata) crosses the network
//    in cleartext unless the connection is TLS. pg_stat_ssl reports ground
//    truth for the live connection — not what the config *asked* for, what the
//    server actually negotiated — so this catches a mis-set DATABASE_URL that
//    silently downgraded to plaintext.
//
// Both checks are pure/injectable so tests can exercise every branch without
// booting the server or owning a TLS-terminating Postgres.

import { pool } from "@workspace/db";

// Returns a human-readable problem with SESSION_SECRET, or null when it's
// acceptable for the given environment. Missing is reported in every
// environment (app.ts throws first in practice — this is the belt to that
// braces); weakness (< 32 chars) is only a problem in production, because dev
// and CI legitimately use short throwaway values.
export function sessionSecretIssue(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = env.SESSION_SECRET;
  if (!secret) return "SESSION_SECRET is not set";
  if (env.NODE_ENV === "production" && secret.length < 32) {
    return (
      `SESSION_SECRET is only ${secret.length} characters — production requires at least 32. ` +
      "Generate a strong one with: openssl rand -base64 32 " +
      "(NOTE: changing it logs every user out and invalidates in-flight voice/unsubscribe tokens, so rotate deliberately)"
    );
  }
  return null;
}

export type DbTlsState = "encrypted" | "plaintext" | "unknown";

type SslQueryFn = (sql: string) => Promise<{ rows: Array<{ ssl?: boolean }> }>;

// Asks Postgres whether THIS connection is TLS-encrypted. "unknown" means the
// check itself failed (DB unreachable, exotic proxy without pg_stat_ssl) — the
// caller treats that as a warning, not a verdict, mirroring how the other boot
// guards tolerate a briefly-unreachable database.
export async function checkDbTls(
  queryFn: SslQueryFn = (sql) => pool.query(sql),
): Promise<DbTlsState> {
  try {
    const result = await queryFn(
      "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    );
    const row = result.rows[0];
    if (!row || typeof row.ssl !== "boolean") return "unknown";
    return row.ssl ? "encrypted" : "plaintext";
  } catch {
    return "unknown";
  }
}
