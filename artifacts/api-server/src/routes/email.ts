/**
 * Public email preference routes — no auth required.
 * Used for one-click unsubscribe links sent inside daily emails.
 */

import { Router, type IRouter } from "express";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { profileTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── GET /email/unsubscribe?uid=:uid&token=:token ─────────────────────────────
//
// One-click unsubscribe for daily emails.  The token is HMAC-SHA256 of
// "unsub:<userId>" keyed by SESSION_SECRET — same derivation as daily-email/src/index.ts.
// No database lookup needed to validate; the HMAC is deterministic.

router.get("/email/unsubscribe", async (req, res): Promise<void> => {
  const uid   = parseInt(String(req.query["uid"] ?? ""), 10);
  const token = String(req.query["token"] ?? "");

  if (!uid || isNaN(uid) || !token) {
    res.status(400).send(unsubPage("Invalid link", "This unsubscribe link is invalid or incomplete."));
    return;
  }

  const secret   = process.env.SESSION_SECRET ?? "";
  const expected = createHmac("sha256", secret)
    .update(`unsub:${uid}`)
    .digest("hex")
    .slice(0, 24);

  if (token !== expected) {
    res.status(400).send(unsubPage("Invalid link", "This unsubscribe link is invalid or has expired."));
    return;
  }

  try {
    await db
      .update(profileTable)
      .set({ dailyEmailOptOut: true })
      .where(eq(profileTable.userId, uid));

    logger.info({ userId: uid }, "User unsubscribed from daily emails");
    res.status(200).send(unsubPage("Done", "You've been unsubscribed from Eos daily notes. You won't receive them again."));
  } catch (err) {
    logger.error({ err, userId: uid }, "Unsubscribe update failed");
    res.status(500).send(unsubPage("Error", "Something went wrong. Please try again or contact support."));
  }
});

// ─── Minimal branded confirmation page ───────────────────────────────────────

function unsubPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Eos — ${title}</title>
</head>
<body style="margin:0;padding:0;background:#1B1922;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;">
  <div style="text-align:center;padding:48px 24px;max-width:400px;">
    <h1 style="font-size:24px;letter-spacing:0.3em;color:#EFE6D6;margin:0 0 12px 0;font-weight:400;text-transform:uppercase;">EOS</h1>
    <div style="width:28px;height:1px;background:#C79A5B;margin:0 auto 12px;opacity:0.55;"></div>
    <p style="font-size:16px;color:#EFE6D6;line-height:1.7;margin:0 0 8px 0;">${body}</p>
    <p style="font-size:13px;color:#8A8194;margin:16px 0 0 0;">
      <a href="/" style="color:#C79A5B;text-decoration:none;">Return to Eos →</a>
    </p>
  </div>
</body>
</html>`;
}

export default router;
