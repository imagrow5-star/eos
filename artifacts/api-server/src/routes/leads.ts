import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { db, leadsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

/**
 * "Ask the founder" — the landing page's direct line to Naveen (public, no
 * auth). A visitor with doubts leaves an email and (optionally) a message; we
 * store it, email Naveen the message so he can reply directly, and send the
 * visitor a short personal confirmation.
 *
 * Fails SOFT end to end: neither a DB nor a Resend hiccup shows the visitor an
 * error on what is meant to be the friendliest interaction on the site — and
 * the founder-notify is attempted even if the DB write fails, so a real message
 * is never lost to a storage blip.
 */

const router: IRouter = Router();

// The exact promise shown beside the form. Server-side and authoritative (not
// trusted from the client): it's the consent record, and it must NOT drift into
// marketing/list language — this is a personal reply, not a subscription.
export const LEAD_CONSENT_TEXT =
  "Naveen reads every message himself and replies personally. You won't be added to anything.";

const VALID_SOURCES = new Set(["landing_hero", "landing_footer"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MESSAGE_MAX = 2000;

const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // per IP — generous for a human, tight for a script
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

/** Escape user text before it goes into an HTML email (the message is free
 *  text and lands in Naveen's inbox — never inject markup into it). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendViaResend(payload: { to: string; subject: string; html: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("leads: RESEND_API_KEY not set — email not sent (message still stored)");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "Eos <hello@eoscompanion.com>",
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend API error ${res.status}: ${await res.text()}`);
  }
}

// Short, personal confirmation to the visitor — from Naveen, no essays, no
// other promises. Matches the EOS transactional-email look.
export function confirmationHtml(): string {
  return `
    <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
      <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">EOS</h1>
      <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">a new dawn</p>
      <p style="font-size:16px;line-height:1.7;">Thanks for reaching out. I read every message myself, and I'll reply to you personally.</p>
      <p style="font-size:16px;line-height:1.7;">— Naveen, founder of Eos</p>
    </div>`;
}

// Founder-notify — carries the message so Naveen can read and reply directly.
// Exported so a test can prove the message is included and escaped.
export function founderNotifyHtml(email: string, message: string, source: string): string {
  const when = new Date().toISOString();
  const msgBlock = message
    ? `<p style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px;margin:12px 0;">${escapeHtml(message)}</p>`
    : `<p style="color:#888;">(no message — email only)</p>`;
  return `
    <div style="font-family:system-ui,sans-serif;font-size:14px;color:#222;line-height:1.7;">
      <p><strong>Someone asked a question on the Eos landing page</strong></p>
      <p>From: ${escapeHtml(email)}<br>Source: ${escapeHtml(source)}<br>When: ${when}</p>
      ${msgBlock}
      <p style="color:#888;">Reply straight to ${escapeHtml(email)}.</p>
    </div>`;
}

router.post("/leads", leadLimiter, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    email?: unknown;
    message?: unknown;
    source?: unknown;
    website?: unknown;
  };

  // Honeypot: a hidden field real users never see. Bots fill it. Pretend
  // success (no store, no email) so a scraper can't tell it was rejected.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    res.json({ ok: true });
    return;
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }

  // Message is optional; trim and cap. Empty stays null (email-only reach out).
  const rawMessage = typeof body.message === "string" ? body.message.trim().slice(0, MESSAGE_MAX) : "";
  const message = rawMessage.length > 0 ? rawMessage : null;

  const source =
    typeof body.source === "string" && VALID_SOURCES.has(body.source) ? body.source : "landing_hero";

  // Store first — one row per email (a returning person updates their latest
  // message rather than piling up rows). A DB blip must not lose the message,
  // so we log and continue: the founder-notify below still fires.
  try {
    await db
      .insert(leadsTable)
      .values({ email, message, source, consentText: LEAD_CONSENT_TEXT })
      .onConflictDoUpdate({ target: leadsTable.email, set: { message, source } });
  } catch (err) {
    logger.error({ err }, "leads: insert failed (still delivering the message by email)");
  }

  // Unlike a newsletter opt-in, EVERY submission is a message to read — so the
  // founder-notify and the personal confirmation fire on every valid, non-bot
  // submission, not just the first. Fire-and-forget: never block the response,
  // never surface a send failure to the visitor.
  const notify = process.env.LEAD_NOTIFY_EMAIL?.trim() || "hello@eoscompanion.com";
  void sendViaResend({
    to: notify,
    subject: "Someone asked a question on the Eos landing page",
    html: founderNotifyHtml(email, message ?? "", source),
  }).catch((err) => logger.error({ err }, "leads: founder-notify email failed"));

  void sendViaResend({
    to: email,
    subject: "I got your message",
    html: confirmationHtml(),
  }).catch((err) => logger.error({ err }, "leads: confirmation email failed"));

  res.json({ ok: true });
});

export default router;
