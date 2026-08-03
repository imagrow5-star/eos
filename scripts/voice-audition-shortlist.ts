/**
 * voice-audition-shortlist — THROWAWAY read-only tool (NOT wired into the app).
 *
 * Queries the ElevenLabs shared Voice Library (GET /v1/shared-voices) and writes
 * an audition shortlist (voice-audition-shortlist.md) so the founder can click
 * through preview URLs and pick native, high-quality companion voices per
 * language. It NEVER adds a voice to the account and touches no app code/schema.
 *
 * Run:
 *   ELEVENLABS_API_KEY=... npx tsx scripts/voice-audition-shortlist.ts
 *   (optional) OUT=some/path.md to change the output file.
 *
 * Safety:
 *   • READ-ONLY — only GET requests to /v1/shared-voices. No add-voice call.
 *   • The API key is read from process.env.ELEVENLABS_API_KEY, used only in the
 *     request header, and NEVER printed, logged, or written to the output file.
 *   • If the key is absent, the tool stops immediately (no network call, no
 *     output file) rather than guessing.
 */

const API = "https://api.elevenlabs.io/v1/shared-voices";
const PAGE_SIZE = 100; // ElevenLabs max
const MAX_PAGES = 6; // cap per query (≤600 candidates) — plenty to rank ~10 from
const PER_BUCKET = 10; // target shortlist size per bucket
const REQUEST_SPACING_MS = 250; // be polite to the API

// ─── Shape of a shared-voice row (defensive — all optional) ───────────────────
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
  category?: string; // "professional" | "high_quality" | "famous" | ...
  language?: string;
  locale?: string;
  description?: string;
  preview_url?: string;
  usage_character_count_1y?: number;
  usage_character_count_7d?: number;
  cloned_by_count?: number;
  rate?: number;
  free_users_allowed?: boolean;
  featured?: boolean;
  verified_languages?: VerifiedLanguage[];
}

interface Bucket {
  id: string;
  title: string;
  /** Extra query params merged onto the base request. */
  params: Record<string, string>;
  /** Target language for native-fit + preview selection. */
  lang: string;
  /** Portuguese gets special pt-PT vs pt-BR labelling + prioritisation. */
  portuguese?: boolean;
}

const BUCKETS: Bucket[] = [
  { id: "de", title: "German (de) — mixed gender", params: { language: "de" }, lang: "de" },
  { id: "fr", title: "French (fr) — mixed gender", params: { language: "fr" }, lang: "fr" },
  { id: "it", title: "Italian (it) — mixed gender", params: { language: "it" }, lang: "it" },
  {
    id: "pt",
    title: "Portuguese — European (pt-PT) prioritised, pt-BR labelled",
    params: { language: "pt" },
    lang: "pt",
    portuguese: true,
  },
  { id: "en-in", title: "English — Indian accent (fills IN=0)", params: { language: "en", accent: "indian" }, lang: "en" },
  { id: "en-ca", title: "English — Canadian accent (fills CA=0)", params: { language: "en", accent: "canadian" }, lang: "en" },
  {
    id: "en-au-f",
    title: "English — Australian FEMALE (fills AU female gap)",
    params: { language: "en", accent: "australian", gender: "female" },
    lang: "en",
  },
  {
    id: "en-ie-f",
    title: "English — Irish FEMALE (fills IE female gap)",
    params: { language: "en", accent: "irish", gender: "female" },
    lang: "en",
  },
];

