/**
 * Security review follow-up: the internal sweep endpoints.
 *
 *  1. The token signs the BODY: a token minted for one body is refused with
 *     any other body (a captured token can no longer be replayed with a
 *     different target user or operator flag); the previous hour is still
 *     accepted; two hours ago is not; an absent body digests as "".
 *  2. The secret is purpose-specific: a token under the raw SESSION_SECRET
 *     (the old scheme) is refused; INTERNAL_SWEEP_SECRET wins when set; the
 *     scheduler's own code (artifacts/daily-email) mints tokens this server
 *     accepts, both with the dedicated secret and with the derived fallback.
 *  3. Bodies are whitelisted: an unknown key is a 400 on all three routes;
 *     the reflection route only takes userId and dryRun.
 *  4. Production gate: dry-run decisions (raw user ids) are not returned when
 *     NODE_ENV is production; the counts still are.
 *  5. Voice tokens use their own key: a token minted under the raw
 *     SESSION_SECRET no longer verifies, and VOICE_TOKEN_SECRET takes over.
 */

import { describe, it, expect, afterEach, afterAll } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import pg from "pg";
import app from "../app.js";
import { internalToken } from "./helpers/internalToken.js";
import { mintInternalToken, internalBodyProblem } from "../lib/internalAuth.js";
import { secretFor, deriveFromSessionSecret, secretSplitWarnings } from "../lib/secrets.js";
import { mintVoiceToken, verifyVoiceToken } from "../lib/voiceToken.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The scheduler lives in another package (outside this tsconfig's rootDir), so
// it is loaded by file URL at run time: the point is to run ITS token code
// against THIS server, not a copy of it.
type Scheduler = {
  resolveSweepSecret(env: NodeJS.ProcessEnv): string;
  sweepToken(secret: string, prefix: string, body: string, d?: Date): string;
};
const schedulerFile = path.resolve(import.meta.dirname, "../../../daily-email/src/run.ts");
const scheduler: Scheduler = await import(pathToFileURL(schedulerFile).href);
const { resolveSweepSecret, sweepToken: schedulerToken } = scheduler;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DB = Boolean(process.env.DATABASE_URL);
const CHAPTERS = "/api/internal/chapters/run";
const REFLECTION = "/api/internal/reflection/weekly-run";
const STORIES = "/api/internal/stories/run";
const NOBODY = { userId: 999999999 }; // scopes every sweep to no rows

const post = (path: string, body: unknown, token: string) =>
  request(app).post(path).set("x-internal-token", token).send(body as object);

afterEach(() => {
  delete process.env.INTERNAL_SWEEP_SECRET;
  delete process.env.VOICE_TOKEN_SECRET;
  process.env.NODE_ENV = "test";
});
afterAll(() => pool.end());

