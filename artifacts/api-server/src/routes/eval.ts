import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod/v4";
import { logger } from "../lib/logger.js";
import { requireEvalKey } from "../lib/evalAuth.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { streamCompanionReply, DEFAULT_COMPANION_MODEL } from "../services/ai.js";
import { memoryCutReport } from "../services/memory/cutReport.js";
import { detectCrisis } from "../services/crisis/detector.js";
import { detectCrisisSemantic, resolveCrisisOutcome } from "../services/crisis/semanticDetector.js";
import { CRISIS_REINFORCEMENT_BLOCK } from "../services/crisis/reinforcement.js";
import { resolveHelplines, buildHelplineBlockText } from "../services/crisis/helplines.js";
import {
  EvalFact, EvalFeeling, EvalProfile, evalProfile, evalMemory, evalStage,
  EVAL_FACTS_MAX, EVAL_FEELINGS_MAX, EVAL_HISTORY_MAX_TURNS,
} from "../services/eval/fixtures.js";

/**
 * POST /api/eval/turn — one text turn for an external evaluation harness.
 *
 * The real thing: the same prompt builder, the same model, the same
 * streaming call path (services/ai.ts) and the same crisis floor as the app.
 * The caller supplies the person: a profile, the facts and feelings Eos is
 * meant to remember, and the conversation so far. The facts go through the
 * same importance ranking and top-40 cut as rows read from the database, so
 * recall is evaluated the way it actually behaves.
 *
 * Nothing is written: no message, no memory, no crisis event, no per-user
 * state. The stand-in user id matches no row. The only trace is the usual
 * counts-only ai_usage line and one "eval turn" line of numbers.
 *
 * Auth is a bearer key (lib/evalAuth.ts). Without EVAL_API_KEY configured the
 * route answers 404. Spend is capped per day across all callers of the key
 * (EVAL_TURNS_PER_DAY, default 500), counted in memory: a restart resets it,
 * which errs on the side of the harness, not the bill.
 */
const router: IRouter = Router();

const MESSAGE_MAX = 2000;

function envLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const dailyCap = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: envLimit("EVAL_TURNS_PER_DAY", 500),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => "eval", // one budget for the key, wherever it is called from
  handler: (_req, res) => {
    res.status(429).json({ error: "The evaluation budget for today is spent.", code: "RATE_LIMITED" });
  },
});

const Turn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MESSAGE_MAX + 4000),
});

const EvalBody = z.object({
  message: z.string().trim().min(1, "message is required").max(MESSAGE_MAX),
  history: z.array(Turn).max(EVAL_HISTORY_MAX_TURNS * 2).default([]),
  profile: EvalProfile.prefault({}),
  memory: z.object({
    facts: z.array(EvalFact).max(EVAL_FACTS_MAX).default([]),
    feelings: z.array(EvalFeeling).max(EVAL_FEELINGS_MAX).default([]),
  }).prefault({}),
});

router.post("/eval/turn", requireEvalKey, dailyCap, async (req, res): Promise<void> => {
  const parsed = EvalBody.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Bad request" });
    return;
  }
  const { message, history, profile: profileInput, memory: memoryInput } = parsed.data;

  // Whole exchanges only, user then assistant: the last turn before `message`
  // must be Eos's, so the caller cannot smuggle a fake assistant voice in.
  if (history.length % 2 !== 0 || history.some((t, i) => t.role !== (i % 2 === 0 ? "user" : "assistant"))) {
    res.status(400).json({ error: "history must be whole user/assistant exchanges, in order" });
    return;
  }

  const now = new Date();
  const profile = evalProfile(profileInput, now);
  const memory = evalMemory(memoryInput.facts, memoryInput.feelings, now);
  const stage = evalStage(profileInput, memory.facts.length);
  const language = profileInput.language;

  try {
    // Crisis floor, exactly as in the app: regex first, semantic backstop when
    // regex misses. Detected, reinforced and reported; never recorded.
    const crisis = detectCrisis(message, language);
    const semanticP = crisis.matched
      ? Promise.resolve({ matched: false, available: false })
      : detectCrisisSemantic(message);

    const systemPrompt = await buildSystemPrompt(profile, stage, { memory });
    const semantic = await semanticP;
    const { active: crisisActive, tier: crisisTier } = resolveCrisisOutcome(crisis, semantic);
    const systemExtra = crisisActive ? CRISIS_REINFORCEMENT_BLOCK : undefined;

    const reply = await streamCompanionReply(
      systemPrompt,
      history,
      message,
      stage,
      () => {}, // collected, not streamed: a harness wants the whole reply
      { systemExtra, callType: "eval" },
    );

    const helplineBlock = crisisActive
      ? buildHelplineBlockText(resolveHelplines(profile.country, language).lines, language, crisisTier)
      : null;
    const content = helplineBlock ? `${reply.text}\n\n${helplineBlock}` : reply.text;

    // Did the reply touch the memory it was given? Same lexical check as the
    // production "memory cut" measurement, above and below the cut.
    const cut = memoryCutReport(systemPrompt, message, reply.text) ?? {
      eligible: memory.facts.length, included: 0, excluded: 0,
      userHitsAboveCut: 0, userHitsBelowCut: 0, replyHitsAboveCut: 0, replyHitsBelowCut: 0,
    };

    logger.info(
      {
        evalTurn: {
          stage,
          historyTurns: history.length,
          facts: cut.eligible,
          factsIncluded: cut.included,
          feelings: memory.feelings.length,
          crisis: crisisActive,
          degraded: reply.degraded,
        },
      },
      "eval turn",
    );

    res.json({
      reply: content,
      stage,
      crisis: {
        active: crisisActive,
        tier: crisisActive ? crisisTier : null,
        helplineBlock,
      },
      memory: {
        facts: { eligible: cut.eligible, included: cut.included, excluded: cut.excluded },
        feelings: memory.feelings.length,
        referencedByReply: { aboveCut: cut.replyHitsAboveCut, belowCut: cut.replyHitsBelowCut },
        referencedByMessage: { aboveCut: cut.userHitsAboveCut, belowCut: cut.userHitsBelowCut },
      },
      model: reply.model ?? DEFAULT_COMPANION_MODEL,
      usage: reply.usage ?? null,
      ...(reply.degraded ? { degraded: true } : {}),
    });
  } catch (err) {
    logger.error({ err }, "eval: turn failed");
    res.status(500).json({ error: "The turn failed. Try again." });
  }
});

export default router;
