import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { db, leadsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

/**
 * Landing-page email capture (public, no auth). A cold visitor's first ask is
 * an email, not a card — this stores it, sends a plain confirmation, and pings
 * the founder so a new signup is a live signal.
 *
 * Fails SOFT end to end: a bad DB or Resend call must never show the visitor an
 * error on what is meant to be the friendliest possible first interaction.
 */

const router: IRouter = Router();

// The exact promise shown beside the form. Deliberately server-side and
// authoritative (not trusted from the client): it's the consent record, and it
// must NOT promise anything we haven't committed to building — no "free tier"
// language until a free tier actually exists.
const LEAD_CONSENT_TEXT = "I'll send you the essays as they're published. Nothing else.";

const VALID_SOURCES = new Set(["landing_hero", "landing_footer"]);

// Pragmatic email shape check — not RFC-perfect (nothing is), just enough to
// reject obvious junk before it hits the DB. Capped length guards abuse.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // per IP — generous for a human, tight for a script
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

async function sendViaResend(payload: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("leads: RESEND_API_KEY not set — email not sent (lead still stored)");
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

// Warm, plain confirmation — no essay links (they're not all published yet),
// no other promises. Matches the EOS transactional-email look.
function confirmationHtml(): string {
  return `
    <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
      <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">EOS</h1>
      <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">a new dawn</p>
      <p style="font-size:16px;line-height:1.7;">Thank you for your interest in Eos.</p>
      <p style="font-size:16px;line-height:1.7;">I'll send you the essays as they're published. Nothing else.</p>
      <p style="font-size:16px;line-height:1.7;">— The Eos team</p>
      <p style="font-size:12px;color:#aaa;line-height:1.6;margin-top:32px;">You're receiving this because you asked for the Eos essays at eoscompanion.com. Reply to this email to be removed.</p>
    </div>`;
}

function founderNotifyHtml(email: string, source: string): string {
  const when = new Date().toISOString();
  return `
    <div style="font-family:system-ui,sans-serif;font-size:14px;color:#222;line-height:1.7;">
      <p><strong>New Eos email signup</strong></p>
      <p>Email: ${email}<br>Source: ${source}<br>When: ${when}</p>
    </div>`;
}

router.post("/leads", leadLimiter, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { email?: unknown; source?: unknown; website?: unknown };

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

  const source =
    typeof body.source === "string" && VALID_SOURCES.has(body.source) ? body.source : "landing_hero";

  // Store first. onConflictDoNothing makes a repeat submit idempotent — the
  // same person re-subscribing is a success, not a duplicate row or an error.
  let isNew = true;
  try {
    const inserted = await db
      .insert(leadsTable)
      .values({ email, source, consentText: LEAD_CONSENT_TEXT })
      .onConflictDoNothing({ target: leadsTable.email })
      .returning({ id: leadsTable.id });
    isNew = inserted.length > 0;
  } catch (err) {
    // A DB hiccup must not fail the friendliest interaction on the site. Log
    // and still return success; the confirmation send below is skipped.
    logger.error({ err }, "leads: insert failed");
    res.json({ ok: true });
    return;
  }

  // Emails are fire-and-forget: never block the response, never surface a send
  // failure to the visitor. Only email a genuinely new lead (no repeat sends).
  if (isNew) {
    void sendViaResend({
      to: email,
      subject: "The Eos essays are coming",
      html: confirmationHtml(),
    }).catch((err) => logger.error({ err }, "leads: confirmation email failed"));

    const notify = process.env.LEAD_NOTIFY_EMAIL?.trim() || "hello@eoscompanion.com";
    void sendViaResend({
      to: notify,
      subject: "New Eos email signup",
      html: founderNotifyHtml(email, source),
    }).catch((err) => logger.error({ err }, "leads: founder-notify email failed"));
  }

  res.json({ ok: true });
});

export default router;
