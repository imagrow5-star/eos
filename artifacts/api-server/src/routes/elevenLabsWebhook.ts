import { Router, type IRouter } from "express";
import { db, voiceUsageTable } from "@workspace/db";
import {
  verifyElevenLabsWebhookSignature,
  isElevenLabsWebhookConfigured,
} from "../services/elevenlabs.js";
import { parseVoiceTokenUserId } from "../lib/voiceToken.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

const router: IRouter = Router();

// ─── POST /api/elevenlabs/post-call — voice-minute metering (stage A) ────────
//
// ElevenLabs sends a post_call_transcription delivery after each call's
// analysis completes. This handler records ONE voice_usage row per call —
// measurement only, no enforcement: nothing reads these rows to gate
// anything yet.
//
// MOUNTING (see app.ts): raw-body mount before express.json(), because the
// ElevenLabs-Signature HMAC covers the raw bytes.
//
// Payload shape confirmed against two real captured deliveries (2026-09-02):
//  - type: "post_call_transcription"; data.conversation_id is the call's
//    unique id (the idempotency key — the envelope has no delivery id);
//  - data.metadata.start_time_unix_secs / call_duration_secs (integers,
//    seconds) — present even on a call ElevenLabs terminated early
//    (status "failed"), which still consumed minutes, so status is
//    deliberately NOT filtered on;
//  - our per-call HMAC voice token rides in
//    data.conversation_initiation_client_data.custom_llm_extra_body
//    .user_token — the same token voice-llm.ts authenticates with, so the
//    userId comes from something WE signed, not from provider-controlled
//    fields. parseVoiceTokenUserId checks signature + env but tolerates
//    expiry (deliveries arrive after the call; retries can be hours late).
//
// FAIL-OPEN CONTRACT: metering must never affect a call or spam retries.
// Every outcome except a bad signature answers 200 — a delivery we can't
// use is logged loudly and dropped (ElevenLabs disables webhooks that keep
// failing, and losing a metering row must never risk that). A lost row can
// only ever UNDER-count a user's minutes.

interface ElevenLabsPostCallPayload {
  type?: string;
  event_timestamp?: number;
  data?: {
    conversation_id?: string;
    status?: string;
    metadata?: {
      start_time_unix_secs?: number;
      call_duration_secs?: number;
    };
    conversation_initiation_client_data?: {
      custom_llm_extra_body?: { user_token?: string };
    };
  };
}

router.post("/elevenlabs/post-call", async (req, res): Promise<void> => {
  if (!isElevenLabsWebhookConfigured()) {
    logger.error("elevenlabs-webhook: ELEVENLABS_WEBHOOK_SECRET not set — rejecting delivery");
    res.status(503).json({ error: "webhook not configured" });
    return;
  }

  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(String(req.body ?? ""), "utf8");
  const sigHeader = req.header("elevenlabs-signature");
  if (
    !verifyElevenLabsWebhookSignature(
      rawBody,
      sigHeader,
      process.env.ELEVENLABS_WEBHOOK_SECRET!.trim(),
    )
  ) {
    logger.error(
      { hasSignature: Boolean(sigHeader), bodyBytes: rawBody.length },
      "elevenlabs-webhook: INVALID SIGNATURE — delivery rejected. If this repeats, verify " +
        "ELEVENLABS_WEBHOOK_SECRET matches the webhook's secret in the ElevenLabs dashboard.",
    );
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  try {
    let payload: ElevenLabsPostCallPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as ElevenLabsPostCallPayload;
    } catch {
      logger.error("elevenlabs-webhook: signed body is not valid JSON — dropped");
      res.status(200).json({ ok: true });
      return;
    }

    if (payload.type !== "post_call_transcription") {
      // post_call_audio (should be off in the dashboard) and any future
      // types: nothing to meter.
      logger.info({ type: payload.type }, "elevenlabs-webhook: ignoring non-transcription event");
      res.status(200).json({ ok: true });
      return;
    }

    const data = payload.data ?? {};
    const conversationId = data.conversation_id;
    const token = data.conversation_initiation_client_data?.custom_llm_extra_body?.user_token;
    const userId = typeof token === "string" ? parseVoiceTokenUserId(token) : null;
    if (!conversationId || userId === null) {
      logger.error(
        { hasConversationId: Boolean(conversationId), hasToken: Boolean(token), status: data.status },
        "elevenlabs-webhook: cannot attribute call to a user — no usage row stored. " +
          "(Missing/invalid user_token means the call didn't come from our web client.)",
      );
      res.status(200).json({ ok: true });
      return;
    }

    const startSecs = data.metadata?.start_time_unix_secs;
    const durationSecs = data.metadata?.call_duration_secs;
    // start_time_unix_secs was present in both captures; event_timestamp is
    // the deliberate fallback (delivery time ≈ call end — minutes off at
    // worst, and only used if ElevenLabs ever omits the start).
    const startMs =
      typeof startSecs === "number" && Number.isFinite(startSecs)
        ? startSecs * 1000
        : typeof payload.event_timestamp === "number" && Number.isFinite(payload.event_timestamp)
          ? payload.event_timestamp * 1000
          : null;
    const duration =
      typeof durationSecs === "number" && Number.isFinite(durationSecs) && durationSecs >= 0
        ? Math.round(durationSecs)
        : null;
    if (startMs === null) {
      logger.error(
        { conversationId },
        "elevenlabs-webhook: delivery has no usable timestamps — no usage row stored",
      );
      res.status(200).json({ ok: true });
      return;
    }

    const inserted = await db
      .insert(voiceUsageTable)
      .values({
        userId,
        callStartedAt: new Date(startMs),
        callEndedAt: duration !== null ? new Date(startMs + duration * 1000) : null,
        durationSeconds: duration,
        source: "elevenlabs_webhook",
        providerConversationId: conversationId,
      })
      .onConflictDoNothing({ target: voiceUsageTable.providerConversationId })
      .returning({ id: voiceUsageTable.id });

    try {
      const uh = hashUserIdForLog(userId);
      if (uh !== undefined) {
        logger.info(
          { uh, durationSecs: duration, duplicate: inserted.length === 0, status: data.status },
          "elevenlabs-webhook: voice usage recorded",
        );
      }
    } catch { /* logging must never crash the caller */ }
    res.status(200).json({ ok: true });
  } catch (err) {
    // Metering is best-effort: a DB hiccup loses one row (under-counting,
    // in the user's favor), never a retry storm or a disabled webhook.
    logger.error({ err }, "elevenlabs-webhook: processing failed — delivery dropped");
    res.status(200).json({ ok: true });
  }
});

export default router;
