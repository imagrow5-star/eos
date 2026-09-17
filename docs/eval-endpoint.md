# Evaluation endpoint

`POST /api/eval/turn` gives an external evaluation harness one text turn
of the real product without an account, a session, or a single row written.

It exists so someone can test Eos as a system: the real prompt, the real
model, the real crisis floor, and above all the real memory path. The
caller hands over the person Eos is talking to, including the facts and
feelings Eos is supposed to remember, and those go through the same
importance ranking, the same top-40 cut and the same formatting as rows
read from the database. Recall is evaluated the way it actually behaves.

## What it never does

- Writes nothing: no message, no memory, no crisis event, no per-user
  state. The stand-in user id (-2) matches no row, so no lookup can touch a
  real person's data.
- Logs nothing anyone said: one `eval turn` line of counts, plus the usual
  counts-only `ai_usage` line.
- Touches voice. Text only.

## Configuration (Render, web service)

| Variable | Meaning |
| --- | --- |
| `EVAL_API_KEY` | The bearer key. At least 32 characters; generate with `openssl rand -hex 32`. Unset means the route answers 404 and exposes nothing. |
| `EVAL_TURNS_PER_DAY` | Daily budget across every call made with the key. Default 500. Counted in memory, so a deploy resets it. |

Rotate the key by changing the variable. Hand it over out of band, never in
a repository or a ticket.

## Request

```
POST https://eoscompanion.com/api/eval/turn
Authorization: Bearer <EVAL_API_KEY>
Content-Type: application/json
```

```json
{
  "message": "I finally called my mum back last night.",
  "history": [
    { "role": "user", "content": "Hey. Long day." },
    { "role": "assistant", "content": "Hey. What made it long?" }
  ],
  "profile": {
    "name": "Maya",
    "companionName": "Eos",
    "path": "breakup",
    "energy": "calm",
    "country": "UK",
    "ageBand": "26-35",
    "timezone": "Europe/London",
    "language": "en",
    "daysSinceJoined": 21,
    "stage": 3
  },
  "memory": {
    "facts": [
      { "text": "Her mum has been unwell since the spring", "category": "person", "daysAgo": 20, "timesReferenced": 4, "emotionalWeight": 0.7 },
      { "text": "She has been avoiding calling her mum back", "category": "life", "daysAgo": 6, "timesReferenced": 2 },
      { "text": "Split up with Dan in August", "category": "event", "daysAgo": 21, "important": true }
    ],
    "feelings": [
      { "text": "Guilty every time the phone rings and it is her mum", "emotion": "shame", "daysAgo": 6 }
    ]
  }
}
```

Every field except `message` is optional.

- `history`: whole user/assistant exchanges, in order, at most 40 turns
  (80 messages). The caller carries the history between calls; the server
  keeps none.
- `profile.path`: `support`, `breakup`, `bereavement` or `lonely`.
  `energy`: `calm`, `playful` or `deep`. `country`: `US`, `UK`, `AU`,
  `other` or empty (the helpline block follows it).
- `profile.daysSinceJoined` sets how long Eos has known the person.
  `profile.stage` (1 Arrival, 2 Settling, 3 Working, 4 Established)
  overrides the derived stage; without it, 14+ days gives 3, 3+ days with
  8+ facts gives 2, otherwise 1.
- `memory.facts`: up to 200. `category` is `life`, `preference`, `event`,
  `person` or `goal`. `daysAgo`, `timesReferenced`, `emotionalWeight`
  (0 to 1) and `important` feed the same importance score as real facts,
  so a harness can test what survives the cut and what does not.
- `memory.feelings`: up to 50, each with an `emotion` family such as
  `grief`, `shame`, `joy`, `fear`, `anger`, `love`, `loneliness`, `hope`,
  `anxiety` or `pride`.

## Response

```json
{
  "reply": "You called her. After all that. How did it go?",
  "stage": 3,
  "crisis": { "active": false, "tier": null, "helplineBlock": null },
  "memory": {
    "facts": { "eligible": 3, "included": 3, "excluded": 0 },
    "feelings": 1,
    "referencedByReply": { "aboveCut": 1, "belowCut": 0 },
    "referencedByMessage": { "aboveCut": 2, "belowCut": 0 }
  },
  "model": "claude-sonnet-4-5-20250929",
  "usage": { "input_tokens": 4210, "output_tokens": 38, "cache_read_input_tokens": 3900, "cache_creation_input_tokens": 0 },
  "flags": { "bannedComfort": [], "selfNarration": [] }
}
```

- `reply` is what the person would see. On a crisis turn it carries the
  same helpline block the app appends, and `crisis.helplineBlock` repeats
  it separately so a harness can strip it.
- `crisis.tier` is `clear` (regex) or `possible` (semantic backstop) when
  active.
- `memory.facts.included` is how many of the supplied facts made the
  prompt after the top-40 cut. `referencedByReply` counts included and
  excluded facts the reply lexically touched, using the same check as the
  production memory-cut measurement (`docs/memory-cut.md`). It is a
  cheap signal, not a judgement of recall quality.
- `usage` is what the provider reported; `null` in keyless mock mode.
- `flags.bannedComfort` lists any banned "I'm here for …" comfort phrases the output guard found and rewrote. `flags.selfNarration` lists any self-narration it stripped — a `*(stage direction)*`, a `(Rule N)` citation, or a Care-System mode name. Both are empty when clean, and the `reply` above is already the cleaned text.
- `degraded: true` appears only when the provider call failed and the
  reply is the honest fallback line.

## Errors

| Status | Body | Meaning |
| --- | --- | --- |
| 404 | `{ "error": "Not found" }` | `EVAL_API_KEY` is not configured. |
| 401 | `{ "code": "EVAL_UNAUTHORIZED" }` | Missing or wrong bearer key. |
| 400 | `{ "error": "<field>: <problem>" }` | Validation, including a history that is not whole exchanges. |
| 429 | `{ "code": "RATE_LIMITED" }` | The daily budget is spent. `RateLimit-*` headers say when it resets. |
| 500 | `{ "error": "The turn failed. Try again." }` | Unexpected failure. Nothing was written. |

## Cost

One Sonnet call per turn over the system prompt, the memory and the
history, plus one Haiku classifier call when the regex crisis check misses.
Each turn is logged as an `ai_usage` line with `callType: "eval"` and an
estimated cost, so the spend is visible with the usual grep.
