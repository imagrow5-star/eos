/**
 * Account email delivery must never be reported as done when it wasn't.
 * A real investigation ("Charlie signed up, nothing in Resend") found the
 * log saying "Verification email sent" on a path where no key was set and
 * nothing was sent. What must hold, through the real signup route:
 *   • no RESEND_API_KEY → the "not configured" line is logged and
 *     "Verification email sent" is NOT;
 *   • Resend rejects the send (403 "testing emails only" / domain not
 *     verified) → "Failed to send verification email" carries the status and
 *     Resend's own message, and "sent" is NOT logged;
 *   • Resend accepts → "Verification email sent".
 * The address never appears in any of these lines.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { logger } from "../lib/logger.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

afterAll(async () => {
  for (const email of emails) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`
      BEGIN;
      DELETE FROM user_sessions             WHERE sess::jsonb->>'userId' = '${uid}';
      DELETE FROM email_verification_tokens WHERE user_id = ${uid};
      DELETE FROM messages                  WHERE user_id = ${uid};
      DELETE FROM profile                   WHERE user_id = ${uid};
      DELETE FROM users                     WHERE id      = ${uid};
      COMMIT;
    `);
  }
  await pool.end();
});

type LogCall = [unknown, string?];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sign one user up with the given Resend key state and fetch behaviour; return the log lines. */
async function signupWith(opts: { key: string | undefined; resend?: (init: RequestInit) => Response }) {
  const email = `delivery-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(email);
  const priorKey = process.env.RESEND_API_KEY;
  const priorSalt = process.env.LOG_HASH_SALT;
  const realFetch = globalThis.fetch;
  process.env.LOG_HASH_SALT = "delivery-test-salt";
  if (opts.key === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = opts.key;
  if (opts.resend) {
    const custom = opts.resend;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.resend.com/")) return Promise.resolve(custom(init ?? {}));
      return realFetch(input, init);
    }) as typeof fetch;
  }
  const info = vi.spyOn(logger, "info");
  const warn = vi.spyOn(logger, "warn");
  const error = vi.spyOn(logger, "error");
  try {
    const res = await request(app).post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(res.status).toBe(201);
    await sleep(400); // the send is fire-and-forget
    const lines = (spy: typeof info) => (spy.mock.calls as unknown as LogCall[]).map((c) => (typeof c[0] === "string" ? [{}, c[0]] : [c[0], c[1]]) as [Record<string, unknown>, string]);
    return { email, info: lines(info), warn: lines(warn), error: lines(error) };
  } finally {
    info.mockRestore(); warn.mockRestore(); error.mockRestore();
    globalThis.fetch = realFetch;
    if (priorKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = priorKey;
    if (priorSalt === undefined) delete process.env.LOG_HASH_SALT; else process.env.LOG_HASH_SALT = priorSalt;
  }
}

describe.skipIf(!process.env.DATABASE_URL)("verification email: the log says what happened", () => {
  it("no RESEND_API_KEY: 'not configured' is logged, 'sent' is not", async () => {
    const r = await signupWith({ key: undefined });
    expect(r.warn.some(([, m]) => /RESEND_API_KEY not set/.test(m ?? ""))).toBe(true);
    expect(r.error.some(([, m]) => m === "Verification email NOT sent: email delivery is not configured")).toBe(true);
    expect(r.info.some(([, m]) => m === "Verification email sent")).toBe(false);
    for (const l of [...r.info, ...r.warn, ...r.error]) expect(JSON.stringify(l)).not.toContain(r.email);
  });

  it("Resend refuses (403, testing-only account): the failure line carries the status and Resend's message", async () => {
    const body = JSON.stringify({ statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (you@example.com)." });
    const r = await signupWith({ key: "re_test_dummy", resend: () => new Response(body, { status: 403, headers: { "Content-Type": "application/json" } }) });
    const failed = r.error.find(([, m]) => m === "Failed to send verification email");
    expect(failed).toBeDefined();
    const err = (failed![0] as { err?: { message?: string } }).err;
    expect(err?.message).toContain("Resend API error 403");
    expect(err?.message).toContain("only send testing emails");
    expect(r.info.some(([, m]) => m === "Verification email sent")).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(r.email);
  });

  it("Resend accepts: 'Verification email sent'", async () => {
    const r = await signupWith({ key: "re_test_dummy", resend: () => new Response(JSON.stringify({ id: "em_1" }), { status: 200, headers: { "Content-Type": "application/json" } }) });
    expect(r.info.some(([, m]) => m === "Verification email sent")).toBe(true);
    expect(r.error.some(([, m]) => /verification email/i.test(m ?? ""))).toBe(false);
  });
});
