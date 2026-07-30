import { Conversation, type DisconnectionDetails } from "@elevenlabs/client";
import type { AlignmentChunk } from "./captionSync";
import {
  buildSessionOverrides,
  type OverrideLevel,
  type VoiceTone,
} from "./voiceOverrides";

export type { VoiceTone, OverrideLevel };

// ─── Realtime voice via ElevenLabs Conversational AI ─────────────────────────
// The agent natively handles mic streaming, live transcription, turn-taking,
// and interruption/barge-in. Its "brain" is our backend custom-LLM endpoint
// (api-server routes/voice-llm.ts), which runs the SAME Claude care-system
// persona with the user's real memory — ElevenLabs does the voice, Claude does
// the thinking.
//
// The per-user HMAC token minted by POST /api/voice-agent/session travels via
// customLlmExtraBody, so the backend knows whose memory to load. This requires
// "Custom LLM extra body" to be enabled on the agent (see setup notes).

export type RealtimeSessionInfo = {
  available: boolean;
  reason?: string;
  /** Human-readable extra context from the server (e.g. the ElevenLabs error). */
  detail?: string;
  mode?: "signed" | "public";
  signedUrl?: string;
  agentId?: string;
  userToken?: string;
  /** "How Eos speaks" preference — maps to TTS delivery overrides (voiceOverrides.ts). */
  tone?: VoiceTone;
  /**
   * Server-built opening line (api-server services/voiceGreeting.ts).
   * NO LONGER SENT to ElevenLabs: the first_message override is rejected with
   * a 1008 disconnect since ~July 29 (permission tightened on their side, no
   * dashboard toggle on our tier). The greeting now always comes from the
   * custom LLM's synthetic-greeting path (routes/voice-llm.ts).
   * TODO(cleanup): drop this field + the server's firstMessage plumbing once
   * we decide the LLM greeting is the permanent path.
   */
  firstMessage?: string;
};

export type RealtimeHandlers = {
  onMode: (mode: "speaking" | "listening") => void;
  onUserText: (text: string) => void;
  onAgentText: (text: string) => void;
  /**
   * Per-chunk character alignment riding on audio events — powers the live
   * caption sync (lib/captionSync.ts). NOTE: fires for EVERY incoming chunk,
   * including post-interrupt stragglers the SDK never plays.
   */
  onAudioAlignment?: (alignment: AlignmentChunk) => void;
  /** A chunk actually ACCEPTED for playback — length in decoded bytes. */
  onAudioBytes?: (bytes: number) => void;
  /** The user barged in — the agent's audio was cut off right now. */
  onInterruption?: () => void;
  /** Server-side truncation of an interrupted reply (its estimate of what was heard). */
  onCorrection?: (correctedText: string, originalText: string) => void;
  /** Agent audio output format from conversation metadata (e.g. "pcm_16000"). */
  onAudioFormat?: (format: string) => void;
  /** Fired when the session ends. `message` is null for a clean/user-initiated end. */
  onDisconnect: (info: { message: string | null }) => void;
  onError: (message: string, context?: unknown) => void;
};

/**
 * Turn the SDK's disconnection details into a human-readable cause, or null
 * when the end was clean (we hung up, or a normal close with no error).
 * Surfacing this is what turns a "silent instant drop" into a diagnosable
 * message like "code 3000 — agent requires authorization".
 */
export function describeDisconnect(details: DisconnectionDetails): string | null {
  if (details.reason === "user") return null; // we ended the call ourselves
  const parts: string[] = [];
  if (details.reason === "error" && details.message) parts.push(details.message);
  const closeReason = details.closeReason ?? details.context?.reason;
  const closeCode = details.closeCode ?? details.context?.code;
  if (closeReason && !parts.includes(closeReason)) parts.push(closeReason);
  // 1000 = normal closure, 1005 = no status present — not errors by themselves.
  if (typeof closeCode === "number" && closeCode !== 1000 && closeCode !== 1005) {
    parts.push(`code ${closeCode}`);
  }
  if (parts.length) return parts.join(" — ");
  return details.reason === "error" ? "connection error" : null;
}

export type RealtimeConversation = Awaited<ReturnType<typeof Conversation.startSession>>;

