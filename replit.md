# Aanya

A warm AI companion web app for people recovering from a breakup. Users talk to a personally named AI companion who remembers everything about them, tracks their mood and habits, and guides them gently from pure emotional support toward rebuilding their life — without ever feeling like a wellness app.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port determined by workflow)
- `pnpm --filter @workspace/aanya run dev` — Frontend (port determined by workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `ANTHROPIC_API_KEY` — Claude API key (app works in mock mode without it)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS v4, Framer Motion, Recharts, Wouter
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- AI: Anthropic Claude (`claude-opus-4-5` for chat, `claude-haiku-4-5` for memory extraction) with mock fallback
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — DB schema: profile, messages, memory_facts, personality_signals, wins, mood_scores, reminders, habits, habit_completions
- `artifacts/api-server/src/services/ai.ts` — Anthropic calls, mock mode, memory extraction, morning note
- `artifacts/api-server/src/services/systemPrompt.ts` — dynamic system prompt builder (injects memories, stage, wisdom)
- `artifacts/api-server/src/services/stage.ts` — relationship stage calculation (1–4) + milestone helpers
- `artifacts/api-server/src/routes/` — onboarding, profile, chat, memory, journey routes
- `artifacts/aanya/src/pages/` — Chat.tsx, Journey.tsx, Memory.tsx

## Architecture decisions

- **Single-user**: No auth. Profile is always id=1, created on first request.
- **Mock mode**: If `ANTHROPIC_API_KEY` is unset, the app returns warm stage-appropriate hardcoded replies with a simulated delay. All other functionality (memory, habits, journey) works fully.
- **Memory extraction**: Triggered every 4 user messages as a background job (does not block response). Uses `claude-haiku-4-5` for cost efficiency.
- **Relationship stages** (1→4, forward-only): Stage gate based on visit days, memory count, change-talk detection, mood average, and habit streak — never just time.
- **Forgiving streak**: A streak doesn't break until the user misses 2 consecutive days (today and yesterday both absent).

## Product

- **Onboarding**: Conversational (chat-based, never a form) — companion asks name, relationship type, energy, and her own name
- **Chat**: Full message history, typing indicator, morning note (once daily), voice mode with browser SpeechRecognition + speechSynthesis
- **Journey panel** (`/journey`): Stage badge, day/streak/wins stats, mood line chart, habits with 7-day completion dots, milestone grid, wins list
- **Conversational goal-setting**: "set a goal for me" (or a companion offer at steady moments — never in acute distress, 7-day cooldown after a decline) → one small grounded proposal → clear yes creates the goal/routine right from chat or voice; the Journey form still works too
- **Memory panel** (`/memory`): Personality signals with confidence levels, remembered facts by category

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Realtime Voice Call flag is ON by default**: set `VOICE_CALL_ENABLED=false` on the api-server + restart to temporarily hide the Voice Call button/overlay and refuse `POST /api/voice-agent/session` (runtime `process.env` read in `src/lib/featureFlags.ts`, surfaced via `GET /api/voices/status` — no rebuild needed). Per-message "Listen" TTS is separate and never gated.
- **Voice-call failures must never be silent**: the session endpoint returns SPECIFIC reasons instead of downgrading to public-agent mode (`api_key_permission` = ElevenLabs key lacks the Conversational AI scope, `api_key_invalid`, `agent_not_found`, `elevenlabs_unreachable`); the call screen shows them verbatim, and browser-side WebSocket failures are reported to `POST /api/voice-agent/client-error` so they land in the server logs.
- **Voice tokens are env-tagged (`dev`/`prod`)**: dev and prod share `SESSION_SECRET` but have separate databases with overlapping user ids, so `verifyVoiceToken` rejects tokens minted in the other environment — otherwise a workspace-preview call could load a real production user's memories. Consequence: test Voice Call in the **published app**; a preview-originated call connects but fails visibly on the first reply (the ElevenLabs agent's Custom LLM URL points at production).
- **ElevenLabs agent config is API-managed** (key has Conversational AI write scope): custom LLM → production `/api/voice-llm/v1`, "extra body" ON, per-user voice override ON, `first_message` empty (listen-first). If calls ever greet generically again, the agent config regressed — PATCH it back via the API; snapshot the agent JSON before any PATCH.
- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` before touching routes or frontend
- The `@anthropic-ai/sdk` uses `require()` dynamic import in the ai.ts service to avoid crashing when key is absent
- `voice.ts` uses a ref pattern for the `onResult` callback to avoid an infinite re-render loop in `useSpeechRecognition`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
