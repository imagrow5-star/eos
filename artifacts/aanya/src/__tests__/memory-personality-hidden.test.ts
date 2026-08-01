/**
 * Guard test: the "Her read on you" personality-signals section is hidden from
 * the Memory Manifest until Sprint 4 (Personality Synthesis).
 *
 * The aanya suite runs in a node environment with no jsdom/testing-library, so
 * (like the api-server Tier 3 log guardrail) this asserts against the page
 * SOURCE rather than a rendered DOM: it proves the signal-rendering JSX is gone,
 * the soft placeholder took its place, and every other Memory section still
 * renders. If Sprint 4 restores a personality section, update this guard.
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

  it("shows the soft placeholder in the section's old slot", () => {
    expect(source).toContain("still learning who you are");
    expect(source).toContain("this section will show what she's understood");
  });

  it("documents why it's hidden (Sprint 4 rationale)", () => {
    expect(source).toContain("Hidden until Sprint 4 (Personality Synthesis)");
  });

  it("keeps every other Memory section intact", () => {
    // Fact categories still present…
    for (const label of ["Preferences", "People", "Moments", "Hopes", "Life"]) {
      expect(source).toContain(`label: "${label}"`);
    }
    // …and the surrounding sections still render.
    expect(source).toContain("Things she knows");
    expect(source).toContain("Reset my memory (dev)"); // founder-gated control untouched
  });

  it("still fetches personality signals (data model untouched — UI-only hide)", () => {
    expect(source).toContain("useGetPersonalitySignals");
  });
});
