import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireSubscription } from "../middleware/entitlements.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import {
  fetchHumeAccessToken,
  humeAllowlistDecision,
  humeConfigId,
  isHumeVoiceConfigured,
} from "../services/hume.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { isVoiceCallEnabled } from "../lib/featureFlags.js";
import { voiceSessionUsageLimits } from "../middleware/usageLimits.js";
import { buildVoiceFirstMessage } from "../services/voiceGreeting.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import { resolveHelplines, buildHelplineBlockText } from "../services/crisis/helplines.js";
import { pendingVoiceCrisisEvent, dismissVoiceCrisisEvent } from "../services/crisis/events.js";
import { resolveAgentRouting } from "../services/voiceAgentRouting.js";
import { prewarmFrozenSystem, primeCallProfile } from "./voice-llm.js";

const router: IRouter = Router();

// Overridable for tests/local measurement only — production always talks to
// the real host (the env var is simply unset there).
function elevenLabsBase(): string {
  return process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io";
}

// Last preferredLanguage seen per user (in-process, reset on deploy — same
// acceptable-loss profile as the usage counters). Powers the speculative
// signed-URL fetch below: agent ROUTING needs the language, the language
// needs a profile read, and serializing DB → ElevenLabs puts our read in
// front of a ~hundreds-of-ms external round trip. With the last language
// remembered, the fetch for that agent starts immediately and the profile
// read runs concurrently; if the language changed since the last call (rare)
// the speculative fetch is discarded and we pay exactly the old sequential
// cost for the correct agent.
const lastLanguageByUser = new Map<number, string>();

// ─── Voice-agent session bootstrap (session-authenticated) ───────────────────
// Called by the web client when the user starts a voice call. Returns what the
// browser needs to open an ElevenLabs Conversational AI session:
//   - a per-user HMAC token the agent passes back to our custom-LLM endpoint
//     (see voice-llm.ts) so the right person's memory is loaded
//   - a signed WebSocket URL (required for private agents — the default)
//
// IMPORTANT: when the signed-URL request fails we return the SPECIFIC failure
// reason instead of silently downgrading to "public agent id" mode. A private
// agent rejects id-only connections by closing the socket immediately, which
// looks like a silent instant drop in the UI — the exact bug this prevents.

// ─── Hume provider branch (voice stage A — founder allowlist + client opt-in) ─
// Returns true when it fully handled the response. Every "no" path returns
// false so the request falls through to the ElevenLabs flow below unchanged —
// including a Hume token-exchange failure (fail open to the provider that
// works; a Hume outage must not kill the founder's voice button). English
// only for now: the multilingual agent routing below is ElevenLabs-specific.
async function tryHumeSession(
  req: import("express").Request,
  res: import("express").Response,
): Promise<boolean> {
  if (req.query?.provider !== "hume") return false;
  if (!isHumeVoiceConfigured()) return false;
  const [u] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, req.userId))
    .limit(1);
  if (humeAllowlistDecision(u?.email) !== "allowed") return false;

  const profile = await getOrCreateProfileForUser(req.userId);
  const preferredLanguage = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  if (preferredLanguage !== "en") return false;

  const accessToken = await fetchHumeAccessToken();
  if (!accessToken) {
    logger.warn("voice-agent: Hume access-token exchange failed — falling back to ElevenLabs");
    return false;
  }

  const userToken = mintVoiceToken(req.userId);
  // Same call-bootstrap warmers as the ElevenLabs path: the greeting turn
  // (Hume's instruction arrives as user content and normalizes to the
  // synthetic-greeting fast path) reads the primed profile, and turn 2
  // finds the frozen prompt already built.
  const issuedAt = Number(userToken.split(".")[1]);
  if (Number.isFinite(issuedAt)) {
    prewarmFrozenSystem(req.userId, issuedAt, profile);
    primeCallProfile(req.userId, issuedAt, profile);
  }
  lastLanguageByUser.set(req.userId, preferredLanguage);

  try {
    const uh = hashUserIdForLog(req.userId);
    if (uh !== undefined) logger.info({ uh, agentUsed: "hume" }, "voice-agent: call routed");
  } catch { /* logging must never break call routing */ }

  res.json({
    available: true,
    mode: "hume",
    accessToken,
    configId: humeConfigId(),
    userToken,
    tone: (profile as { voiceTone?: string }).voiceTone ?? "auto",
    firstMessage: buildVoiceFirstMessage(profile),
  });
  return true;
}

