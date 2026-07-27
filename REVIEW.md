# Eos — Senior Engineering Review

*A pre-launch review of the whole repo, written as a careful senior engineer would before real customers start paying. Read `ARCHITECTURE.md` first for what everything is. Findings are ranked within each section; the "Top 5" at the end is the executive summary.*

**Overall verdict up front:** this is a genuinely well-built codebase for its age — far above typical early-startup quality. Auth is hardened (session regeneration, enumeration-proof responses, timing-safe token compares, cooldowns), the encryption layer is real and carefully engineered, account deletion is transactional with a test that fails the build if a table is missed, and 252 server/job tests pass. The problems below are real, but most of them are the *last 15%*, not structural rot.

Test run (this review, against a fresh local Postgres): **29 test files, 252 passed, 6 skipped, 0 failures.**

---

## 1. Correctness & reliability

### 1.1 HIGH — When the AI provider fails, paying users get fake replies and nothing alerts you
`artifacts/api-server/src/services/ai.ts` (streamCompanionReply / getCompanionReply): any Anthropic error falls back to a canned "mock" response — one of ~20 hardcoded lines — and the request is treated as a success. The same pattern exists in the daily-email job (`daily-email/src/run.ts` ~line 565): if the Anthropic key is revoked or the API is down, **every user still receives an email**, just a generic one, `markSent` records success, and the run's failure counter stays at 0. Mock mode is great for development, but in production it means a total AI outage is invisible in your metrics and users quietly get a degraded product they're paying for. Fix: in production, surface an honest error to the user (chat) and count generation failures as failures (email), plus an alert when the mock/fallback path fires.

### 1.2 HIGH — The hourly email job won't scale past a few hundred users and has no overlap guard
`daily-email/src/run.ts` processes users **one at a time**: each eligible user is one multi-second Claude call + one Resend call + ~10+ database queries (there are per-habit and per-goal query loops). At a few thousand users the run can't finish within the hour, and there is no protection against the next hourly run starting while the previous one is still going (double emails are only prevented by the `lastEmailDate` stamp, which is written *after* sending). Also: `DAILY_EMAIL_ONLY_USER` set to a typo becomes `NaN` and silently skips **every** user; the commitment-nudge "claim release" on send failure doesn't check it still owns the claim.

### 1.3 MEDIUM — Schema changes are managed three different ways
The real schema is Drizzle (`lib/db/src/schema/`), but `app.ts` also runs ~8 fire-and-forget "safety-net" `ALTER TABLE`/`CREATE TABLE` patches on every boot (failures only logged), and `scripts/post-merge.sh` runs `drizzle-kit push` — an unreviewed schema mutation — automatically on every merge against whatever `DATABASE_URL` the environment holds. This works today but is how production schemas drift. Consolidate on proper migrations before billing tables arrive (billing bugs + schema drift is a bad combination).

### 1.4 MEDIUM — Several servers' worth of state lives in process memory
The auth rate limiter (express-rate-limit default memory store), the voice-call frozen-prompt cache, the per-user voice persistence chains, and the resolved voice map all assume **one server process**. The deployment is autoscale-capable; at >1 instance the rate limits halve in effectiveness and voice dedup weakens (the DB-level dedup checks still catch most of it). Fine for now — but know that "scale to 2 instances" is not free.

### 1.5 MEDIUM — Broken entry funnel on the marketing page
`welcome.html`'s "Enter Eos" / "Sign in" buttons all link to `/?enter=1`, which routes to the app — but the app ignores `?enter=1` entirely (`aanya/src/App.tsx` initializes to the *second* marketing page, `LandingPage.tsx`, for every logged-out visitor). So a visitor who clicks "Sign in" lands on… another landing page, and has to click again. Nothing is broken functionally, but this is measurable conversion friction at exactly the moment you'll start paying for it.

### 1.6 MEDIUM — Voice playback can hang forever
`aanya/src/lib/voice.ts` (~line 312): the "Listen" playback awaits a promise that only resolves on `canplaythrough`/`ended`/`error`. A media element that never becomes playable (blocked autoplay, stalled network) resolves none of these — the voice state machine wedges until page reload. Same file: an abort-listener leak and module-level singletons that make the settings voice preview and a live reply fight over global state.

