---
name: Workspace lib types via TS project references
description: Consumers typecheck against @workspace libs' built dist (db, api-zod, api-client-react), not source — how to keep it fresh
---

# @workspace/db types come from built `dist/`, not source

`artifacts/api-server/tsconfig.json` lists `references: [../../lib/db, ../../lib/api-zod]`.
With TS **project references**, the type checker resolves those packages from their
composite build output (`lib/db/dist/*.d.ts`), NOT from `lib/db/src`. So if the
schema source changes but `dist` isn't rebuilt, `tsc -p` sees stale types and can
emit misleading errors (missing tables/columns), while the app + tests still run
fine because the runtime bundle (esbuild `build.mjs`) reads source directly.

**Why:** `lib/db` is `composite: true` + `emitDeclarationOnly: true`, so referencing
projects consume its emitted declarations. `dist/` and `tsconfig.tsbuildinfo` are
**gitignored** — they are never committed, so a fresh checkout has no dist at all
and `tsc -p` fails with `TS6305: Output file ... has not been built`.

**How to apply:**
- The root `pnpm run typecheck` already builds libs first (`typecheck:libs` = `tsc --build`).
- The per-artifact `pnpm --filter @workspace/api-server run typecheck` is made
  self-sufficient by prefixing `tsc --build ../../lib/db ../../lib/api-zod &&`
  before the `tsc -p ... --noEmit`. Keep that prefix; removing it reintroduces the
  stale/missing-dist failure when run in isolation.
- `tsc --build` is incremental via `lib/db/tsconfig.tsbuildinfo` (at the package
  root, not inside dist). To force a clean rebuild you must delete BOTH `dist/` and
  `tsconfig.tsbuildinfo`; deleting only dist makes `--build` skip emit and dist
  stays missing.
- **Same trap with `lib/api-client-react` → aanya.** `artifacts/aanya/tsconfig.json`
  references `../../lib/api-client-react`, so editing that lib's source (e.g. the
  generated `api.schemas.ts`) does NOT reach aanya's typecheck until the lib is
  rebuilt. It has **no package build script** — run `pnpm exec tsc --build
  lib/api-client-react` from the workspace root. Symptom of staleness: TS2353
  "property does not exist" in aanya for a field that's plainly present in the
  lib's source. Vite/HMR is unaffected (bundles source), so the app can work
  while typecheck lies.
