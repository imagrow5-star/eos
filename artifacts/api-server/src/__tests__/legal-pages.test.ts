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
  for (const f of ["terms.html", "refunds.html"]) {
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
