/**
 * Weekly review — marker labels and the story date range (components/week/weekLabel.ts).
 * Pins the prototype's receding pattern: This week · Last week · August · 14 Aug.
 */

import { describe, it, expect } from "vitest";
import { formatWeekRange, weekLabels } from "../components/week/weekLabel";

// Tuesday 8 September 2026. This week's Monday is the 7th.
const NOW = new Date(2026, 8, 8, 14, 0, 0);

const spans = (...starts: string[]) =>
  starts.map((weekStart) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 6);
    return { weekStart, weekEnd: d.toISOString().slice(0, 10) };
  });

describe("weekLabels", () => {
  it("reproduces the prototype's row: This week · Last week · August · 14 Aug", () => {
    expect(weekLabels(spans("2026-09-07", "2026-08-31", "2026-08-17", "2026-08-10"), NOW)).toEqual([
      "This week",
      "Last week",
      "August",
      "10 Aug",
    ]);
  });

  it("names a month only the first time it appears; later weeks in it get dates", () => {
    expect(weekLabels(spans("2026-08-24", "2026-08-17", "2026-08-10", "2026-07-27"), NOW)).toEqual([
      "August",
      "17 Aug",
      "10 Aug",
      "July",
    ]);
  });

  it("'Last week' is the week immediately before the current one, whatever month it is in", () => {
    // Now: Tuesday 1 September 2026 → this Monday is 31 Aug, last Monday 24 Aug.
    const now = new Date(2026, 8, 1, 9, 0, 0);
    expect(weekLabels(spans("2026-08-31", "2026-08-24", "2026-08-17"), now)).toEqual([
      "This week",
      "Last week",
      "August",
    ]);
  });

  it("a Sunday-night story for the week ending today is still 'This week'", () => {
    const sundayNight = new Date(2026, 8, 13, 22, 30, 0); // Sunday 13 Sept
    expect(weekLabels(spans("2026-09-07"), sundayNight)).toEqual(["This week"]);
  });

  it("returns nothing for nothing", () => {
    expect(weekLabels([], NOW)).toEqual([]);
  });
});

describe("formatWeekRange", () => {
  it("collapses a single-month week", () => {
    expect(formatWeekRange({ weekStart: "2026-09-07", weekEnd: "2026-09-13" })).toBe("7–13 September");
    expect(formatWeekRange({ weekStart: "2026-09-02", weekEnd: "2026-09-08" })).toBe("2–8 September");
  });

  it("spells both months across a boundary", () => {
    expect(formatWeekRange({ weekStart: "2026-08-31", weekEnd: "2026-09-06" })).toBe("31 August – 6 September");
  });
});
