import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, and, gt, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, pool } from "@workspace/db";
import { usersTable, passwordResetTokensTable, emailVerificationTokensTable } from "@workspace/db";
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
      from: process.env.RESEND_FROM_EMAIL ?? "ASHA <onboarding@resend.dev>",
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

async function sendVerificationEmail(
  toEmail: string,
  verifyUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn({ verifyUrl }, "RESEND_API_KEY not set — verification link logged for dev");
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "ASHA <onboarding@resend.dev>",
      to: [toEmail],
      subject: "Verify your ASHA email address",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">ASHA</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">Your companion, your story</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">Thank you for creating an ASHA account. Please verify your email address to get started. This link expires in 24 hours.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${verifyUrl}" style="display:inline-block;background:#b8962e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">Verify My Email</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">If you didn't create an ASHA account, you can safely ignore this email.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${verifyUrl}" style="color:#b8962e;word-break:break-all;">${verifyUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

async function sendChangeEmailVerification(
  toEmail: string,
  verifyUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn({ verifyUrl }, "RESEND_API_KEY not set — change-email link logged for dev");
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "ASHA <onboarding@resend.dev>",
      to: [toEmail],
      subject: "Confirm your new ASHA email address",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">ASHA</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">Your companion, your story</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">We received a request to change the email address on your ASHA account to this one. Click below to confirm this is your address. This link expires in 24 hours.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${verifyUrl}" style="display:inline-block;background:#b8962e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">Confirm New Email</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">If you didn't request this change, you can safely ignore this email — nothing will change until you confirm.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${verifyUrl}" style="color:#b8962e;word-break:break-all;">${verifyUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/** Creates a verification token in the DB and fires off the email (no throw). */
async function issueAndSendVerification(userId: number, email: string): Promise<void> {
  try {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db.insert(emailVerificationTokensTable).values({ token, userId, expiresAt });

    const domain =
      process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : "http://localhost:3000";

    const verifyUrl = `${domain}/?verifyToken=${token}`;

    await sendVerificationEmail(email, verifyUrl);
    logger.info({ userId }, "Verification email sent");
  } catch (err) {
    logger.error({ err, userId }, "Failed to send verification email");
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

    // Fire-and-forget: send verification email after responding
    res.status(201).json({ user: { id: user!.id, email: user!.email }, emailVerified: false });

    // Issue verification asynchronously (don't block the response)
    issueAndSendVerification(user!.id, user!.email);
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
    res.json({
      user: { id: user.id, email: user.email },
      emailVerified: user.emailVerifiedAt !== null,
    });
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
    .select({ id: usersTable.id, email: usersTable.email, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Session invalid" });
    return;
  }

  res.json({ user: { id: user.id, email: user.email }, emailVerified: user.emailVerifiedAt !== null });
});

// ─── GET /auth/verify-email ───────────────────────────────────────────────────

router.get("/auth/verify-email", async (req, res): Promise<void> => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Verification token is required." });
    return;
  }

  try {
    const now = new Date();

    const [row] = await db
      .select()
      .from(emailVerificationTokensTable)
      .where(
        and(
          eq(emailVerificationTokensTable.token, token),
          gt(emailVerificationTokensTable.expiresAt, now),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(400).json({ error: "This verification link is invalid or has expired." });
      return;
    }

    // ── Email-change confirmation ──
    // A token with `newEmail` set stages a pending change. Confirming it swaps
    // the account's email over to the new address atomically and marks it verified.
    if (row.newEmail) {
      try {
        await db
          .update(usersTable)
          .set({ email: row.newEmail, emailVerifiedAt: now })
          .where(eq(usersTable.id, row.userId));
      } catch (err: any) {
        if (err?.code === "23505") {
          // Someone else claimed this address between request and confirmation.
          // Drop the stale token so the user can start over.
          await db
            .delete(emailVerificationTokensTable)
            .where(eq(emailVerificationTokensTable.token, token));
          res.status(409).json({
            error: "That email address is now in use by another account.",
          });
          return;
        }
        throw err;
      }

      await db
        .delete(emailVerificationTokensTable)
        .where(eq(emailVerificationTokensTable.userId, row.userId));

      logger.info({ userId: row.userId }, "Email address changed and verified");
      res.json({ ok: true, emailChanged: true });
      return;
    }

    // ── Ordinary signup verification ──
    // Mark the user as verified
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: now })
      .where(and(eq(usersTable.id, row.userId), isNull(usersTable.emailVerifiedAt)));

    // Delete all verification tokens for this user (clean up)
    await db
      .delete(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, row.userId));

    logger.info({ userId: row.userId }, "Email verified");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "verify-email error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/resend-verification ──────────────────────────────────────────

router.post("/auth/resend-verification", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email, emailVerifiedAt: usersTable.emailVerifiedAt })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "Session invalid" });
      return;
    }

    if (user.emailVerifiedAt !== null) {
      res.status(400).json({ error: "Your email is already verified." });
      return;
    }

    // Delete old tokens before issuing a new one
    await db
      .delete(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, userId));

    // Respond immediately, then send the email
    res.json({ ok: true });

    issueAndSendVerification(user.id, user.email);
  } catch (err) {
    logger.error({ err }, "resend-verification error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/change-email ─────────────────────────────────────────────────
// Authenticated users request a change to a new email address. The current
// address (and its verified status) is kept until the user confirms the new one
// via a link sent to that new address.

router.post("/auth/change-email", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { newEmail, password } = req.body ?? {};

  if (!newEmail || typeof newEmail !== "string" || !newEmail.includes("@")) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }
  const cleanEmail = newEmail.toLowerCase().trim();
  if (cleanEmail.length > 254) {
    res.status(400).json({ error: "Email address is too long." });
    return;
  }
  if (!password || typeof password !== "string") {
    res.status(400).json({ error: "Your current password is required to change your email." });
    return;
  }

  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email, hashedPassword: usersTable.hashedPassword })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "Session invalid" });
      return;
    }

    const valid = await bcrypt.compare(password, user.hashedPassword);
    if (!valid) {
      res.status(403).json({ error: "That password is incorrect." });
      return;
    }

    if (cleanEmail === user.email) {
      res.status(400).json({ error: "That's already your email address." });
      return;
    }

    // Reject if another account already uses this address.
    const [taken] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (taken) {
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }

    // Clear any prior pending verification/change tokens, then stage this change.
    await db
      .delete(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, userId));

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db
      .insert(emailVerificationTokensTable)
      .values({ token, userId, newEmail: cleanEmail, expiresAt });

    const domain = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://localhost:3000";
    const verifyUrl = `${domain}/?verifyToken=${token}`;

    // Respond before sending so a slow email provider doesn't hang the request.
    res.json({ ok: true, pendingEmail: cleanEmail });

    try {
      await sendChangeEmailVerification(cleanEmail, verifyUrl);
      logger.info({ userId }, "Change-email verification sent");
    } catch (err) {
      logger.error({ err, userId }, "Failed to send change-email verification");
    }
  } catch (err) {
    logger.error({ err }, "change-email error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  }
});

