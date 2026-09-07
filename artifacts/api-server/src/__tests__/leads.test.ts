/**
 * "Ask the founder" capture — POST /api/leads (public, no auth).
 *
 * A visitor with doubts reaches Naveen directly: email + optional message. This
 * path has none of the app's auth scaffolding, so guard it — valid capture
 * stores the message and the consent record, the consent copy never drifts into
 * marketing/list claims, a repeat updates the message (one row), junk is
 * rejected, the bot honeypot stores nothing, and the founder-notify carries the
 * message (escaped).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { founderNotifyHtml, LEAD_CONSENT_TEXT } from "../routes/leads.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function freshEmail(tag: string): string {
  const e = `lead-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

beforeAll(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id serial PRIMARY KEY,
      email text NOT NULL UNIQUE,
      source text NOT NULL,
      consent_text text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS message text;`);
});

afterAll(async () => {
  for (const e of emails) await pool.query("DELETE FROM leads WHERE email = $1", [e]);
  await pool.end();
});

describe("consent copy — must stay a personal reply, never a marketing claim", () => {
  it("is the exact founder-reply promise and carries no list/marketing language", () => {
    expect(LEAD_CONSENT_TEXT).toBe(
      "Naveen reads every message himself and replies personally. You won't be added to anything.",
    );
    // The whole point of the reframe: no newsletter/subscription/offer wording,
    // and no leftover "essays"/"free" from the previous version.
    expect(LEAD_CONSENT_TEXT).not.toMatch(
      /newsletter|subscribe|unsubscribe|marketing|essays|free|offer|discount|deal|promo/i,
    );
  });
});

describe("founder-notify email — the message must reach Naveen", () => {
  it("includes the message and HTML-escapes it", () => {
    const html = founderNotifyHtml("who@example.invalid", "why <b>should</b> I trust you?", "landing_hero");
    expect(html).toContain("who@example.invalid");
    expect(html).toContain("why &lt;b&gt;should&lt;/b&gt; I trust you?"); // escaped, not raw markup
    expect(html).not.toContain("<b>should</b>");
  });

  it("handles an email-only reach out (no message)", () => {
    const html = founderNotifyHtml("who@example.invalid", "", "landing_footer");
    expect(html).toMatch(/no message/i);
  });
});

describe("POST /api/leads — the capture", () => {
  it("stores the email, the message, the source and the consent copy", async () => {
    const email = freshEmail("valid");
    const res = await request(app)
      .post("/api/leads")
      .send({ email, message: "What happens to what I tell it?", source: "landing_hero" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = await pool.query(
      "SELECT message, source, consent_text FROM leads WHERE email = $1",
      [email],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].message).toBe("What happens to what I tell it?");
    expect(rows.rows[0].source).toBe("landing_hero");
    expect(rows.rows[0].consent_text).toBe(LEAD_CONSENT_TEXT);
  });

  it("allows an email-only reach out (message optional → null)", async () => {
    const email = freshEmail("nomsg");
    const res = await request(app).post("/api/leads").send({ email });
    expect(res.status).toBe(200);
    const rows = await pool.query("SELECT message FROM leads WHERE email = $1", [email]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].message).toBeNull();
  });

  it("keeps one row per person and updates the message on a repeat", async () => {
    const email = freshEmail("repeat");
    await request(app).post("/api/leads").send({ email, message: "first question" });
    await request(app).post("/api/leads").send({ email, message: "second question" });
    const rows = await pool.query("SELECT message FROM leads WHERE email = $1", [email]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].message).toBe("second question");
  });

  it("caps an over-long message rather than storing unbounded text", async () => {
    const email = freshEmail("long");
    await request(app).post("/api/leads").send({ email, message: "x".repeat(5000) });
    const rows = await pool.query("SELECT length(message) AS n FROM leads WHERE email = $1", [email]);
    expect(Number(rows.rows[0].n)).toBe(2000);
  });

  it("rejects an obviously invalid email", async () => {
    const res = await request(app).post("/api/leads").send({ email: "not-an-email", message: "hi" });
    expect(res.status).toBe(400);
  });

  it("silently drops a bot submission that fills the honeypot", async () => {
    const email = freshEmail("bot");
    const res = await request(app)
      .post("/api/leads")
      .send({ email, message: "spam", website: "http://spam.example" });
    expect(res.status).toBe(200);
    const rows = await pool.query("SELECT id FROM leads WHERE email = $1", [email]);
    expect(rows.rowCount).toBe(0);
  });

  it("defaults an unknown source to landing_hero rather than storing junk", async () => {
    const email = freshEmail("src");
    await request(app).post("/api/leads").send({ email, source: "'; DROP TABLE leads; --" });
    const rows = await pool.query("SELECT source FROM leads WHERE email = $1", [email]);
    expect(rows.rows[0]?.source).toBe("landing_hero");
  });
});