// ─── Key handling — stop, don't guess ─────────────────────────────────────────
const KEY = process.env.ELEVENLABS_API_KEY?.trim();
if (!KEY) {
  console.error(
    "ELEVENLABS_API_KEY is not set in the environment.\n" +
      "This tool needs it to read the Voice Library. Set it and re-run:\n" +
      "  ELEVENLABS_API_KEY=... npx tsx scripts/voice-audition-shortlist.ts\n" +
      "(No network call was made and no output file was written.)",
  );
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One page of shared voices for a set of query params. Throws on auth errors. */
async function fetchPage(
  params: Record<string, string>,
  page: number,
): Promise<{ voices: SharedVoice[]; hasMore: boolean }> {
  const qs = new URLSearchParams({ ...params, page_size: String(PAGE_SIZE), page: String(page) });
  const res = await fetch(`${API}?${qs.toString()}`, {
    headers: { "xi-api-key": KEY as string, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `ElevenLabs rejected the API key (HTTP ${res.status}). Check ELEVENLABS_API_KEY. Aborting.`,
    );
  }
  if (!res.ok) {
    // Non-auth error: surface status only (body may be large; never the key).
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

/** Page through a bucket's query up to MAX_PAGES (or until has_more is false). */
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

// ─── Ranking + native-fit helpers ─────────────────────────────────────────────

/** Does the voice have a VERIFIED entry for the bucket language? Strong native
 *  signal — the owner had it verified speaking that language. */
function verifiedIn(v: SharedVoice, lang: string): VerifiedLanguage | undefined {
  return (v.verified_languages ?? []).find((x) => (x.language ?? "").toLowerCase() === lang);
}

/** Best preview URL for the bucket language: the verified-language preview
 *  (native pronunciation) if present, else the top-level preview. */
function previewFor(v: SharedVoice, lang: string): string {
  return verifiedIn(v, lang)?.preview_url ?? v.preview_url ?? "";
}

const CATEGORY_BONUS: Record<string, number> = { professional: 1_000_000, high_quality: 500_000 };

/** Quality score: popularity (cloned_by_count) is the main proxy, with a large
 *  bump for professional/high-quality category and a nudge for native-verified. */
function qualityScore(v: SharedVoice, lang: string): number {
  const cloned = v.cloned_by_count ?? 0;
  const usage = v.usage_character_count_1y ?? 0;
  const cat = CATEGORY_BONUS[(v.category ?? "").toLowerCase()] ?? 0;
  const nativeBump = verifiedIn(v, lang) ? 250_000 : 0;
  return cat + nativeBump + cloned * 1000 + Math.min(usage / 1000, 200_000);
}

/** pt-PT vs pt-BR (or unknown) from locale/accent/verified metadata. */
function portugueseVariant(v: SharedVoice): "pt-PT" | "pt-BR" | "pt-?" {
  const hay = [
    v.locale,
    v.accent,
    ...(v.verified_languages ?? []).flatMap((x) => [x.locale, x.accent]),
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
    .join(" ");
  if (/pt-?pt|portugal|european|europe/.test(hay)) return "pt-PT";
  if (/pt-?br|brazil|brasil/.test(hay)) return "pt-BR";
  return "pt-?";
}

/**
 * Personality-diverse top-N: after sorting by quality, greedily prefer voices
 * with a not-yet-seen "descriptive" (falling back to use_case) so the shortlist
 * spans soft/bright/steady rather than ten near-identical picks; then fill any
 * remaining slots by pure quality.
 */
function diverseTop(sorted: SharedVoice[], n: number, lang: string): SharedVoice[] {
  const trait = (v: SharedVoice) => (v.descriptive || v.use_case || "").toLowerCase();
  const picked: SharedVoice[] = [];
  const seenTraits = new Set<string>();
  for (const v of sorted) {
    if (picked.length >= n) break;
    const t = trait(v);
    if (t && seenTraits.has(t)) continue;
    picked.push(v);
    if (t) seenTraits.add(t);
  }
  if (picked.length < n) {
    const chosen = new Set(picked.map((v) => v.voice_id));
    for (const v of sorted) {
      if (picked.length >= n) break;
      if (!chosen.has(v.voice_id)) picked.push(v);
    }
  }
  void lang;
  return picked.slice(0, n);
}

// ─── Markdown emitters ────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

function accentVariant(v: SharedVoice, bucket: Bucket): string {
  if (bucket.portuguese) return portugueseVariant(v);
  const parts = [v.accent, v.locale].filter(Boolean).map(String);
  return parts.length ? Array.from(new Set(parts)).join(" / ") : "—";
}

function qualitySignal(v: SharedVoice, lang: string): string {
  const bits: string[] = [];
  if (typeof v.cloned_by_count === "number") bits.push(`${v.cloned_by_count.toLocaleString()} clones`);
  if (typeof v.usage_character_count_1y === "number")
    bits.push(`${Math.round(v.usage_character_count_1y / 1000).toLocaleString()}k chars/1y`);
  if (verifiedIn(v, lang)) bits.push("native-verified");
  return bits.length ? bits.join(", ") : "—";
}

function tableRow(v: SharedVoice, bucket: Bucket): string {
  const preview = previewFor(v, bucket.lang);
  const previewCell = preview ? `[▶ listen](${preview})` : "—";
  const desc = esc(v.description || v.descriptive || v.use_case || "");
  return [
    esc(v.name),
    `\`${esc(v.voice_id)}\``,
    `\`${esc(v.public_owner_id)}\``,
    esc(v.gender),
    esc(accentVariant(v, bucket)),
    esc(v.category),
    esc(qualitySignal(v, bucket.lang)),
    desc.length > 160 ? desc.slice(0, 157) + "…" : desc,
    previewCell,
  ].join(" | ");
}

function bucketSection(bucket: Bucket, picks: SharedVoice[], totalFound: number): string {
  const header =
    "| Name | voice_id | public_owner_id | Gender | Accent/Variant | Category | Usage/quality signal | Description | Preview URL |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = picks.map((v) => `| ${tableRow(v, bucket)} |`).join("\n");
  const note =
    picks.length === 0
      ? "\n> ⚠️ **No candidates returned** for this bucket — the library is genuinely thin here.\n"
      : picks.length < PER_BUCKET
        ? `\n> ⚠️ Only ${picks.length} candidate(s) found (fewer than the ${PER_BUCKET} target) — thin bucket.\n`
        : "";
  let extra = "";
  if (bucket.portuguese) {
    const ptPT = picks.filter((v) => portugueseVariant(v) === "pt-PT").length;
    const ptBR = picks.filter((v) => portugueseVariant(v) === "pt-BR").length;
    const ptU = picks.length - ptPT - ptBR;
    extra = `\n> European (pt-PT): ${ptPT} · Brazilian (pt-BR): ${ptBR} · unlabelled (pt-?): ${ptU}. ` +
      `pt-PT rows are listed first; pt-BR are included (labelled) because the library is deeper in Brazilian.\n`;
  }
  return `## ${bucket.title}\n\n_${picks.length} shown of ${totalFound} returned by the library._\n${note}${extra}\n${header}\n${rows}\n`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const OUT = process.env.OUT || process.argv[2] || "voice-audition-shortlist.md";

  const sections: string[] = [];
  const summary: Array<{ bucket: string; found: number; shown: number; thinNote?: string }> = [];

  for (const bucket of BUCKETS) {
    process.stderr.write(`Querying ${bucket.id} …\n`);
    const all = await fetchBucket(bucket);

    // De-dup by voice_id, drop rows missing a voice_id or preview.
    const seen = new Set<string>();
    const usable = all.filter((v) => {
      if (!v.voice_id || seen.has(v.voice_id)) return false;
      seen.add(v.voice_id);
      return true;
    });

    let ranked: SharedVoice[];
    if (bucket.portuguese) {
      // Prioritise pt-PT: sort pt-PT first (by quality), then pt-?, then pt-BR.
      const rank = { "pt-PT": 0, "pt-?": 1, "pt-BR": 2 } as const;
      ranked = [...usable].sort((a, b) => {
        const ra = rank[portugueseVariant(a)];
        const rb = rank[portugueseVariant(b)];
        if (ra !== rb) return ra - rb;
        return qualityScore(b, bucket.lang) - qualityScore(a, bucket.lang);
      });
      // Ensure pt-PT candidates are surfaced even if lower quality: take the best
      // pt-PT first, then fill the rest of the slots from the global ranking.
      const ptPT = ranked.filter((v) => portugueseVariant(v) === "pt-PT");
      const rest = ranked.filter((v) => portugueseVariant(v) !== "pt-PT");
      const picks = [...diverseTop(ptPT, PER_BUCKET, bucket.lang)];
      for (const v of diverseTop(rest, PER_BUCKET, bucket.lang)) {
        if (picks.length >= PER_BUCKET) break;
        picks.push(v);
      }
      ranked = picks;
    } else {
      const sorted = [...usable].sort((a, b) => qualityScore(b, bucket.lang) - qualityScore(a, bucket.lang));
      ranked = diverseTop(sorted, PER_BUCKET, bucket.lang);
    }

    sections.push(bucketSection(bucket, ranked, usable.length));
    summary.push({
      bucket: bucket.id,
      found: usable.length,
      shown: ranked.length,
      thinNote: usable.length < PER_BUCKET ? "THIN" : undefined,
    });
    await sleep(REQUEST_SPACING_MS);
  }

  // Build the file. Timestamp is stamped at write time (throwaway tool — fine).
  const stamp = new Date().toISOString();
  const summaryTable =
    "| Bucket | Candidates found | Shown | Note |\n| --- | --- | --- | --- |\n" +
    summary.map((s) => `| ${s.bucket} | ${s.found} | ${s.shown} | ${s.thinNote ?? ""} |`).join("\n");

  const doc =
    `# Voice audition shortlist\n\n` +
    `_Generated ${stamp} from the ElevenLabs shared Voice Library (GET /v1/shared-voices). ` +
    `Read-only audition aid — nothing was added to the account._\n\n` +
    `**How to use:** click the **Preview URL** in each row to listen. Preview links prefer the ` +
    `voice's *native-language* verified sample where one exists. To later add a chosen voice to the ` +
    `account you need both its \`voice_id\` and \`public_owner_id\`.\n\n` +
    `Ranking proxy: professional/high-quality category, native-language verification, then ` +
    `\`cloned_by_count\` (how many users cloned it) and 1-year usage. Picks are personality-diversified ` +
    `by the library's "descriptive" trait so each bucket spans distinct styles.\n\n` +
    `## Summary\n\n${summaryTable}\n\n---\n\n` +
    sections.join("\n---\n\n");

  await fs.writeFile(path.resolve(process.cwd(), OUT), doc, "utf8");

  // Machine-readable summary to stdout (safe — no key, no PII).
  process.stderr.write(`\nWrote ${OUT}\n`);
  console.log(JSON.stringify({ output: OUT, generatedAt: stamp, buckets: summary }, null, 2));
}

main().catch((err) => {
  // Surface the message only — our errors never include the key.
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
