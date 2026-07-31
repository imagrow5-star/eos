# CI setup

## What the workflow does

`.github/workflows/ci.yml` runs on every **pull request to `main`** and every
**push to `main`**. It spins up an `ubuntu-latest` runner with a **Postgres 16**
service container, installs dependencies with pnpm (frozen lockfile), pushes the
Drizzle schema into the throwaway test database, typechecks the API server (and
the libraries it builds), and runs the full **api-server** and **daily-email**
Vitest suites. Everything runs on dummy, CI-safe env values — **no GitHub
Secrets are required and none are used**. This is the gate that stops a broken
test from reaching `main` unnoticed (the gap that let a broken `dry-run.test.ts`
slip through before).

Validated locally against a real Postgres 16: **472 passed, 6 skipped, 0
failed** (api-server) and **38 passed** (daily-email). The 6 skips are E2E tests
that need a real `ANTHROPIC_API_KEY` — see below.

## Make it a required check (branch protection)

Once the workflow has run green at least once on `main`:

1. GitHub → the repo → **Settings** → **Branches**.
2. Under **Branch protection rules**, click **Add branch ruleset** (or **Add
   rule** in the classic UI) and target the branch **`main`**.
3. Enable **Require status checks to pass before merging**.
4. In the status-checks search box, select **`test`** (the job name in
   `ci.yml`). It appears after the workflow has run once.
5. (Recommended) Enable **Require branches to be up to date before merging** so a
   PR must be rebased/merged onto the latest `main` before it can land — this
   prevents two green-but-mutually-incompatible PRs from breaking `main`.
6. Save. From now on, no PR can merge into `main` until `test` is green.

## Run the same checks locally

The CI does exactly this (from the repo root, with a Postgres reachable at the
`DATABASE_URL` below):

```bash
# 1. A local Postgres (any of: Docker, Postgres.app, a local install). Example:
docker run -d --name eos-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres_test -p 5432:5432 postgres:16

# 2. The same env the CI uses (all dummy values):
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres_test
export LOG_HASH_SALT=ci-test-log-hash-salt-fixed-value-0123456789
# Generated, not hard-coded — a committed base64 32-byte value is key-shaped
# and trips secret-scan.test.ts. Any valid 32-byte base64 works for tests.
export DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
export SESSION_SECRET=ci-test-session-secret-not-a-real-secret
export RESEND_API_KEY=re_ci_fake_key_intercepted_by_test_setup
export APP_URL=http://localhost:3000
export NODE_ENV=test

# 3. Install, push schema, typecheck, test:
pnpm install --frozen-lockfile
pnpm --filter @workspace/db push
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/daily-email test
```

If `drizzle-kit push` ever pauses on a prompt (only happens on a **destructive**
schema change against a non-empty DB — not on the fresh CI DB), use
`pnpm --filter @workspace/db push-force`.

## Adding a new env var to the workflow

When a new external service or config is introduced:

1. Add the variable to the `env:` block in `ci.yml` with a **dummy** value that
   passes format validation but does **not** point at a real service.
2. **Exception — skip-gated live tests.** If a test does
   `skipIf(!process.env.SOME_KEY)` and then makes a **real** call to that
   service, do **not** set `SOME_KEY` in CI — leave it unset so the test skips.
   Setting a fake value would make the test run and hit the real API (or fail an
   assertion). Today this applies to `ANTHROPIC_API_KEY` (skips the E2E model
   tests in `goal-agreement`/`weekly-chapters`) and `ELEVENLABS_API_KEY` (voice
   tests delete it to force the no-outbound "public agent" path;
   `settings-voice` even asserts it is empty).
3. Many test-only vars are set automatically by Vitest setup files
   (`src/__tests__/setup/*`): `DATA_ENCRYPTION_KEY` (auto-generated if unset),
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, and all rate-limit caps. You usually
   don't need to add those.
4. Never commit a real secret. If we later want CI to run against staging
   services, add a **GitHub Secret** and reference it as
   `${{ secrets.NAME }}` — but keep the default path (dummy values, mocked
   externals) working without any secrets configured.

## What to do if CI fails

1. Open the failed run (the **Actions** tab, or the ✗ on the PR) and read the
   step log — the failing test name and assertion are printed there.
2. Reproduce locally with the commands above (same env, real Postgres).
3. Fix the code or the test, commit, and push to the PR branch. CI re-runs
   automatically; the previous in-progress run is cancelled.
4. Merge only once `test` is green.
