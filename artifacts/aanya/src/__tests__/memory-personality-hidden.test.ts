/**
 * Guard test: the "Her read on you" personality-signals section is hidden from
 * the Memory Manifest until Sprint 4 (Personality Synthesis).
 *
 * The aanya suite runs in a node environment with no jsdom/testing-library, so
 * (like the api-server Tier 3 log guardrail) this asserts against the page
 * SOURCE rather than a rendered DOM: it proves the signal-rendering JSX is gone
 * and every other Memory section still renders. If Sprint 4 restores a
 * personality section, update this guard.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_PAGE = path.resolve(here, "../pages/Memory.tsx");
const source = fs.readFileSync(MEMORY_PAGE, "utf8");

describe("Memory Manifest — personality signals hidden until Sprint 4", () => {
  it("no longer renders the raw personality-signals grid", () => {
    // These bindings only ever appeared inside the "Her read on you" grid, so
    // their absence proves the section no longer renders.
    expect(source).not.toContain("signal.observedCount");
    expect(source).not.toContain("signal.isActive");
    expect(source).not.toContain("signals.map(");
    // The old "Confirmed"/"Observing" status pills are gone too.
    expect(source).not.toContain('"Confirmed" : "Observing"');
  });

  it("has no placeholder line about still learning — the facts below it said otherwise", () => {
    expect(source).not.toContain("still learning who you are");
  });

  it("keeps every other Memory section intact", () => {
    // The category rows now come from lib/memoryCategories (five base rows
    // plus the folded / promoted hidden ones); the page renders them as
    // LinkRows without a count on the heading.
    expect(source).toContain("groupFacts(facts)");
    expect(source).toContain("Things {companionName} knows");
    expect(source).not.toMatch(/Things \{companionName\} knows[^\n]*count=/);
    expect(source).toContain("Reset my memory (dev)"); // founder-gated control untouched
  });

  it("still fetches personality signals (data model untouched — UI-only hide)", () => {
    expect(source).toContain("useGetPersonalitySignals");
  });
});
