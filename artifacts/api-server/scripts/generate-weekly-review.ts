/**
 * Generate this week's weekly review for one user, ignoring the Sunday
 * window (and replacing an existing row), so the real generator can be seen
 * on a local account.
 *
 * Usage (same env as the server: DATABASE_URL, DATA_ENCRYPTION_KEY, and
 * ANTHROPIC_API_KEY if you want the model-proposed moment card):
 *   pnpm exec tsx scripts/generate-weekly-review.ts <email>
 */

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { generateWeeklyReviewForUser } from "../src/services/weeklyReviewGenerate.js";

const email = process.argv[2];
if (!email) {
  console.error("usage: tsx scripts/generate-weekly-review.ts <email>");
  process.exit(1);
}

const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
if (!user) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

const result = await generateWeeklyReviewForUser(user.id, { force: true });
console.log(JSON.stringify(result));
process.exit(0);
