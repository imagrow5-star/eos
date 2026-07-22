---
name: Pre-publish build check
description: How to verify the frontend production build without false alarms from missing platform env
---

## Rule
A bare-shell `vite build` of an artifact frontend fails at config load with "PORT/BASE_PATH environment variable is required" — that is NOT a code defect. The scaffold's vite config throws on purpose; the platform's workflow and publish pipelines inject both.

**Why:** During a go/no-go pre-publish check this failure looked like a broken build. Proof it's benign: `git show <last-published-commit>:.../vite.config.ts` showed the identical requirement existed when the last publish succeeded — so the pipeline provably supplies the vars.

**How to apply:**
- To verify build health from the shell: `env PORT=5000 BASE_PATH=/ pnpm --filter <pkg> run build`.
- Before declaring a publish blocker, check whether the failing requirement also existed at the last published commit (`git log` — platform publish commits are titled "Published your App").
- Don't run the big test suite and multiple builds concurrently in one batch when diagnosing — a truncated tail from a parallel run masked the real error message the first time.

## Related
- Transient dev-server HMR errors (e.g. duplicate declaration mid-edit) can linger in workflow logs long after the file is fixed; trust a fresh isolated build over stale log entries.
