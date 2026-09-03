/**
 * Hume Octave TTS probe — Stage 0 of the ElevenLabs removal.
 *
 * Answers, with real API responses instead of assumptions:
 *  1. Can Hume TTS synthesize per-message audio with our four curated call
 *     voices? (→ "Listen" survives the ElevenLabs removal)
 *  2. What's the blocking latency per request? (Listen is user-initiated,
 *     so ~1-2s is fine; tens of seconds is not)
 *  3. Does the response carry word/char TIMESTAMPS or alignment data?
 *     (→ decides whether word-synced captions survive or degrade to
 *     sentence-level. The script doesn't assume the schema: it scans the
 *     raw response for timestamp-ish keys and prints what it finds.)
 *  4. Does it speak SPANISH well? (one Spanish sample on each gender's
 *     default voice — listen to the saved files yourself)
 *
 * Run LOCALLY (the API key never leaves your machine):
 *
 *   HUME_API_KEY=... pnpm --filter @workspace/scripts hume-tts-probe
 *
 * Audio lands in ./hume-tts-probe-out/ — open the files and listen.
 * If the API rejects the request shape, the full status + body is printed:
 * paste that back and the request gets fixed against the real error.
 */

import fs from "node:fs";
import path from "node:path";

const apiKey = process.env.HUME_API_KEY?.trim();
if (!apiKey) {
  console.error("Set HUME_API_KEY (Hume dashboard → API keys). See the file header.");
  process.exit(1);
}

const TTS_URL = "https://api.hume.ai/v0/tts";
const OUT_DIR = path.resolve("hume-tts-probe-out");

// The curated call voices (artifacts/api-server/src/services/hume.ts).
const PROBES: Array<{ slug: string; voiceId: string; text: string }> = [
  {
    slug: "kora-en",
    voiceId: "59cfc7ab-e945-43de-ad1a-471daa379c67",
    text: "Hey, it's me. I read what you wrote earlier, and I just wanted to say: that took courage.",
  },
  {
    slug: "asmr-woman-en",
    voiceId: "aeaaf1f8-fe31-49ae-893d-c744e5207bc2",
    text: "Hey, it's me. I read what you wrote earlier, and I just wanted to say: that took courage.",
  },
  {
    slug: "comforting-male-en",
    voiceId: "99d2cb9c-9011-4ead-8734-641656d3df66",
    text: "Hey, it's me. I read what you wrote earlier, and I just wanted to say: that took courage.",
  },
  {
    slug: "soft-male-en",
    voiceId: "b152864b-6720-496a-9d18-eaadb31516ee",
    text: "Hey, it's me. I read what you wrote earlier, and I just wanted to say: that took courage.",
  },
  // Spanish sample on each gender's default — the es "Listen" story.
  {
    slug: "kora-es",
    voiceId: "59cfc7ab-e945-43de-ad1a-471daa379c67",
    text: "Hola, soy yo. Leí lo que escribiste antes y solo quería decirte: eso requirió valentía.",
  },
  {
    slug: "comforting-male-es",
    voiceId: "99d2cb9c-9011-4ead-8734-641656d3df66",
    text: "Hola, soy yo. Leí lo que escribiste antes y solo quería decirte: eso requirió valentía.",
  },
];

/** Walk the response for keys that look like timing/alignment data. */
function findTimestampKeys(value: unknown, trail = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    if (value.length > 0) findTimestampKeys(value[0], `${trail}[0]`, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/timestamp|alignment|word|char|timing|offset/i.test(k)) found.push(`${trail}.${k}`);
      findTimestampKeys(v, `${trail}.${k}`, found);
    }
  }
  return found;
}

/** Find the audio payload wherever it lives; returns decoded bytes. */
function findAudioBase64(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findAudioBase64(v);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(audio|audio_base64|data)$/i.test(k) && typeof v === "string" && v.length > 1000) return v;
      const hit = findAudioBase64(v);
      if (hit) return hit;
    }
  }
  return null;
}

/** Compact shape sketch of a response so unknown schemas are still legible. */
function sketch(value: unknown, depth = 0): string {
  if (depth > 4) return "…";
  if (Array.isArray(value)) return `[${value.length}× ${value.length ? sketch(value[0], depth + 1) : ""}]`;
  if (value && typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (typeof v === "string") return `${k}: str(${v.length})`;
      if (typeof v === "number" || typeof v === "boolean") return `${k}: ${v}`;
      return `${k}: ${sketch(v, depth + 1)}`;
    });
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

async function probeOne(p: (typeof PROBES)[number]): Promise<{
  slug: string; ok: boolean; ms: number; bytes: number; timestampKeys: string[];
}> {
  const started = Date.now();
  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { "X-Hume-Api-Key": apiKey!, "Content-Type": "application/json" },
    body: JSON.stringify({
      utterances: [{ text: p.text, voice: { id: p.voiceId, provider: "HUME_AI" } }],
    }),
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    console.error(`\n✗ ${p.slug}: HTTP ${res.status} after ${ms}ms`);
    console.error(`  body: ${(await res.text()).slice(0, 2000)}`);
    return { slug: p.slug, ok: false, ms, bytes: 0, timestampKeys: [] };
  }

  const body = (await res.json()) as unknown;
  const totalMs = Date.now() - started;
  console.log(`\n✓ ${p.slug}: HTTP 200 in ${totalMs}ms`);
  console.log(`  response shape: ${sketch(body).slice(0, 1200)}`);

  const timestampKeys = findTimestampKeys(body);
  console.log(
    timestampKeys.length
      ? `  timing-ish keys found: ${timestampKeys.join(", ")}`
      : "  NO timing/alignment keys found in the response",
  );

  const b64 = findAudioBase64(body);
  let bytes = 0;
  if (b64) {
    const buf = Buffer.from(b64, "base64");
    bytes = buf.byteLength;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${p.slug}.mp3`);
    fs.writeFileSync(file, buf);
    console.log(`  audio: ${bytes} bytes → ${file} (saved as .mp3 — rename if the header disagrees)`);
  } else {
    console.log("  no audio payload found — see the response shape above");
  }
  return { slug: p.slug, ok: true, ms: totalMs, bytes, timestampKeys };
}

const results: Awaited<ReturnType<typeof probeOne>>[] = [];
for (const p of PROBES) {
  try {
    results.push(await probeOne(p));
  } catch (err) {
    console.error(`\n✗ ${p.slug}: request failed — ${String(err)}`);
    results.push({ slug: p.slug, ok: false, ms: 0, bytes: 0, timestampKeys: [] });
  }
}

console.log("\n─── Stage 0 TTS summary ─────────────────────────────");
for (const r of results) {
  console.log(
    `  ${r.ok ? "✓" : "✗"} ${r.slug.padEnd(20)} ${String(r.ms).padStart(6)}ms  ${String(r.bytes).padStart(8)}B  timestamps: ${r.timestampKeys.length ? "YES" : "no"}`,
  );
}
console.log("\nNow LISTEN to the files in hume-tts-probe-out/ — especially the -es ones.");
process.exit(results.every((r) => r.ok) ? 0 : 2);
