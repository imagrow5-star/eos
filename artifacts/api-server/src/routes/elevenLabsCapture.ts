import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── TEMPORARY: ElevenLabs post-call webhook capture ─────────────────────────
// DELETE THIS FILE (and its mounts in app.ts + routes/index.ts) once one real
// post_call_transcription delivery has been captured from the Render logs.
//
// Voice-minute metering (stage A) needs the handler built against a REAL
// payload, not inferred field names — same rule as the Dodo webhook. This
// endpoint logs one delivery's headers and raw body to the service logs and
// answers 200, so the transcript never leaves our infrastructure (the
// alternative — webhook.site — ships call content to a third party).
//
// The unguessable path segment is the only gate: the route is unauthenticated
// (ElevenLabs' servers call it), does nothing but log, and touches no data.
//
// DELIBERATE EXCEPTION to the no-content-in-logs rule: the whole point is to
// read the payload (of the founder's own content-free test call) out of the
// logs. The body is logged as base64 so the exact bytes survive — signature
// verification is an HMAC over the raw byte layout — split into numbered
// chunks small enough that no log pipeline truncates them.
//
// To reassemble from the Render logs:
//   grep "elevenlabs-capture body" → concatenate the chunk strings in order
//   → base64-decode → the delivery's exact JSON body.

const CHUNK_CHARS = 4000;

router.post("/elevenlabs/capture-e9723ffc8e1e5e50", (req, res): void => {
  try {
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(String(req.body ?? ""), "utf8");
    const b64 = raw.toString("base64");
    const totalChunks = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));

    logger.info(
      { headers: req.headers, bodyBytes: raw.length, totalChunks },
      "elevenlabs-capture headers",
    );
    for (let i = 0; i < totalChunks; i++) {
      logger.info(
        { part: `${i + 1}/${totalChunks}`, b64: b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) },
        "elevenlabs-capture body",
      );
    }
  } catch (err) {
    logger.error({ err }, "elevenlabs-capture failed to log delivery");
  }
  res.status(200).json({ ok: true });
});

export default router;
