import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, and, gt, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, pool } from "@workspace/db";
import { usersTable, passwordResetTokensTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Email helper (Resend REST API) ──────────────────────────────────────────

async function sendPasswordResetEmail(
  toEmail: string,
  resetUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Log the link in dev so the feature is testable without an email provider
    logger.warn({ resetUrl }, "RESEND_API_KEY not set — reset link logged for dev");
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "ASHA <noreply@asha.app>",
      to: [toEmail],
      subject: "Reset your ASHA password",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">ASHA</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">Your companion, your story</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">We received a request to reset the password for your ASHA account. Click the button below to choose a new password. This link expires in 1 hour.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${resetUrl}" style="display:inline-block;background:#b8962e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">Reset My Password</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${resetUrl}" style="color:#b8962e;word-break:break-all;">${resetUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

// ─── POST /auth/signup ────────────────────────────────────────────────────────

router.post("/auth/signup", async (req, res): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }
  const cleanEmail = email.toLowerCase().trim();
  if (cleanEmail.length > 254) {
    res.status(400).json({ error: "Email address is too long." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (existing) {
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(usersTable)
      .values({ email: cleanEmail, hashedPassword })
      .returning({ id: usersTable.id, email: usersTable.email });

    req.session.userId = user!.id;
    logger.info({ userId: user!.id }, "New user signed up");
    res.status(201).json({ user: { id: user!.id, email: user!.email } });
  } catch (err: any) {
    if ((err as any)?.code === "23505") {
      // Race-condition unique violation
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }
    logger.error({ err }, "Signup error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || typeof email !== "string" || !password || typeof password !== "string") {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (!user) {
      // Same message as wrong password to prevent user enumeration
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    const valid = await bcrypt.compare(password, user.hashedPassword);
    if (!valid) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    req.session.userId = user.id;
    logger.info({ userId: user.id }, "User logged in");
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

router.post("/auth/logout", (req, res): void => {
  req.session.destroy((err) => {
    if (err) logger.error({ err }, "Session destroy error");
    res.clearCookie("sid");
    res.json({ ok: true });
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Session invalid" });
    return;
  }

  res.json({ user });
});

// ─── POST /auth/forgot-password ───────────────────────────────────────────────

router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const { email } = req.body ?? {};

  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }

  const cleanEmail = email.toLowerCase().trim();

  // Always respond with success to prevent user enumeration
  res.json({ ok: true });

  // Do the heavy work asynchronously after responding
  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (!user) {
      // No account — silently do nothing (already responded 200)
      return;
    }

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(passwordResetTokensTable).values({
      token,
      userId: user.id,
      expiresAt,
    });

    const domain =
      process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : "http://localhost:3000";

    const resetUrl = `${domain}/?resetToken=${token}`;

    await sendPasswordResetEmail(user.email, resetUrl);
    logger.info({ userId: user.id }, "Password reset email sent");
  } catch (err) {
    logger.error({ err }, "forgot-password background error");
  }
});

// ─── POST /auth/reset-password ────────────────────────────────────────────────

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const { token, password } = req.body ?? {};

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Reset token is required." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  try {
    const now = new Date();

    const [row] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.token, token),
          gt(passwordResetTokensTable.expiresAt, now),
          isNull(passwordResetTokensTable.usedAt),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Atomically mark the token as used (conditional — guards against concurrent replay)
    const consumed = await pool.query<{ user_id: number }>(
      `UPDATE password_reset_tokens
          SET used_at = NOW()
        WHERE token = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id`,
      [token],
    );

    if (consumed.rowCount === 0) {
      // Another request beat us to it — treat as invalid
      res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
      return;
    }

    // Update the password now that we own the token
    await db
      .update(usersTable)
      .set({ hashedPassword })
      .where(eq(usersTable.id, row.userId));

    // Invalidate all existing sessions for this user
    await pool.query(
      `DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1::text`,
      [String(row.userId)],
    );

    logger.info({ userId: row.userId }, "Password reset successfully");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "reset-password error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

export default router;
