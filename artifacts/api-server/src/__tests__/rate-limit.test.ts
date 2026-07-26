/**
 * Integration tests: per-IP rate limiting on the auth endpoints.
 *
 * The limiters read AUTH_RATE_LIMIT_MAX / FORGOT_RATE_LIMIT_MAX from the
 * environment at app-import time, so this file sets SMALL values and then
 * imports the app DYNAMICALLY (each vitest file runs in its own isolated
 * module graph, so this cannot leak into other test files — they get the
 * high defaults from setup/rate-limit-env.ts).
 *
 * Covers:
 *  - forgot-password trips its dedicated limiter with a JSON 429.
 *  - the general /api/auth limiter trips on repeated login attempts.
 *  - GET endpoints (/auth/me) are exempt so the app can never lock itself out.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.AUTH_RATE_LIMIT_MAX = "10";
process.env.FORGOT_RATE_LIMIT_MAX = "2";

let app: Express;

beforeAll(async () => {
  app = (await import("../app.js")).default;
});

describe("auth rate limiting", () => {
  it("throttles forgot-password after its limit with a JSON 429", async () => {
    // Unknown address: the route still answers the generic 200 and does no
    // DB writes, so these requests are side-effect free.
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: "rate-limit-probe@example.invalid" });
      expect(res.status).toBe(200);
    }

    const limited = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "rate-limit-probe@example.invalid" });
    expect(limited.status).toBe(429);
    expect(limited.headers["content-type"]).toMatch(/application\/json/);
    expect(limited.body.error).toMatch(/Too many password reset requests/);
  });

  it("throttles repeated login attempts with a JSON 429", async () => {
    // The two successful forgot-password calls above also consumed general
    // budget (the forgot 429 was rejected before reaching it). Burn through
    // the remainder with failing logins, then expect a 429.
    let sawTooMany = false;
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "rate-limit-probe@example.invalid", password: "nope-nope" });
      if (res.status === 429) {
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.body.error).toMatch(/Too many attempts/);
        sawTooMany = true;
        break;
      }
      expect(res.status).toBe(401); // wrong credentials until the limit trips
    }
    expect(sawTooMany).toBe(true);
  });

  it("keeps GET /api/auth/me exempt even when POSTs are throttled", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401); // unauthenticated — but NOT 429
    expect(res.body.error).toBe("Not authenticated");
  });
});
