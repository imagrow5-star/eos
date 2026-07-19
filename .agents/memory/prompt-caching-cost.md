---
name: Prompt caching & AI cost architecture
description: How the system prompt is split for Anthropic prompt caching, the voice frozen-prompt pattern, and per-call usage logging
---

## Rule: nothing volatile may ever enter the `stable` prompt part

`buildSystemPrompt` returns `SystemPromptParts { stable, context }`, not a string.
- `stable` gets the `cache_control` breakpoint and MUST be byte-identical turn after turn: persona, character, rules, voice pack, book wisdom, stage rules.
- `context` (after the breakpoint) carries everything live: dateTime block, commitments list, mood line, discovery, facts, signals, habits, goals, anti-repetition phrases, safety tail (safety stays LAST).

**Why:** the original assembly put a minute-precision dateTime block FIRST in a single cached string — the cache never hit and every turn paid the 1.25× cache-WRITE premium on ~8.5k tokens (worse than no caching). Verified after the split: turn 2 shows `cacheRead: 8539, cacheWrite: 0` (~82% cheaper per chat turn).

**How to apply:** when adding any new block to the system prompt, ask "can this differ between two consecutive messages?" If yes → context part only. Anti-repetition `recentPhrases` and clock time are the classic offenders. Wording of existing blocks must never be silently changed when regrouping — regroup only.

## Voice: frozen per-call prompt + stepped history window

The ElevenLabs custom-LLM endpoint is hit every few seconds during a call:
- System parts are frozen per call in an in-memory Map keyed `userId:issuedAt` (token issue time = call start) with a **sliding** 15-min TTL (refreshed on every hit — a fixed TTL expired mid-call and re-busted the cache, caught in code review). Mid-call profile changes apply on the next call.
- Voice passes `cacheConversation: true` → context block + second-to-last message also get breakpoints (3 total, ≤4 allowed), so the growing transcript re-reads from cache (`cacheRead: 9769, input: 18` on turn 2, ~91% cheaper).
- History window is stepped, not sliding: window start moves in strides of 10 (size floats 20–29). A per-turn `slice(-20)` changes the first message every turn and voids the conversation-prefix cache.

## Cost visibility

Every Anthropic call logs a structured `ai_usage` line (callType, model, input, cacheRead, cacheWrite, output, estCostUsd) — grep workflow logs for `ai_usage`. Healthy caching = large cacheRead + small input from turn 2 on. A cacheWrite spike mid-call means the frozen prompt was rebuilt (restart or bug). Streaming usage must be accumulated from BOTH `message_start` (input/cache fields) and `message_delta` (final output tokens) events.
