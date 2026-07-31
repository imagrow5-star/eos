/**
 * Privacy audit Tier 1 — CONTENT_LEAK fix (services/ai.ts).
 *
 * The habit/goal arbitration log must NEVER contain the extracted habit name or
 * goal title (user-authored free-text). It now logs only {habitCount, goalCount,
 * extractedAt}. Deterministic and DB-free: we stub the Anthropic SDK's
 * `messages.create` (on its prototype — getAnthropic() builds a real client via
 * require(), so module mocking doesn't reach it) to return BOTH a habit and a
 * goal so the arbitration branch fires, and the post-arbitration DB writes are
 * skipped by construction (the habit's whenThen is ≤5 chars so the insert guard
 * fails, and the goal is nulled by the arbitration itself) — no query ever runs.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Must exist before ai.ts (→ @workspace/db) is imported. getAnthropic() also
// returns null without a key, so give it a dummy one — messages.create is
// stubbed below, so it never reaches the network.
vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-unused-create-is-stubbed";
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/dummy";
});

import { createRequire } from "node:module";
import { logger } from "../lib/logger.js";
import { detectHabitMentions } from "../services/ai.js";

const HABIT_SENTINEL = "ZZHABITNAMELEAKZZ";
const GOAL_SENTINEL = "ZZGOALTITLELEAKZZ";

let createSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  // getAnthropic() loads the SDK via require() (the CJS build), a DIFFERENT
  // module instance than an ESM `import` would give — so we resolve the same
  // CJS module here and stub create() on its Messages prototype. create() lives
  // on that prototype, shared by any client getAnthropic() constructs.
  const require = createRequire(import.meta.url);
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod.Anthropic;
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  createSpy = vi.spyOn(messagesProto, "create").mockResolvedValue({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          completedHabitIds: [],
          newHabit: { name: HABIT_SENTINEL, whenThen: "x", reason: "r" },
          newGoal: { title: GOAL_SENTINEL, description: "d" },
          goalOfferDeclined: false,
        }),
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as never);
});

afterAll(() => createSpy.mockRestore());

describe("ai extraction arbitration log — no user free-text (privacy Tier 1)", () => {
  it("logs counts + timestamp only, never the habit name or goal title", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");

    const result = await detectHabitMentions(
      { userName: "Test", timezone: "UTC", userId: 4242 } as never,
      "yes, set both of those",
      "Done — added.",
      [],
      [],
    );

    // Arbitration fired: the model drifted (returned both) and the goal was dropped.
    expect(result.newGoal).toBeNull();

    const arb = warn.mock.calls.find(
      (c) => c[1] === "Extractor returned habit AND goal — keeping habit only",
    );
    expect(arb, "arbitration log should have fired").toBeTruthy();

    const payload = arb![0] as Record<string, unknown>;
    // Safe metadata only.
    expect(payload).toMatchObject({ habitCount: 1, goalCount: 1 });
    expect(payload).toHaveProperty("extractedAt");
    // The old leaky field names are gone.
    expect(payload).not.toHaveProperty("habit");
    expect(payload).not.toHaveProperty("goal");

    // Strongest assertion: the user-authored strings appear in NO log call.
    const everythingLogged = JSON.stringify([warn.mock.calls, info.mock.calls]);
    expect(everythingLogged).not.toContain(HABIT_SENTINEL);
    expect(everythingLogged).not.toContain(GOAL_SENTINEL);

    warn.mockRestore();
    info.mockRestore();
  });
});
