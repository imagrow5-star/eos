/**
 * Privacy audit Tier 3 — regression guardrail (static source scan, no DB).
 *
 * After Tier 3, NO server-side log call may emit a raw `userId`. This test
 * walks the api-server and daily-email source trees at test time and fails if
 * it finds a log call carrying a raw userId field — so the pattern can never be
 * re-introduced. It also checks that every file using hashUserIdForLog imports
 * it.
 *
 * One documented exception: the UNCLEAR "voice-call failed in browser" site
 * (routes/voice-agent.ts) is left for separate review (its browser-supplied
 * message/detail need judgment, not a mechanical hash) — allow-listed below.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // .../api-server/src/__tests__
const API_SRC = path.resolve(here, "..");
const ARTIFACTS = path.resolve(here, "../../..");
const DEMAIL_SRC = path.join(ARTIFACTS, "daily-email", "src");

// Allow-listed UNCLEAR site (separate future review — not a Tier 3 target).
const ALLOW = [/voice-call failed in browser/];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      out.push(...walk(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const FILES = [...walk(API_SRC), ...walk(DEMAIL_SRC)];

// A log call (pino logger, req.log, the daily-email log()/logErr() wrappers, or
// console.*) whose payload object carries a top-level `userId` field. `[\s\S]`
// so multi-line calls are caught; one level of nested braces is tolerated.
const LEAK_PATTERNS = [
  /(?:logger|req\.log)\.(?:info|warn|error|debug|fatal|trace)\(\s*\{(?:[^{}]|\{[^{}]*\})*?\buserId\b/g,
  /\b(?:log|logErr)\((?:[^;{}]|\{[^{}]*\})*?\{(?:[^{}]|\{[^{}]*\})*?\buserId\b/g,
  /console\.(?:log|error|warn|info|debug)\((?:[^;{}]|\{[^{}]*\})*?\buserId\b/g,
];

describe("Tier 3 guardrail — no raw userId in any server-side log", () => {
  it("finds no log call emitting a raw userId (except the allow-listed UNCLEAR site)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, "utf8");
      for (const re of LEAK_PATTERNS) {
        for (const m of text.matchAll(re)) {
          // Test the allow-list against the whole statement (the match itself
          // stops at `userId`, before the message string).
          const window = text.slice(m.index, (m.index ?? 0) + 300);
          if (ALLOW.some((a) => a.test(window))) continue;
          const snippet = m[0].replace(/\s+/g, " ").slice(0, 120);
          const line = text.slice(0, m.index).split("\n").length;
          violations.push(`${path.relative(ARTIFACTS, file)}:${line}  ${snippet}`);
        }
      }
    }
    expect(violations, `raw-userId log sites found:\n${violations.join("\n")}`).toEqual([]);
  });

  it("every source file that calls hashUserIdForLog also imports it", () => {
    const missing: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, "utf8");
      const usesHelper = /\bhashUserIdForLog\(/.test(text);
      const importsHelper = /import\s*\{\s*hashUserIdForLog\s*\}\s*from/.test(text);
      // the helper files define it themselves (no import needed)
      const isHelper = /hashUserIdForLog\.ts$|logHash\.ts$/.test(file);
      if (usesHelper && !importsHelper && !isHelper) {
        missing.push(path.relative(ARTIFACTS, file));
      }
    }
    expect(missing, `files using the helper without importing it:\n${missing.join("\n")}`).toEqual([]);
  });

  it("scans a meaningful number of files (sanity — the walk actually ran)", () => {
    expect(FILES.length).toBeGreaterThan(60);
  });
});
