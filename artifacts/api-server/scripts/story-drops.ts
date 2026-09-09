/**
 * List the story cards the gates refused for one user — what the model tried
 * to write, and which gate said no — so the prompt and the gates can be tuned.
 *
 * Usage (same env as the server: DATABASE_URL, DATA_ENCRYPTION_KEY):
 *   pnpm exec tsx scripts/story-drops.ts <email> [limit]
 */

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { listStoryDrops } from "../src/services/storyDrops.js";

const email = process.argv[2];
const limit = Number(process.argv[3] ?? 50);
if (!email) {
  console.error("usage: tsx scripts/story-drops.ts <email> [limit]");
  process.exit(1);
}

const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
if (!user) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

const drops = await listStoryDrops(user.id, limit);
if (drops.length === 0) console.log("no dropped cards");
for (const d of drops) {
  console.log(`\n[${d.createdAt.toISOString()}] ${d.kind}${d.subjectId != null ? ` #${d.subjectId}` : ""} · stage: ${d.stage}`);
  console.log(`  reasons: ${d.reasons.join("; ")}`);
  console.log(`  text:    ${d.text}`);
}
process.exit(0);
