---
name: Goals route zod ban
description: api-server cannot import zod directly; goals.ts must use plain JS validation
---

The `@workspace/api-server` package does not list `zod` as a dependency. esbuild bundles it from scratch and cannot resolve `zod` (or `zod/v4`) unless it's in `package.json`.

**Why:** Other routes validate via `@workspace/api-zod` (generated schemas). The goals route was added manually and tried to import zod directly — build failure.

**How to apply:** Any new route added to api-server that needs request body validation must either:
1. Use schemas from `@workspace/api-zod` (preferred), OR
2. Use plain JavaScript checks (`typeof x === "string"`, length checks, etc.)

Never `import { z } from "zod"` or `import { z } from "zod/v4"` directly in api-server route files.
