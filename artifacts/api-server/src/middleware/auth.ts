import type { Request, Response, NextFunction } from "express";

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
