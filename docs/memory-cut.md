# Memory cut measurement

The prompt does not inject every fact. It ranks a person's active facts by
importance and keeps the top 40 (feelings the top 15). For anyone with more
than 40 facts, something is left out on every turn. This measurement says
whether what is left out ever mattered, so that any change to retrieval starts
from numbers. Nothing about retrieval changes with it.

## The log line

One `memory cut` line per chat or voice turn, numbers and the hashed user id
only, never a fact. Skipped without `LOG_HASH_SALT`, like `memory ranking`.

| field | meaning |
| --- | --- |
| `callType` | `chat`, `voice_fallback` (classic voice) or `voice` (live call) |
| `eligible` | active facts the person has |
| `included` | facts that made the prompt (at most 40) |
| `excluded` | facts that did not |
| `userHitsAboveCut` | included facts the person's message referenced |
| `userHitsBelowCut` | excluded facts the person's message referenced |
| `replyHitsAboveCut` | included facts the reply referenced |
| `replyHitsBelowCut` | excluded facts the reply referenced |

A reference is the same lexical check the importance scorer uses: the text
and the fact share a word of four or more letters that is not a stopword.
It is deliberately generous, so the below-cut numbers are an upper bound.

## Reading it

```
pnpm --filter @workspace/scripts voice-timing-summary < render-logs.txt
```

The summary groups `memory cut` lines by call type. What to look at:

- How many turns have `excluded` above zero at all. If few, the cut is not
  in play for most people yet.
- `userHitsBelowCut` on those turns. This is the person talking about
  something Eos was not shown. Compare its rate with `userHitsAboveCut`
  relative to `included` and `excluded`: if a below-cut fact is referenced
  about as often per fact as an above-cut one, importance ranking is not
  separating what matters from what does not, and a relevance boost on top
  of it would earn its place.
- `replyHitsBelowCut` is weaker evidence (the reply can share a word with a
  fact by coincidence) but a steady non-zero rate means Eos is reaching for
  things it was not told.

If the below-cut rates stay near zero, the top-40 is not losing anything
and retrieval stays as it is.

## Where it lives

- `services/memory/cutReport.ts`: the report and the log line.
- `services/systemPrompt.ts` hands the included and excluded fact text to
  the caller on `SystemPromptParts.memory`, in process only.
- Logged from the chat routes and the voice CLM route after the reply.
