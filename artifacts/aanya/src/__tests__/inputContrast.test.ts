/**
 * Input legibility guard (dark-mode invisible-typing bug, Aug 2026).
 *
 * Every Tailwind /opacity color compiles to color-mix(), and some Chromium
 * builds resolve color-mix against STALE custom-property values when
 * [data-mode] flips — typed input text rendered dark-on-dark in dark mode
 * while plain hsl(var()) colors themed correctly. The fix: input/textarea
 * text and placeholders use full-opacity token colors only. These guards
 * keep /NN modifiers from sneaking back onto typing surfaces, and pin the
 * base-layer safety net in index.css.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");

// Extract className strings that belong to <Input …>, <input …> or <textarea …>
// elements, tolerant of attributes spread over multiple lines.
function inputClassNames(src: string): string[] {
  // Attribute lists contain arrow functions ("=>"), so a [^>]* scan stops
  // early — instead take a generous window after each opening tag and pull
  // the first className out of it.
  const out: string[] = [];
  for (const m of src.matchAll(/<(?:Input|input|textarea)\b/g)) {
    const window = src.slice(m.index, m.index! + 900);
    const cls = window.match(/className=(?:\{`([^`]*)`\}|"([^"]*)")/s);
    if (cls) out.push(cls[1] ?? cls[2] ?? "");
  }
  return out;
}

describe("typing surfaces use full-opacity colors (no color-mix)", () => {
  for (const page of ["../pages/Chat.tsx", "../pages/AuthScreen.tsx"]) {
    it(`${page.replace("../pages/", "")}: no /NN text or placeholder colors on inputs`, () => {
      const classes = inputClassNames(read(page));
      expect(classes.length).toBeGreaterThan(0);
      for (const cls of classes) {
        expect(cls, `offending input classes: "${cls}"`).not.toMatch(/text-foreground\/\d+/);
        expect(cls, `offending input classes: "${cls}"`).not.toMatch(
          /placeholder:text-[a-z-]+\/\d+/,
        );
      }
    });
  }

  it("index.css keeps the solid-color base rule for inputs", () => {
    const css = read("../index.css");
    expect(css).toMatch(/input,\s*\n\s*textarea,\s*\n\s*select\s*\{\s*\n\s*color: hsl\(var\(--foreground\)\);/);
    expect(css).toMatch(/input::placeholder/);
  });
});