/** One cascade attempt's outcome — fed to the connect-timing beacon. */
export type AttemptResult = {
  level: OverrideLevel;
  ok: boolean;
  ms: number;
  message?: string;
};

const nowMs = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export async function startRealtimeCall(
  session: RealtimeSessionInfo,
  voiceId: string | undefined,
  handlers: RealtimeHandlers,
  /** Called after every attempt (success or failure) with its timing. */
  onAttempt?: (result: AttemptResult) => void,
): Promise<RealtimeConversation> {
  if (!session.signedUrl && !session.agentId) {
    throw new Error("Realtime session is missing both signedUrl and agentId");
  }

  const shared = {
    connectionType: "websocket" as const,
    // Arrives at our custom-LLM endpoint as body.elevenlabs_extra_body.user_token
    customLlmExtraBody: { user_token: session.userToken ?? "" },
    onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => handlers.onMode(mode),
    onMessage: ({ message, role }: { message: string; role: "user" | "agent" }) => {
      if (role === "user") handlers.onUserText(message);
      else handlers.onAgentText(message);
    },
    // ── Caption-sync taps ────────────────────────────────────────────────────
    // onAudioAlignment fires for every incoming chunk; onAudio only for chunks
    // the SDK accepts for playback (stale post-interrupt chunks are dropped).
    // The caption engine relies on exactly that distinction to ignore straggler
    // alignments — see lib/captionSync.ts.
    onAudioAlignment: (alignment: AlignmentChunk) => handlers.onAudioAlignment?.(alignment),
    onAudio: (base64Audio: string) =>
      handlers.onAudioBytes?.(Math.floor(base64Audio.length * 0.75)),
    onInterruption: () => handlers.onInterruption?.(),
    onAgentResponseCorrection: (correction: {
      corrected_agent_response: string;
      original_agent_response: string;
    }) =>
      handlers.onCorrection?.(
        correction.corrected_agent_response,
        correction.original_agent_response,
      ),
    onConversationMetadata: (metadata: { agent_output_audio_format: string }) =>
      handlers.onAudioFormat?.(metadata.agent_output_audio_format),
    onDisconnect: (details: DisconnectionDetails) =>
      handlers.onDisconnect({ message: describeDisconnect(details) }),
    onError: (message: string, context?: unknown) => handlers.onError(message, context),
  };

  const attempt = (level: OverrideLevel) => {
    // The SDK's override typings lag the API — stability/speed are accepted
    // when enabled in the agent's Security settings. session.firstMessage is
    // deliberately NOT passed: the first_message override is rejected by
    // ElevenLabs with a 1008 disconnect (see voiceOverrides.ts).
    const overrides = buildSessionOverrides(level, {
      tone: session.tone,
      voiceId,
    }) as Record<string, never>;
    return session.signedUrl
      ? Conversation.startSession({ signedUrl: session.signedUrl, ...shared, ...overrides })
      : Conversation.startSession({ agentId: session.agentId!, ...shared, ...overrides });
  };

  // Cascade: full → voice → none. Each failed level is a FULL paid
  // reconnection, so two rules keep it cheap and visible:
  //  - a level whose override payload is byte-identical to one that already
  //    failed is skipped (no-op retries never dial);
  //  - every attempt (ok or not, with its duration) is reported via onAttempt
  //    so the timing beacon can tell the server which level connected — a
  //    failing "full" means override flags are disabled on the agent
  //    dashboard, and the server logs exactly that.
  const seenPayloads = new Set<string>();
  let lastErr: unknown = null;
  for (const level of ["full", "voice", "none"] as const) {
    const payloadKey = JSON.stringify(
      buildSessionOverrides(level, { tone: session.tone, voiceId }),
    );
    if (seenPayloads.has(payloadKey)) continue;
    seenPayloads.add(payloadKey);

    const t0 = nowMs();
    try {
      const convo = await attempt(level);
      onAttempt?.({ level, ok: true, ms: Math.round(nowMs() - t0) });
      return convo;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      onAttempt?.({ level, ok: false, ms: Math.round(nowMs() - t0), message });
      console.warn(`[realtime-voice] "${level}" override attempt failed:`, err);
    }
  }
  throw lastErr ?? new Error("realtime connection failed");
}
