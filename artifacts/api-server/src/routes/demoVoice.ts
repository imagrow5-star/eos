import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod/v4";
import { logger } from "../lib/logger.js";
import { mintDemoVoiceToken, parseDemoVoiceToken, type DemoVoiceTokenClaims } from "../lib/demoVoiceToken.js";
import { fetchHumeAccessToken, humeConfigId, humeVoiceIdForGender } from "../services/hume.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { streamCompanionReply, buildVoiceCallAddendum, VOICE_MAX_TOKENS } from "../services/ai.js";
import { GREETING_POOLS } from "../services/voiceGreeting.js";
import { detectCrisis } from "../services/crisis/detector.js";
import { detectCrisisSemantic, SEMANTIC_OFFPATH_TIMEOUT_MS } from "../services/crisis/semanticDetector.js";
import { CRISIS_REINFORCEMENT_BLOCK_VOICE } from "../services/crisis/reinforcement.js";
import { resolveHelplines, buildHelplineBlockText } from "../services/crisis/helplines.js";
import { resolveVoiceLlmModel } from "./voice-llm.js";
import { demoProfile, DEMO_SYSTEM_ADDENDUM } from "./demo.js";
import type { HumeChatMessage } from "./humeLlm.js";
import {
  DEMO_VOICE_SECONDS,
  DEMO_VOICE_TOKEN_TTL_MS,
  clearVoiceDemoCookie,
  endVoiceDemo,
  liveDemoCall,
  noteDemoCrisis,
  startVoiceDemo,
  voiceDemoAvailability,
  voiceDemoCookie,
} from "../services/demoVoice.js";

/**
 * The landing-page voice demo: "Or hear it — one minute, no signup."
 *
 * One click starts a REAL Hume EVI call — the product's default voice, the
 * product's prompt, the product's brain (routes/humeLlm.ts hands a demo
 * call's turns to demoVoiceCompletionHandler below). The page draws a thin
 * line for the minute; at the end it stops the microphone, lets the sentence
 * being spoken finish, and shows the same closing line as the text demo.
 *
 * Nothing said on the call is stored — not the transcript, not a crisis
 * event, not a memory. The one row written (demo_sessions) holds when the
 * call started, how long it ran and how it ended. See services/demoVoice.ts
 * for the three protections (cookie, IP, daily spend cap) and the token
 * that enforces the minute server-side.
 */
const router: IRouter = Router();

function envLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Availability is read on every landing-page load; the others once per call.
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: envLimit("DEMO_VOICE_READ_LIMIT", 120),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  handler: (_req, res) => res.status(429).json({ available: false }),
});
const mintLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envLimit("DEMO_VOICE_MINT_LIMIT_PER_HOUR", 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  handler: (_req, res) => res.status(429).json({ available: false }),
});

/** True → the page shows the voice button. Only ever a boolean: the reason
 *  (cookie, IP, cap, disabled) stays server-side so the page has nothing to
 *  explain — at the cap the button simply isn't there. */
router.get("/demo/voice/availability", readLimiter, async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const a = await voiceDemoAvailability({ ip: req.ip ?? "", cookieHeader: req.headers.cookie });
    res.json({ available: a.available });
  } catch (err) {
    logger.error({ err }, "demo voice: availability check failed");
    res.json({ available: false });
  }
});

/**
 * Mint a call. Order matters: check the gates, get Hume's short-lived
 * access token (a Hume outage costs nothing), THEN reserve the minute and
 * mark the browser. The response carries what the page needs to open the
 * EVI socket: the access token (never the API key), the config, the
 * product's default voice, and the call token that our brain will verify
 * on every turn until the minute plus grace has passed.
 */
router.post("/demo/voice/session", mintLimiter, async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const ip = req.ip ?? "";
    const a = await voiceDemoAvailability({ ip, cookieHeader: req.headers.cookie });
    if (!a.available) {
      res.json({ available: false });
      return;
    }
    const accessToken = await fetchHumeAccessToken();
    if (!accessToken) {
      res.status(503).json({ available: false, error: "Voice isn't available right now. Try the text demo." });
      return;
    }
    const now = new Date();
    const { id } = await startVoiceDemo(ip, now);
    const token = mintDemoVoiceToken(id, DEMO_VOICE_TOKEN_TTL_MS, now.getTime());
    liveDemoCall(id, now.getTime());
    res.setHeader("Set-Cookie", voiceDemoCookie(now));
    logger.info({ demoCallId: id }, "demo voice: call started");
    res.json({
      available: true,
      accessToken,
      configId: humeConfigId(),
      humeVoiceId: humeVoiceIdForGender("female", null),
      token,
      seconds: DEMO_VOICE_SECONDS,
    });
  } catch (err) {
    logger.error({ err }, "demo voice: session mint failed");
    res.status(500).json({ available: false, error: "Voice isn't available right now. Try the text demo." });
  }
});

