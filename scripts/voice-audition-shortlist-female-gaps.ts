/**
 * voice-audition-shortlist-female-gaps — THROWAWAY read-only tool (NOT wired
 * into the app). Companion follow-up to voice-audition-shortlist.ts.
 *
 * The first run's French/German buckets were mixed-gender and skewed male (fr
 * came back all-male; de yielded only one companion-suitable female). This tool
 * re-queries JUST those two buckets with gender=female and a stricter
 * COMPANION-FIT selection: warm, conversational, natural voices — explicitly
 * filtering OUT narration / audiobook / trailer / character / news / agent-IVR
 * voices, which dominate the library and are wrong for a companion.
 *
 * Run (Render Shell has the key in env, like the first script):
 *   ELEVENLABS_API_KEY=... npx tsx scripts/voice-audition-shortlist-female-gaps.ts
 *   (optional) OUT=some/path.md to change the output file.
 *
 * Safety:
 *   • READ-ONLY — only GET /v1/shared-voices. No add-voice call. No app/schema
 *     /catalog changes.
 *   • The API key is read from process.env.ELEVENLABS_API_KEY, used only in the
 *     request header, and NEVER printed, logged, or written to the output.
 *   • If the key is absent, the tool stops immediately (no network call, no
 *     output file) rather than guessing.
 */

const API = "https://api.elevenlabs.io/v1/shared-voices";
const PAGE_SIZE = 100; // ElevenLabs max
const MAX_PAGES = 8; // female-only is a thinner slice — page a little deeper
const PER_BUCKET = 10;
const REQUEST_SPACING_MS = 250;

interface VerifiedLanguage {
  language?: string;
  model_id?: string;
  accent?: string;
  locale?: string;
  preview_url?: string;
}
interface SharedVoice {
  public_owner_id?: string;
  voice_id?: string;
  name?: string;
  accent?: string;
  gender?: string;
  age?: string;
  descriptive?: string;
  use_case?: string;
  category?: string;
  language?: string;
  locale?: string;
  description?: string;
  preview_url?: string;
  usage_character_count_1y?: number;
  cloned_by_count?: number;
  featured?: boolean;
  verified_languages?: VerifiedLanguage[];
}

interface Bucket {
  id: string;
  title: string;
  params: Record<string, string>;
  lang: string;
}

// gender=female is applied server-side; we double-check client-side too.
const BUCKETS: Bucket[] = [
  {
    id: "fr-female",
    title: "French (fr) — FEMALE, companion-fit",
    params: { language: "fr", gender: "female" },
    lang: "fr",
  },
  {
    id: "de-female",
    title: "German (de) — FEMALE, companion-fit",
    params: { language: "de", gender: "female" },
    lang: "de",
  },
];

