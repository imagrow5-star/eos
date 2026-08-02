/**
 * Deterministic unit tests for the memory-export presentation layer
 * (services/memoryExport.ts). No DB, no clock, no I/O — every function under
 * test is pure, so these run everywhere and pin the JSON shape, the Markdown
 * memoir structure, and the filename format.
 */

import { describe, it, expect } from "vitest";
import {
  shapeMemoryExport,
  renderMemoryMarkdown,
  memoryExportFilename,
  MEMORY_EXPORT_FORMAT_VERSION,
  MEMORY_EXPORT_USER_NOTE,
  type ExportSourcePayload,
  type AccountBasics,
} from "../services/memoryExport.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function samplePayload(overrides: Partial<ExportSourcePayload> = {}): ExportSourcePayload {
  return {
    exportedAt: "2026-08-01T14:23:00.000Z",
    profile: {
      companion_name: "Aria",
      preferred_language: "en",
      voice_id: "voice-xyz",
      voice_accent: "gb",
      voice_gender: "female",
      created_at: "2026-01-15T09:00:00.000Z",
    },
    messages: [
      { role: "user", content: "I miss her every morning.", created_at: "2026-02-01T08:00:00.000Z" },
      { role: "assistant", content: "That ache is real. I'm here.", created_at: "2026-02-01T08:00:05.000Z" },
    ],
    memoryFacts: [
      {
        fact: "Grieving the loss of her mother.",
        category: "life",
        created_at: "2026-01-20T00:00:00.000Z",
        times_referenced: 8,
        last_referenced_at: "2026-07-01T00:00:00.000Z",
        emotional_weight: 0.9,
        user_marked_important: true,
      },
      {
        fact: "Likes oat-milk lattes.",
        category: "preference",
        created_at: "2026-03-01T00:00:00.000Z",
        times_referenced: 1,
        last_referenced_at: null,
        emotional_weight: 0.1,
        user_marked_important: false,
      },
    ],
    memoryFeelings: [
      {
        feeling: "The Sunday family dinner made her feel small, the way it always does.",
        category: "shame",
        created_at: "2026-02-05T00:00:00.000Z",
        times_referenced: 3,
        last_referenced_at: "2026-06-01T00:00:00.000Z",
        emotional_weight: 0.8,
        user_marked_important: false,
      },
    ],
    personalitySignals: [
      { signal: "reflective", observed_count: 4, is_active: true, created_at: "2026-02-10T00:00:00.000Z" },
    ],
    wins: [{ content: "Went for a walk today.", created_at: "2026-04-01T00:00:00.000Z" }],
    moodScores: [{ score: 6, date: "2026-05-01" }],
    reminders: [
      {
        content: "Call the doctor",
        due_date: "2026-06-01",
        scheduled_time: "09:00",
        is_recurring: false,
        is_done: false,
        created_at: "2026-05-20T00:00:00.000Z",
      },
    ],
    habits: [
      { name: "Morning walk", when_then: "After coffee, I walk", created_at: "2026-03-10T00:00:00.000Z" },
    ],
    habitCompletions: [
      { habit_name: "Morning walk", completed_date: "2026-03-11" },
      { habit_name: "Morning walk", completed_date: "2026-03-12" },
    ],
    goals: [
      { title: "Sleep by 11pm", description: "Wind down earlier", is_complete: false, created_at: "2026-03-15T00:00:00.000Z" },
    ],
    commitments: [
      { content: "Text Sam", cue: "tomorrow after coffee", state: "open", created_at: "2026-03-16T00:00:00.000Z" },
    ],
    weeklyChapters: [
      {
        week_start: "2026-02-02",
        week_end: "2026-02-08",
        status: "revealed",
        thread_opening: "This was a week of small returns to yourself.",
        threshold_question: "What felt lighter?",
        threshold_answer: "The mornings.",
        themes: [{ title: "Small returns" }],
        generated_at: "2026-02-09T00:00:00.000Z",
        revealed_at: "2026-02-09T12:00:00.000Z",
      },
      {
        week_start: "2026-02-09",
        week_end: "2026-02-15",
        status: "revealed",
        thread_opening: "You started naming what you need.",
        threshold_question: null,
        threshold_answer: null,
        themes: [],
        generated_at: "2026-02-16T00:00:00.000Z",
        revealed_at: null,
      },
    ],
    sealedNotes: [
      {
        kind: "prediction",
        prompt: "Will next week feel lighter?",
        text: "I think it might.",
        status: "sealed",
        created_at: "2026-02-09T00:00:00.000Z",
        resolved_at: null,
      },
    ],
    storyThreads: [
      {
        label: "the airport goodbye",
        state: "evolving",
        first_seen_week: "2026-01-05",
        last_seen_week: "2026-02-09",
        created_at: "2026-01-06T00:00:00.000Z",
      },
    ],
    crisisEvents: [
      {
        detected_at: "2026-03-20T22:00:00.000Z",
        country_served: "US",
        source: "chat",
        // Fields the shaper must NOT surface (metadata-only policy):
        pattern_matched: "explicit_ideation",
        block_dismissed: true,
      },
    ],
    subscriptions: [
      {
        tier: "closer",
        status: "active",
        trial_ends_at: null,
        current_period_ends_at: "2026-09-01T00:00:00.000Z",
        created_at: "2026-01-15T09:05:00.000Z",
        // Fields the shaper must NOT surface:
        paddle_customer_id: "ctm_secret",
      },
    ],
    ...overrides,
  };
}

