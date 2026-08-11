/**
 * Pure unit tests for reflection export formatting (Phase 2) — no DB, no HTTP.
 * Covers format normalisation, filenames, the Markdown→plain-text conversion,
 * and that the PDF renderer produces a real, non-trivial PDF document.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeFormat,
  reflectionContentType,
  reflectionExportFilename,
  reflectionToPlainText,
  reflectionToPdf,
} from "../services/reflection/exportReport.js";

const SAMPLE = `**This period, in short**
This week kept circling two things: work and your brother Sam.

**Worth noticing**
- You said you want to **start running again**.
- Dana came up twice this week.

**In your own words**
> she presented it like it was hers and I just sat there feeling invisible.

**A question to sit with**
Want to talk about what makes picking up the phone feel hard right now?`;

describe("format normalisation + filenames", () => {
  it("maps aliases to the three supported formats", () => {
    expect(normalizeFormat("md")).toBe("markdown");
    expect(normalizeFormat("markdown")).toBe("markdown");
    expect(normalizeFormat("MD")).toBe("markdown");
    expect(normalizeFormat("pdf")).toBe("pdf");
    expect(normalizeFormat("txt")).toBe("txt");
    expect(normalizeFormat(undefined)).toBe("txt"); // safe default
    expect(normalizeFormat("weird")).toBe("txt");
  });

  it("uses the right content type + extension per format", () => {
    const d = new Date("2026-08-11T09:00:00Z");
    expect(reflectionContentType("markdown")).toContain("text/markdown");
    expect(reflectionContentType("txt")).toContain("text/plain");
    expect(reflectionContentType("pdf")).toBe("application/pdf");
    expect(reflectionExportFilename("markdown", d)).toBe("eos-reflection-20260811.md");
    expect(reflectionExportFilename("txt", d)).toBe("eos-reflection-20260811.txt");
    expect(reflectionExportFilename("pdf", d)).toBe("eos-reflection-20260811.pdf");
  });
});

describe("Markdown → plain text", () => {
  it("strips emphasis markers but keeps the words and structure", () => {
    const txt = reflectionToPlainText(SAMPLE);
    // No stray Markdown markers.
    expect(txt).not.toContain("**");
    expect(txt).not.toMatch(/^>/m);
    // Words preserved.
    expect(txt).toContain("start running again");
    expect(txt).toContain("feeling invisible");
    // Headings upcased, bullets bulleted, quotes quoted.
    expect(txt).toContain("THIS PERIOD, IN SHORT");
    expect(txt).toContain("• You said you want to start running again.");
    expect(txt).toContain('"she presented it like it was hers');
  });
});

describe("Markdown → PDF", () => {
  it("produces a real, non-trivial PDF document", async () => {
    const pdf = await reflectionToPdf({
      content: SAMPLE,
      periodStart: new Date("2026-08-04T00:00:00Z"),
      periodEnd: new Date("2026-08-11T00:00:00Z"),
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    // PDF magic header + EOF marker → a structurally complete document.
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-6).toString("latin1")).toContain("%%EOF");
    // Not an empty shell.
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
