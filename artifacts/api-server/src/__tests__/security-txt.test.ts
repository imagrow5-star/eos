/**
 * /.well-known/security.txt (RFC 9116) is served from code on every
 * deployment, carries the required fields, and its Expires date is still
 * ahead — an expired file counts as absent, so this test is the yearly
 * reminder to bump it (lib/securityTxt.ts).
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app.js";
import { SECURITY_TXT_EXPIRES } from "../lib/securityTxt.js";

describe("GET /.well-known/security.txt", () => {
  it("serves the RFC 9116 fields as plain text with the page headers", async () => {
    const res = await request(app).get("/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toContain("Contact: mailto:hello@eoscompanion.com");
    expect(res.text).toContain(`Expires: ${SECURITY_TXT_EXPIRES}`);
    expect(res.text).toContain("Canonical: https://eoscompanion.com/.well-known/security.txt");
    expect(res.text).toContain("Policy: https://eoscompanion.com/security");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("Expires is in the future and at most a year out (bump SECURITY_TXT_EXPIRES yearly)", () => {
    const expires = new Date(SECURITY_TXT_EXPIRES).getTime();
    const now = Date.now();
    expect(expires).toBeGreaterThan(now + 7 * 24 * 3600 * 1000);
    expect(expires).toBeLessThanOrEqual(now + 366 * 24 * 3600 * 1000);
  });
});
