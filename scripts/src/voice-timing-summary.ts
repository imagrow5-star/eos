/**
 * Voice turn timing summary (voice audit, PR 1).
 *
 * Turns a log export into medians per stage, so tuning starts from numbers
 * rather than feel. Feed it the JSON-lines the api-server logs (Render's
 * "Download logs", or a `render logs` pipe); every other line is ignored.
 *
 *   pnpm --filter @workspace/scripts voice-timing-summary < render-logs.txt
 *   pnpm --filter @workspace/scripts voice-timing-summary render-logs.txt
 *
 * It groups the three timing lines (see docs/voice-timing.md):
 *   "voice turn timing"          — server, per CLM turn (greeting / real)
 *   "voice turn timing (client)" — browser, per reply (what the person waits)
 *   "demo voice turn timing"     — the landing-page demo's server turns
 * and prints, per numeric field: count, median, p90, max. Numbers only go in,
 * numbers only come out — the lines never carry message text.
 */

import fs from "node:fs";
import readline from "node:readline";

const MESSAGES = ["voice turn timing", "voice turn timing (client)", "demo voice turn timing"] as const;

type Row = Record<string, unknown>;

function parseLine(line: string): Row | null {
  // Render prefixes each line with a timestamp; the JSON starts at the first brace.
  const at = line.indexOf("{");
  if (at < 0) return null;
  try {
    const obj = JSON.parse(line.slice(at)) as Row;
    return typeof obj.msg === "string" ? obj : null;
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function summarize(rows: Row[]): string[] {
  const fields = new Map<string, number[]>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "number" && Number.isFinite(v) && !["time", "pid", "level", "turn"].includes(k)) {
        const arr = fields.get(k) ?? [];
        arr.push(v);
        fields.set(k, arr);
      }
    }
  }
  const out: string[] = [];
  const width = Math.max(10, ...[...fields.keys()].map((k) => k.length));
  out.push(`  ${"field".padEnd(width)}  ${"n".padStart(6)}  ${"median".padStart(8)}  ${"p90".padStart(8)}  ${"max".padStart(8)}`);
  for (const [k, values] of [...fields.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...values].sort((a, b) => a - b);
    out.push(
      `  ${k.padEnd(width)}  ${String(sorted.length).padStart(6)}  ${String(percentile(sorted, 50)).padStart(8)}  ${String(percentile(sorted, 90)).padStart(8)}  ${String(sorted[sorted.length - 1]).padStart(8)}`,
    );
  }
  // Boolean fields: how often true (crisis, degraded, frozenHit, …).
  const flags = new Map<string, { t: number; n: number }>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "boolean" && k !== "greeting") {
        const f = flags.get(k) ?? { t: 0, n: 0 };
        f.n += 1;
        if (v) f.t += 1;
        flags.set(k, f);
      }
    }
  }
  for (const [k, f] of [...flags.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`  ${k.padEnd(width)}  true ${f.t}/${f.n}`);
  }
  return out;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const input = file ? fs.createReadStream(file, "utf8") : process.stdin;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const groups = new Map<string, Row[]>();
  let total = 0;
  for await (const line of rl) {
    total += 1;
    const row = parseLine(line);
    if (!row) continue;
    const msg = row.msg as string;
    if (!(MESSAGES as readonly string[]).includes(msg)) continue;
    // Server lines split into greeting and real turns; the client line is
    // already one row per reply.
    const serverLine = msg !== "voice turn timing (client)";
    const key = `${msg}${serverLine ? (row.greeting === true ? " — greeting" : " — real turn") : ""}`;
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }
  if (groups.size === 0) {
    console.log(`No voice timing lines found in ${total} line(s). Expected JSON lines whose "msg" is one of: ${MESSAGES.map((m) => `"${m}"`).join(", ")}.`);
    return;
  }
  for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`\n${key}  (${rows.length} turn${rows.length === 1 ? "" : "s"})`);
    for (const l of summarize(rows)) console.log(l);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
