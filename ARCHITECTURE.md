# Eos — How Your Product Actually Works

*A plain-language guide to the codebase, written for a non-programmer founder. Every claim below comes from reading the actual code (July 2026).*

---

## 1. The 30-second overview

Eos is one web application made of two halves that ship together:

- **The frontend** (`artifacts/aanya`) — everything the user sees in the browser: the landing page, sign-up screen, chat window, voice-call overlay, Journey page, and so on. It's a React app compiled into static files.
- **The backend** (`artifacts/api-server`) — an Express (Node.js) server that does everything real: accounts, sessions, talking to the Claude AI, talking to ElevenLabs for voice, reading and writing the Postgres database, and sending emails through Resend.

In production the backend serves the compiled frontend files itself, so the whole product lives on **one web address** (eoscompanion.com). Every frontend request to `/api/...` goes to the same server.

There is also a third, separate program: **the daily-email job** (`artifacts/daily-email`), which runs on a schedule (hourly), sends the daily morning emails, and pings two "internal" API endpoints that trigger the weekly chapter generation and the morning push notifications.

---

## 2. What happens when a visitor lands, signs up, and verifies

**Landing.** A brand-new visitor opens eoscompanion.com. The server checks: no session cookie, no special link in the URL → it serves the static marketing page `welcome.html`. If the visitor already has a login cookie (or clicked a link from an email, e.g. a verification link), they get the app itself instead. This logic lives in `artifacts/api-server/src/app.ts` (the "Landing page at the root" section).

**Sign-up.** The "Enter Eos" button takes them to the app's auth screen (`artifacts/aanya/src/pages/AuthScreen.tsx`). They enter an email and password. The frontend calls `POST /api/auth/signup` (`artifacts/api-server/src/routes/auth.ts`), which:
1. Checks the email looks valid and the password is at least 8 characters.
2. Checks no account already uses that email.
3. Scrambles the password with bcrypt (a one-way hash — the real password is never stored anywhere).
4. Creates the `users` row and logs them in immediately (a session cookie named `sid` is set; the session itself is stored in Postgres, so logins survive server restarts).
5. **After** replying to the browser, it creates a random 64-character verification token, stores it in `email_verification_tokens`, and emails a link like `eoscompanion.com/?verifyToken=...` via the Resend API. The link is valid for 7 days.

**Verification.** Until they click that link, the user is held at a "please verify" screen — every protected API route runs the `requireVerified` check (`artifacts/api-server/src/middleware/auth.ts`) and refuses with a 403 until `email_verified_at` is set. Clicking the emailed link calls `GET /api/auth/verify-email`, which stamps the account verified and deletes the token. There's a "resend" button with a 1-minute cooldown, protected against abuse.

**Consent + onboarding.** After verification, the app shows a consent screen (recorded server-side via `POST /api/profile/consent`, with the version of the consent text and a server timestamp). Then a conversational onboarding (`routes/onboarding.ts`) asks — in chat form, not a form — what brought them here, companion gender, their name, the companion's name, their age (with a hard adults-only gate: under-18 answers stop setup and store nothing), country (optional), and gender (optional). When it finishes, the companion's first greeting is written into their chat history and the app opens the chat.

**Password reset**, for completeness: "forgot password" always answers "OK" (so nobody can probe which emails have accounts), emails a 1-hour reset link *plus* a security alert with a "this wasn't me" cancel link, and when a reset succeeds it logs the user out of every device.

---

## 3. What happens when a user sends a text message

Files involved, in order:

| Step | File |
|---|---|
| Chat screen, send box, streaming display | `artifacts/aanya/src/pages/Chat.tsx` |
| The API route that receives it | `artifacts/api-server/src/routes/chat.ts` (`POST /api/chat/stream`) |
| Building the AI's "who am I, who are they" briefing | `artifacts/api-server/src/services/systemPrompt.ts` |
| The relationship-stage calculator | `artifacts/api-server/src/services/stage.ts` |
| The actual call to Claude + background extraction | `artifacts/api-server/src/services/ai.ts` |

Step by step:

