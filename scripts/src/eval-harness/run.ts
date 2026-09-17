/**
 * Eval harness — replays the reconstructed scenarios against the /api/eval/turn
 * endpoint and reports which regression markers are gone and which remain.
 *
 * It drives each scenario multi-turn (the endpoint is stateless, so the
 * harness carries the history forward), collects every Eos reply, scans them
 * for the markers (markers.ts), and prints a per-scenario and per-category
 * summary. A full JSON transcript is written for inspection.
 *
 * Config (env):
 *   EVAL_BASE_URL   default https://eoscompanion.com
 *   EVAL_API_KEY    required — the bearer key set on the web service
 *   EVAL_OUT        default ./eval-harness-run.json
 *
 * Run:  EVAL_API_KEY=… pnpm --filter @workspace/scripts exec tsx ./src/eval-harness/run.ts
 *
 * Note: this needs a real model behind the endpoint. Against a server in
 * keyless mock mode the replies are canned and the markers are meaningless.
 */
import { writeFileSync } from "node:fs";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { scanReply, type MarkerHit, type MarkerCategory } from "./markers.js";

const BASE_URL = (process.env.EVAL_BASE_URL ?? "https://eoscompanion.com").replace(/\/$/, "");
const API_KEY = process.env.EVAL_API_KEY ?? "";
const OUT = process.env.EVAL_OUT ?? "./eval-harness-run.json";
const ENDPOINT = `${BASE_URL}/api/eval/turn`;

interface TurnRecord {
  user: string;
  reply: string;
  stage: number;
  crisisActive: boolean;
  flags: { bannedComfort: string[] };
  hits: MarkerHit[];
}
interface ScenarioRecord {
  id: number;
  name: string;
  turns: TurnRecord[];
  hits: MarkerHit[];
}

async function evalTurn(body: unknown): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for turn: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function runScenario(s: Scenario): Promise<ScenarioRecord> {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  const turns: TurnRecord[] = [];
  for (let i = 0; i < s.turns.length; i += 1) {
    const message = s.turns[i]!;
    const data = await evalTurn({
      message,
      history,
      ...(s.profile ? { profile: s.profile } : {}),
      ...(s.memory ? { memory: s.memory } : {}),
    });
    const reply: string = data.reply ?? "";
    const hits = scanReply(reply, i);
    turns.push({
      user: message,
      reply,
      stage: data.stage,
      crisisActive: Boolean(data.crisis?.active),
      flags: data.flags ?? { bannedComfort: [] },
      hits,
    });
    history.push({ role: "user", content: message }, { role: "assistant", content: reply });
  }
  return { id: s.id, name: s.name, turns, hits: turns.flatMap((t) => t.hits) };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("EVAL_API_KEY is not set. Set it to the web service's key and re-run.");
    process.exit(2);
  }
  console.error(`Running ${SCENARIOS.length} scenarios against ${ENDPOINT}\n`);

  const records: ScenarioRecord[] = [];
  for (const s of SCENARIOS) {
    process.stderr.write(`  [${s.id}] ${s.name} … `);
    try {
      const rec = await runScenario(s);
      records.push(rec);
      const n = rec.hits.length;
      process.stderr.write(n === 0 ? "clean\n" : `${n} marker hit(s)\n`);
    } catch (err) {
      process.stderr.write(`ERROR: ${(err as Error).message}\n`);
      records.push({ id: s.id, name: s.name, turns: [], hits: [] });
    }
  }

  // Per-category rollup: which scenarios still trip each marker category.
  const byCategory: Record<MarkerCategory, number[]> = { lockout: [], combative: [], rule_disclosure: [], banned_comfort: [] };
  for (const rec of records) {
    const cats = new Set(rec.hits.map((h) => h.category));
    for (const c of cats) byCategory[c].push(rec.id);
  }

  console.log("\n=== Regression markers by category (scenarios still tripping them) ===");
  for (const c of Object.keys(byCategory) as MarkerCategory[]) {
    const ids = byCategory[c];
    console.log(`  ${c.padEnd(16)} ${ids.length === 0 ? "GONE — none" : `remains in ${ids.join(", ")}`}`);
  }

  console.log("\n=== Per scenario ===");
  for (const rec of records) {
    const tag = rec.hits.length === 0 ? "clean" : rec.hits.map((h) => `${h.category}@t${h.turnIndex}`).join(", ");
    console.log(`  [${String(rec.id).padStart(2)}] ${rec.name.slice(0, 52).padEnd(52)} ${tag}`);
    for (const h of rec.hits) console.log(`        ${h.category} (${h.fix}) — "${h.excerpt}"`);
  }

  writeFileSync(OUT, JSON.stringify({ endpoint: ENDPOINT, at: new Date().toISOString(), records }, null, 2));
  console.log(`\nFull transcript written to ${OUT}`);

  const totalHits = records.reduce((n, r) => n + r.hits.length, 0);
  console.log(`\nTotal marker hits across all scenarios: ${totalHits}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