describe.skipIf(!DB)("internal token signs the body", () => {
  it("accepts the token for its own body and refuses it for any other", async () => {
    const ok = await post(CHAPTERS, NOBODY, internalToken("chapters-run", NOBODY));
    expect(ok.status).toBe(200);

    const replayed = await post(CHAPTERS, { userId: 1 }, internalToken("chapters-run", NOBODY));
    expect(replayed.status).toBe(401);
    const widened = await post(CHAPTERS, {}, internalToken("chapters-run", NOBODY));
    expect(widened.status).toBe(401);
    const otherRoute = await post(STORIES, NOBODY, internalToken("chapters-run", NOBODY));
    expect(otherRoute.status).toBe(401);
  });

  it("accepts the previous hour, not two hours ago", async () => {
    const prev = await post(CHAPTERS, NOBODY, internalToken("chapters-run", NOBODY, new Date(Date.now() - 3_600_000)));
    expect(prev.status).toBe(200);
    const stale = await post(CHAPTERS, NOBODY, internalToken("chapters-run", NOBODY, new Date(Date.now() - 7_200_000)));
    expect(stale.status).toBe(401);
  });

  it("a request with no body at all is signed over the empty string", async () => {
    const res = await request(app).post(REFLECTION).set("x-internal-token", internalToken("reflection-run", undefined));
    expect(res.status).toBe(200);
    expect(res.body.candidates).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!DB)("the sweep secret is its own", () => {
  it("refuses the old scheme (HMAC under the raw SESSION_SECRET, no body)", async () => {
    const stamp = new Date().toISOString().slice(0, 13);
    const legacy = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(`chapters-run:${stamp}`).digest("hex");
    expect((await post(CHAPTERS, {}, legacy)).status).toBe(401);
    // Even signing the body under the raw session secret is not enough.
    const rawKeyed = mintInternalToken(process.env.SESSION_SECRET!, "chapters-run", JSON.stringify(NOBODY));
    expect((await post(CHAPTERS, NOBODY, rawKeyed)).status).toBe(401);
  });

  it("derives from SESSION_SECRET by default and prefers INTERNAL_SWEEP_SECRET when set", async () => {
    expect(secretFor("internal-sweep")).toBe(deriveFromSessionSecret(process.env.SESSION_SECRET!, "internal-sweep"));
    expect(secretFor("internal-sweep")).not.toBe(secretFor("voice-token"));

    process.env.INTERNAL_SWEEP_SECRET = "dedicated-sweep-secret";
    const underDerived = mintInternalToken(deriveFromSessionSecret(process.env.SESSION_SECRET!, "internal-sweep"), "chapters-run", JSON.stringify(NOBODY));
    expect((await post(CHAPTERS, NOBODY, underDerived)).status).toBe(401);
    expect((await post(CHAPTERS, NOBODY, internalToken("chapters-run", NOBODY))).status).toBe(200);
  });

  it("the scheduler's own token code is accepted, with the dedicated secret and with the fallback", async () => {
    const body = JSON.stringify(NOBODY);
    // Fallback: both sides derive from SESSION_SECRET.
    const derived = resolveSweepSecret({ SESSION_SECRET: process.env.SESSION_SECRET });
    expect(derived).toBe(secretFor("internal-sweep"));
    const viaFallback = await request(app).post(STORIES).set("x-internal-token", schedulerToken(derived, "stories-run", body)).send(NOBODY);
    expect(viaFallback.status).toBe(200);

    // Dedicated: both sides read INTERNAL_SWEEP_SECRET.
    process.env.INTERNAL_SWEEP_SECRET = "shared-dedicated";
    const dedicated = resolveSweepSecret({ INTERNAL_SWEEP_SECRET: "shared-dedicated", SESSION_SECRET: "irrelevant" });
    const viaDedicated = await request(app).post(STORIES).set("x-internal-token", schedulerToken(dedicated, "stories-run", body)).send(NOBODY);
    expect(viaDedicated.status).toBe(200);
  });

  it("production warns until the dedicated secrets exist", () => {
    expect(secretSplitWarnings({ NODE_ENV: "production", SESSION_SECRET: "x" })).toHaveLength(2);
    expect(secretSplitWarnings({ NODE_ENV: "production", SESSION_SECRET: "x", INTERNAL_SWEEP_SECRET: "a", VOICE_TOKEN_SECRET: "b" })).toEqual([]);
    expect(secretSplitWarnings({ NODE_ENV: "test", SESSION_SECRET: "x" })).toEqual([]);
  });
});

describe.skipIf(!DB)("bodies are whitelisted", () => {
  it("an unknown field is a 400 on every route; the reflection route takes only userId and dryRun", async () => {
    const typo = { ...NOBODY, ignorWindow: true };
    expect((await post(CHAPTERS, typo, internalToken("chapters-run", typo))).body).toEqual({ error: "unknown field: ignorWindow" });
    expect((await post(STORIES, typo, internalToken("stories-run", typo))).status).toBe(400);
    const notForReflection = { ...NOBODY, ignoreWindow: true, force: true };
    const r = await post(REFLECTION, notForReflection, internalToken("reflection-run", notForReflection));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unknown fields: force, ignoreWindow");
  });

  it("userId must be a positive integer", () => {
    expect(internalBodyProblem({ userId: "7" }, ["userId"])).toBe("userId must be a positive integer");
    expect(internalBodyProblem({ userId: 0 }, ["userId"])).toBe("userId must be a positive integer");
    expect(internalBodyProblem([1], ["userId"])).toBe("body must be a JSON object");
    expect(internalBodyProblem(undefined, ["userId"])).toBeNull();
    expect(internalBodyProblem({ userId: 7, dryRun: true }, ["userId", "dryRun"])).toBeNull();
  });
});

describe.skipIf(!DB)("production keeps user ids out of responses", () => {
  it("dry-run decisions are returned in test and dropped in production", async () => {
    const body = { ...NOBODY, dryRun: true };
    const local = await post(REFLECTION, body, internalToken("reflection-run", body));
    expect(local.status).toBe(200);
    expect(local.body.decisions).toEqual([]);

    process.env.NODE_ENV = "production";
    const prod = await post(REFLECTION, body, internalToken("reflection-run", body));
    expect(prod.status).toBe(200);
    expect(prod.body.dryRun).toBe(true);
    expect(prod.body.candidates).toBe(0);
    expect("decisions" in prod.body).toBe(false);

    const chapters = await post(CHAPTERS, body, internalToken("chapters-run", body));
    expect(chapters.status).toBe(200);
    expect("decisions" in chapters.body).toBe(false);
  });
});

describe("voice tokens use their own key", () => {
  it("a token signed under the raw SESSION_SECRET is refused; VOICE_TOKEN_SECRET takes over when set", () => {
    const good = mintVoiceToken(42);
    expect(verifyVoiceToken(good)?.userId).toBe(42);

    const [userId, iat, exp, env] = good.split(".");
    const payload = `${userId}.${iat}.${exp}.${env}`;
    const rawSig = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
    expect(verifyVoiceToken(`${payload}.${rawSig}`)).toBeNull();

    process.env.VOICE_TOKEN_SECRET = "dedicated-voice-secret";
    expect(verifyVoiceToken(good)).toBeNull(); // minted under the derived key
    const dedicatedSig = crypto.createHmac("sha256", "dedicated-voice-secret").update(payload).digest("base64url");
    expect(verifyVoiceToken(`${payload}.${dedicatedSig}`)?.userId).toBe(42);
  });
});