### 1.7 LOW — Assorted
- `POST /api/chat/stream`: if the browser disconnects mid-reply, the server keeps generating (and paying for) the full Claude response. Abort the Anthropic stream on `res`'s close event.
- Chat.tsx's settings panel fires the full `GET /api/account/export/summary` (17 COUNT queries) every time settings is opened.
- `Journey.tsx` polls `/api/commitments` every 30s forever, including backgrounded tabs.
- `aanya/src/api/contextualGreeting.ts` hardcodes `/api/...` (ignores `BASE_URL`) — 404s if the app is ever deployed under a sub-path.
- The frontend build fails on a clean checkout unless `PORT`/`BASE_PATH` are set (`vite.config.ts` throws even for `vite build`).
- `Chat.tsx` is 3,323 lines with 53 `useState` hooks — the concurrency discipline in it is genuinely careful, but it's the repo's biggest future-bug factory. Extract `useVoiceCall()`, `useChatStream()`, `<SettingsPanel/>`.

---

## 2. Data ownership — route by route

I walked every route in `artifacts/api-server/src/routes/`. Method: does each read/write filter by the session's `userId` (set by `requireAuth`, verified email enforced by `requireVerified`)?

**One real hole found:**

### 2.1 HIGH — `PUT /goals/:id/tasks/:taskId` lets a user modify another user's goal task
`routes/goals.ts` lines ~109–113: the route correctly verifies the **goal** belongs to the caller, but then updates the **task** by `taskId` alone:
```ts
db.update(goalTasksTable).set({ isComplete }).where(eq(goalTasksTable.id, taskId))
```
There is no check that the task belongs to that goal (or to any goal the caller owns). Task IDs are sequential integers, so any signed-in user can flip `isComplete` on any other user's task by sending their own goal id + a guessed taskId — and the follow-up "auto-complete goal when all tasks done" logic then reads the *attacker's* goal, so the victim's goal state can also be silently skewed. Small blast radius (one boolean on a task), but it is a genuine cross-tenant write. Fix: `where(and(eq(goalTasksTable.id, taskId), eq(goalTasksTable.goalId, goalId)))`.

**Everything else checks out.** The full table:

