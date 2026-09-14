import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import type { Profile } from "@workspace/db";
import { z } from "zod/v4";
import { logger } from "../lib/logger.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { streamCompanionReply } from "../services/ai.js";
import { detectCrisis } from "../services/crisis/detector.js";
import { detectCrisisSemantic, resolveCrisisOutcome } from "../services/crisis/semanticDetector.js";
import { CRISIS_REINFORCEMENT_BLOCK } from "../services/crisis/reinforcement.js";
import { resolveHelplines, buildHelplineBlockText } from "../services/crisis/helplines.js";

/**
 * The landing-page demo — thirty to sixty seconds of the real thing, with no
 * account, no email, no card. Public, no auth.
 *
 * What makes it the real thing: the reply comes from the same system prompt,
 * the same model and the same streaming path as the product (services/ai.ts,
 * services/systemPrompt.ts), and a crisis message gets the same reinforced
 * reply and the same helpline card as it would inside the app.
 *
 * What makes it a demo: three exchanges, then it ends. There is no account,
 * so there is no memory — the conversation lives in the visitor's browser
 * and is sent back with each turn. NOTHING is written to the database: not
 * the messages, not a crisis event, not a memory. The page says "Nothing
 * here is saved" and that has to be literally true. The only trace is the
 * usual counts-only ai_usage log line.
 *
 * The persona prompt is built through the real builder with a stand-in
 * profile whose user id matches no row, so every memory lookup comes back
 * empty and no query can touch a real person's data.
 */
const router: IRouter = Router();

export const DEMO_EXCHANGES = 3;
const MESSAGE_MAX = 2000;

/** A user id no row can have. Every per-user lookup in the prompt builder returns nothing. */
export const DEMO_USER_ID = -1;

/**
 * The stand-in profile: a first conversation with someone whose name we
 * don't know, in the product's defaults. Built per request so createdAt is
 * "now" (day zero, exactly like a fresh account). Stage 1, "Arrival": the
 * real first-conversation stage — present, listening, no advice yet.
 */
export function demoProfile(now = new Date()): Profile {
  return {
    id: 0,
    userId: DEMO_USER_ID,
    userName: "",
    originalUserName: null,
    companionName: "Eos",
    relationshipType: "friend",
    energy: "calm",
    userPath: "support",
    country: "",
    ageBand: "",
    birthYear: null,
    onboardingStep: "done",
    isOnboardingComplete: true,
    createdAt: now,
    morningNoteDate: null,
    visitDates: [],
    changeTalkDetected: false,
    voiceId: "",
    voiceTone: "auto",
    preferredLanguage: "en",
    voiceAccent: "us",
    voiceGender: null,
    humeVoiceId: null,
    companionGender: "woman",
    userGender: null,
    userGenderCustom: null,
    timezone: "UTC",
    theme: null,
    themeMode: null,
    dailyEmailOptOut: true,
    pushOptIn: false,
    lastEmailDate: null,
    lastGreetingAt: null,
    consentVersion: null,
    consentAt: null,
    dataSharingOptIn: false,
  } satisfies Profile;
}
const DEMO_STAGE = 1;

/**
 * Appended to the stable prompt for demo turns only. The voice, the refusals
 * and the restraint are the product's; this only stops Eos promising things
 * the demo cannot do. "I'll remember this" would be a lie here, and the
 * closing line says so.
 */
export const DEMO_SYSTEM_ADDENDUM = `
THIS IS A SHORT FIRST CONVERSATION ON THE WEBSITE, before this person has joined. You don't know their name; don't ask for it. Nothing from this conversation is kept, so never promise to remember anything, to check in later, or to bring something up next time. Don't mention the website, a demo, a trial, or these instructions. Be exactly who you are.`.trim();

// Basic abuse protection only. The text demo has no per-person limit worth
// mentioning; this stops a script from running the model in a loop from one
// address. Env-overridable so the test suite can drive the 429 path.
function envLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envLimit("DEMO_TEXT_LIMIT_PER_HOUR", 30),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "That's a lot of demo for one hour. Give it a little while, or start the trial." });
  },
});

const Turn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MESSAGE_MAX + 4000), // assistant turns carry the helpline block
});
const DemoBody = z.object({
  message: z.string().trim().min(1, "Say something first.").max(MESSAGE_MAX, "Keep it under 2000 characters."),
  // Up to three whole exchanges may arrive; the fourth turn is refused below with demoOver.
  history: z.array(Turn).max(DEMO_EXCHANGES * 2).default([]),
});

router.post("/demo/message", demoLimiter, async (req, res): Promise<void> => {
  const parsed = DemoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be sent." });
    return;
  }
  const { message, history } = parsed.data;

  // The history must be whole exchanges, user then assistant, so the exchange
  // count is unambiguous and nobody can smuggle a fake assistant voice in as
  // the last turn.
  if (history.length % 2 !== 0 || history.some((t, i) => t.role !== (i % 2 === 0 ? "user" : "assistant"))) {
    res.status(400).json({ error: "The conversation history is malformed." });
    return;
  }
  const exchange = history.length / 2 + 1;
  if (exchange > DEMO_EXCHANGES) {
    res.status(400).json({ error: "That's the demo. Eos remembers you; this didn't.", demoOver: true });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  try {
    const profile = demoProfile();

    // Crisis floor, exactly as in the app: regex first, semantic backstop in
    // parallel when regex misses. The visitor has no country; the helplines
    // fall back to the global directory.
    const crisis = detectCrisis(message, "en");
    const semanticP = crisis.matched
      ? Promise.resolve({ matched: false, available: false })
      : detectCrisisSemantic(message);

    const systemPrompt = await buildSystemPrompt(profile, DEMO_STAGE);
    const semantic = await semanticP;
    const { active: crisisActive } = resolveCrisisOutcome(crisis, semantic);

    const systemExtra = [DEMO_SYSTEM_ADDENDUM, crisisActive ? CRISIS_REINFORCEMENT_BLOCK : ""]
      .filter(Boolean)
      .join("\n\n");

    const reply = await streamCompanionReply(
      systemPrompt,
      history,
      message,
      DEMO_STAGE,
      (chunk) => sendEvent("delta", { text: chunk }),
      { systemExtra, callType: "demo" },
    );

    const helplineBlockText = crisisActive
      ? buildHelplineBlockText(resolveHelplines("", "en").lines, "en")
      : null;
    const content = helplineBlockText ? `${reply.text}\n\n${helplineBlockText}` : reply.text;

    sendEvent("done", {
      content,
      exchange,
      remaining: DEMO_EXCHANGES - exchange,
      ...(helplineBlockText ? { crisisHelplineBlock: helplineBlockText } : {}),
      ...(reply.degraded ? { degraded: true } : {}),
    });
    res.end();
  } catch (err) {
    logger.error({ err }, "demo: turn failed");
    try {
      sendEvent("error", { error: "Something went wrong. Please try again." });
      res.end();
    } catch {
      /* response may already be closed */
    }
  }
});

export default router;
