import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

// ─── Reflection reports (periodic reflection feature) ─────────────────────────
// A layered, readable reflection the user can generate over a period (default
// weekly, or on demand). It is DERIVED content: the generator reads what the
// user already said — the same export payload memory-export uses
// (routes/account.ts fetchExportPayload) — and a cheap model (Haiku) summarises
// it into the layered report defined in services/reflection/generateReport.ts.
// Nothing new is captured here; this table only stores the finished report so
// the user can revisit, download, or delete it.
//
// The report body is stored encrypted at rest (same protection as the
// conversations it's built from), exactly like memory_feelings.feeling.
//
// ON DELETE CASCADE on user_id: a deleted account takes its reports with it
// even if a deletion path forgets to sweep this table (the sweep in
// routes/auth.ts still deletes it explicitly, matching the rest of the codebase).
export const reflectionReportsTable = pgTable("reflection_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  // The finished report as Markdown — the layered structure from the generator
  // (This period in short → Worth noticing → In your own words → A question to
  // sit with). Encrypted at rest.
  content: encryptedText("content", "reflection_reports.content").notNull(),
  // The window the report reflects on (inclusive start, exclusive-ish end —
  // whatever range was handed to fetchExportPayload). Stored so the UI can label
  // "your week of Aug 4–11" and so a scheduler can avoid double-covering a period.
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  // How it was triggered: "on_demand" (user pressed the button) or "auto" (the
  // weekly scheduled run). Plain text — no PII, safe to query in SQL.
  generatedBy: text("generated_by").notNull().default("on_demand"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertReflectionReportSchema = createInsertSchema(reflectionReportsTable).omit({ id: true });
export type InsertReflectionReport = z.infer<typeof insertReflectionReportSchema>;
export type ReflectionReport = typeof reflectionReportsTable.$inferSelect;
