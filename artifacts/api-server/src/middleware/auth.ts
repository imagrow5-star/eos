import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// ─── Augment express-session to carry userId ──────────────────────────────────
declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

// ─── Augment Express Request with typed userId ────────────────────────────────
// After requireAuth runs, req.userId is always a number.
declare global {
  namespace Express {
    interface Request {
      userId: number;
    }
  }
}

/**
 * Protect any route that requires a logged-in user.
 * Reads req.session.userId set by the auth routes.
 * Returns 401 if there is no valid session.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.userId = userId;
  next();
}

/**
 * Require the session user's email to be verified before accessing protected
 * application routes. Must run after requireAuth (so req.userId is set).
 * Returns 403 with emailVerified: false so the client can surface the right UI.
 */
export async function requireVerified(req: Request, res: Response, next: NextFunction): Promise<void> {
  const [user] = await db
    .select({ emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(eq(usersTable.id, req.userId))
    .limit(1);

  if (!user || user.emailVerifiedAt === null) {
    res.status(403).json({
      error: "Please verify your email address before continuing.",
      emailVerified: false,
    });
    return;
  }

  next();
}
