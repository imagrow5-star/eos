/**
 * The 18+ date-of-birth gate (lib/basics.ts parseAgeText / ageFromParts).
 *
 * The gate refuses under-18 and, crucially, is exact when a full date is
 * given: a 17-year-old whose birth YEAR alone rounds up to 18 is caught. It
 * never resolves to an adult on a bare year at the boundary — it asks for the
 * date. The parse result carries only age + year; month and day are used for
 * the cutoff and then discarded, so nothing downstream can store a full DOB.
 */
import { describe, it, expect } from "vitest";
import { parseAgeText, ageFromParts } from "../lib/basics.js";

// Fixed "now" so the tests don't drift: 15 June 2026.
const NOW = new Date("2026-06-15T12:00:00Z");

describe("ageFromParts", () => {
  it("subtracts a year when the birthday hasn't happened yet", () => {
    expect(ageFromParts(2000, 6, 14, NOW)).toBe(26); // yesterday's date → had birthday
    expect(ageFromParts(2000, 6, 15, NOW)).toBe(26); // today → counts
    expect(ageFromParts(2000, 6, 16, NOW)).toBe(25); // tomorrow → not yet
    expect(ageFromParts(2000, 12, 1, NOW)).toBe(25); // later this year → not yet
  });
});

describe("parseAgeText — exact when a date is given", () => {
  it("catches a 17-year-old whose birth year alone would round up to 18", () => {
    // Born Dec 2008: in June 2026 they are 17. Year-only math (2026-2008=18)
    // would have passed them; the date must not.
    expect(parseAgeText("12/12/2008", NOW)).toEqual({ kind: "under18" });
    expect(parseAgeText("5 December 2008", NOW)).toEqual({ kind: "under18" });
  });

  it("passes an adult whose birthday has already come this year", () => {
    expect(parseAgeText("01/02/2008", NOW)).toMatchObject({ kind: "age", age: 18, birthYear: 2008 });
    expect(parseAgeText("3 March 2000", NOW)).toMatchObject({ kind: "age", age: 26, birthYear: 2000 });
  });

  it("reads day-first, and uses a value over 12 as the day", () => {
    // 13/05/2000 — 13 can only be the day → 13 May 2000.
    expect(parseAgeText("13/05/2000", NOW)).toMatchObject({ kind: "age", birthYear: 2000 });
    // 05/13/2000 — 13 in the second slot is the day → 13 May 2000.
    expect(parseAgeText("05/13/2000", NOW)).toMatchObject({ kind: "age", birthYear: 2000 });
  });

  it("carries only age and year — never a month or day — in the result", () => {
    const r = parseAgeText("9 September 2001", NOW);
    expect(Object.keys(r).sort()).toEqual(["age", "birthYear", "kind"]);
  });
});

describe("parseAgeText — bare year, plain age, and the boundary", () => {
  it("asks for the date when a bare year could be 17 or 18", () => {
    // Born 2008, no month: in June 2026 they are 17 or 18 depending on birthday.
    expect(parseAgeText("2008", NOW)).toEqual({ kind: "needsDate" });
  });

  it("resolves a bare year when it's unambiguous either way", () => {
    expect(parseAgeText("2009", NOW)).toEqual({ kind: "under18" }); // at most 17
    expect(parseAgeText("2007", NOW)).toMatchObject({ kind: "age", birthYear: 2007 }); // at least 18
  });

  it("takes a plain stated age at face value", () => {
    expect(parseAgeText("24", NOW)).toMatchObject({ kind: "age", age: 24 });
    expect(parseAgeText("I'm 17", NOW)).toEqual({ kind: "under18" });
    expect(parseAgeText("18", NOW)).toMatchObject({ kind: "age", age: 18 });
  });

  it("keeps the legacy band chips and rejects nonsense", () => {
    expect(parseAgeText("26-35", NOW)).toEqual({ kind: "band", band: "26-35" });
    expect(parseAgeText("banana", NOW)).toEqual({ kind: "invalid" });
  });
});
