import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Give integration tests plenty of time — they hit a real DB
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/__tests__/**/*.test.ts"],
    // Keep test runs from sending real emails (see the setup file's rationale)
    setupFiles: ["src/__tests__/setup/suppress-resend.ts", "src/__tests__/setup/vapid-env.ts"],
  },
});
