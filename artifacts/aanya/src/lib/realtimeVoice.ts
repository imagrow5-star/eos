import { Conversation } from "@elevenlabs/client";

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
  mode?: "signed" | "public";
  signedUrl?: string;
  agentId?: string;
  userToken?: string;
};

export type RealtimeHandlers = {
  onMode: (mode: "speaking" | "listening") => void;
  onUserText: (text: string) => void;
  onAgentText: (text: string) => void;
  onDisconnect: () => void;
  onError: (message: string) => void;
};

export type RealtimeConversation = Awaited<ReturnType<typeof Conversation.startSession>>;

export async function startRealtimeCall(
  session: RealtimeSessionInfo,
  voiceId: string | undefined,
  handlers: RealtimeHandlers,
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
    onDisconnect: () => handlers.onDisconnect(),
    onError: (message: string) => handlers.onError(message),
  };

  const attempt = (withVoice: boolean) => {
    const overrides =
      withVoice && voiceId ? { overrides: { tts: { voiceId } } } : {};
    return session.signedUrl
      ? Conversation.startSession({ signedUrl: session.signedUrl, ...shared, ...overrides })
      : Conversation.startSession({ agentId: session.agentId!, ...shared, ...overrides });
  };

  try {
    // Prefer the user's chosen companion voice — requires the "TTS voice ID"
    // override to be enabled in the agent's Security tab.
    return await attempt(true);
  } catch (err) {
    if (!voiceId) throw err;
    // Voice override may be disabled on the agent — retry with its default voice.
    console.warn("[realtime-voice] retrying without voice override:", err);
    return await attempt(false);
  }
}
