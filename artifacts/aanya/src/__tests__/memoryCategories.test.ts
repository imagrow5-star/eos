import { describe, it, expect } from "vitest";
import { groupFacts, factsForCategory, categoryLabel, PROMOTE_AT } from "../lib/memoryCategories";

let nextId = 1;
const fact = (category: string, text = `${category} ${nextId}`) => ({ id: nextId++, fact: text, category });

describe("groupFacts", () => {
  it("keeps the five base rows in order and hides empty ones", () => {
    const rows = groupFacts([fact("life", "Lives in Leeds"), fact("person", "Sister Maya"), fact("person", "Dan from work")]);
    expect(rows.map((r) => r.id)).toEqual(["person", "life"]);
    expect(rows[0]).toMatchObject({ label: "People", count: 2, preview: "Sister Maya" });
  });

  it("folds the hidden categories so nothing is invisible", () => {
    const rows = groupFacts([
      fact("interest", "Loves early swims"),
      fact("routine", "Coffee at six"),
      fact("work", "Nurse on nights"),
      fact("value", "Honesty first"),
      fact("soother", "Rain on the roof"),
      fact("life", "Lives in Leeds"),
      fact("something-new", "Unknown category"),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["preference", "life"]);
    expect(rows[0]).toMatchObject({ label: "Preferences", count: 1, preview: "Loves early swims" });
    expect(rows[1]!.count).toBe(6);
    expect(rows[1]!.facts.map((f) => f.fact)).toContain("Unknown category");
    // Every fact is somewhere.
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(7);
  });

  it("a hidden category with enough facts gets its own row instead of being buried", () => {
    const routines = Array.from({ length: PROMOTE_AT }, (_, i) => fact("routine", `Routine ${i}`));
    const rows = groupFacts([fact("life", "Lives in Leeds"), ...routines, fact("work", "Nurse on nights")]);
    expect(rows.map((r) => r.id)).toEqual(["life", "routine"]);
    expect(rows.find((r) => r.id === "routine")).toMatchObject({ label: "Routines", count: PROMOTE_AT, preview: "Routine 0" });
    expect(rows.find((r) => r.id === "life")!.count).toBe(2); // life + the folded work fact
  });

  it("the preview is the first fact the API returned (newest first)", () => {
    const rows = groupFacts([fact("event", "Newest"), fact("event", "Older")]);
    expect(rows[0]!.preview).toBe("Newest");
  });
});

describe("factsForCategory / categoryLabel", () => {
  it("returns the same folding for one screen, or null for an empty or unknown category", () => {
    const facts = [fact("preference", "Tea, not coffee"), fact("interest", "Crosswords")];
    expect(factsForCategory(facts, "preference")?.facts.map((f) => f.fact)).toEqual(["Tea, not coffee", "Crosswords"]);
    expect(factsForCategory(facts, "person")).toBeNull();
    expect(factsForCategory(facts, "nope")).toBeNull();
  });

  it("labels", () => {
    expect(categoryLabel("goal")).toBe("Hopes");
    expect(categoryLabel("soother")).toBe("What helps");
    expect(categoryLabel("feelings")).toBe("How things have felt");
    expect(categoryLabel("nope")).toBeNull();
  });
});
