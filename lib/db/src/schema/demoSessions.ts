import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

// ─── Landing-page demo sessions ───────────────────────────────────────────────
// One row per demo run on the public landing page. Records WHEN, WHICH kind
// (voice today; text rows arrive with the demo logging step), HOW LONG, and
// HOW it ended — never a word of what was said. There is no user: the demo
// has no account, and this table has no user_id on purpose.
//
// The voice rows also enforce the voice demo's protections:
//   • one voice demo per IP per UTC day — ip_hash is a keyed hash of the
//     visitor's address (lib/secrets.ts "demo-ip"), never the address itself;
//   • the global daily spend cap — the sum of `seconds` since midnight UTC,
//     against the budget DEMO_VOICE_DAILY_CAP_USD buys at the per-minute rate.
// A voice row is written at call start with the full minute reserved, and
// settled to the real duration when the call ends; a call that never reports
// its end stays at the full reservation (the safe direction).

export const demoSessionsTable = pgTable("demo_sessions", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // "voice" | "text"
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  // Reserved at start (the demo's full length), settled at end.
  seconds: integer("seconds").notNull(),
  // "ended" (the person hung up), "limit" (the minute ran out), "failed"
  // (never connected — does not count against the person), null while live.
  endedReason: text("ended_reason"),
  ipHash: text("ip_hash"),
});

export type DemoSession = typeof demoSessionsTable.$inferSelect;
