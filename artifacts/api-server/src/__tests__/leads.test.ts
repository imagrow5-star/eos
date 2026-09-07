/**
 * Landing-page email capture — POST /api/leads (public, no auth).
 *
 * A cold visitor's first ask is an email, not a card. This path had none of
 * the app's auth scaffolding, so it's the kind of user-facing route that ships
 * untested — guard it: valid capture stores the consent record, a repeat is
 * idempotent, junk is rejected, and the bot honeypot stores nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function freshEmail(tag: string): string {
  const e = `lead-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

beforeAll(async () => {
  // The boot safety-net creates this fire-and-forget; ensure it exists before
  // the first request so the suite never races the table into being.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id serial PRIMARY KEY,
      email text NOT NULL UNIQUE,
      source text NOT NULL,
      consent_text text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
  `);
});

afterAll(async () => {
  for (const e of emails) await pool.query("DELETE FROM leads WHERE email = $1", [e]);
  await pool.end();
});

describe("POST /api/leads — landing email capture", () => {
  it("stores a valid email with its source and the consent copy", async () => {
    const email = freshEmail("valid");
    const res = await request(app).post("/api/leads").send({ email, source: "landing_hero" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = await pool.query(
      "SELECT source, consent_text FROM leads WHERE email = $1",
      [email],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].source).toBe("landing_hero");
    // The stored consent must be the real promise — and must NOT claim a free
    // tier we haven't committed to.
    expect(rows.rows[0].consent_text).toBe(
      "I'll send you the essays as they're published. Nothing else.",
    );
    expect(rows.rows[0].consent_text).not.toMatch(/free/i);
  });

  it("normalizes case/whitespace and is idempotent on a repeat submit", async () => {
    const email = freshEmail("dupe");
    const r1 = await request(app).post("/api/leads").send({ email: `  ${email.toUpperCase()} ` });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post("/api/leads").send({ email });
    expect(r2.status).toBe(200);

    const rows = await pool.query("SELECT id FROM leads WHERE email = $1", [email]);
    expect(rows.rowCount).toBe(1); // one row, stored lowercased/trimmed
  });

  it("rejects an obviously invalid email", async () => {
    const res = await request(app).post("/api/leads").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("silently drops a bot submission that fills the honeypot", async () => {
    const email = freshEmail("bot");
    const res = await request(app)
      .post("/api/leads")
      .send({ email, website: "http://spam.example" });
    expect(res.status).toBe(200); // looks like success to the bot
    const rows = await pool.query("SELECT id FROM leads WHERE email = $1", [email]);
    expect(rows.rowCount).toBe(0); // …but nothing was stored
  });

  it("defaults an unknown source to landing_hero rather than storing junk", async () => {
    const email = freshEmail("src");
    await request(app).post("/api/leads").send({ email, source: "'; DROP TABLE leads; --" });
    const rows = await pool.query("SELECT source FROM leads WHERE email = $1", [email]);
    expect(rows.rows[0]?.source).toBe("landing_hero");
  });
});
