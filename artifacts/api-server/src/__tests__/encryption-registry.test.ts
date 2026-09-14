/**
 * Security review follow-up: the encryption registry cannot drift.
 *
 * `SPECS` (services/dataEncryptionMigration.ts) drives two things: the boot
 * sweep that encrypts legacy plaintext rows, and the key-rotation engine
 * (services/dataKeyRotation.ts) that re-keys every ciphertext OLD → NEW.
 * Rotation only visits the columns listed there. Five encrypted columns
 * (stories.fragment, stories.cards, story_drops.text,
 * reflection_reports.content, profile.original_user_name) were added to the
 * schema without being added to SPECS — so a rotation would have left them
 * under the old key and they would have become unreadable the day that key
 * was retired.
 *
 * `ENCRYPTED_COLUMNS` (lib/db) is filled in by the column constructors
 * themselves as the schema loads, so it is the ground truth. This test:
 *   • fails on any column encrypted in the schema but absent from SPECS
 *     (rotation would skip it), and any column in SPECS the schema does not
 *     encrypt (the sweep would encrypt something the ORM reads as plaintext);
 *   • checks the kinds agree, so the engines use the right shape;
 *   • against the real database, checks every SPECS table, id column and
 *     column exists with the expected on-disk type — a typo here would make
 *     the boot migration crash on the first deploy.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { ENCRYPTED_COLUMNS } from "@workspace/db";
import { SPECS } from "../services/dataEncryptionMigration.js";

const DB = Boolean(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const specEntries = SPECS.flatMap((s) => s.cols.map((c) => ({ ...c, table: s.table, idCol: s.idCol })));

describe("encryption registry", () => {
  it("SPECS lists exactly the columns the schema encrypts", () => {
    const schemaAads = ENCRYPTED_COLUMNS.map((c) => c.aad).sort();
    const specAads = specEntries.map((c) => c.aad).sort();
    expect(new Set(schemaAads).size).toBe(schemaAads.length); // no duplicate registrations
    const missingFromSpecs = schemaAads.filter((a) => !specAads.includes(a));
    const notInSchema = specAads.filter((a) => !schemaAads.includes(a));
    expect({ missingFromSpecs, notInSchema }).toEqual({ missingFromSpecs: [], notInSchema: [] });
    // The five columns the review found are the ones that must never vanish again.
    for (const aad of [
      "stories.fragment",
      "stories.cards",
      "story_drops.text",
      "reflection_reports.content",
      "profile.original_user_name",
    ]) {
      expect(specAads).toContain(aad);
    }
  });

  it("every SPECS entry names the column its AAD says, with the schema's kind", () => {
    const byAad = new Map(ENCRYPTED_COLUMNS.map((c) => [c.aad, c.kind]));
    for (const c of specEntries) {
      expect(c.aad, `${c.table}.${c.name}`).toBe(`${c.table}.${c.name}`);
      expect(byAad.get(c.aad), c.aad).toBe(c.kind);
    }
  });

  it.skipIf(!DB)("every SPECS table, id column and column exists in the database with the expected type", async () => {
    const wantType = { text: "text", jsonb: "jsonb", textarray: "ARRAY" } as const;
    for (const c of specEntries) {
      const { rows } = await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
        [c.table, [c.name, c.idCol]],
      );
      const idRow = rows.find((r) => r.column_name === c.idCol);
      const colRow = rows.find((r) => r.column_name === c.name);
      expect(idRow, `${c.table}.${c.idCol} (id column)`).toBeDefined();
      expect(colRow?.data_type, `${c.table}.${c.name}`).toBe(wantType[c.kind]);
    }
  });
});