const basics: AccountBasics = {
  email: "someone@example.com",
  companionName: "Aria",
  onboardingComplete: true,
};

// ─── JSON shape ──────────────────────────────────────────────────────────────

describe("shapeMemoryExport — JSON structure", () => {
  it("produces the documented top-level shape and metadata", () => {
    const out = shapeMemoryExport(samplePayload(), basics);

    expect(out.export_metadata.generated_at).toBe("2026-08-01T14:23:00.000Z");
    expect(out.export_metadata.format_version).toBe(MEMORY_EXPORT_FORMAT_VERSION);
    expect(out.export_metadata.user_note).toBe(MEMORY_EXPORT_USER_NOTE);

    // Every documented section is present.
    for (const key of [
      "export_metadata",
      "profile",
      "memory",
      "chapters",
      "sealed_notes",
      "habits",
      "commitments",
      "goals",
      "mood_scores",
      "reminders",
      "story_threads",
      "messages",
      "crisis_events",
      "subscription",
    ]) {
      expect(out).toHaveProperty(key);
    }
  });

  it("carries the profile + voice settings", () => {
    const out = shapeMemoryExport(samplePayload(), basics);
    expect(out.profile.email).toBe("someone@example.com");
    expect(out.profile.companion_name).toBe("Aria");
    expect(out.profile.preferred_language).toBe("en");
    expect(out.profile.voice_settings).toEqual({
      voice_id: "voice-xyz",
      voice_accent: "gb",
      voice_gender: "female",
    });
    expect(out.profile.onboarding_completed).toBe(true);
  });

  it("includes the Sprint 2A importance columns on every fact", () => {
    const out = shapeMemoryExport(samplePayload(), basics);
    const fact = out.memory.facts[0];
    expect(fact).toMatchObject({
      fact: "Grieving the loss of her mother.",
      category: "life",
      times_referenced: 8,
      last_referenced_at: "2026-07-01T00:00:00.000Z",
      emotional_weight: 0.9,
      user_marked_important: true,
    });
  });

  it("includes feelings-in-context (Sprint 2C) in the memory block", () => {
    const out = shapeMemoryExport(samplePayload(), basics);
    expect(out.memory.feelings).toHaveLength(1);
    expect(out.memory.feelings[0]).toMatchObject({
      feeling: "The Sunday family dinner made her feel small, the way it always does.",
      emotion: "shame",
      times_referenced: 3,
      emotional_weight: 0.8,
    });
  });

  it("maps messages to role/content/created_at only", () => {
    const out = shapeMemoryExport(samplePayload(), basics);
    expect(out.messages).toHaveLength(2);
    expect(Object.keys(out.messages[0]!).sort()).toEqual(["content", "created_at", "role"]);
    expect(out.messages[0]).toEqual({
      role: "user",
      content: "I miss her every morning.",
      created_at: "2026-02-01T08:00:00.000Z",
    });
  });

  it("attaches habit completions to their habit by name", () => {
    const out = shapeMemoryExport(samplePayload(), basics);
    expect(out.habits[0]!.completions).toEqual(["2026-03-11", "2026-03-12"]);
  });

  it("exposes crisis events as metadata only — never content or pattern", () => {
    const out = shapeMemoryExport(samplePayload(), basics);
    const evt = out.crisis_events[0]!;
    expect(evt).toEqual({
      detected_at: "2026-03-20T22:00:00.000Z",
      country_served: "US",
      source: "chat",
    });
    // The detector pattern name and dismissal state must not leak.
    expect(evt).not.toHaveProperty("pattern_matched");
    expect(evt).not.toHaveProperty("block_dismissed");
  });

  it("exposes subscription metadata only — no payment/provider ids", () => {
    const out = shapeMemoryExport(samplePayload(), basics);
    expect(out.subscription).toEqual({
      tier: "closer",
      status: "active",
      trial_ends_at: null,
      current_period_ends_at: "2026-09-01T00:00:00.000Z",
      created_at: "2026-01-15T09:05:00.000Z",
    });
    expect(JSON.stringify(out.subscription)).not.toContain("paddle");
  });

  it("handles a completely empty account without throwing", () => {
    const empty: ExportSourcePayload = {
      exportedAt: "2026-08-01T00:00:00.000Z",
      profile: null,
      messages: [],
      memoryFacts: [],
      memoryFeelings: [],
      personalitySignals: [],
      wins: [],
      moodScores: [],
      reminders: [],
      habits: [],
      habitCompletions: [],
      goals: [],
      commitments: [],
      weeklyChapters: [],
      sealedNotes: [],
      storyThreads: [],
      crisisEvents: [],
      subscriptions: [],
    };
    const out = shapeMemoryExport(empty, { email: "new@example.com", companionName: "Eos", onboardingComplete: false });
    expect(out.profile.email).toBe("new@example.com");
    expect(out.profile.companion_name).toBe("Eos");
    expect(out.memory.facts).toEqual([]);
    expect(out.messages).toEqual([]);
    expect(out.subscription).toBeNull();
    // Must still round-trip as JSON.
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

// ─── Markdown memoir ─────────────────────────────────────────────────────────

describe("renderMemoryMarkdown — memoir structure", () => {
  it("titles the memoir with the companion's name and includes every section", () => {
    const md = renderMemoryMarkdown(samplePayload(), basics);
    expect(md.startsWith("# Everything Aria remembers about you")).toBe(true);
    expect(md).toContain("## About you");
    expect(md).toContain("## What Aria remembers");
    expect(md).toContain("## How things have felt");
    expect(md).toContain("## Your intentions and goals");
    expect(md).toContain("## Your habits");
    expect(md).toContain("## Your chapters");
    expect(md).toContain("## Your conversations");
    expect(md).toContain("## On the record");
  });

  it("renders the feelings-in-context section content (Sprint 2C)", () => {
    const md = renderMemoryMarkdown(samplePayload(), basics);
    const idx = md.indexOf("## How things have felt");
    expect(idx).toBeGreaterThan(-1);
    expect(md).toContain("made her feel small");
    // Appears after facts, before goals (texture sits with memory).
    expect(idx).toBeGreaterThan(md.indexOf("## What Aria remembers"));
    expect(idx).toBeLessThan(md.indexOf("## Your intentions and goals"));
  });

  it("orders the sections as: about → memories → goals → habits → chapters → conversations → record", () => {
    const md = renderMemoryMarkdown(samplePayload(), basics);
    const order = [
      "## About you",
      "## What Aria remembers",
      "## Your intentions and goals",
      "## Your habits",
      "## Your chapters",
      "## Your conversations",
      "## On the record",
    ].map((h) => md.indexOf(h));
    // Every heading found, and strictly increasing in document order.
    expect(order.every((i) => i >= 0)).toBe(true);
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });

  it("renders conversations as 'You said' / '<name> said'", () => {
    const md = renderMemoryMarkdown(samplePayload(), basics);
    expect(md).toContain("**You said**");
    expect(md).toContain("**Aria said**");
    expect(md).toContain("I miss her every morning.");
    expect(md).toContain("That ache is real. I'm here.");
  });

  it("shows facts most-important first, with a star and importance score", () => {
    const md = renderMemoryMarkdown(samplePayload(), basics);
    const starred = md.indexOf("Grieving the loss of her mother.");
    const trivial = md.indexOf("Likes oat-milk lattes.");
    expect(starred).toBeGreaterThan(-1);
    expect(trivial).toBeGreaterThan(-1);
    // The starred, higher-weight fact appears before the trivial one.
    expect(starred).toBeLessThan(trivial);
    expect(md).toContain("⭐");
    expect(md).toContain("importance 0.90");
  });

  it("lists chapters most-recent first", () => {
    const md = renderMemoryMarkdown(samplePayload(), basics);
    const later = md.indexOf("You started naming what you need.");
    const earlier = md.indexOf("This was a week of small returns to yourself.");
    expect(later).toBeGreaterThan(-1);
    expect(earlier).toBeGreaterThan(-1);
    expect(later).toBeLessThan(earlier);
  });

  it("reads warmly — the data-is-yours note is present", () => {
    const md = renderMemoryMarkdown(samplePayload(), basics);
    expect(md.toLowerCase()).toContain("your words belong to you");
    expect(md.toLowerCase()).toContain("your data is yours");
  });

  it("renders a valid memoir for an empty account (no crash, gentle empties)", () => {
    const empty: ExportSourcePayload = {
      exportedAt: "2026-08-01T00:00:00.000Z",
      profile: null,
      messages: [],
      memoryFacts: [],
      memoryFeelings: [],
      personalitySignals: [],
      wins: [],
      moodScores: [],
      reminders: [],
      habits: [],
      habitCompletions: [],
      goals: [],
      commitments: [],
      weeklyChapters: [],
      sealedNotes: [],
      storyThreads: [],
      crisisEvents: [],
      subscriptions: [],
    };
    const md = renderMemoryMarkdown(empty, { email: null, companionName: "Eos", onboardingComplete: false });
    expect(md).toContain("# Everything Eos remembers about you");
    expect(md).toContain("## What Eos remembers");
    expect(md).toContain("## Your conversations");
    // Empty-state prose rather than a stack trace.
    expect(md).toContain("the page is still open");
    // Sections with no data (goals/habits/chapters) are simply omitted.
    expect(md).not.toContain("## Your habits");
  });
});

// ─── Filename ────────────────────────────────────────────────────────────────

describe("memoryExportFilename", () => {
  it("uses a compact YYYYMMDD date and the right extension", () => {
    const d = new Date("2026-08-01T14:23:00.000Z");
    expect(memoryExportFilename("json", d)).toBe("eos-memory-export-20260801.json");
    expect(memoryExportFilename("markdown", d)).toBe("eos-memory-export-20260801.md");
  });

  it("zero-pads month and day", () => {
    const d = new Date("2026-03-09T00:00:00.000Z");
    expect(memoryExportFilename("json", d)).toBe("eos-memory-export-20260309.json");
  });
});
