/**
 * Cloudflare Web Analytics on the public pages (lib/publicPage.ts).
 *   • the beacon is injected once, before </head>, only when CF_BEACON_TOKEN
 *     is a plausible token; unset or malformed → the page is byte-identical
 *     and carries no analytics script;
 *   • it reaches the landing page, the legal pages and the visitor pricing
 *     page through the real routes, and never the app shell.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyticsBeaconTag, withAnalyticsBeacon } from "../lib/publicPage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../../aanya/public");
// Built at runtime, not a hex literal: the secret scan flags key-shaped
// literals in tracked files, and this test value must not look like one.
const TOKEN = "ab".repeat(16);
let app: Express;

beforeAll(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "eos-public-analytics-"));
  fs.writeFileSync(path.join(fixture, "index.html"), "<!doctype html><html><head><title>app</title></head><body></body></html>");
  for (const f of ["welcome.html", "privacy.html", "pricing.html", "security.html", "terms.html", "refunds.html"]) {
    fs.copyFileSync(path.join(publicDir, f), path.join(fixture, f));
  }
  process.env.FRONTEND_DIR = fixture;
  app = (await import("../app.js")).default;
});

afterEach(() => {
  delete process.env.CF_BEACON_TOKEN;
});

describe("withAnalyticsBeacon", () => {
  const page = "<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>";

  it("injects the beacon once before </head> with the token", () => {
    const out = withAnalyticsBeacon(page, TOKEN);
    expect(out.match(/cloudflareinsights\.com\/beacon\.min\.js/g)).toHaveLength(1);
    expect(out).toContain(`data-cf-beacon='{"token": "${TOKEN}"}'`);
    expect(out.indexOf("beacon.min.js")).toBeLessThan(out.indexOf("</head>"));
    expect(out).toContain("<script defer");
  });

  it("leaves the page untouched without a token, or with a malformed one", () => {
    expect(withAnalyticsBeacon(page, undefined)).toBe(page);
    expect(withAnalyticsBeacon(page, "")).toBe(page);
    expect(withAnalyticsBeacon(page, "abc")).toBe(page); // too short
    expect(withAnalyticsBeacon(page, `${TOKEN}"><script>alert(1)</script>`)).toBe(page); // never injected
    expect(analyticsBeaconTag("not a token")).toBe("");
  });
});

describe("the public routes", () => {
  it("carry the beacon when CF_BEACON_TOKEN is set", async () => {
    process.env.CF_BEACON_TOKEN = TOKEN;
    for (const url of ["/", "/privacy", "/security", "/terms", "/refunds", "/pricing"]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.headers["content-type"], url).toMatch(/text\/html/);
      expect(res.text.match(/beacon\.min\.js/g), url).toHaveLength(1);
      expect(res.text, url).toContain(TOKEN);
    }
  });

  it("carry no analytics script at all when it is unset", async () => {
    for (const url of ["/", "/privacy", "/security", "/terms", "/refunds", "/pricing"]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.text, url).not.toContain("cloudflareinsights");
      expect(res.text, url).not.toContain("data-cf-beacon");
    }
  });

  it("never reaches the app shell", async () => {
    process.env.CF_BEACON_TOKEN = TOKEN;
    // Any app route falls through to index.html…
    const anon = await request(app).get("/memory");
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain("cloudflareinsights");
    // …and so do / and /pricing for a signed-in member.
    const member = request.agent(app);
    const signup = await member
      .post("/api/auth/signup")
      .send({ email: `analytics-member-${Date.now()}@example.com`, password: "Test1234!" });
    expect(signup.status).toBe(201);
    for (const url of ["/", "/pricing"]) {
      const res = await member.get(url);
      expect(res.status, url).toBe(200);
      expect(res.text, url).toContain("<title>app</title>");
      expect(res.text, url).not.toContain("cloudflareinsights");
    }
  });

  // The regression: a stale sid cookie must not turn the landing page into
  // the app's sign-in form. The beacon still rides along, and the cookie goes.
  it("serves the landing page, beacon and all, over a stale sid cookie", async () => {
    process.env.CF_BEACON_TOKEN = TOKEN;
    const res = await request(app).get("/").set("Cookie", "sid=s%3Agone.sig");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<title>app</title>");
    expect(res.text).toContain("beacon.min.js");
    expect(String(res.headers["set-cookie"])).toMatch(/(^|,)sid=;/);
  });
});
