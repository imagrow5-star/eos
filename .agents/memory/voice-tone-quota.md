---
name: Voice tone preference & quota UX
description: Policies for the "How Eos speaks" tone feature and ElevenLabs quota-exhaustion handling
---

# "How Eos speaks" tone + voice-quota UX

## Tone policies
- Tone (`auto` default | gentle | calm | upbeat) is **delivery style only** — it must never change or drop the user's chosen voiceId. The session-start retry ladder therefore degrades full overrides → voice-only → none, so a rejected tone field can't cost the user their voice.
- Tone reaches the call two ways: TTS overrides (stability/speed) set by the client at session start, and a DELIVERY STYLE line appended to the voice system addendum server-side. `auto` adds **no** prompt line — situational adaptation leads.
- **Cache safety:** the tone line freezes with the per-call system prompt. A mid-call Settings change applies on the NEXT call — systemExtra lives in the cached stable block, so changing it mid-call would break the prompt-cache prefix.

## ElevenLabs agent security gotcha
- Conversation overrides are **deny-by-default per field** on the agent (`platform_settings.overrides.conversation_config_override`). Before the client sends a new override field, enable its flag via the agents PATCH API — otherwise startSession fails and the client silently degrades down the retry ladder.

## Quota exhaustion UX
- Quota failures (`quota_exceeded` detail status, any /quota/i message, WS close "code 1002") must never surface raw errors. All three failure paths — session bootstrap, handshake throw, mid-call disconnect — show the warm in-character line ("My voice needs a little rest right now — but I'm right here with you in text.") and roll back to text chat.
- **No classic-engine fallback on quota** — classic TTS draws on the same ElevenLabs quota and would fail identically.
- The server must classify quota explicitly at signed-url time so a 401-shaped quota error isn't mislabeled as an invalid API key.

**Why:** the audience is emotionally vulnerable; a raw "quota exceeded" mid-confession is a product failure, and burning remaining quota on a fallback makes it worse.
