/**
 * One URL per public page (lib/canonicalUrls.ts, app.ts):
 *   • the file-name twins (/welcome.html, /pricing.html, …) redirect
 *     permanently to the clean path, query kept;
 *   • www.eoscompanion.com redirects permanently to the apex, path and
 *     query kept; other hosts are left alone;
 *   • every public page declares its clean URL as canonical, and the app
 *     shell is noindex.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apexRedirectFor, cleanPathForTwin, HTML_TWINS } from "../lib/canonicalUrls.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const aanya = path.resolve(here, "../../../aanya");
const publicDir = path.join(aanya, "public");
const PAGES = ["welcome", "pricing", "privacy", "security", "terms", "refunds"] as const;

let app: Express;

beforeAll(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "eos-canonical-"));
  fs.copyFileSync(path.join(aanya, "index.html"), path.join(fixture, "index.html"));
  for (const p of PAGES) fs.copyFileSync(path.join(publicDir, `${p}.html`), path.join(fixture, `${p}.html`));
  process.env.FRONTEND_DIR = fixture;
  app = (await import("../app.js")).default;
});

describe("canonicalUrls", () => {
  it("maps every file-name twin to its clean path, case-insensitively", () => {
    expect(cleanPathForTwin("/welcome.html")).toBe("/");
    expect(cleanPathForTwin("/index.html")).toBe("/");
    expect(cleanPathForTwin("/Pricing.HTML")).toBe("/pricing");
    expect(cleanPathForTwin("/pricing")).toBeNull();
    expect(cleanPathForTwin("/assets/app.html")).toBeNull();
    for (const p of PAGES) expect(HTML_TWINS[`/${p}.html`]).toBeDefined();
  });

  it("sends only the www host to the apex, keeping path and query", () => {
    expect(apexRedirectFor("www.eoscompanion.com", "/pricing?utm_source=x")).toBe("https://eoscompanion.com/pricing?utm_source=x");
    expect(apexRedirectFor("WWW.eoscompanion.com", "/")).toBe("https://eoscompanion.com/");
    expect(apexRedirectFor("eoscompanion.com", "/")).toBeNull();
    expect(apexRedirectFor("eos-oug8.onrender.com", "/")).toBeNull();
    expect(apexRedirectFor("localhost", "/")).toBeNull();
    expect(apexRedirectFor(undefined, "/")).toBeNull();
  });
});

describe("the public pages, on the wire", () => {
  it("redirect each file-name twin permanently to the clean path, query kept", async () => {
    for (const [twin, clean] of Object.entries(HTML_TWINS)) {
      const res = await request(app).get(`${twin}?igsh=abc`);
      expect(res.status, twin).toBe(301);
      expect(res.headers.location, twin).toBe(`${clean}?igsh=abc`);
    }
  });

  it("redirect the www host to the apex and leave other hosts alone", async () => {
    const www = await request(app).get("/privacy?x=1").set("Host", "www.eoscompanion.com");
    expect(www.status).toBe(301);
    expect(www.headers.location).toBe("https://eoscompanion.com/privacy?x=1");
    // Behind Render the host arrives forwarded; trust proxy makes req.hostname read it.
    const fwd = await request(app).get("/").set("X-Forwarded-Host", "www.eoscompanion.com");
    expect(fwd.status).toBe(301);
    expect(fwd.headers.location).toBe("https://eoscompanion.com/");
    const apex = await request(app).get("/privacy").set("Host", "eoscompanion.com");
    expect(apex.status).toBe(200);
    const post = await request(app).post("/api/leads").set("Host", "www.eoscompanion.com").send({});
    expect(post.status).toBe(308);
  });

  it("declare one canonical URL each, and the app shell is noindex", async () => {
    const expected: Record<string, string> = {
      "/": "https://eoscompanion.com/",
      "/pricing": "https://eoscompanion.com/pricing",
      "/privacy": "https://eoscompanion.com/privacy",
      "/security": "https://eoscompanion.com/security",
      "/terms": "https://eoscompanion.com/terms",
      "/refunds": "https://eoscompanion.com/refunds",
    };
    for (const [url, canonical] of Object.entries(expected)) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      const tags = res.text.match(/<link rel="canonical"[^>]*>/g) ?? [];
      expect(tags, url).toHaveLength(1);
      expect(tags[0], url).toContain(`href="${canonical}"`);
      expect(res.text, url).not.toMatch(/name="robots"[^>]*noindex/);
    }
    const shell = await request(app).get("/?enter=1");
    expect(shell.status).toBe(200);
    expect(shell.text).toMatch(/<meta name="robots" content="noindex"/);
    expect(shell.text).not.toContain('rel="canonical"');
  });

  it("lists exactly the six public pages in the sitemap, none of which redirect", async () => {
    const xml = fs.readFileSync(path.join(publicDir, "sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.sort()).toEqual([
      "https://eoscompanion.com/",
      "https://eoscompanion.com/pricing",
      "https://eoscompanion.com/privacy",
      "https://eoscompanion.com/refunds",
      "https://eoscompanion.com/security",
      "https://eoscompanion.com/terms",
    ]);
    for (const loc of locs) {
      const res = await request(app).get(new URL(loc).pathname);
      expect(res.status, loc).toBe(200);
    }
    // No date older than the last content change of its page.
    for (const m of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) expect(m[1]! >= "2026-09-14").toBe(true);
  });
});
