import {
  HumeClient,
  EVIWebAudioPlayer,
  checkForAudioTracks,
  convertBlobToBase64,
  getAudioStream,
} from "hume";

// ─── Realtime voice via Hume EVI (provider trial — allowlist only) ───────────
// Hume handles mic streaming, transcription, turn-taking, and barge-in; its
// "brain" is our backend CLM endpoint (api-server routes/humeLlm.ts →
// voiceCompletionHandler), so Eos's persona and this user's real memory stay
// identical to ElevenLabs calls — plus the prosody-driven voice-tone context
// only Hume provides.
//
// Auth: the server's /voice-agent/session?provider=hume response carries a
// short-lived OAuth ACCESS TOKEN (never the Hume API key) and our per-call
// HMAC voice token. The voice token is sent as session_settings'
// language_model_api_key (arrives at our CLM as the Bearer) and as
// custom_session_id (the redundant query-param carrier) — the exact flow the
// WS capture tests proved end to end.
//
// Mic capture mirrors Hume's own browser wrapper: MediaRecorder chunks
// (webm, with mp4/wav fallbacks for Safari) base64-sent as audio_input.
// Playback is the SDK's EVIWebAudioPlayer (AudioWorklet; blob: worker-src is
// already in our CSP for the ElevenLabs worklets).
//
// Captions: Hume has no per-character alignment (that's an ElevenLabs
// feature), so callers get the full reply text per turn — the call screen
// shows sentence-level captions instead of word-timed ones.

export type HumeSessionInfo = {
  accessToken: string;
  configId: string;
  userToken: string;
  /** Voice for the user's picked voice gender (phase-1 parity). Optional:
   *  absent (older server) means the EVI config's own voice plays. */
  humeVoiceId?: string;
};

export type HumeCallHandlers = {
  /** speaking = a reply is being voiced; listening = her turn is over. */
  onMode: (mode: "speaking" | "listening") => void;
  /** Live user transcript (interim and final — final replaces interim). */
  onUserText: (text: string) => void;
  /** Full reply text for THIS turn (sentence-level captions). */
  onAgentText: (text: string) => void;
  /** First audio chunk accepted for playback — the connect-timing moment. */
  onFirstAudio?: () => void;
  /** Fired once when the session ends. `message` null = clean close. */
  onDisconnect: (info: { message: string | null }) => void;
  onError: (message: string, context?: unknown) => void;
  /** The SDK's reconnecting socket silently redialed mid-call: a NEW EVI
   *  chat started (fresh chatId in chat_metadata). Session settings have
   *  already been re-sent by the time this fires — this is observability,
   *  not a call to action. */
  onReconnect?: (chatId: string) => void;
};

/** Structurally compatible with how Chat.tsx drives the ElevenLabs convo. */
export type HumeCallControls = {
  endSession: () => Promise<void>;
  setVolume: (opts: { volume: number }) => void;
};

/** Close-event → human-readable cause (null = clean close). Exported for tests. */
export function humeCloseMessage(code: number | undefined, reason: string | undefined): string | null {
  // 1000 = normal closure, 1005 = no status — not errors by themselves.
  if (code === undefined || code === 1000 || code === 1005) return reason?.trim() || null;
  return reason?.trim() ? `${reason.trim()} — code ${code}` : `code ${code}`;
}

/** True when a session response is a complete Hume payload. Exported for tests. */
export function isHumeSession(body: unknown): body is HumeSessionInfo & { mode: "hume" } {
  const b = body as { mode?: unknown; accessToken?: unknown; configId?: unknown; userToken?: unknown } | null;
  return (
    b?.mode === "hume" &&
    typeof b.accessToken === "string" && b.accessToken.length > 0 &&
    typeof b.configId === "string" && b.configId.length > 0 &&
    typeof b.userToken === "string" && b.userToken.length > 0
  );
}

const CONNECT_TIMEOUT_MS = 10_000;
const RECORDER_CHUNK_MS = 100;

