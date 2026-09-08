/**
 * Seed the four prototype weekly-review markers for one account, so the
 * Journey row can be felt on a real phone before stage 3 generates anything.
 *
 * Usage (same env as the server: DATABASE_URL, DATA_ENCRYPTION_KEY):
 *
 *     pnpm exec tsx scripts/seed-weekly-review.ts you@example.com
 *
 * Idempotent: re-running upserts the same four weeks. Only the newest marker
 * is unviewed, as in the prototype. Remove them with:
 *
 *     DELETE FROM weekly_reviews WHERE user_id = (SELECT id FROM users WHERE email = '…');
 */

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { seedPrototypeReviews } from "../src/services/weeklyReview.js";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("usage: pnpm exec tsx scripts/seed-weekly-review.ts <email>");
  process.exit(2);
}

const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
if (!user) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

const rows = await seedPrototypeReviews(user.id);
console.log(`seeded ${rows.length} weekly reviews for user ${user.id}:`);
for (const r of rows) console.log(`  ${r.weekStart} → ${r.weekEnd}  ${r.viewedAt ? "viewed" : "NEW"}`);
process.exit(0);