// ─── Key handling — stop, don't guess ─────────────────────────────────────────
const KEY = process.env.ELEVENLABS_API_KEY?.trim();
if (!KEY) {
  console.error(
    "ELEVENLABS_API_KEY is not set in the environment.\n" +
      "This tool needs it to read the Voice Library. Set it and re-run:\n" +
      "  ELEVENLABS_API_KEY=... npx tsx scripts/voice-audition-shortlist-female-gaps.ts\n" +
      "(No network call was made and no output file was written.)",
  );
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(
  params: Record<string, string>,
  page: number,
): Promise<{ voices: SharedVoice[]; hasMore: boolean }> {
  const qs = new URLSearchParams({ ...params, page_size: String(PAGE_SIZE), page: String(page) });
  const res = await fetch(`${API}?${qs.toString()}`, {
    headers: { "xi-api-key": KEY as string, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`ElevenLabs rejected the API key (HTTP ${res.status}). Check ELEVENLABS_API_KEY. Aborting.`);
  }
  if (!res.ok) {
    let hint = "";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (body?.detail) hint = ` — ${JSON.stringify(body.detail).slice(0, 200)}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(`shared-voices request failed (HTTP ${res.status})${hint}`);
  }
  const data = (await res.json()) as { voices?: SharedVoice[]; has_more?: boolean };
  return { voices: data.voices ?? [], hasMore: Boolean(data.has_more) };
}

async function fetchBucket(bucket: Bucket): Promise<SharedVoice[]> {
  const out: SharedVoice[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { voices, hasMore } = await fetchPage(bucket.params, page);
    out.push(...voices);
    if (!hasMore || voices.length === 0) break;
    await sleep(REQUEST_SPACING_MS);
  }
  return out;
}

// ─── Native-fit + companion-fit + quality ─────────────────────────────────────

function verifiedIn(v: SharedVoice, lang: string): VerifiedLanguage | undefined {
  return (v.verified_languages ?? []).find((x) => (x.language ?? "").toLowerCase() === lang);
}
function previewFor(v: SharedVoice, lang: string): string {
  return verifiedIn(v, lang)?.preview_url ?? v.preview_url ?? "";
}

// Voices that are the WRONG shape for a companion — narration/performance/agent.
// Matched against use_case + descriptive + description (NOT the name, to avoid
// false positives on people's names).
const EXCLUDE_RE =
  /\b(narrat\w*|audio ?book|storytell\w*|trailer|charac\w*|animation|cartoon|villain|\bhero\b|gaming|video ?games?|news\b|anchor\b|announc\w*|documentary|advertis\w*|commercial|\bpromo\b|cinematic|\bepic\b|voice ?over|\bivr\b|\bagent\b|assistant\b|receptionist|telephon\w*)\b/i;

// Warm/conversational signals — the companion vibe we DO want.
const WARM_RE =
  /\b(warm|soft|gentle|calm|friendly|natural|casual|conversational|soothing|pleasant|kind|caring|sweet|comfort\w*|tender|relaxed|approachable|intimate|reassuring)\b/i;

function fitText(v: SharedVoice): string {
  return [v.use_case, v.descriptive, v.description, v.category].filter(Boolean).join(" ").toLowerCase();
}

/** Hard companion-fit gate: drop performance/narration/agent voices. */
function isCompanionFit(v: SharedVoice): boolean {
  if (EXCLUDE_RE.test(fitText(v))) return false;
  return true;
}

const CATEGORY_BONUS: Record<string, number> = { professional: 1_000_000, high_quality: 500_000 };

/** Warmth/conversational boost on top of the base quality proxy. */
function companionFitBoost(v: SharedVoice): number {
  let s = 0;
  const uc = (v.use_case ?? "").toLowerCase();
  if (uc.includes("conversation")) s += 400_000;
  if (uc.includes("social")) s += 150_000;
  if (uc.includes("informative") || uc.includes("educational")) s += 60_000;
  if (WARM_RE.test(fitText(v))) s += 120_000;
  return s;
}

function score(v: SharedVoice, lang: string): number {
  const cat = CATEGORY_BONUS[(v.category ?? "").toLowerCase()] ?? 0;
  const nativeBump = verifiedIn(v, lang) ? 250_000 : 0;
  const cloned = (v.cloned_by_count ?? 0) * 1000;
  const usage = Math.min((v.usage_character_count_1y ?? 0) / 1000, 200_000);
  return cat + nativeBump + companionFitBoost(v) + cloned + usage;
}

/** Personality-diverse top-N by "descriptive" so we span soft/bright/steady. */
function diverseTop(sorted: SharedVoice[], n: number): SharedVoice[] {
  const trait = (v: SharedVoice) => (v.descriptive || v.use_case || "").toLowerCase();
  const picked: SharedVoice[] = [];
  const seen = new Set<string>();
  for (const v of sorted) {
    if (picked.length >= n) break;
    const t = trait(v);
    if (t && seen.has(t)) continue;
    picked.push(v);
    if (t) seen.add(t);
  }
  if (picked.length < n) {
    const chosen = new Set(picked.map((v) => v.voice_id));
    for (const v of sorted) {
      if (picked.length >= n) break;
      if (!chosen.has(v.voice_id)) picked.push(v);
    }
  }
  return picked.slice(0, n);
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

function qualitySignal(v: SharedVoice, lang: string): string {
  const bits: string[] = [];
  if (typeof v.cloned_by_count === "number") bits.push(`${v.cloned_by_count.toLocaleString()} clones`);
  if (typeof v.usage_character_count_1y === "number")
    bits.push(`${Math.round(v.usage_character_count_1y / 1000).toLocaleString()}k chars/1y`);
  if (verifiedIn(v, lang)) bits.push("native-verified");
  return bits.length ? bits.join(", ") : "—";
}

function row(v: SharedVoice, lang: string): string {
  const preview = previewFor(v, lang);
  const previewCell = preview ? `[▶ listen](${preview})` : "—";
  const useCase = esc(v.use_case || "—");
  const desc = esc(v.description || v.descriptive || "");
  return `| ${[
    esc(v.name),
    `\`${esc(v.voice_id)}\``,
    `\`${esc(v.public_owner_id)}\``,
    esc(v.gender),
    esc([v.accent, v.locale].filter(Boolean).join(" / ") || "—"),
    esc(v.category),
    useCase,
    esc(qualitySignal(v, lang)),
    desc.length > 150 ? desc.slice(0, 147) + "…" : desc,
    previewCell,
  ].join(" | ")} |`;
}

function section(bucket: Bucket, picks: SharedVoice[], found: number, afterFit: number): string {
  const header =
    "| Name | voice_id | public_owner_id | Gender | Accent/Locale | Category | Use case | Usage/quality signal | Description | Preview URL |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = picks.map((v) => row(v, bucket.lang)).join("\n");
  const note =
    picks.length === 0
      ? "\n> ⚠️ **No companion-fit female candidates** survived filtering — genuinely thin here.\n"
      : picks.length < PER_BUCKET
        ? `\n> ⚠️ Only ${picks.length} companion-fit candidate(s) (target ${PER_BUCKET}) — thin bucket.\n`
        : "";
  return (
    `## ${bucket.title}\n\n` +
    `_${picks.length} shown · ${afterFit} companion-fit female of ${found} female returned by the library._\n${note}\n` +
    `${header}\n${rows}\n`
  );
}

async function main() {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const OUT = process.env.OUT || process.argv[2] || "voice-audition-shortlist-female-gaps.md";

  const sections: string[] = [];
  const summary: Array<{ bucket: string; female: number; companionFit: number; shown: number; thin?: string }> = [];

  for (const bucket of BUCKETS) {
    process.stderr.write(`Querying ${bucket.id} …\n`);
    const all = await fetchBucket(bucket);

    // De-dup, keep only real female rows (defensive — server already filtered).
    const seen = new Set<string>();
    const female = all.filter((v) => {
      if (!v.voice_id || seen.has(v.voice_id)) return false;
      seen.add(v.voice_id);
      return (v.gender ?? "").toLowerCase() === "female";
    });

    const fit = female.filter(isCompanionFit);
    const ranked = diverseTop([...fit].sort((a, b) => score(b, bucket.lang) - score(a, bucket.lang)), PER_BUCKET);

    sections.push(section(bucket, ranked, female.length, fit.length));
    summary.push({
      bucket: bucket.id,
      female: female.length,
      companionFit: fit.length,
      shown: ranked.length,
      thin: ranked.length < PER_BUCKET ? "THIN" : undefined,
    });
    await sleep(REQUEST_SPACING_MS);
  }

  const stamp = new Date().toISOString();
  const summaryTable =
    "| Bucket | Female returned | Companion-fit | Shown | Note |\n| --- | --- | --- | --- | --- |\n" +
    summary.map((s) => `| ${s.bucket} | ${s.female} | ${s.companionFit} | ${s.shown} | ${s.thin ?? ""} |`).join("\n");

  const doc =
    `# Voice audition shortlist — French & German FEMALE gaps\n\n` +
    `_Generated ${stamp} from the ElevenLabs shared Voice Library (GET /v1/shared-voices). ` +
    `Read-only audition aid — nothing was added to the account._\n\n` +
    `Re-run of the fr/de buckets with **gender=female** and a **companion-fit** filter: warm, ` +
    `conversational, natural voices only — narration / audiobook / trailer / character / news / ` +
    `agent-IVR voices are filtered out. Preview links prefer each voice's native-language verified ` +
    `sample. To add a chosen voice later you need both its \`voice_id\` and \`public_owner_id\`.\n\n` +
    `## Summary\n\n${summaryTable}\n\n---\n\n` +
    sections.join("\n---\n\n");

  await fs.writeFile(path.resolve(process.cwd(), OUT), doc, "utf8");
  process.stderr.write(`\nWrote ${OUT}\n`);
  console.log(JSON.stringify({ output: OUT, generatedAt: stamp, buckets: summary }, null, 2));
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
