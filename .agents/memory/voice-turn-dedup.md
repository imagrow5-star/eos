---
name: Voice-call turn dedup
description: Why voice turns duplicated in chat history and the dedup rules any voice-persistence path must follow
---

# Voice-call turn dedup

**The lesson:** ElevenLabs Conversational AI fires MULTIPLE completion requests to the custom-LLM endpoint per spoken turn — rolling ASR finals revise the user's sentence (A→B→A), barge-ins regenerate replies, and hard double-fires arrive within the same second. This is expected platform behavior, not a bug to work around once. Any persistence on that path must be built for it.

**The rules (all three needed):**
1. Dedup by **exact content since call start** (the voice token's issuedAt is the boundary) — scoped to the call so identical pre-call text still saves. "Compare against the latest row" is structurally insufficient: A→B→A revisions defeat it.
2. **Serialize persists per user** (in-process promise chain is enough on a single-process server) — the persist runs fire-and-forget after the response ends, so concurrent requests race any check-then-insert.
3. Apply the same dedup to **assistant** replies — genuinely different regenerations should still save (both were partly spoken), only exact duplicates drop. Side effects (anti-repetition phrase log, extraction pipeline) must only fire for rows actually written.

**Why:** duplicate rows silently poison chat history, model context, and anti-repetition state — testers saw every voice line "echoed".

**How to apply:** all voice-turn persistence goes through the single exported persist function in the voice-LLM route; never insert into messages directly from that path. Historical duplicates were repaired by a boot-time, date-gated DELETE (cutoff hardcoded just after the fix shipped; window evidence-based from measured gaps) — that repair must stay date-gated so it can never collapse future legit rapid repeats in text chat.
