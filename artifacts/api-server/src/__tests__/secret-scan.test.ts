// ─── Secret scan: no key-shaped values may live in tracked files ──────────────
// Regression guard for a real incident: encryption/VAPID keys were once
// written into .replit (a git-tracked file) via env-var config instead of the
// secrets store. Keys in tracked files survive in git history and checkpoints
// and must be treated as burned. This test fails the suite the moment any
// key-shaped literal reappears in ANY tracked file, so the mistake can't ship
// quietly again.
//
// Three layers:
//   1. .replit env sections — a sensitive-NAMED var with a long quoted literal
//      is an instant failure (the exact incident signature), entropy ignored.
//   2. Sensitive-named assignments with long high-entropy quoted literals in
//      any tracked file.
//   3. Vendor key fingerprints (Stripe/OpenAI/Resend/AWS/Slack/GitHub/Google
//      live-key prefixes, PEM private-key blocks, signed JWTs) anywhere.
//
// Findings are reported as file:line + variable/pattern + value LENGTH only —
// never the value itself.
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

const SKIP_FILES = new Set(["pnpm-lock.yaml"]);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|mp[34]|webm|wav|pdf|zip|stl|glb|gltf)$/i;
// Runtime-generated or documented-format examples that scanners must ignore.
const PLACEHOLDER = /(example|placeholder|your[-_ ]|changeme|dummy|fake|redacted|masked|<[^>]+>|\$\{|\bprocess\.env\b|\bimport\.meta\b)/i;

const SENSITIVE_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
// name = "long-literal"  or  name: 'long-literal'
const ASSIGNMENT = /([A-Za-z0-9_.-]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)[A-Za-z0-9_.-]*)\s*[:=]\s*["'`]([A-Za-z0-9+/_=-]{24,})["'`]/gi;

const VENDOR_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai-style sk- key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "stripe live secret", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { name: "resend key", re: /\bre_[A-Za-z0-9]{20,}\b/ },
  { name: "aws access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack token", re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google api key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "github token", re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "signed JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Shannon entropy in bits/char — high-entropy strings look like key material. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

type Finding = { file: string; line: number; what: string; valueLength: number };

function scan(): Finding[] {
  const tracked = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !SKIP_FILES.has(f.split("/").pop() ?? "") && !SKIP_EXT.test(f));

  const findings: Finding[] = [];
  for (const file of tracked) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      continue; // deleted-but-staged or unreadable — nothing to scan
    }
    if (text.includes("\u0000")) continue; // binary
    const lines = text.split("\n");

    // this scanner's own pattern definitions would otherwise match themselves
    const isSelf = file.endsWith("__tests__/secret-scan.test.ts");

    lines.forEach((line, i) => {
      // Layer 1: .replit env sections — sensitive name + long quoted literal.
      if (file === ".replit") {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.{16,})"\s*$/);
        if (m && SENSITIVE_NAME.test(m[1]!) && !PLACEHOLDER.test(m[2]!)) {
          findings.push({ file, line: i + 1, what: `.replit env var ${m[1]}`, valueLength: m[2]!.length });
          return;
        }
      }

      if (isSelf) return;

      // Layer 2: sensitive-named assignment of a long high-entropy literal.
      for (const m of line.matchAll(ASSIGNMENT)) {
        const value = m[2]!;
        if (PLACEHOLDER.test(line)) continue;
        if (entropy(value) < 3.5) continue; // prose/identifiers score lower than key material
        findings.push({ file, line: i + 1, what: `assignment to ${m[1]}`, valueLength: value.length });
      }

      // Layer 3: vendor fingerprints anywhere in the line.
      for (const { name, re } of VENDOR_PATTERNS) {
        const m = line.match(re);
        if (m && !PLACEHOLDER.test(line)) {
          findings.push({ file, line: i + 1, what: name, valueLength: m[0]!.length });
        }
      }
    });
  }
  return findings;
}

describe("secret scan (tracked files)", () => {
  it("no key-shaped values appear in any git-tracked file", () => {
    const findings = scan();
    const report = findings
      .map((f) => `  ${f.file}:${f.line} — ${f.what} [${f.valueLength} chars, value withheld]`)
      .join("\n");
    expect(findings, `key-shaped values found in tracked files — move them to Replit Secrets and rotate them:\n${report}\n`).toEqual([]);
  });
});
