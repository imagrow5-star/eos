import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { encryptedBoolean, encryptedText } from "../encryptedColumns";

// ─── Sealed notes — the chapter's closing ritual ─────────────────────────────
// At the end of a chapter the user may (never must) leave one sentence for
// next-week's self: either free-form or an answer to Eos's gentle prediction
// prompt. The note stays sealed until a later chapter resolves it.
//
// Safety invariants enforced by the engine (not just prompts):
// - crisis language is detected at WRITE time (crisisFlagged) and triggers an
//   immediate caring response in the API reply — never a seven-day timer;
// - crisis-flagged notes are NEVER quoted back verbatim; their resolution is a
//   fixed warm template that references the note without repeating it;
// - the user can always "keep it sealed another week" (deferrals) so a hard
//   day never forces a confrontation with last week's words.

export const sealedNotesTable = pgTable(
  "sealed_notes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    chapterId: integer("chapter_id").notNull(), // chapter at whose end this was written
    weekStart: text("week_start").notNull(), // that chapter's analyzed week (YYYY-MM-DD)
    kind: text("kind").notNull(), // free | prediction
    prompt: encryptedText("prompt", "sealed_notes.prompt"), // Eos's prediction question when kind = prediction — encrypted at rest
    text: encryptedText("text", "sealed_notes.text").notNull(), // the user's own sentence — quoted verbatim at resolution — encrypted at rest
    // Encrypted at rest (review finding): the note text beside it was
    // encrypted while this flag sat queryable in plaintext — a DB dump could
    // list crisis-flagged users with one WHERE clause. Tradeoff: the flag is
    // no longer SQL-filterable; nothing filters on it today (all readers load
    // rows via drizzle and branch in app code — keep it that way). Stored as
    // encrypted text "true"/"false"; legacy boolean columns are converted by
    // the boot migration (see dataEncryptionMigration.ts).
    crisisFlagged: encryptedBoolean("crisis_flagged", "sealed_notes.crisis_flagged")
      .notNull()
      .default(sql`'false'`),
    status: text("status").notNull().default("sealed"), // sealed | resolved
    deferrals: integer("deferrals").notNull().default(0), // "keep it sealed another week" count
    resolvedChapterId: integer("resolved_chapter_id"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("sealed_notes_chapter").on(t.chapterId)], // one note per chapter
);

export type SealedNote = typeof sealedNotesTable.$inferSelect;
