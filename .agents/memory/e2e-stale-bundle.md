---
name: E2E stale-bundle false failures
description: Tester browser can hold a pre-restart Vite bundle; re-run fresh before debugging
---
- A persistent testing-subagent browser can keep a STALE Vite/HMR bundle from before a workflow restart. Symptom: "clicked the button, nothing happened" with zero console errors, immediately after frontend edits.
- **Why:** the tester's page loaded before the restart; the old bundle keeps running until a fresh navigation/context.
- **How to apply:** when a click-does-nothing e2e failure lands right after frontend changes + restart, re-run that one step in a fresh browser context first. A single diagnostic follow-up (console at click time + a localStorage/state probe) settles it far cheaper than code archaeology.
