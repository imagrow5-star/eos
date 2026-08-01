/**
 * Deterministic unit tests for the semantic-dedup building blocks
 * (services/memory/dedup.ts + dedupBackfill.ts). No DB, no network — the Haiku
 * call is injected as a stub so the orchestration, parsing, lexical pre-filter,
 * and merge planner are all pinned deterministically. The model's own semantic
 * judgement is exercised in production; here the stub stands in for it.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeTokens,
  lexicalOverlap,
  bestLexicalOverlap,
  parseDedupDecision,
  parseClusterDecision,
  findSemanticDuplicate,
  type DedupLlm,
} from "../services/memory/dedup.js";
import { planMerges, type MergeRow } from "../services/memory/dedupBackfill.js";
import type { SemanticCluster } from "../services/memory/dedup.js";

// ─── Lexical pre-filter ─────────────────────────────────────────────────────

describe("lexical overlap (cheap negative fast-path)", () => {
  it("drops stopwords when normalizing", () => {
    expect(normalizeTokens("I want to read the book")).toEqual(["read", "book"]);
  });

  it("scores clearly-unrelated items at 0 overlap", () => {
    expect(lexicalOverlap("read the book", "walk every morning")).toBe(0);
  });

  it("scores re-phrasings of the same thing above 0", () => {
    expect(lexicalOverlap("100 crores this year", "Year target is 100 crores")).toBeGreaterThan(0);
    expect(lexicalOverlap("read the book before sleep", "read the book before bed")).toBeGreaterThan(0);
  });

  it("bestLexicalOverlap finds the closest existing entry", () => {
    const best = bestLexicalOverlap("read the book before sleep", [
      { id: 1, content: "walk every morning" },
      { id: 2, content: "read the book before bed" },
    ]);
    expect(best).toBeGreaterThan(0);
  });
});

// ─── Response parsing ────────────────────────────────────────────────────────

describe("parseDedupDecision", () => {
  it("parses a positive decision", () => {
    const d = parseDedupDecision('{"is_duplicate": true, "matching_id": 7, "reasoning": "same revenue goal"}');
    expect(d).toEqual({ isDuplicate: true, matchingId: 7, reasoning: "same revenue goal" });
  });

  it("tolerates code fences and surrounding prose", () => {
    const d = parseDedupDecision(
      'Sure — here is the JSON:\n```json\n{"is_duplicate": true, "matching_id": 3, "reasoning": "bed vs sleep, same reading habit"}\n```',
    );
    expect(d.isDuplicate).toBe(true);
    expect(d.matchingId).toBe(3);
  });

  it("parses a negative decision and nulls the id", () => {
    const d = parseDedupDecision('{"is_duplicate": false, "matching_id": null, "reasoning": "different activities"}');
    expect(d).toEqual({ isDuplicate: false, matchingId: null, reasoning: "different activities" });
  });

  it("never reports a matching id when not a duplicate", () => {
    // Defensive: a confused model that says not-duplicate but still names an id.
    const d = parseDedupDecision('{"is_duplicate": false, "matching_id": 9, "reasoning": "x"}');
    expect(d.isDuplicate).toBe(false);
    expect(d.matchingId).toBeNull();
  });
});

describe("parseClusterDecision", () => {
  it("keeps only clusters with real duplicates", () => {
    const clusters = parseClusterDecision(
      '{"clusters": [{"canonical_id": 1, "duplicate_ids": [2, 3]}, {"canonical_id": 5, "duplicate_ids": []}]}',
    );
    expect(clusters).toEqual([{ canonicalId: 1, duplicateIds: [2, 3] }]);
  });

  it("drops a duplicate id equal to the canonical", () => {
    const clusters = parseClusterDecision('{"clusters": [{"canonical_id": 4, "duplicate_ids": [4, 6]}]}');
    expect(clusters).toEqual([{ canonicalId: 4, duplicateIds: [6] }]);
  });
});

// ─── findSemanticDuplicate orchestration (stubbed model) ─────────────────────

describe("findSemanticDuplicate", () => {
  const existing = [
    { id: 7, content: "Year target is 100 crores" },
    { id: 8, content: "read the book before bed" },
  ];

  it("identifies '100 crores this year' as a duplicate of the existing revenue goal", async () => {
    let called = 0;
    const llm: DedupLlm = async () => {
      called++;
      return '{"is_duplicate": true, "matching_id": 7, "reasoning": "same 100-crore goal"}';
    };
    const d = await findSemanticDuplicate("100 crores this year", existing, llm);
    expect(d.isDuplicate).toBe(true);
    expect(d.matchingId).toBe(7);
    expect(called).toBe(1);
  });

  it("identifies 'read the book before sleep' as a duplicate of 'before bed'", async () => {
    const llm: DedupLlm = async () => '{"is_duplicate": true, "matching_id": 8, "reasoning": "bed and sleep are the same"}';
    const d = await findSemanticDuplicate("read the book before sleep", existing, llm);
    expect(d.isDuplicate).toBe(true);
    expect(d.matchingId).toBe(8);
  });

  it("says an unrelated candidate is NOT a duplicate WITHOUT calling the model (0 overlap)", async () => {
    let called = 0;
    const llm: DedupLlm = async () => {
      called++;
      return '{"is_duplicate": true, "matching_id": 7}'; // would wrongly say dup if reached
    };
    const d = await findSemanticDuplicate("walk every morning", [{ id: 7, content: "read the book" }], llm);
    expect(d.isDuplicate).toBe(false);
    expect(called).toBe(0); // cheap negative fast-path — no Haiku spend
  });

  it("fails OPEN: a throwing model resolves to not-a-duplicate", async () => {
    const llm: DedupLlm = async () => {
      throw new Error("network down");
    };
    const d = await findSemanticDuplicate("100 crores this year", existing, llm);
    expect(d.isDuplicate).toBe(false);
  });

  it("rejects a hallucinated matching_id not present in the existing set", async () => {
    const llm: DedupLlm = async () => '{"is_duplicate": true, "matching_id": 999, "reasoning": "made up"}';
    const d = await findSemanticDuplicate("100 crores this year", existing, llm);
    expect(d.isDuplicate).toBe(false);
  });
});

// ─── Backfill merge planner ──────────────────────────────────────────────────

describe("planMerges", () => {
  const rows: MergeRow[] = [
    { id: 1, createdAt: new Date("2026-01-01"), timesReferenced: 2, lastReferencedAt: new Date("2026-03-01"), emotionalWeight: 0.4, userMarkedImportant: false },
    { id: 2, createdAt: new Date("2026-02-01"), timesReferenced: 3, lastReferencedAt: new Date("2026-05-01"), emotionalWeight: 0.9, userMarkedImportant: true },
    { id: 3, createdAt: new Date("2026-03-01"), timesReferenced: 1, lastReferencedAt: null, emotionalWeight: 0.1, userMarkedImportant: false },
    { id: 9, createdAt: new Date("2026-04-01"), timesReferenced: 5, lastReferencedAt: null, emotionalWeight: 0.2, userMarkedImportant: false },
  ];

  it("keeps the OLDEST row and folds counters/weights/flags into it", () => {
    const clusters: SemanticCluster[] = [{ canonicalId: 2, duplicateIds: [1, 3] }];
    const plans = planMerges(rows, clusters);
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    // Oldest of {1,2,3} is id 1 (Jan) — NOT the model's canonical (id 2).
    expect(p.keeperId).toBe(1);
    expect(p.deleteIds.sort()).toEqual([2, 3]);
    expect(p.timesReferenced).toBe(2 + 3 + 1); // summed
    expect(p.emotionalWeight).toBe(0.9); // max
    expect(p.userMarkedImportant).toBe(true); // OR
    expect(p.lastReferencedAt).toEqual(new Date("2026-05-01")); // latest
  });

  it("never merges a unique row (single-member clusters are dropped)", () => {
    const plans = planMerges(rows, [{ canonicalId: 9, duplicateIds: [] }]);
    expect(plans).toEqual([]);
  });

  it("ignores ids that aren't in the loaded rows", () => {
    const plans = planMerges(rows, [{ canonicalId: 1, duplicateIds: [2, 12345] }]);
    expect(plans[0]!.keeperId).toBe(1);
    expect(plans[0]!.deleteIds).toEqual([2]);
  });

  it("marks weight/important null for tables that don't have those columns", () => {
    const bare: MergeRow[] = [
      { id: 1, createdAt: new Date("2026-01-01"), timesReferenced: 1, lastReferencedAt: null },
      { id: 2, createdAt: new Date("2026-02-01"), timesReferenced: 4, lastReferencedAt: null },
    ];
    const plans = planMerges(bare, [{ canonicalId: 2, duplicateIds: [1] }]);
    expect(plans[0]!.keeperId).toBe(1);
    expect(plans[0]!.timesReferenced).toBe(5);
    expect(plans[0]!.emotionalWeight).toBeNull();
    expect(plans[0]!.userMarkedImportant).toBeNull();
  });
});