async function sendSecurityAlertEmail(
  toEmail: string,
  cancelUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn({ cancelUrl }, "RESEND_API_KEY not set — cancel link logged for dev");
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "ASHA <onboarding@resend.dev>",
      to: [toEmail],
      subject: "Security alert: password reset requested for your ASHA account",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">ASHA</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">Your companion, your story</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">Someone just requested a password reset for your ASHA account. If that was you, you can ignore this message — a separate email with the reset link was sent to you.</p>
          <p style="font-size:16px;line-height:1.6;font-weight:bold;">If you did <em>not</em> request this, click below to cancel the reset immediately and keep your account safe.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${cancelUrl}" style="display:inline-block;background:#c0392b;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">No, Secure My Account</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">Clicking that link will invalidate the pending reset request. Your password will remain unchanged.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${cancelUrl}" style="color:#c0392b;word-break:break-all;">${cancelUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

// ─── POST /auth/cancel-reset ──────────────────────────────────────────────────

router.post("/auth/cancel-reset", async (req, res): Promise<void> => {
  const { token } = req.body ?? {};

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Token is required." });
    return;
  }

  try {
    // Look up the user from the token (expired or not — we still want to cancel)
    const [row] = await db
      .select({ userId: passwordResetTokensTable.userId })
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.token, token),
          isNull(passwordResetTokensTable.usedAt),
        ),
      )
      .limit(1);

    if (!row) {
      // Token doesn't exist or was already used — treat as success to avoid enumeration
      res.json({ ok: true });
      return;
    }

    // Delete ALL pending reset tokens for this user
    await db
      .delete(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.userId, row.userId),
          isNull(passwordResetTokensTable.usedAt),
        ),
      );

    logger.info({ userId: row.userId }, "Password reset cancelled by user via security alert");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "cancel-reset error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
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
    const cancelUrl = `${domain}/?cancelReset=${token}`;

    await Promise.all([
      sendPasswordResetEmail(user.email, resetUrl),
      sendSecurityAlertEmail(user.email, cancelUrl),
    ]);
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

    // First, look up the token without any expiry/used filter so we can give
    // a precise error message (expired vs never-existed vs already used).
    const [anyRow] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.token, token))
      .limit(1);

    if (!anyRow) {
      res.status(400).json({
        error: "This reset link is invalid.",
        code: "TOKEN_INVALID",
      });
      return;
    }

    if (anyRow.usedAt !== null) {
      res.status(400).json({
        error: "This reset link has already been used. Please request a new one if you need to reset your password again.",
        code: "TOKEN_USED",
      });
      return;
    }

    if (anyRow.expiresAt <= now) {
      res.status(400).json({
        error: "This reset link has expired. Please request a new one.",
        code: "TOKEN_EXPIRED",
      });
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
      // Another request beat us to it (race condition) — treat as expired
      res.status(400).json({
        error: "This reset link has expired. Please request a new one.",
        code: "TOKEN_EXPIRED",
      });
      return;
    }

    // Update the password now that we own the token
    await db
      .update(usersTable)
      .set({ hashedPassword })
      .where(eq(usersTable.id, anyRow.userId));

    // Invalidate all existing sessions for this user
    await pool.query(
      `DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1::text`,
      [String(anyRow.userId)],
    );

    logger.info({ userId: anyRow.userId }, "Password reset successfully");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "reset-password error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── DELETE /auth/account ─────────────────────────────────────────────────────

router.delete("/auth/account", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // Acquire a dedicated client so we can issue BEGIN/COMMIT explicitly.
  // pool.query() does not support multiple statements in a single parameterised call.
  const client = await pool.connect();
  try {
    // Delete all user-owned data in a single transaction, ordered to respect FK constraints.
    // goal_tasks cascade from goals, so we only need to delete goals explicitly.
    await client.query("BEGIN");
    await client.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1::text`, [String(userId)]);
    await client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM messages          WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM memory_facts      WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM personality_signals WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM wins              WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM mood_scores       WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM reminders         WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = $1)`, [userId]);
    await client.query(`DELETE FROM habits            WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM goals             WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM commitments       WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM profile           WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM users             WHERE id = $1`, [userId]);
    await client.query("COMMIT");

    logger.info({ userId }, "Account deleted — all data wiped");

    // Destroy the session and clear the cookie before responding
    req.session.destroy((err) => {
      if (err) logger.error({ err }, "Session destroy error after account deletion");
      res.clearCookie("sid");
      res.json({ ok: true });
    });
  } catch (err) {
    logger.error({ err }, "Account deletion error");
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: "Something went wrong. Please try again." });
  } finally {
    client.release();
  }
});

export default router;
