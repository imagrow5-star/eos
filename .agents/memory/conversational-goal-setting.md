---
name: Conversational goal-setting
description: How goals/routines get created from chat+voice conversation, the extraction gates that make it safe, and the prod schema-sync model.
---

# Conversational goal-setting

One extractor (the post-exchange habit-detection Haiku call) handles habits AND goals AND offer-declines. It runs from the shared dispatcher used by text chat and realtime voice; classic voice reuses the chat stream endpoint, so every channel is covered by construction.

## The rules that keep it safe

**Agreement gate:** create only when the companion proposed the thing AND the last user message clearly agrees, or the user explicitly declared/asked for it. Hesitation = null.

**Chronology gate (hard-won):** the companion reply comes AFTER the user message in an exchange. A reply that proposes and asks permission ("want me to set that?") means the user has NOT answered yet → must NOT create. Creation happens on the NEXT exchange, whose user message carries the yes.
**Why:** in live E2E, Haiku created the goal on the proposal turn without this rule — my integration tests only modeled the agreement exchange and missed it.
**How to apply:** any future conversational capture (goals/habits/commitments/anything) needs the chronology rule spelled out in the prompt AND a negative test asserting the proposal exchange creates nothing.

**Taxonomy:** recurring practice with a cue → habit (even if the user says "goal"); finite objective with an end state → goal (gets AI step breakdown); single-specific-day plan → commitment (handled by the commitment extractor, not this one). Borderline "once this week" items may land as habits — acceptable, both flow to Journey + follow-up loops.

**Decline cooldown:** a declined offer upserts personalization_state.goalOfferDeclinedAt; the system prompt renders a HOLD OFF line for 7 days (volatile context block). With no active goals/habits and stage>=3, an opportunity line invites ONE gentle offer. Both live in the context part — never in stable (cache invariant). Voice calls freeze the context per call, so mid-call declines apply on the next call — accepted tradeoff.

**Shared creation path:** goal creation is one function used by both the Journey form route and the extractor, so conversational goals are indistinguishable from manual ones (steps, Journey, emails, prompt blocks).

## Prod schema changes — publish does it

Replit's Publish flow diffs dev schema against prod and applies it when the user publishes; never hand-write prod DDL or migration scripts. Code-level try/catch guards around new-column reads are only for the replica-lag/pre-publish window, not a substitute.
