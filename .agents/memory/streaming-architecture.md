---
name: Streaming chat architecture
description: How the chat send/stream flow works, model choices, and caching approach
---

## Chat path: /api/chat/stream (primary)

`POST /api/chat/stream` is the main chat endpoint. It uses SSE (Server-Sent Events):
- Events: `delta { text }`, `done { messageId, content }`, `error { error }`
- Sets `X-Accel-Buffering: no` header to prevent nginx/proxy buffering
- Calls `streamCompanionReply` which uses Anthropic streaming (`messages.create({ stream: true })`)
- Background extractions (commitments, habits, memory) run inside an IIFE after `res.end()` — truly fire-and-forget, never blocks the stream
- The DB fetch for openCommitments/activeHabits also happens AFTER `res.end()`

`/api/chat/send` (old endpoint) is kept for compatibility but is no longer called by the main chat UI.

## Model choices (as of July 2026)
- **Companion chat**: `claude-sonnet-4-5` (was claude-opus-4-5; Sonnet is faster)
- **Memory extraction**: `claude-haiku-4-5` (unchanged — cheap background task)
- **Commitment extraction**: `claude-haiku-4-5` (unchanged)
- **Habit detection**: `claude-haiku-4-5` (unchanged)
- **Morning note**: `claude-sonnet-4-5` (was claude-opus-4-5)

## Prompt caching
`cache_control: { type: "ephemeral" }` is applied to the system prompt block in both `streamCompanionReply` and `getCompanionReply`. The whole system prompt is cached as one block. Cache TTL is 5 min (Anthropic default). Hit rate ~75% in normal conversation (misses when memory extraction adds new facts every 4 messages).

**Why:** System prompt is large (~300+ lines); caching avoids reprocessing it from scratch on every message.

**Future improvement:** Split into static (rules/voice packs) + dynamic (facts/signals) blocks for near-100% cache hit rate on the static portion.

## Frontend streaming (Chat.tsx)

State: `streamingContent: string`, `isStreaming: boolean`

`sendStreamingMessage(content)`:
1. Opens fetch to `/api/chat/stream`
2. Parses SSE events from `ReadableStream` (split on `\n\n`)
3. Appends delta tokens to `streamingContent` via setState updater form
4. On `done`: sets `speakingMessageId` + `revealedWords = 0` BEFORE query invalidation (prevents flash of full text), invalidates messages query, calls `handleSpeak` for TTS+LiveCaption

The streaming bubble (`isStreaming=true`) shows `streamingContent` building up in a companion message bubble. Uses `AnimatePresence` to fade in/out.

Input/mic/send buttons are disabled while `isStreaming=true`.

## Anthropic SDK streaming gotcha
Use `(anthropic.messages.create as any)({ ..., stream: true })` and iterate with `for await`. The `event.delta.type === 'text_delta'` check gates the text chunks. The SDK is loaded via require() pattern.
