/**
 * voice-add-curated — Phase 1.5. WRITES the curated shortlist voices into the
 * ElevenLabs account so Phase 2 can wire them into the app. NOT wired into the
 * app here.
 *
 * Flow (safety-first):
 *   1. GET /v1/user/subscription  → read the voice-slot limit.
 *   2. GET /v1/voices             → current custom-voice count + idempotency.
 *   3. Pre-flight cap check: if (used + voices-to-add) would EXCEED the limit,
 *      STOP and report — never partially add.
 *   4. POST /v1/voices/add/{public_owner_id}/{voice_id} for each not-yet-present
 *      voice, named "Eos <Lang> <Gender> — <Name>". The response's voice_id is
 *      the new account voice id usable in the app.
 *   5. Report: limit, how many added/skipped/failed, and each new account voice_id.
 *
 * Idempotent: a voice already in the account (matched by its source voice_id via
 * `sharing.original_voice_id`, or by our exact name) is skipped, and its existing
 * account voice_id is reported.
 *
 * Run (Render Shell has the key in env):
 *   ELEVENLABS_API_KEY=... npx tsx scripts/voice-add-curated.ts
 *   DRY_RUN=1 to do the checks + print the plan WITHOUT adding anything.
 *
 * Safety: ELEVENLABS_API_KEY is read from env, used only in the request header,
 * and NEVER printed/logged/committed. Stops immediately (no writes) if absent.
 */

const BASE = "https://api.elevenlabs.io";
const REQUEST_SPACING_MS = 400;

interface Curated {
  lang: string; // de | fr | it | pt | en-IN | en-CA | en-AU | en-IE
  gender: "F" | "M";
  name: string;
  owner: string; // public_owner_id
  voiceId: string; // source (shared) voice_id
}

const VOICES: Curated[] = [
  { lang: "de", gender: "F", name: "Leoni Vergara", owner: "b11ba57b5815bf861c2cb764605fd53a9544948008706505e87a2765ac4b5717", voiceId: "pBZVCk298iJlHAcHQwLr" },
  { lang: "de", gender: "M", name: "Jorin", owner: "f3f897a61160636d75727e7548be11b829432bc12cff72a7d1e12f837ad02604", voiceId: "wloRHjPaKZv3ucH7TQOT" },
  { lang: "fr", gender: "F", name: "Juniper", owner: "64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e", voiceId: "aMSt68OGf4xUZAnLpTU8" },
  { lang: "fr", gender: "M", name: "Adrien", owner: "b01d096c1d3c905a07c4eacdf5dbf7223c1dfda6c83388343b9ffe128d7f5262", voiceId: "TTtB1x9U8PF0Vgf20IAP" },
  { lang: "it", gender: "F", name: "Violetta", owner: "136391b37c76c590e5a8337fee0ade3148d010535925031b132ae20221553dc6", voiceId: "gfKKsLN1k0oYYN9n2dXX" },
  { lang: "it", gender: "M", name: "MarcoTrox", owner: "d0bc74494e98081c4e15ba13dc421de4c9112aa6b7715616e49e2abad7b7a8b6", voiceId: "W71zT1VwIFFx3mMGH2uZ" },
  { lang: "pt", gender: "F", name: "Mariza", owner: "76915474520321db2027457dd5a7c76c586bc0ce4a7b33c2df8fa6e99dacbe3e", voiceId: "zKjRewuiqTkXNUVAMwat" },
  { lang: "pt", gender: "M", name: "Francisco", owner: "ce5368c1ca535550012e6d4efef9a9870c45658630d801d0a4214587f2d94dc2", voiceId: "WsQeRzWJvoDvhPPJj5r7" },
  { lang: "en-IN", gender: "F", name: "Sia", owner: "7398804d9eaf2f463899a907587c33a390591775784f87857b6d0e1e4e3e66f6", voiceId: "oO7sLA3dWfQXsKeSAjpA" },
  { lang: "en-IN", gender: "M", name: "Aashish", owner: "0095caaaf402dd7559e7c298c47fad1ba7e5af296bc37a8c07f1607a1ce4792f", voiceId: "RpiHVNPKGBg7UmgmrKrN" },
  { lang: "en-CA", gender: "F", name: "Jenna", owner: "499c08008bc2b1d8cd3b700c9b91d5a0eb2a3ac8b7a50646a4cfcf4dd903e692", voiceId: "TgnhEILA8UwUqIMi20rp" },
  { lang: "en-CA", gender: "M", name: "Chris Heyez", owner: "6e86211e105edd6552ad00d5f6baa7334823c09b31138ea73e388994ae59d8ac", voiceId: "6rr4jpS124uCLNtgVdAk" },
  { lang: "en-AU", gender: "F", name: "Emma", owner: "94f03704b477b84c140c5569ba231544d4de6b7d7d4a3df569700a4c0b4a340b", voiceId: "56bWURjYFHyYyVf490Dp" },
  { lang: "en-IE", gender: "F", name: "Maeve", owner: "e6bf2e8aeee8562f5c239a15738788e01362e7f7496cc01319969fe2f00d5197", voiceId: "kOvUpYLYS0rKGldsKcD1" },
];