router.post("/voice-agent/session", requireSubscription, ...voiceSessionUsageLimits, async (req, res): Promise<void> => {
  if (!isVoiceCallEnabled()) {
    res.json({ available: false, reason: "disabled" });
    return;
  }

  if (await tryHumeSession(req, res)) return;

  const baseAgentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (!baseAgentId) {
    res.json({ available: false, reason: "not_configured" });
    return;
  }

  const userToken = mintVoiceToken(req.userId);
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const startSignedUrlFetch = (forAgentId: string): Promise<{ r: Response } | { err: unknown }> =>
    fetch(
      `${elevenLabsBase()}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(forAgentId)}`,
      { headers: { "xi-api-key": apiKey! }, signal: AbortSignal.timeout(8000) },
    ).then(
      (r) => ({ r }),
      (err: unknown) => ({ err }),
    );

  // Speculative signed-URL fetch, in parallel with the profile read (see the
  // lastLanguageByUser note above). First call after a deploy has no cached
  // language and stays sequential — identical to the old behavior.
  const cachedLanguage = lastLanguageByUser.get(req.userId);
  let speculative: { agentId: string; promise: Promise<{ r: Response } | { err: unknown }> } | null =
    null;
  if (apiKey && cachedLanguage !== undefined) {
    const specRouting = resolveAgentRouting({ preferredLanguage: cachedLanguage });
    const specAgentId = specRouting.agentId ?? baseAgentId;
    speculative = { agentId: specAgentId, promise: startSignedUrlFetch(specAgentId) };
  }

  // Agent routing needs the user's language (English → Flash agent; active
  // non-English → Multilingual agent); tone/greeting inputs come from the
  // same read. The speculative fetch above keeps the ElevenLabs round trip
  // out of this read's shadow on every call but the first.
  let tone = "auto";
  let firstMessage: string;
  let preferredLanguage = "en";
  try {
    const profile = await getOrCreateProfileForUser(req.userId);
    tone = (profile as { voiceTone?: string }).voiceTone ?? "auto";
    preferredLanguage = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
    lastLanguageByUser.set(req.userId, preferredLanguage);
    firstMessage = buildVoiceFirstMessage(profile);
    // Latency: build the call's frozen system prompt NOW, in the background,
    // keyed by the issuedAt inside the token we just minted (format
    // "<userId>.<issuedAt>...."). The first LLM turn — the greeting the user
    // is waiting on — then hits the in-memory cache instead of paying the
    // full memory/habits/commitments prompt build inline. The profile itself
    // is primed too, so the greeting turn runs database-free.
    const issuedAt = Number(userToken.split(".")[1]);
    if (Number.isFinite(issuedAt)) {
      prewarmFrozenSystem(req.userId, issuedAt, profile);
      primeCallProfile(req.userId, issuedAt, profile);
    }
  } catch (err) {
    logger.warn({ err }, "voice-agent: couldn't load profile — using defaults");
    firstMessage = buildVoiceFirstMessage(null);
  }

  // Route the call to the language-appropriate agent (safe-degrades inside).
  const routing = resolveAgentRouting({ preferredLanguage });
  const agentId = routing.agentId ?? baseAgentId;
  // Privacy (Tier 2): drop preferredLanguage (a language trait); hash userId to
  // `uh`. agentUsed is kept — it is the coarse routing OUTCOME (english-flash vs
  // multilingual), which is the whole point of this observability line.
  try {
    const uh = hashUserIdForLog(req.userId);
    if (uh !== undefined) {
      logger.info({ uh, agentUsed: routing.agentUsed }, "voice-agent: call routed");
    }
  } catch {
    /* logging must never break call routing */
  }
  // Language code (multilingual-agent calls only) — INFORMATIONAL for the
  // client. It is deliberately NOT forwarded to ElevenLabs anymore: the
  // agent.language override is rejected by config with a post-connect 1008
  // that kills the call (July 31 — same pattern as first_message).
  // Transcription language comes from the multilingual agent's own dashboard
  // config; Multilingual v2 TTS speaks whatever language the reply text is in.
  const language = routing.agentUsed === "multilingual" ? preferredLanguage : undefined;

  // Use the speculative fetch when it targeted the right agent; otherwise
  // (language changed, or first call after deploy) fetch for the real one.
  const signedUrlPromise: Promise<{ r: Response } | { err: unknown }> | null = apiKey
    ? speculative && speculative.agentId === agentId
      ? speculative.promise
      : startSignedUrlFetch(agentId)
    : null;

  // "How Eos speaks" preference rides along so the client can set matching
  // TTS delivery overrides (stability/speed) on the ElevenLabs session.
  // firstMessage is still computed and returned, but the client NO LONGER
  // forwards it to ElevenLabs: the first_message override is rejected with a
  // 1008 disconnect since ~July 29 (permission tightened on their side; no
  // dashboard toggle on our tier). Greetings come from the custom LLM's
  // synthetic-greeting path instead (routes/voice-llm.ts).
  // TODO(cleanup): drop firstMessage from this response + voiceGreeting.ts
  // once the LLM greeting is confirmed as the permanent path.

  if (!signedUrlPromise) {
    // No API key to sign with — only a PUBLIC agent can possibly work. Let the
    // browser try; if the agent is private the client will surface the drop.
    logger.warn("ELEVENLABS_API_KEY not set — attempting public-agent voice call");
    res.json({
      available: true,
      mode: "public",
      agentId,
      userToken,
      tone,
      firstMessage,
      ...(language ? { language } : {}),
    });
    return;
  }

  try {
    const settled = await signedUrlPromise;
    if ("err" in settled) throw settled.err;
    const r = settled.r;

    if (r.ok) {
      const data = (await r.json()) as { signed_url?: string };
      if (data?.signed_url) {
        res.json({
          available: true,
          mode: "signed",
          signedUrl: data.signed_url,
          userToken,
          tone,
          firstMessage,
          ...(language ? { language } : {}),
        });
        return;
      }
      logger.error({ data }, "ElevenLabs get-signed-url returned 200 without signed_url");
      res.json({
        available: false,
        reason: "signed_url_failed",
        detail: "Unexpected ElevenLabs response (no signed_url)",
      });
      return;
    }

    // Classify the failure so the client can show a SPECIFIC, actionable error.
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      /* non-JSON error body */
    }
    const detail = (body as { detail?: { message?: string; status?: string } | string } | null)
      ?.detail;
    const elMessage =
      typeof detail === "object" && typeof detail?.message === "string"
        ? detail.message
        : typeof detail === "string"
          ? detail
          : `ElevenLabs returned HTTP ${r.status}`;

    logger.error(
      { status: r.status, body },
      "ElevenLabs get-signed-url failed — voice call cannot start",
    );

    let reason = "signed_url_failed";
    if (r.status === 401 || r.status === 403) {
      reason =
        typeof detail === "object" && detail?.status === "missing_permissions"
          ? "api_key_permission"
          : "api_key_invalid";
    } else if (r.status === 404) {
      reason = "agent_not_found";
    }
    // Voice-minute quota exhaustion must never render as a raw config error —
    // the client shows a warm in-character note and returns to text chat.
    if (
      (typeof detail === "object" && detail?.status === "quota_exceeded") ||
      /quota/i.test(elMessage)
    ) {
      reason = "quota_exceeded";
    }
    res.json({ available: false, reason, detail: elMessage });
  } catch (err) {
    logger.error({ err }, "ElevenLabs get-signed-url unreachable — voice call cannot start");
    res.json({
      available: false,
      reason: "elevenlabs_unreachable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ─── Browser-side failure reporting ──────────────────────────────────────────
// WebSocket close reasons and SDK errors happen browser↔ElevenLabs and never
// transit our server, so the client posts them here. This is what makes a
// remote tester's "it just dropped" diagnosable from the server logs.
// ─── Crisis floor (voice) — on-call helpline overlay ─────────────────────────
// The realtime voice reply is spoken by ElevenLabs, so no field can ride along
// with it to the browser. Instead the voice-llm callback writes a crisis_events
// row and the call UI polls THIS endpoint (session-authed) every few seconds
// during an active call. An undismissed voice event in the recent window means
// "show the helpline card on-screen now".

router.get("/voice-agent/crisis-status", async (req, res): Promise<void> => {
  const userId = req.userId;
  const event = await pendingVoiceCrisisEvent(userId);
  if (!event) {
    res.json({ active: false });
    return;
  }
  const profile = await getOrCreateProfileForUser(userId);
  const language = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  const resolved = resolveHelplines(profile.country, language);
  res.json({
    active: true,
    event: {
      id: event.id,
      countryServed: resolved.countryServed,
      lines: resolved.lines,
      blockText: buildHelplineBlockText(resolved.lines, language),
    },
  });
});

// Dismiss one on-call helpline overlay (per-event — a later crisis turn shows
// a fresh card). Same review-flag rules as the chat card.
router.post("/voice-agent/crisis-events/:id/dismiss", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const result = await dismissVoiceCrisisEvent(userId, id);
  if (!result) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true, reviewFlagged: result.reviewFlagged });
});

router.post("/voice-agent/client-error", (req, res): void => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const clip = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : undefined;
  const stage = clip(b.stage, 100) ?? "unknown";
  const message = clip(b.message, 1000) ?? "";
  const detail = clip(b.detail, 2000);
  // Privacy (Tier 2): this was the ONE log line still carrying a raw userId —
  // hash it like every other line (and skip the line entirely when no salt is
  // configured, same fail-safe as elsewhere). message/detail are ElevenLabs
  // SDK/WebSocket error strings from the browser, never transcript content.
  try {
    const uh = hashUserIdForLog(req.userId);
    if (uh !== undefined) logger.error({ uh, stage, message, detail }, "voice-call failed in browser");
  } catch {
    /* logging must never break the beacon */
  }
  res.status(204).end();
});

