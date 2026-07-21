---
name: Voice-call turn duplication
description: Why realtime voice turns save twice — ElevenLabs fires multiple LLM completions per spoken turn; the persist guard is single-row + racy, assistant insert unguarded.
---

# Voice-call turn duplication (diagnosed from prod data, not yet fixed)

The realtime voice engine has exactly ONE persistence site (the custom-LLM endpoint's fire-and-forget persist block). There is no frontend transcript save and no webhook save. Duplicates come from that one site running on MULTIPLE completion requests for the same spoken turn.

**Why multiple completions per turn (ElevenLabs behavior, observed in prod):**
1. Rolling ASR finals — the user's utterance re-finalizes ("Hello, what are you doing?" → "…Just wanted to…" → "…Hey.") and each revision triggers a fresh LLM call whose transcript ends at a same-or-revised user turn.
2. Same-second double-fires / regenerations — two overlapping requests for one turn (prod rows in the same second).

**Why the guards don't hold:**
- User insert guard compares ONLY the single latest user row by content. An A→B→A revision sequence defeats it (A re-inserts because B is now the latest). Concurrent requests race check-then-insert (both read stale "latest" before either commits — fire-and-forget after res.end, no serialization).
- Assistant insert has NO guard at all — every completion request saves its full reply, so retried/regenerated requests store identical assistant rows seconds apart.

**Minimal fix direction (agreed in investigation):** existence check scoped to the call — "identical row for this user+role since the call token's issuedAt" — for BOTH roles, plus serialize the persist block per user (single-process server, an in-process per-user promise chain suffices) or use INSERT…WHERE NOT EXISTS to shrink the race. issuedAt is already in the handler (used for the pre-call history boundary). Content-based dedup intentionally does NOT collapse near-duplicate ASR revisions (genuinely different text) — full fix for those needs turn-index identity (count of user turns in the request transcript), a bigger change.

**How to apply:** any future persistence keyed off ElevenLabs custom-LLM calls must assume N≥1 calls per spoken turn and dedup accordingly; never trust "one request = one turn".
