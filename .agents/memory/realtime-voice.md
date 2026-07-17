---
name: Realtime voice (ElevenLabs Conversational AI)
description: How realtime voice calls work — agent owns audio, Claude stays the brain via a custom-LLM endpoint; token auth; fallback rules
---

# Realtime voice architecture

**Rule:** Voice calls try the ElevenLabs Conversational AI agent first (native mic streaming, turn-taking, barge-in); the browser SpeechRecognition + sentence-TTS "classic" engine is the automatic fallback, never removed. Claude remains the only brain: the agent's LLM is configured as a Custom LLM pointing at our OpenAI-compatible endpoint (`/api/voice-llm/v1/chat/completions`), which rebuilds the full persona/memory system prompt server-side and ignores the agent-config system prompt.

**Why:** ElevenLabs owns the hard realtime problems (latency, VAD, interruption) far better than our hand-rolled loop, but the product's soul is the persona + user memory — that must never fork into a second prompt maintained in the ElevenLabs dashboard.

**How to apply:**
- Auth on the custom-LLM endpoint is ONLY the HMAC token (`userId.iat.exp.sig`, SESSION_SECRET-signed) that the session endpoint mints and the client passes via `customLlmExtraBody` → arrives as `body.elevenlabs_extra_body.user_token`. The endpoint is public (ElevenLabs servers call it) — never weaken the token check; 401 on any failure.
- The token's `issuedAt` doubles as the call-start marker: prompt context = DB messages `createdAt < issuedAt` + the in-call turns ElevenLabs sends. Never mix in rows persisted during the call or turns duplicate.
- In-call turns are persisted fire-and-forget; ElevenLabs resends the conversation each turn, so persistence dedupes the latest user turn (interruption resend) — keep that guard.
- Claude alternation invariants: merge consecutive same-role turns, drop a leading assistant turn, and if history ends with assistant, synthesize/merge a user turn.
- `ELEVENLABS_AGENT_ID` secret gates the feature; unset → session endpoint returns `available:false` → client shows a note and uses classic mode. The agent must have **"Custom LLM extra body" enabled** in the dashboard or user_token never arrives; TTS voice-ID override (Security tab) is optional — client retries startSession without the override if it throws.
- Frontend engine discipline: `voiceEngineRef` ("realtime"|"classic"|null); every classic-mode callback (TTS onStart/onEnd, handleSpeak, tap-to-interrupt/speak UI) must guard against running while realtime is active — the agent owns all audio. On call end/unmount/disconnect: `endSession()`, null the convo ref, invalidate the messages query (voice turns appear in chat history).
- Realtime callbacks need SESSION-IDENTITY gating, not just ref guards: a gen counter bumped at every call start AND end, captured per-attempt; every SDK callback (onMode/onUserText/onAgentText/onDisconnect/onError) and every post-await checkpoint compares it. Otherwise a delayed onDisconnect from an ended session passes the ref guards and tears down the next call (end→quick-restart race).