| Route file | Routes | Ownership verdict |
|---|---|---|
| `auth.ts` | signup/login/logout/me/verify/resend/change-email/cancel-*/forgot/reset/delete-account | ✅ Session- or token-scoped throughout; deletion wipes ~20 tables in one transaction, guarded by a build-failing test |
| `chat.ts` | messages list/delete, stream, send, greeting, morning-note | ✅ Every query filters `userId`; message delete also scrubs story-thread quotes + dismissals in one transaction |
| `memory.ts` | facts, signals, wins, habits CRUD + complete | ✅ All filtered; habit completion verifies habit ownership first |
| `profile.ts` | get/put profile, consent | ✅ Profile fetched/updated by `userId` (creation race fixed with advisory lock) |
| `onboarding.ts` | status, answer | ✅ Profile-scoped; adults-only gate is server-enforced (client can't skip the age step) |
| `journey.ts` | journey, mood | ✅ All aggregates filtered by `userId` |
| `goals.ts` | list/create/delete goals; **update task** | ⚠️ **Task update — see 2.1.** Others fine (list joins tasks via owned goals; delete filtered) |
| `commitments.ts` | list/update/delete | ✅ Filtered |
| `chapters.ts` | list, get, threshold, note, defer, quote-dismiss, offer | ✅ Chapter ownership checked on every route; quote-dismiss verifies the *message* is the caller's; offer accept/decline uses row-lock claims against double-taps |
| `account.ts` | export (json/html), report, summary | ✅ Every one of the ~19 queries is `WHERE user_id = $1` |
| `push.ts` | vapid-key, subscribe, unsubscribe, test | ✅ Scoped. (Subscribe re-binds an endpoint to the current user by design — endpoints are unguessable browser secrets, this is correct.) |
| `tts.ts`, `voices.ts`, `voice-agent.ts` | tts, status, session, client-error | ✅ No per-record data; voice session mints a token for the session user only |
| `voice-llm.ts` | ElevenLabs callback (public) | ✅ HMAC voice token (userId + call-start + expiry + env tag, timing-safe compare) is the identity; all queries scoped to it. Env tag prevents dev tokens working in prod |
| `chapters.ts` / `push.ts` internal | sweep triggers (public) | ✅ HMAC over the UTC hour, timing-safe, current+previous hour only. (Replayable within its hour — harmless: the sweeps are idempotent.) |
| `email.ts` | unsubscribe (public) | ✅ HMAC per user. Minor: the token never expires — a leaked link can unsubscribe that user forever. Acceptable. |
| `health.ts` | healthz (public) | ✅ No user data |

Also checked and worth praise: `requireVerified` runs on **every** protected route (a DB check per request — mild perf cost, correct behavior), and the pino request logger strips query strings, so emailed tokens (`?verifyToken=...`) don't land in your own logs.

---

## 3. Privacy promises vs. reality

Your site makes strong promises. Most of them are **actually implemented** — which is rare and worth saying. But three pages tell three different stories, and a few specific claims overshoot what the code does.

**What's true and verifiable in code:**
- ✅ *"Encrypted at the field level"* — real. AES-256-GCM per value, random IVs, applied by the app before data reaches Postgres (`lib/db/src/crypto.ts`). A stolen database dump without the key is unreadable for messages, memories, names, chapters, sealed notes.
- ✅ *"Never used to train AI"* — consistent with the code: standard Anthropic API (no training on API traffic per their terms), and the boot guard (`agentConfigGuard.ts`) actively pins ElevenLabs transcript/audio retention to **0 days** on every production boot. Nothing anywhere ships data to a training pipeline.
- ✅ *"No ads, no trackers"* — I grepped for every common analytics/pixel vendor: nothing. The CSP would block them anyway.
- ✅ *"Delete means delete"* — account deletion is a single transaction across ~20 tables with a test that fails the build if a new table is missed. Single-message "forget" hard-deletes and scrubs derived quotes.
- ✅ *"No admin screen"* — true; no admin routes exist.

**Where claims and code diverge — fix the words or fix the code:**

### 3.1 HIGH — "Not even the founder can read them" is not literally true
`welcome.html` (~line 444): *"Notice we don't say we **won't** read them. We say we **can't**."* and `LandingPage.tsx` (~315): *"Not our team. Not even the founder."* Reality: the server decrypts on every request, and the founder holds both the database and `DATA_ENCRYPTION_KEY`. Anyone with those two things (you, a hosting-level attacker who gets the env, a subpoena directed at you) **can** read everything — the export endpoint literally does. What you've built is honestly excellent ("encrypted at rest; the operator holds the key; no admin interface exists") but it is not the zero-knowledge/end-to-end claim the marketing makes ("ENCRYPTED END-TO-END" at welcome.html:381 is flatly wrong — E2E means keys only on user devices). For a mental-health product this is FTC-deception territory. Soften the two marketing pages to match what `Privacy.tsx` should say.

### 3.2 HIGH — A third of the sensitive data is not actually encrypted
"Field-level encryption" covers messages, memory facts, signals, wins, names, chapters, sealed-note text, story retellings. **Plaintext today:** `commitments.content/cue/qualityNote`, `goals.title/description`, `goal_tasks.content`, `habits.name/whenThen/reason`, `reminders.content`, `story_threads.label` (e.g. "the airport goodbye"), `profile.userPath` (breakup/bereavement — a life-event inference), all mood scores, and — sharpest of all — **`sealed_notes.crisis_flagged`**: the note text is encrypted but the boolean marking a user as having written crisis/self-harm language is queryable in plaintext (`SELECT user_id FROM sealed_notes WHERE crisis_flagged`). These are all verbatim-from-conversation or mental-health-signal fields, semantically identical to the encrypted ones. Extend the encrypted-column list (the migration machinery to do this already exists and is excellent) or scope the marketing claim to "conversations."

### 3.3 MEDIUM — "Voice is never stored" (welcome.html:452) is half-true
Audio: correct, not stored, and ElevenLabs retention is pinned to 0. But voice **transcripts are stored** as normal messages — that's the whole point of the shared memory. `Privacy.tsx` discloses this honestly ("voice calls become text"); the landing page hides it. Align the landing page.

### 3.4 MEDIUM — The three pages disagree, and the consent screen is the weakest one
- `Privacy.tsx` *understates* your encryption ("encrypted on disk and in transit" — that's just Neon's default; your field-level layer isn't even mentioned). Funny inversion: the legal page undersells, the marketing oversells.
- `ConsentGate.tsx` — the screen users actually consent on — names only two processors (Anthropic, ElevenLabs), omitting Resend and the host/DB. The consent screen should be the superset.
- "Delete means delete. One tap. Permanently." (welcome.html) omits the already-written-chapters nuance that `Privacy.tsx` discloses.
- `Privacy.tsx` itself says at the top of the file: *"needs review by a qualified lawyer before any PAID launch."* Do that.

### 3.5 LOW — Internal hygiene is genuinely good
Code repeatedly avoids logging message content (only lengths/counts), the account report iframe is fully sandboxed, tokens don't reach logs, VAPID keys moved out of the DB. Two stragglers: the legacy `push_config` table still holds an old VAPID private key in plaintext (drop it), and verification/reset tokens are stored raw rather than hashed (acceptable for short-lived tokens; hash them when convenient).

---

## 4. Cost safety (Anthropic + ElevenLabs)

**The pattern to copy already exists in your own repo:** push notifications have an atomic, race-proof cap of 2/user/day. Nothing else has anything like it.

### 4.1 HIGH — No rate limit and no size limit on any AI endpoint
The only rate limiter in the entire server is on `/api/auth/*`. A signed-in user (or a script with a stolen session cookie, or just an angry user with a `while true; do curl ...` loop) can call, unbounded:
- `POST /api/chat/stream` / `send` — each call = 1 Sonnet call (+2 Haiku extraction calls, +1 more every 4th message). `SendMessageBody.content` is `z.string().min(1)` with **no max length** and the JSON body limit is 1 MB — so a single message can also be enormous, inflating each prompt.
- `POST /api/tts` — each call = an ElevenLabs charge (text capped at 5,000 chars/call, calls uncapped).
- `POST /api/chat/contextual-greeting` — Sonnet call (has a 6-hour cooldown gate, decent).
- `POST /api/voice-agent/session` + the call itself — ElevenLabs conversation minutes; per-turn Haiku calls on `/api/voice-llm/...` (HMAC-gated but per-token unlimited for 2 hours; no call-length or per-day-minutes cap on your side — you're relying on ElevenLabs' account quota as the only stop).

One user cannot bankrupt you *per call* (max_tokens 600, prompt caching is aggressively and correctly used), but **per hour** there is nothing between one motivated client and your Anthropic invoice. Fix: an express-rate-limit on `/api/chat/*` and `/api/tts` (e.g. 30 messages / 10 min / user), a `.max(4000)` on message content, and a cheap per-user daily message counter with a soft in-character ceiling.

### 4.2 MEDIUM — The daily job's spend scales with the users table, uncapped
One Sonnet call per eligible user per day + Haiku nudges, sequential, no `MAX_SENDS_PER_RUN`, no budget guard (§1.2). A bug that resets `last_email_date` would re-email (and re-bill) everyone every hour until noticed.
Also: weekly chapter generation (Sonnet, multiple calls per user per week) has per-user idempotency (unique week rows) — good — but the same no-global-budget property.

### 4.3 LOW — Cost observability is half-built
Every Anthropic call logs an `ai_usage` line with token counts and estimated USD — genuinely useful. But it doesn't include `userId`, so you can't answer "who is costing me money," and the price tables are hardcoded in **two** diverging copies (`ai.ts`, `run.ts`) that silently return `undefined` cost for any unknown model ID. Add userId to the log line and unify the table.

### 4.4 LOW — Streaming waste on disconnect
See §1.7: a closed browser tab doesn't cancel the in-flight Claude stream.

---

## 5. Payment readiness (Paddle)

Where you stand: **the marketing already sells billing that doesn't exist.** `welcome.html` promises "7-DAY FREE TRIAL · CANCEL IN ONE TAP · SECURE CHECKOUT BY PADDLE" and links to `/terms` and `/refunds` — neither page exists, and there is zero billing code anywhere. What will make Paddle harder if not addressed first:

1. **No plan/entitlement model.** `users` is `id, email, hashed_password, email_verified_at, created_at` — nothing about plan, trial, or subscription state, and no billing tables. You'll need: a `subscriptions` (or plan columns) table keyed by `users.id` storing Paddle customer id + subscription id + status + period end, written **only** by webhook events (idempotently — Paddle retries webhooks, so record processed event IDs).
2. **Webhook body parsing.** `app.ts` applies `express.json()` globally. Paddle signature verification requires the **raw** request body. Mount the webhook route with `express.raw()` *before* the global JSON parser (or use `express.json({ verify })` to capture the raw body). Easy now, an annoying refactor later.
3. **A natural gating point exists — use it.** The `requireAuth → requireVerified` middleware chain in `routes/index.ts` is exactly where a `requirePlan` / trial check slots in. The 4-stage relationship model even gives you a natural free-tier boundary. This is the good news: gating will be clean.
4. **Honest failure for paying users.** The silent mock-reply fallback (§1.1) is incompatible with charging money.
5. **Account deletion + export vs. billing records.** Your deletion wipes everything instantly; once you have paying customers you must *retain* invoice/transaction records (tax law) while deleting personal content. Plan for "delete content, keep billing skeleton" now, and add the billing tables to the deletion test's explicit-decision list.
6. **Trial abuse.** Signup is email+password with free AI usage from message one; with a 7-day trial, disposable emails become a cost vector — one more reason for §4.1's caps.
7. **Legal pages.** Paddle's checkout approval generally requires working terms/refund pages; the links are already in your footer pointing at 404s. Also the in-repo privacy page needs the lawyer pass it asks for.
8. Positives: single-origin session auth (no CORS pain for checkout redirects), Postgres-backed sessions, the change-email flow already handles the "email is identity" problem properly, and consent versioning gives you a pattern for ToS versioning.

---

## 6. Dependency health

**`pnpm audit`: 5 findings — none in code that runs while serving users.** 4 high + 1 low, all in build/codegen tooling:
- `js-yaml`, `fast-uri`, `brace-expansion` — all inside `orval` (the API code generator in `lib/api-spec`); it only runs when you regenerate the API client on your machine.
- `postcss` (< 8.5.18) — inside Vite; build-time only.
- `esbuild` (low) — dev-server issue, Windows-only.

Plain-language: nothing here is reachable by an attacker through your website. Still cheap to clean up: update `orval`, bump `vite` patch, set `esbuild` to 0.28.1. Meanwhile your `pnpm-workspace.yaml` enforces a 1-day minimum release age on new packages — a genuinely good supply-chain defense most startups don't have.

**`pnpm outdated`: nothing urgent.** Worth doing: `@anthropic-ai/sdk` 0.111 → 0.115 (routine), `@elevenlabs/client` patch, the Radix UI patch wave, and delete deprecated `@types/bcryptjs` (bcryptjs v3 ships its own types). Worth **not** doing now: zod 3→4, pino 9→10, TypeScript 5.9→7, recharts 2→3, Vite 7→8 — all majors with migration cost and no current pain. The `express@5` and `react@19` pins are already modern.

One process note: the generated API client (`lib/api-zod`, `lib/api-client-react`) is only regenerated by convention — no CI check that it matches `openapi.yaml`. Drift will eventually ship a frontend that disagrees with the server.

---

## 7. Dead weight & test coverage

**Delete/clean candidates (biggest first):**
| What | Why |
|---|---|
| `artifacts/mockup-sandbox` (~412 KB src + ~40 Radix deps) | A mockup preview harness whose mockups directory **doesn't exist** — the generated manifest is literally empty. Pure install/typecheck weight. Strongest deletion candidate in the repo. |
| `artifacts/eos-video` | Standalone promo-video project with heavy deps (`three`, `gsap`, `lottie`) used nowhere by the product. Keep it if you use the video, but consider moving it out of the workspace so product builds/typechecks stop paying for it. |
| `replit.md` | Actively misleading: says "Single-user: No auth. Profile is always id=1" and names wrong models. Anyone (human or AI assistant) reading it will make wrong changes. Rewrite or delete. |
| `reminders` table + schema | Nothing ever creates a reminder — the table is written by no code path. Dead feature; remove or ship it. |
| `push_config` table | Legacy home of VAPID keys (now env vars); prod row still holds a plaintext private key. Drop it. |
| `attached_assets/` (3 JPEGs) + the `@assets` vite alias | Alias configured, zero imports anywhere. |
| `aanya/src/pages/not-found.tsx` | Never imported; off-brand; leaks a dev message. The real 404 is inline in App.tsx. |
| `scripts/src/hello.ts` | Hello-world placeholder in the typecheck path. |
| "A S H A" branding leftovers | The **user-facing data export report** still renders the old wordmark "A S H A" (`routes/account.ts` ~line 383), and the schema default companion name is `"Asha"`. Users downloading "their Eos report" get another product's name on the cover. |
| Duplicated integrations | Anthropic client setup, Resend fetch call, and the AI price table each exist twice (api-server + daily-email) and have already drifted. A tiny shared `lib` module would stop that. |

**Test coverage — where it's strong and where the holes are.** The API server's 24 suites are excellent and unusually security-minded (rate limiting, auth hardening, email verification, account deletion FK-graph guard, encryption round-trips, secret scanning). The real gaps, in order of importance:
1. **Route ownership tests** — nothing asserts "user B gets a 404 on user A's record." Exactly the class of test that would have caught the goal-task hole (§2.1). One parameterized suite covers this forever.
2. **Frontend: one test file total** (captionSync). The auth/verification/consent gate machine in `App.tsx`, the SSE stream parser, and the voice-call state machine in `Chat.tsx` — the three most intricate client state machines — have zero tests.
3. **`/chat/stream` and `/voice-llm` end-to-end** — voice persistence/dedup and model selection are tested, but the SSE contract of the two revenue-critical endpoints isn't.
4. **Cost-control tests don't exist because cost controls don't exist** (§4.1) — when you add the caps, test them like `rate-limit.test.ts` tests auth.
5. Tests require a live `DATABASE_URL` and aren't wired to any CI — they only run when someone remembers. A GitHub Action with a Postgres service container makes the whole suite (it passed cleanly for me in ~1 minute) run on every push.

---

# Top 5 things to fix before people pay

**1. Put guardrails on what one user can spend.** Today the only rate limiter in the product protects the login form; the endpoints that cost you actual money per call — chat, voice, and text-to-speech — have no per-user limits, and a chat message has no maximum length. One user with a script (or one stolen session cookie) can run your Anthropic and ElevenLabs bills up all night, and you'd only find out from the invoice. The fix is small and uses a library you already ship: add a per-user rate limit on `/api/chat/*` and `/api/tts`, cap message length at a few thousand characters, and add a per-user daily ceiling with a warm in-character message when it's hit. Copy the pattern from your own push-notification code, which already does this perfectly.

**2. Make the privacy pages tell one true story.** Your marketing page promises things the system doesn't deliver ("encrypted end-to-end", "not even the founder *can* read them", "voice is never stored"), your actual privacy policy *undersells* what you built, and your consent screen names only half of your data processors. What you actually have — real field-level encryption, zero-retention voice, no trackers, real deletion — is a genuinely strong story that doesn't need exaggeration. For a mental-health product taking payment, overshooting is a regulatory (FTC/CMA) and trust risk. Rewrite the three pages to match the code, encrypt the leftover plaintext tables (especially the plaintext crisis flag next to encrypted crisis notes), create the `/terms` and `/refunds` pages your footer already links to, and take the lawyer pass your own privacy page asks for.

**3. Close the one broken ownership check.** Every route in the API correctly verifies "this record belongs to the signed-in user" — except one: updating a goal's task checks that the *goal* is yours but updates the *task* by its raw ID, so any user can modify any other user's task by guessing sequential IDs. It's a one-line fix (`goalId` must match too), plus one test suite that tries user-B-touches-user-A's-data across every route so this class of bug can never ship again. Small blast radius today, but "we had a cross-customer data write" is not a sentence you want to say after launch.

**4. Build the billing foundation before flipping Paddle on.** The landing page already sells a 7-day trial with Paddle checkout, but the code has no concept of a plan: no subscription table, no webhook endpoint (and the server's JSON parsing will need a raw-body carve-out for Paddle's signature verification), no gating middleware, and account deletion currently erases *everything* — which collides with the legal requirement to retain invoices. None of this is hard, and your middleware chain gives billing a clean place to live — but retrofitting it after users have paid is much messier than building it the week before. Also decide what a paying user sees when the AI fails: today they'd silently get canned fallback lines, which is fine for a free beta and unacceptable on a paid plan.

**5. Protect the two things that can kill the product operationally: the encryption key and the silent failure modes.** `DATA_ENCRYPTION_KEY` exists only as an environment secret; if it's ever lost, every user's history is permanently unreadable — there is no recovery, by design. Make sure a copy of each environment's key lives in a real secrets vault or offline safe *today*, and write down the rotation runbook (the rotation script already exists and is excellent). Then de-silence the failure paths: alert when AI calls fall back to mock replies, when the daily email job's generation fails (today it sends generic emails and reports success), and when the internal sweep triggers get rejected — because every one of those currently degrades your product invisibly. A single free uptime monitor on `/api/healthz` plus three log-based alerts covers it.

---

*Nothing in this review was changed in the code — these two documents are the only files added, per your instruction.*