export async function startHumeCall(
  session: HumeSessionInfo,
  handlers: HumeCallHandlers,
): Promise<HumeCallControls> {
  const client = new HumeClient({ accessToken: session.accessToken });
  const socket = client.empathicVoice.chat.connect({ configId: session.configId });

  const player = new EVIWebAudioPlayer();
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let ended = false;
  let firstAudio = false;
  // Last chat id seen in chat_metadata — a DIFFERENT id later in the same
  // call means the reconnecting socket silently redialed into a new chat.
  let currentChatId: string | null = null;

  // Session settings must be (re)sent on EVERY open, not just the first:
  // the SDK's socket is a ReconnectingWebSocket (up to 30 silent redials on
  // network blips), and each redial starts a brand-new EVI chat that knows
  // NOTHING sent on the previous connection. Without this, a mid-call
  // reconnect silently dropped both the CLM auth (Eos's brain gone) and the
  // gender-matched voice_id (voice reverts to the EVI config's voice —
  // heard as "a different voice took over mid-call").
  const sendSettings = () => {
    socket.sendSessionSettings({
      customSessionId: session.userToken,
      languageModelApiKey: session.userToken,
      ...(session.humeVoiceId ? { voiceId: session.humeVoiceId } : {}),
    });
  };
  socket.on("open", () => {
    if (!ended) sendSettings();
  });

  const teardown = () => {
    if (ended) return;
    ended = true;
    try { recorder?.state !== "inactive" && recorder?.stop(); } catch { /* already stopped */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
    try { player.dispose(); } catch { /* never played */ }
    try { socket.close(); } catch { /* already closed */ }
  };

  socket.on("message", (msg) => {
    if (ended) return;
    switch (msg.type) {
      case "user_message":
        // Interim and final transcripts both update the live line; a final
        // simply replaces the interim it refined.
        handlers.onUserText(msg.message?.content ?? "");
        break;
      case "assistant_message":
        handlers.onAgentText(msg.message?.content ?? "");
        handlers.onMode("speaking");
        break;
      case "audio_output":
        if (!firstAudio) {
          firstAudio = true;
          handlers.onFirstAudio?.();
        }
        void player.enqueue(msg).catch((err) => handlers.onError(`audio playback failed: ${String(err)}`));
        break;
      case "assistant_end":
        handlers.onMode("listening");
        break;
      case "user_interruption":
        // Barge-in: cut her audio right now and hand the turn to the user.
        try { player.stop(); } catch { /* nothing playing */ }
        handlers.onMode("listening");
        break;
      case "error":
        handlers.onError(msg.message ?? "Hume error", msg);
        break;
      case "chat_metadata": {
        // One per connection. A SECOND, different chatId in the same call
        // means the socket silently reconnected into a new EVI chat — the
        // open handler has already re-sent the session settings; surface
        // the event so mid-call voice/brain glitches are diagnosable.
        const chatId = (msg as { chatId?: string }).chatId ?? "";
        if (currentChatId && chatId && chatId !== currentChatId) {
          handlers.onReconnect?.(chatId);
        }
        if (chatId) currentChatId = chatId;
        break;
      }
      default:
        break; // assistant_prosody and friends — nothing to render
    }
  });
  socket.on("close", (event) => {
    if (ended) return;
    const message = humeCloseMessage(event?.code, (event as { reason?: string })?.reason);
    teardown();
    handlers.onDisconnect({ message });
  });
  socket.on("error", (err) => {
    if (!ended) handlers.onError(err instanceof Error ? err.message : String(err));
  });

  try {
    await Promise.race([
      socket.waitForOpen(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Hume connect timed out")), CONNECT_TIMEOUT_MS),
      ),
    ]);

    // Session settings (voice token in both carriers + the gender voice_id)
    // are sent by the on("open") handler above — on the first open AND on
    // every silent reconnect. waitForOpen resolving means the first send
    // has happened: the open handler runs in the same event dispatch.

    // Audio out, then audio in. init() unlocks the AudioContext — the call
    // press is the user gesture that makes this legal on mobile Safari.
    await player.init();
    stream = await getAudioStream();
    checkForAudioTracks(stream);
    const mimeType = ["audio/webm", "audio/mp4", "audio/wav"].find((t) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
    );
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
      if (ended || !e.data?.size || socket.readyState !== WebSocket.OPEN) return;
      void convertBlobToBase64(e.data)
        .then((data) => { if (!ended) socket.sendAudioInput({ data }); })
        .catch(() => { /* one dropped chunk — the next lands in 100ms */ });
    };
    recorder.start(RECORDER_CHUNK_MS);
  } catch (err) {
    teardown();
    throw err;
  }

  return {
    endSession: async () => teardown(),
    setVolume: ({ volume }) => {
      try { player.setVolume(volume); } catch { /* player not initialized */ }
    },
  };
}