function targetName(v: Curated): string {
  return `Eos ${v.lang} ${v.gender} — ${v.name}`;
}

// ─── Key handling — stop, don't guess ─────────────────────────────────────────
const KEY = process.env.ELEVENLABS_API_KEY?.trim();
if (!KEY) {
  console.error(
    "ELEVENLABS_API_KEY is not set in the environment.\n" +
      "This tool writes voices to the account and needs the key. Set it and re-run:\n" +
      "  ELEVENLABS_API_KEY=... npx tsx scripts/voice-add-curated.ts\n" +
      "(No network call was made and nothing was added.)",
  );
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headers = { "xi-api-key": KEY as string, Accept: "application/json" };

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`ElevenLabs rejected the API key (HTTP ${res.status}) on GET ${path}. Aborting.`);
  }
  if (!res.ok) {
    let hint = "";
    try {
      const b = await res.json();
      if (b?.detail) hint = ` — ${JSON.stringify(b.detail).slice(0, 200)}`;
    } catch {
      /* non-JSON */
    }
    throw new Error(`GET ${path} failed (HTTP ${res.status})${hint}`);
  }
  return res.json();
}

/** POST add-shared-voice. Returns the new account voice_id, or throws. */
async function addVoice(v: Curated): Promise<string> {
  const res = await fetch(`${BASE}/v1/voices/add/${encodeURIComponent(v.owner)}/${encodeURIComponent(v.voiceId)}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: targetName(v) }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail).slice(0, 200);
    } catch {
      /* non-JSON */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as { voice_id?: string };
  if (!body.voice_id) throw new Error("add succeeded but response had no voice_id");
  return body.voice_id;
}

interface Outcome {
  source: Curated;
  status: "added" | "skipped" | "failed";
  accountVoiceId?: string;
  detail?: string;
}

async function main() {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");

  // 1. Subscription → voice-slot limit.
  const sub = await getJson("/v1/user/subscription");
  const voiceLimit: number | null = typeof sub.voice_limit === "number" ? sub.voice_limit : null;
  const slotsUsedReported: number | null = typeof sub.voice_slots_used === "number" ? sub.voice_slots_used : null;

  // 2. Current voices → count custom (non-premade) + idempotency lookups.
  const voicesResp = await getJson("/v1/voices");
  const existing: any[] = Array.isArray(voicesResp?.voices) ? voicesResp.voices : [];
  const customCount = existing.filter((x) => (x.category ?? "") !== "premade").length;
  const acctIdByOriginal = new Map<string, string>();
  const acctIdByName = new Map<string, string>();
  for (const x of existing) {
    const orig = x?.sharing?.original_voice_id;
    if (orig) acctIdByOriginal.set(String(orig), String(x.voice_id));
    if (x?.name) acctIdByName.set(String(x.name).trim(), String(x.voice_id));
  }

  // Be conservative about "used" so we never overshoot the cap.
  const used = Math.max(customCount, slotsUsedReported ?? 0);

  // If the plan's limit can't be read, STOP — a write that might exceed the cap
  // must not proceed blindly. Dump the voice-related fields so it can be fixed.
  if (voiceLimit == null) {
    const voiceFields = Object.fromEntries(
      Object.entries(sub).filter(([k]) => /voice/i.test(k)),
    );
    console.error(
      "Could not read a numeric `voice_limit` from GET /v1/user/subscription — refusing to add " +
        "voices without knowing the slot cap.\nVoice-related subscription fields returned:\n" +
        JSON.stringify(voiceFields, null, 2) +
        "\n(Nothing was added.)",
    );
    process.exit(1);
  }

  // Classify: already-present (idempotent skip) vs to-add.
  const already: Outcome[] = [];
  const toAdd: Curated[] = [];
  for (const v of VOICES) {
    const acctId = acctIdByOriginal.get(v.voiceId) ?? acctIdByName.get(targetName(v));
    if (acctId) already.push({ source: v, status: "skipped", accountVoiceId: acctId, detail: "already in account" });
    else toAdd.push(v);
  }

  // 3. Pre-flight cap check — STOP entirely rather than partially add.
  const projected = used + toAdd.length;
  process.stderr.write(
    `Voice slots: ${used} used / ${voiceLimit} limit. ${already.length} already present, ` +
      `${toAdd.length} to add → would be ${projected}.\n`,
  );
  if (projected > voiceLimit) {
    console.error(
      `STOP: adding ${toAdd.length} voice(s) would bring the account to ${projected}, over the ` +
        `plan limit of ${voiceLimit} (currently ${used} used). Nothing was added.\n` +
        `Free up ${projected - voiceLimit} slot(s) or raise the plan, then re-run.`,
    );
    process.exit(1);
  }

  if (DRY_RUN) {
    process.stderr.write("DRY_RUN=1 — checks passed; not adding. Plan below.\n");
  }

  // 4. Add each not-yet-present voice.
  const outcomes: Outcome[] = [...already];
  for (const v of toAdd) {
    if (DRY_RUN) {
      outcomes.push({ source: v, status: "skipped", detail: "dry-run (would add)" });
      continue;
    }
    process.stderr.write(`Adding ${targetName(v)} …\n`);
    try {
      const accountVoiceId = await addVoice(v);
      outcomes.push({ source: v, status: "added", accountVoiceId });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // "already added" style errors → treat as skipped (idempotent), not fatal.
      if (/already|exists|duplicate/i.test(detail)) {
        outcomes.push({ source: v, status: "skipped", detail: `already added (${detail})` });
      } else {
        outcomes.push({ source: v, status: "failed", detail });
      }
    }
    await sleep(REQUEST_SPACING_MS);
  }

  // 5. Report.
  const added = outcomes.filter((o) => o.status === "added");
  const skipped = outcomes.filter((o) => o.status === "skipped");
  const failed = outcomes.filter((o) => o.status === "failed");

  const rows = outcomes
    .map(
      (o) =>
        `| ${targetName(o.source)} | ${o.source.voiceId} | ${o.status} | ${o.accountVoiceId ?? "—"} | ${o.detail ?? ""} |`,
    )
    .join("\n");
  const md =
    `# Phase 1.5 — curated voices added to the account\n\n` +
    `_Run ${new Date().toISOString()}${DRY_RUN ? " (DRY RUN — nothing added)" : ""}._\n\n` +
    `Voice slots: **${used} used / ${voiceLimit} limit** (would be ${projected} after adds).\n\n` +
    `Added: **${added.length}** · Skipped: **${skipped.length}** · Failed: **${failed.length}**\n\n` +
    `| Name | source voice_id | Status | Account voice_id | Detail |\n` +
    `| --- | --- | --- | --- | --- |\n${rows}\n`;

  const OUT = process.env.OUT || "voice-add-curated-result.md";
  await fs.writeFile(path.resolve(process.cwd(), OUT), md, "utf8");
  process.stderr.write(`\nWrote ${OUT}\n`);

  // Machine-readable to stdout (no key, no secrets) — the deliverable list.
  console.log(
    JSON.stringify(
      {
        voiceLimit,
        used,
        projected,
        added: added.length,
        skipped: skipped.length,
        failed: failed.length,
        dryRun: DRY_RUN,
        voices: outcomes.map((o) => ({
          name: targetName(o.source),
          sourceVoiceId: o.source.voiceId,
          status: o.status,
          accountVoiceId: o.accountVoiceId ?? null,
          detail: o.detail ?? null,
        })),
      },
      null,
      2,
    ),
  );

  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
