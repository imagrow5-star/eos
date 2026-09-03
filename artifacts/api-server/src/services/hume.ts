import { logger } from "../lib/logger.js";

/**
 * Hume EVI provider plumbing (voice stage A — server only).
 *
 * The browser must never hold the Hume API key, and Hume supports exactly
 * this split: an OAuth2 client-credentials exchange turns HUME_API_KEY +
 * HUME_SECRET_KEY into a short-lived access token the browser uses on the
 * EVI WebSocket instead of the key. Endpoint, auth header, body, and
 * response shape are all verified against the official SDK source
 * (hume npm package, wrapper/fetchAccessToken):
 *   POST {base}/oauth2-cc/token
 *   Authorization: Basic base64("apiKey:secretKey")
 *   body: grant_type=client_credentials  → { access_token }
 *
 * Rollout gate: HUME_VOICE_ALLOWLIST (comma-separated emails) mirrors the
 * memory-reset gate exactly — unset means the feature doesn't exist, and
 * only listed accounts ever take the Hume branch. Additionally the client
 * must OPT IN per request (?provider=hume): the currently shipped client
 * can't render a Hume session, so an allowlisted account on the old client
 * must keep getting ElevenLabs until the stage-B client asks for Hume.
 */

export function humeApiBase(): string {
  return process.env.HUME_API_BASE?.trim() || "https://api.hume.ai";
}

export function humeConfigId(): string | null {
  return process.env.HUME_CONFIG_ID?.trim() || null;
}

export function isHumeVoiceConfigured(): boolean {
  return Boolean(
    process.env.HUME_API_KEY?.trim() &&
      process.env.HUME_SECRET_KEY?.trim() &&
      humeConfigId(),
  );
}

// ─── Phase-2 call voices (curated two-per-gender picker) ─────────────────────
// The Settings picker's specific voices are still ElevenLabs voices with no
// Hume equivalents, so a Hume call resolves its voice from this curated
// catalog: a warmer default and a softer alternative per gender, pickable in
// Settings. The resolved id rides to the client in the session response and is
// sent as session_settings.voice_id (wire name verified from the SDK
// serializer), in the same message that carries the CLM auth — which EVI
// provably processes before synthesizing the greeting. Ids are from the live
// Voice Library API capture (2026-09-03), founder-picked; all four report
// compatible_octave_models 1 and 2 (catalogue query, 2026-09-03).
export interface HumeCallVoice {
  id: string;
  name: string;
  /** Short feel label shown on the picker chip, e.g. "warm & calm". */
  tagline: string;
}

/** The FIRST entry per gender is that gender's default. */
export const HUME_CALL_VOICES: Record<"female" | "male", readonly HumeCallVoice[]> = {
  female: [
    { id: "59cfc7ab-e945-43de-ad1a-471daa379c67", name: "Kora", tagline: "warm & calm" },
    { id: "aeaaf1f8-fe31-49ae-893d-c744e5207bc2", name: "Relaxing ASMR Woman", tagline: "soft & close" },
  ],
  male: [
    { id: "99d2cb9c-9011-4ead-8734-641656d3df66", name: "Comforting Male Conversationalist", tagline: "warm & steady" },
    { id: "b152864b-6720-496a-9d18-eaadb31516ee", name: "Soft Male Conversationalist", tagline: "gentle & low" },
  ],
};

export function isCuratedHumeVoice(gender: "female" | "male", id: string): boolean {
  return HUME_CALL_VOICES[gender].some((v) => v.id === id);
}

/**
 * Resolve the call voice. An explicit pick (profile.hume_voice_id) wins when
 * it's in the curated catalog FOR THE CURRENT GENDER — a pick from the other
 * gender goes inert and that gender's default plays (switching back revives
 * it), so no reconciliation write is needed on a gender change.
 *
 * Without a pick, the env overrides (HUME_VOICE_ID_FEMALE /
 * HUME_VOICE_ID_MALE) replace the gender DEFAULT — they exist for voice
 * AUDITIONING and hotfixes: swapping the default is a Render env change, not
 * a deploy. Not every Voice Library voice is EVI-compatible (voices carry a
 * compatible_octave_models field; an incompatible voice_id gets the session
 * rejected by EVI), so being able to retry candidates quickly matters. The
 * winners get promoted into the catalog above.
 */
export function humeVoiceIdForGender(
  gender: "female" | "male",
  pickedId?: string | null,
): string {
  if (pickedId && isCuratedHumeVoice(gender, pickedId)) return pickedId;
  const override =
    process.env[gender === "female" ? "HUME_VOICE_ID_FEMALE" : "HUME_VOICE_ID_MALE"]?.trim();
  return override || HUME_CALL_VOICES[gender][0]!.id;
}

export type HumeGateDecision = "not_configured" | "forbidden" | "allowed";

/** Same semantics and tolerance as resetAllowlistDecision (resetGate.ts). */
export function humeAllowlistDecision(
  email: string | null | undefined,
  rawAllowlist: string | undefined = process.env.HUME_VOICE_ALLOWLIST,
): HumeGateDecision {
  if (!rawAllowlist || rawAllowlist.trim() === "") return "not_configured";
  const allow = new Set(
    rawAllowlist
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
  if (allow.size === 0) return "not_configured";
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized && allow.has(normalized)) return "allowed";
  return "forbidden";
}

/**
 * One exchange per session mint, deliberately uncached: the token's real
 * lifetime isn't verified (the SDK parses only access_token), and a cached
 * token outliving its TTL would break calls in a way that looks like a
 * client bug. The mint path is prefetched on call intent, so the extra
 * round trip stays off the press-to-connect critical path — same cost
 * profile as the ElevenLabs signed-URL fetch. Cache later if Hume's
 * expiry semantics get pinned.
 */
export async function fetchHumeAccessToken(): Promise<string | null> {
  const apiKey = process.env.HUME_API_KEY?.trim();
  const secretKey = process.env.HUME_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) return null;
  try {
    const res = await fetch(`${humeApiBase()}/oauth2-cc/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.error(
        { status: res.status },
        "hume: access-token exchange failed — check HUME_API_KEY/HUME_SECRET_KEY",
      );
      return null;
    }
    const data = (await res.json()) as { access_token?: unknown };
    return typeof data.access_token === "string" && data.access_token ? data.access_token : null;
  } catch (err) {
    logger.error({ err }, "hume: access-token exchange unreachable");
    return null;
  }
}