1. **Your message is saved** to the `messages` table (encrypted — see §5).
2. **The stage is computed** (`stage.ts`). Eos models the relationship in 4 stages — Arrival, Held, First Step, Building — based on days since start, visit streaks, how many memories exist, mood trend, and habit streaks. The stage controls what the AI is *allowed* to do (stage 1: pure presence, no advice; stage 4: full goal/habit coaching).
3. **The system prompt is built** (`systemPrompt.ts`, ~1,100 lines). This is the companion's entire briefing: the persona and stage rules, plus this user's real data pulled live from the database — up to 30 remembered facts, active personality signals, habits and their streaks, open commitments, recent moods, active goals, story threads, the local date/time in their timezone, and the last ~15 opening phrases the AI used (so it doesn't repeat itself). It is split into a "stable" part and a "live context" part so Anthropic's prompt cache keeps the big stable part cheap (~10% of normal price on cache hits).
4. **Claude is called with streaming** (`ai.ts` → `streamCompanionReply`). Model: Claude Sonnet 4.5, max 600 tokens per reply. Each word is pushed to the browser as it's generated (SSE), which is why replies appear to "type" live. If the Anthropic key is missing or the call fails, a canned warm fallback reply is used instead of crashing.
5. **The reply is saved** to `messages` and the browser gets a "done" event.
6. **Background extraction** then runs *after* the user already has their reply (`runConversationExtractions` in `ai.ts`), so it never slows chat down. It makes up to three cheap Claude Haiku calls:
   - **Commitment extraction** (every message): did the user just agree to a concrete plan ("tomorrow at 4am I'll...")? → saved to `commitments`, with follow-up dates so the morning greeting/email can ask "how did it go?"
   - **Habit & goal detection** (every message): did the two of them agree on a recurring habit or a finite goal? → creates rows in `habits` or `goals` (goals get 3–5 AI-generated sub-tasks). Declining an offer starts a cooldown so the AI doesn't nag.
   - **Memory extraction** (every 4th user message): reads the last 8 messages and extracts durable facts ("has a sister named Priya"), personality signals, real-world wins, a 1–10 mood estimate, and "change talk" (wanting to move forward). These become the AI's long-term memory and feed the stage calculation.

So the conversation *is* the interface: memories, habits, goals, commitments, and mood are all captured from natural chat, and all of them flow back into the system prompt of every future message.

Two smaller message-like features use the same machinery: the **morning note** (`POST /api/chat/morning-note`, one per day, generated from memories + wins + pending commitments) and the **contextual greeting** (`POST /api/chat/contextual-greeting`, a time-of-day-aware "welcome back" written into the chat when the user opens the app in the morning/evening/night or after 2+ days away).

---

## 4. What happens on a voice call

There are actually **two** voice systems:

**A. "Listen" playback (classic TTS).** Any AI reply can be read aloud: the frontend calls `POST /api/tts` (`routes/tts.ts`), the server forwards the text to ElevenLabs' text-to-speech, and sends back MP3 audio plus per-character timing data that `lib/captionSync.ts` uses to highlight words as they're spoken. Voices are restricted to a fixed allowlist (13 premade + 3 "romantic" voices resolved at boot in `services/voiceLibrary.ts`).

**B. The real-time Voice Call (ElevenLabs Conversational AI).** This is the phone-call experience:

1. User taps the call button. The frontend calls `POST /api/voice-agent/session` (`routes/voice-agent.ts`). The server checks the feature flag, then asks ElevenLabs for a **signed WebSocket URL** for our agent, and mints a **voice token** — a short-lived (2 h) HMAC-signed pass that encodes *which user* this call belongs to (`lib/voiceToken.ts`). No cookie can travel with the call, so this token is how the call stays tied to the right person's memories.
2. The browser opens the WebSocket **directly to ElevenLabs** (`aanya/src/lib/realtimeVoice.ts`). ElevenLabs handles all the audio work: microphone streaming, speech-to-text, deciding when the user has finished talking, interruptions, and text-to-speech of the reply.
3. Every time the user finishes a sentence, **ElevenLabs' servers call our server back** at `POST /api/voice-llm/v1/chat/completions` (`routes/voice-llm.ts`) — an OpenAI-compatible endpoint — carrying the call transcript and the voice token. The server verifies the token, loads that user's profile/stage/memories, and streams a reply from Claude **Haiku 4.5** (chosen for speed on calls; switchable back to Sonnet with the `VOICE_LLM_MODEL` env var without any code change). The reply text streams back to ElevenLabs, which speaks it.
4. So the "brain" on a voice call is *the same brain* as text chat — same system prompt, same memories, same stage rules — with a "voice mode" addendum telling it to keep replies short and spoken-sounding, plus the user's chosen delivery tone (gentle/calm/upbeat).
5. Each spoken exchange is **persisted to the same `messages` table** with careful de-duplication (ElevenLabs fires multiple requests per turn; `persistVoiceTurn` serializes and dedups them), and the same background extraction runs — so things agreed on a call show up on the Journey page like anything else.

Clever cost detail worth knowing: the system prompt is **frozen for the duration of one call** and the transcript is cached with Anthropic's prompt caching, so each turn of a call re-reads the conversation at ~10% price instead of full price.

A startup guard (`services/agentConfigGuard.ts`) also re-checks on every production boot that the shared ElevenLabs agent's settings match what the code supports (this exists because a July 2026 config drift caused a bad "filler word" incident), and pins ElevenLabs' transcript retention to **0 days** (delete after processing).

---

## 5. How user data is stored and encrypted

**Database.** One Postgres database, accessed through Drizzle ORM. All tables live in `lib/db/src/schema/`. Roughly: `users` (email + password hash), `profile` (names, path, preferences, consent, timezone), `messages` (every chat/voice message), `memory_facts`, `personality_signals`, `wins`, `mood_scores`, `habits` + `habit_completions`, `goals` + `goal_tasks`, `commitments`, `reminders`, `weekly_chapters` + sealed notes + story threads (the weekly letter feature), `push_subscriptions`/`push_events`, `user_sessions` (login sessions), and the token tables for email verification / password reset.

**Encryption at rest.** The sensitive columns are encrypted by the application itself before they ever reach the database, using AES-256-GCM with a single master key that exists **only** in the `DATA_ENCRYPTION_KEY` environment secret (`lib/db/src/crypto.ts`). Every value gets a fresh random IV and is bound to its table+column, stored as `enc:v1:...` text. The ORM layer (`lib/db/src/encryptedColumns.ts`) encrypts on write and decrypts on read automatically, so someone with a copy of the database but not the key sees only ciphertext.

What is encrypted today: **message content, memory facts, personality signals, wins, sealed notes, weekly-chapter content, story-thread retellings, the anti-repetition phrase list, the user's name, and custom gender words.**

What is *not* encrypted (worth knowing): emails and password hashes (hashes are safe by design), and the conversation-derived planning tables — **commitments, habits, goals/goal-tasks, and reminders** — plus mood scores and country/timezone. See REVIEW.md §3 for why that gap matters.

**Key loss = data loss.** This is by design and loudly documented in the code: if `DATA_ENCRYPTION_KEY` is ever lost, all encrypted rows are permanently unreadable — there is no recovery. The server refuses to boot without a valid key. **Keep a secure offline backup of this key for each environment.** A verified, resumable migration (`services/dataEncryptionMigration.ts`) encrypted all pre-existing plaintext rows in place, and a rotation script exists (`artifacts/api-server/scripts/rotate-data-key.ts`).

**Sessions & passwords.** Passwords: bcrypt, cost 12. Sessions: random-ID cookie (`sid`), HttpOnly, Secure in production, 30-day life, stored in Postgres. Session fixation is defended (session ID regenerated at login/signup). Auth endpoints are rate-limited per IP (20 attempts / 15 min; forgot-password 5 / 15 min).

**Deletion & export.** `DELETE /api/auth/account` wipes every user-owned row across all ~20 tables in one transaction, then destroys the session — and a test (`account-deletion.test.ts`) fails the build if someone adds a new table without adding it to the wipe list. `GET /api/account/export` gives the user their full data as JSON or a styled HTML report (GDPR-style portability), decrypting everything so the user gets readable data.

---

## 6. What every folder in the repo is for

| Path | What it is | One-liner |
|---|---|---|
| `artifacts/api-server` | **Production backend** | Express server: auth, chat, voice, memory, chapters, push, export; serves the built frontend. |
| `artifacts/aanya` | **Production frontend** | The React app users see (Aanya was the product's earlier name). |
| `artifacts/daily-email` | **Scheduled job** | Hourly run (Replit Scheduled Deployment, cron `0 * * * *`): sends the daily morning email (6–9 AM in each user's timezone, once per day) and "you said 4 PM" commitment-nudge emails, and triggers the weekly-chapter + morning-push sweeps via internal HMAC-protected endpoints. Every email has a one-click unsubscribe link. |
| `artifacts/eos-video` | Side project | A Remotion-style promo/demo video built in React. Not part of the running product. |
| `artifacts/mockup-sandbox` | Side project | A UI mockup playground with its own copy of the component library. Not part of the running product. |
| `lib/db` | Shared library | Database schema (Drizzle), the encryption layer, and the shared connection pool. |
| `lib/api-zod` | Shared library | Zod validation schemas for API request/response bodies (generated from the OpenAPI spec). |
| `lib/api-client-react` | Shared library | Generated React-Query hooks for calling the API from the frontend. |
| `lib/api-spec` | Tooling | The OpenAPI contract + Orval codegen config that generates the two libraries above. |
| `scripts` | Tooling | Workspace scratch scripts (currently just a hello-world). |
| `attached_assets` | Assets dump | Uploaded images/files from development sessions. |
| `replit.md` | Docs | Old dev notes — **significantly out of date** (still says "no auth, single user"). |

---

## 7. Every environment variable, and what breaks without it

**Hard requirements — server refuses to boot or a core feature is dead without them:**

| Variable | What it is | What breaks if missing |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Server won't start at all. |
| `SESSION_SECRET` | Secret that signs login sessions, voice tokens, internal job tokens, and unsubscribe links | Server won't start. **Changing it logs everyone out and breaks in-flight voice calls / emailed unsubscribe links.** |
| `DATA_ENCRYPTION_KEY` | Master encryption key for user content (32 bytes, base64/hex) | Server refuses to boot. **Losing it permanently destroys all encrypted user data.** |
| `PORT` | Port to listen on | Server won't start (host platforms set this automatically). |
| `APP_URL` | Public URL used inside emails | In production the server throws when building any email link; without it (on Replit) links fall back to `REPLIT_DOMAINS`. Wrong/missing = verification and reset emails point to the wrong place → nobody can sign up. |

**Per-feature — the app runs, but that feature degrades:**

| Variable | Feature | Behavior when missing |
|---|---|---|
| `ANTHROPIC_API_KEY` | All AI replies | App switches to canned "mock" replies; memory/extraction silently stops. Users would notice immediately. |
| `RESEND_API_KEY` | All email (verification, reset, daily notes) | Emails are skipped and links only logged to the server console — **new users can never verify**, so effectively signup is broken in production. |
| `RESEND_FROM_EMAIL` | Email "from" address | Falls back to `Eos <hello@eoscompanion.com>`. |
| `ELEVENLABS_API_KEY` | Voice: TTS playback + voice calls | `/api/tts` returns 503; voice-call setup fails with a clear reason; romantic voices unavailable. |
| `ELEVENLABS_AGENT_ID` | Real-time voice calls | Voice call button reports "not configured". |
| `ELEVENLABS_VOICE_ID` | Optional global TTS fallback voice | Falls back to Rachel (hardcoded default). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web push notifications | Push endpoints throw; subscribe/test push fails. (Each environment needs its own pair.) |
| `VOICE_LLM_MODEL` | Voice-call model override | Defaults to `claude-haiku-4-5`. Set to a Sonnet model ID to roll back voice quality/latency tradeoff. |
| `VOICE_CALL_ENABLED` | Kill switch for voice calls | Anything but `"false"` = enabled. |
| `FRONTEND_DIR` | Where the built frontend lives | Defaults to `../aanya/dist/public`; if wrong, the API works but the site serves no pages ("API only" warning in logs). |
| `AUTH_RATE_LIMIT_MAX`, `FORGOT_RATE_LIMIT_MAX` | Auth rate-limit tuning | Default 20 and 5 per 15 min. Mainly for tests. |
| `LOG_LEVEL` | Log verbosity | Defaults to `info`. |

**Daily-email job only:** `DATABASE_URL`, `SESSION_SECRET` (must match the API server's — it derives the internal-endpoint tokens and unsubscribe links from it), `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `APP_URL`, plus `DAILY_EMAIL_DRY_RUN=true` (preview without sending) and `DAILY_EMAIL_ONLY_USER=<id>` (limit to one user for testing).

**Frontend build only:** `BASE_PATH` (the URL sub-path the app is built for — normally `/`) and `PORT` are required by `artifacts/aanya/vite.config.ts` even for a plain build; a fresh checkout's `pnpm build` fails without them.

**Platform-set (don't set these yourself):** `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN`, `REPLIT_DEPLOYMENT`, `RENDER`, `NODE_ENV`, `REPL_ID`.

---

## 8. Troubleshooting cheat-sheet

| If users report... | Look at... |
|---|---|
| "I signed up but never got the verification email" | Server logs for `Failed to send verification email`; check `RESEND_API_KEY` and Resend dashboard (bounces/suppression); check `APP_URL` is right so the link points to production. Resend flow: `routes/auth.ts`. |
| "Verification link says invalid/expired" | Tokens live 7 days; `routes/auth.ts` (`GET /auth/verify-email`). User can self-serve a new one from the gate screen ("resend"). |
| "I'm logged out constantly" / "can't stay signed in" | `SESSION_SECRET` changed? `user_sessions` table reachable? Cookie settings in `app.ts` (secure cookies require HTTPS + `trust proxy`). |
| "The AI gives generic canned replies" | `ANTHROPIC_API_KEY` missing/invalid → mock mode. Grep logs for `ANTHROPIC_API_KEY not set` or `Anthropic API error`. `services/ai.ts`. |
| "The AI forgot everything about me" | Memory extraction runs every 4th user message — check logs for `Memory extraction failed`; verify facts exist in `memory_facts`; system prompt assembly in `services/systemPrompt.ts`. |
| "Replies cut off mid-sentence" | `max_tokens: 600` in `services/ai.ts` — long replies are clipped by design. |
| "Voice call won't connect / drops instantly" | `POST /api/voice-agent/session` returns a specific `reason` (`api_key_invalid`, `api_key_permission`, `agent_not_found`, `quota_exceeded`, `elevenlabs_unreachable`) — check server logs; browser-side failures land via `POST /api/voice-agent/client-error`. `routes/voice-agent.ts`. |
| "Voice call connects but the companion talks like a stranger" | The voice token maps the call to the user — check `voice-llm: missing or invalid user token` in logs (`routes/voice-llm.ts`); confirm `SESSION_SECRET` matches between environments. |
| "Listen button does nothing" | `/api/tts` — check `ELEVENLABS_API_KEY`, ElevenLabs quota, and logs for `ElevenLabs API returned error`. `routes/tts.ts`. |
| "I said something twice in the transcript / duplicate messages" | Voice dedup logic in `persistVoiceTurn` (`routes/voice-llm.ts`); one-time repair sweep in `app.ts`. |
| "No daily email arrived" | Daily-email job logs (runs hourly; sends only 7–9 AM local time, once/day); user's `timezone` and `daily_email_opt_out` in `profile`; `artifacts/daily-email/src/run.ts`. |
| "No weekly chapter appeared" | Chapters generate Sunday evening/Monday morning local time via the internal sweep — logs for `chapter sweep finished`; `services/chapters/generate.ts`. |
| "Push notifications stopped" | Subscriptions are auto-pruned after repeated failures or key rotation; cap is 2 pushes/user/day. `services/push.ts`. |
| "Site shows a blank page but API works" | Frontend bundle missing — logs for `Frontend bundle not found`; check the build + `FRONTEND_DIR`. `app.ts`. |
| "Something crashed / users see 'Something went wrong'" | All unhandled API errors log as `Unhandled API error` with a stack trace (pino JSON logs). Every Anthropic call logs an `ai_usage` line — grep those to watch cost per feature. |
| "Is user data encrypted?" | `lib/db/src/crypto.ts` + `encryptedColumns.ts`; boot check in `api-server/src/index.ts`. |

---

*Companion document: `REVIEW.md` — a senior-engineer code review with ranked findings and the top 5 things to fix before charging money.*