const EndBody = z.object({
  token: z.string().min(1),
  reason: z.enum(["ended", "limit", "failed"]),
});

/**
 * The page reports how the call ended. The duration is settled from the
 * server's clocks, never the page's. "failed" (the call never connected)
 * clears the browser mark and doesn't count against the address, so a
 * microphone hiccup doesn't cost the person their one try.
 */
router.post("/demo/voice/end", readLimiter, async (req, res): Promise<void> => {
  const parsed = EndBody.safeParse(req.body);
  const claims = parsed.success ? parseDemoVoiceToken(parsed.data.token) : null;
  if (!parsed.success || !claims) {
    res.status(400).json({ error: "That call couldn't be found." });
    return;
  }
  try {
    const settled = await endVoiceDemo(claims.callId, parsed.data.reason);
    if (!settled) {
      res.status(404).json({ error: "That call couldn't be found." });
      return;
    }
    if (settled.reason === "failed") res.setHeader("Set-Cookie", clearVoiceDemoCookie());
    logger.info({ demoCallId: claims.callId, seconds: settled.seconds, reason: settled.reason }, "demo voice: call ended");
    res.json({ ok: true, seconds: settled.seconds, reason: settled.reason });
  } catch (err) {
    logger.error({ err }, "demo voice: settling the call failed");
    res.status(500).json({ error: "Something went wrong." });
  }
});

/**
 * Polled by the page during the call. A spoken reply carries no helpline
 * numbers (read aloud they interrupt the moment), so when the crisis floor
 * fires on a spoken turn the card appears on the page instead — exactly as
 * it does on an in-app call. Same two-intro rule as everywhere else.
 */
router.get("/demo/voice/status", readLimiter, (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  const raw = req.query?.token;
  const claims = typeof raw === "string" ? parseDemoVoiceToken(raw) : null;
  if (!claims) {
    res.status(400).json({ error: "That call couldn't be found." });
    return;
  }
  const call = liveDemoCall(claims.callId);
  res.json(
    call.crisisTier
      ? { crisisHelplineBlock: buildHelplineBlockText(resolveHelplines("", "en").lines, "en", call.crisisTier) }
      : {},
  );
});

// ─── The brain, demo edition ─────────────────────────────────────────────────
// Reached from routes/humeLlm.ts when the Bearer is a demo call token. Same
// persona, same voice-call rules, same crisis floor as an in-app call — minus
// everything that needs a person: no memory, no persistence, no extraction.

type Turn = { role: "user" | "assistant"; content: string };

/** Claude needs strict alternation starting with "user": merge same-role
 *  runs and drop a leading greeting. */
