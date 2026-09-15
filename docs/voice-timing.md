# Voice turn timing

Where the seconds go on a call, measured, so tuning starts from numbers.
Every spoken turn writes one log line with stage durations. The lines carry
numbers, booleans and a hashed user id only, never a word of what was said.

## The three log lines

Search Render's logs (or a downloaded export) for these exact strings.

| grep string | Written by | One line per |
| --- | --- | --- |
| `voice turn timing` | api-server, `routes/voice-llm.ts` | CLM turn on a real call (greeting and real turns) |
| `voice turn timing (client)` | api-server, `POST /api/voice-agent/turn-timing`, sent by the call screen | reply the person hears |
| `demo voice turn timing` | api-server, `routes/demoVoice.ts` | turn on the landing-page voice demo |

### Server line, real turn (`greeting: false`)

| field | meaning |
| --- | --- |
| `authMs` | voice token check |
| `profileMs` | profile load (primed per call, so usually near zero) |
| `dbMs` | memory and history reads |
| `promptMs` | system prompt build; `frozenHit` says the frozen per-call prompt was reused |
| `classifierRan` | the semantic crisis classifier ran (no regex hit, not a greeting) |
| `classifierMs` | classifier wall time from its start, or `null` when it did not run or was still running when the reply finished. It no longer holds the reply up: a late yes shows the card through the poll and arms the next turn's reinforcement. |
| `crisisArmed` | this turn's reinforcement block came from a late detection on the previous turn |
| `firstTokenMs` | model time to first streamed token |
| `firstSentenceMs` | model time to the first sentence boundary in the streamed text. If Hume synthesises per sentence, its first audio should trail this, not `totalMs`. |
| `modelMs` | model time to the last token |
| `totalMs` | request in to response out |
| `replyWords`, `contextTurns` | reply length and prior turns sent as context |
| `resumed` | this turn followed a mid-call reconnect and the pre-drop turns were loaded back from the database |
| `aborted`, `abortedAtMs` | Hume cancelled the request mid-reply because the person started talking again (end of turn fired mid-thought), and when. The provider stream is stopped, the person's words are stored, the unheard reply is not. A high abort rate means the EVI end-of-turn silence is too short. |
| `crisis`, `degraded`, `tone` | crisis block added, provider fallback used, tone delivery applied |

### Server line, greeting (`greeting: true`)

`authMs`, `profileMs`, `totalMs`, `replyWords`, plus `curated` (English pool
line, no model), `primedProfile`, and `reconnect` (the empty transcript came
from Hume redialling mid-call, so Eos said the resume line instead of a
second greeting).

### Client line

Measured in the browser from Hume's socket events (`lib/turnTiming.ts`):

| field | meaning |
| --- | --- |
| `lastInterimToFirstAudioMs` | the last interim transcript of the person's turn to the first audio of the reply. Interims arrive while the person is still talking, so this is the wait the person feels, within one interim's lag. |
| `finalToFirstAudioMs` | Hume's final transcript to the first audio. Hume hands the final transcript over together with the reply, so this reads a few tens of ms and is Hume's delivery gap, not the wait. |
| `textToFirstAudioMs` | reply text to its first audio. Text and audio arrive together after synthesis, so this is small; Hume's synthesis time is `lastInterimToFirstAudioMs` minus the end-of-turn silence minus the server's `totalMs`. |
| `userEndToFinalMs` | end of the person's speech to the final transcript, only when Hume's utterance timestamp is wall-clock. In practice Hume's timestamps are relative, so this is `null`. |
| `turn`, `greeting` | reply number in the call, and whether it was the greeting |

Subtract the server `totalMs` from `lastInterimToFirstAudioMs` to see how
much of the wait is Hume's own end-of-turn silence and synthesis rather than
our server. Compare Hume's first audio against `firstSentenceMs` and
`totalMs` to see whether it waits for the first sentence or the whole reply.

## Medians from a log export

```
pnpm --filter @workspace/scripts voice-timing-summary < render-logs.txt
```

Prints count, median, p90 and max per field, grouped by line type and by
greeting or real turn, plus how often each boolean was true. Lines that are
not timing lines are ignored, so the raw export can be piped in as is.

## Rate limits

The client beacon is limited per user (`VOICE_TURN_TIMING_LIMIT_PER_HOUR`,
default 600, and `_PER_DAY`, default 2400). A body without a numeric `turn`
is a 400; other fields outside 0 to 120000 ms are logged as `null`.