// ─── Browser-side connect-timing beacon ──────────────────────────────────────
// One fire-and-forget POST per call attempt, recording how long the connect
// path took and which override level finally connected. This makes the retry
// cascade VISIBLE: every failed level is a full paid reconnection, so if
// "full" keeps failing the fix is a dashboard toggle (enable the TTS +
// first-message overrides in the agent's Security settings), not code — the
// warn line below says exactly that. grep: "voice-connect timing".
router.post("/voice-agent/client-timing", (req, res): void => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

  const timing = {
    // Privacy (Tier 3): hashed id only — this object is logged wholesale below.
    uh: hashUserIdForLog(req.userId),
    /** "prefetched" | "fresh" — where the /session result came from. */
    sessionSource: str(b.sessionSource, 20) ?? "unknown",
    sessionFetchMs: num(b.sessionFetchMs),
    /** Per-level attempt results from startRealtimeCall's cascade. */
    attempts: Array.isArray(b.attempts)
      ? b.attempts.slice(0, 5).map((a) => {
          const at = (a ?? {}) as Record<string, unknown>;
          return {
            level: str(at.level, 10) ?? "unknown",
            ok: at.ok === true,
            ms: num(at.ms),
            message: str(at.message, 300),
          };
        })
      : [],
    /** Level that finally connected ("full" | "voice" | "none"). */
    connectedLevel: str(b.connectedLevel, 10),
    /** Button press → connection established. */
    connectMs: num(b.connectMs),
    /** Button press → first agent audio actually accepted for playback. */
    firstAudioMs: num(b.firstAudioMs),
  };

  const fullFailed = timing.attempts.some((a) => a.level === "full" && !a.ok);
  if (fullFailed && timing.connectedLevel && timing.connectedLevel !== "full") {
    logger.warn(
      timing,
      "voice-connect timing: 'full' override attempt failed and a lower level connected — " +
        "the agent's override flags (TTS voice/stability/speed + first message) are likely " +
        "DISABLED in the ElevenLabs dashboard Security settings. Enable them there; every " +
        "call is currently paying a full reconnect retry (and losing the instant greeting).",
    );
  } else {
    logger.info(timing, "voice-connect timing");
  }
  res.status(204).end();
});

export default router;