function sanitizeTurns(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n${t.content}`;
    else merged.push({ ...t });
  }
  while (merged.length && merged[0]!.role !== "user") merged.shift();
  return merged;
}

/** A first line that knows no name and no time of day. */
export function demoVoiceGreeting(rng: () => number = Math.random): string {
  const pool = GREETING_POOLS.anytime;
  return pool[Math.floor(rng() * pool.length) % pool.length]!(null);
}

export async function demoVoiceCompletionHandler(
  req: Request,
  res: Response,
  claims: DemoVoiceTokenClaims,
  messages: HumeChatMessage[],
  voiceTone: string | null,
): Promise<void> {
  const tStart = performance.now();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const model = typeof body.model === "string" && body.model ? body.model : "eos-hume";
  const wantStream = body.stream !== false;
  const call = liveDemoCall(claims.callId);
  const ms = (from: number, to = performance.now()) => Math.round(to - from);

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunkPayload = (delta: Record<string, unknown>, finish: string | null) =>
    JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const flushRes = () => {
    if (typeof (res as { flush?: () => void }).flush === "function") {
      (res as unknown as { flush: () => void }).flush();
    }
  };
  const openStream = () => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(`data: ${chunkPayload({ role: "assistant" }, null)}\n\n`);
  };
  const finish = (text: string) => {
    if (wantStream) {
      res.write(`data: ${chunkPayload({}, "stop")}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  };

  try {
    const turns: Turn[] = messages.map(({ role, content }) => ({ role, content }));
    let lastUserIdx = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    // Greeting: Hume's instruction normalized to an empty transcript.
    if (lastUserIdx === -1) {
      const greeting = demoVoiceGreeting();
      if (wantStream) {
        openStream();
        res.write(`data: ${chunkPayload({ content: greeting }, null)}\n\n`);
        flushRes();
      }
      finish(greeting);
      logger.info({ demoCallId: claims.callId, greeting: true, totalMs: ms(tStart) }, "demo voice turn timing");
      return;
    }

    const freshUserContent = turns[lastUserIdx]!.content;
    const context = sanitizeTurns(turns.slice(0, lastUserIdx));

    // Crisis floor, as in the app: regex before the reply, the semantic
    // backstop OFF the critical path (the reply doesn't wait for it). The
    // card goes to the page via /demo/voice/status; a regex hit shapes this
    // reply, a late classifier yes shows the card and shapes the next one.
    const crisis = detectCrisis(freshUserContent, "en");
    const crisisPending = call.crisisPending;
    call.crisisPending = false;
    const classifierRan = !crisis.matched;
    let classifierResolvedAt: number | null = null;
    if (classifierRan) void detectCrisisSemantic(freshUserContent, { timeoutMs: SEMANTIC_OFFPATH_TIMEOUT_MS }).then((semantic) => {
      classifierResolvedAt = performance.now();
      if (!semantic.matched) return;
      noteDemoCrisis(call, "ambiguous");
      call.crisisPending = true;
    });
    const tPromptStart = performance.now();
    const frozenHit = call.system != null;
    if (!call.system) call.system = await buildSystemPrompt(demoProfile(), 1);
    const tPrompt = performance.now();
    if (crisis.matched) noteDemoCrisis(call, "clear");
    const crisisActive = crisis.matched || crisisPending;

    const systemExtra =
      buildVoiceCallAddendum(false) +
      `\n${DEMO_SYSTEM_ADDENDUM}` +
      (crisisActive ? `\n${CRISIS_REINFORCEMENT_BLOCK_VOICE}` : "");
    const userContent = voiceTone ? `${freshUserContent}\n${voiceTone}` : freshUserContent;

    if (wantStream) openStream();
    const tModelStart = performance.now();
    let firstTokenAt: number | null = null;
    // First sentence boundary in the streamed text: if Hume synthesises per
    // sentence, its first audio should trail THIS, not the end of the reply.
    let firstSentenceAt: number | null = null;
    let streamedSoFar = "";
    const reply = await streamCompanionReply(
      call.system,
      context,
      userContent,
      1,
      (chunk) => {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        if (firstSentenceAt === null) {
          streamedSoFar += chunk;
          if (/[.!?…](?:["')\]]|\s|$)/.test(streamedSoFar)) firstSentenceAt = performance.now();
        }
        if (wantStream) {
          res.write(`data: ${chunkPayload({ content: chunk }, null)}\n\n`);
          flushRes();
        }
      },
      { systemExtra, callType: "demo_voice", cacheConversation: true, model: resolveVoiceLlmModel(), maxTokens: VOICE_MAX_TOKENS },
    );
    const tModelEnd = performance.now();
    finish(reply.text);
    logger.info(
      {
        demoCallId: claims.callId,
        greeting: false,
        frozenHit,
        promptMs: ms(tPromptStart, tPrompt),
        classifierMs: classifierResolvedAt === null ? null : ms(tPromptStart, classifierResolvedAt),
        classifierRan,
        firstTokenMs: firstTokenAt === null ? null : ms(tModelStart, firstTokenAt),
        firstSentenceMs: firstSentenceAt === null ? null : ms(tModelStart, firstSentenceAt),
        modelMs: ms(tModelStart, tModelEnd),
        totalMs: ms(tStart),
        replyWords: reply.text.split(/\s+/).filter(Boolean).length,
        crisis: crisisActive,
        crisisArmed: crisisPending,
        degraded: reply.degraded,
      },
      "demo voice turn timing",
    );
  } catch (err) {
    logger.error({ err }, "demo voice: completion failed");
    if (res.headersSent) {
      try {
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {
        // connection already closed
      }
    } else {
      res.status(500).json({ error: { message: "Internal error", type: "server_error" } });
    }
  }
}

export default router;
