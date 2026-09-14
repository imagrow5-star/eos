/**
 * Purpose-specific secrets.
 *
 * One SESSION_SECRET used to do every signing job: login cookies, voice
 * tokens, and the internal sweep tokens — and for the sweeps it had to be
 * copied into the scheduler's deployment as well. A leak anywhere forged
 * everything. Each job now has its own secret:
 *
 *   SESSION_SECRET          login cookies only (express-session). Web service.
 *   VOICE_TOKEN_SECRET      per-call voice tokens (lib/voiceToken.ts). Web service.
 *   INTERNAL_SWEEP_SECRET   the internal sweep endpoints (lib/internalAuth.ts).
 *                           Web service AND the scheduler; nothing else is shared.
 *
 * Migration: when a dedicated secret is not set, its key is DERIVED from
 * SESSION_SECRET with HKDF and a per-purpose label. The derived keys are
 * independent of each other and of the session signing key, so even in the
 * fallback a captured sweep token or voice token says nothing about cookies.
 * What the fallback cannot fix is the scheduler still holding SESSION_SECRET;
 * production logs a warning at boot until INTERNAL_SWEEP_SECRET is set (on
 * both services), after which SESSION_SECRET can leave the scheduler's
 * environment. The scheduler derives the same fallback key
 * (artifacts/daily-email/src/run.ts).
 */
import { hkdfSync } from "node:crypto";

export type SecretPurpose = "internal-sweep" | "voice-token" | "demo-ip";

const LABEL: Record<SecretPurpose, string> = {
  "internal-sweep": "eos-internal-sweep-v1",
  "voice-token": "eos-voice-token-v1",
  // Keyed hash of a landing-page visitor's IP for the one-voice-demo-per-day
  // rule (services/demoVoice.ts). A salt, not a credential: the derived
  // fallback is fine to keep, so no boot warning asks for the dedicated var.
  "demo-ip": "eos-demo-ip-v1",
};

const DEDICATED: Record<SecretPurpose, string> = {
  "internal-sweep": "INTERNAL_SWEEP_SECRET",
  "voice-token": "VOICE_TOKEN_SECRET",
  "demo-ip": "DEMO_IP_HASH_SECRET",
};

/** 32 bytes derived from SESSION_SECRET for one purpose, as lowercase hex. */
export function deriveFromSessionSecret(sessionSecret: string, purpose: SecretPurpose): string {
  return Buffer.from(hkdfSync("sha256", sessionSecret, "", LABEL[purpose], 32)).toString("hex");
}

/** The secret for a purpose: the dedicated env var, else the derived fallback. */
export function secretFor(purpose: SecretPurpose, env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env[DEDICATED[purpose]]?.trim();
  if (dedicated) return dedicated;
  const session = env.SESSION_SECRET;
  if (!session) throw new Error(`${DEDICATED[purpose]} or SESSION_SECRET is required`);
  return deriveFromSessionSecret(session, purpose);
}

/** Boot-time warnings for production: which dedicated secrets are still missing. */
export function secretSplitWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const out: string[] = [];
  if (!env.INTERNAL_SWEEP_SECRET?.trim()) {
    out.push(
      "INTERNAL_SWEEP_SECRET is not set — the internal sweep endpoints use a key derived from SESSION_SECRET, " +
        "so the scheduler still needs SESSION_SECRET. Set INTERNAL_SWEEP_SECRET (openssl rand -hex 32) on the " +
        "web service and the cron job, then remove SESSION_SECRET from the cron job.",
    );
  }
  if (!env.VOICE_TOKEN_SECRET?.trim()) {
    out.push("VOICE_TOKEN_SECRET is not set — voice tokens use a key derived from SESSION_SECRET. Set it to complete the split.");
  }
  return out;
}
