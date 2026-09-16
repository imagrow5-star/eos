/**
 * /terms and /refunds — the standalone legal pages the marketing footer has
 * linked to (as 404s) since before billing existed.
 *
 * app.ts serves them from the frontend bundle directory, which doesn't exist
 * in the test environment — so this file points FRONTEND_DIR at a fixture
 * copied from the real source pages in artifacts/aanya/public/ and imports
 * the app dynamically (same isolation pattern as rate-limit.test.ts). This
 * proves the routes serve the REAL page content, not stand-ins.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../../aanya/public");

let app: Express;

beforeAll(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "eos-legal-pages-"));
  fs.writeFileSync(path.join(fixture, "index.html"), "<!doctype html><title>app</title>");
  for (const f of ["privacy.html", "pricing.html", "terms.html", "refunds.html"]) {
    fs.copyFileSync(path.join(publicDir, f), path.join(fixture, f));
  }
  process.env.FRONTEND_DIR = fixture;
  app = (await import("../app.js")).default;
});

describe("legal pages", () => {
  it("serves /terms with the required commitments in plain English", async () => {
    const res = await request(app).get("/terms");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    const html = res.text;
    expect(html).toContain("Terms of Service");
    // The commitments that must never silently vanish from this page:
    expect(html).toMatch(/not therapy, not medical care, and not a crisis service/i);
    expect(html).toMatch(/18 years or older/i);
    expect(html).toContain("secure payment partner"); // processor deliberately unnamed
    expect(html).toMatch(/7-day free trial/i);
    expect(html).toMatch(/30 days'? notice/i);
    expect(html).toMatch(/text never stops/i);
    expect(html).toMatch(/don'?t roll over/i);
    expect(html).toContain("governed by the laws of India");
    // No bracketed placeholder may ever be visible on the live page — the
    // "[GOVERNING LAW — FOUNDER TO CONFIRM …]" block shipped exactly once.
    expect(html).not.toMatch(/\[[A-Z]{2,}/);
    expect(html).toContain("/privacy");
    // Privacy pointer must reuse only APPROVED claims — the overreaching
    // marketing phrase must not appear here.
    expect(html).not.toMatch(/end-to-end/i);
  });

  it("serves /privacy as a static page that needs no JavaScript and no modern engine", async () => {
    const res = await request(app).get("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    const html = res.text;
    expect(html).toContain("Your privacy, in plain words");
    // The trust page must work everywhere: no scripts at all, so JavaScript
    // off or an old engine still renders every word.
    expect(html).not.toMatch(/<script/i);
    // The commitments that must never silently vanish:
    expect(html).toMatch(/never used to train|Use your conversations to train AI models/i);
    expect(html).toMatch(/Sell or rent your data/i);
    expect(html).toMatch(/delete account/i);
    expect(html).toMatch(/within one turn during a live voice call/i);
    expect(html).toContain("hello@eoscompanion.com");
    expect(html).toContain("Itslexa");
    expect(html).not.toMatch(/end-to-end/i);
    expect(html).not.toMatch(/\[[A-Z]{2,}/);
  });

  it("serves /pricing to a visitor as a static page with all three plans and no JavaScript", async () => {
    const res = await request(app).get("/pricing");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    const html = res.text;
    expect(html).not.toMatch(/<script/i);
    // The same three plans and prices as the landing page and the structured data.
    for (const s of ["Essential", "$19.99", "Standard", "$39.99", "Full", "$59.99", "120 minutes", "300 minutes", "500 minutes"]) {
      expect(html).toContain(s);
    }
    expect(html).toMatch(/7-day trial/i);
    expect(html).toMatch(/pay nothing/i);
    for (const tier of ["companion", "closer", "always"]) expect(html).toContain(`/?enter=1&amp;plan=${tier}`);
    expect(html).toContain("/refunds");
  });

  it("hands /pricing to the app for a signed-in member (live session)", async () => {
    const agent = request.agent(app);
    const signup = await agent
      .post("/api/auth/signup")
      .send({ email: `pricing-member-${Date.now()}@example.com`, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const res = await agent.get("/pricing");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>app</title>"); // the SPA shell fixture, not the static page
    expect(res.text).not.toContain("Choose the plan that fits.");
  });

  // A sid cookie is not a session. One left behind by an expired or destroyed
  // session (or an abandoned Google sign-in) used to send the visitor to the
  // app, which met them with the sign-in form. The static page wins, and the
  // stale cookie is cleared so the browser stops presenting it.
  it("serves /pricing to a visitor whose sid cookie no longer maps to a session, and clears it", async () => {
    const res = await request(app).get("/pricing").set("Cookie", "sid=s%3Astale.signature; theme=dark");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Choose the plan that fits.");
    expect(String(res.headers["set-cookie"])).toMatch(/sid=;.*Expires=Thu, 01 Jan 1970/);
  });

  it("serves /refunds with the 14-day guarantee", async () => {
    const res = await request(app).get("/refunds");
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html).toContain("Refund Policy");
    expect(html).toMatch(/14 days/i);
    expect(html).toContain("hello@eoscompanion.com");
    expect(html).toMatch(/no questions asked/i);
    expect(html).toMatch(/never charged/i);
    expect(html).toMatch(/stops all future billing/i);
  });
});
