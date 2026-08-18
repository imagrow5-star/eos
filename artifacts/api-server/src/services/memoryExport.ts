/**
 * Memory-export shaping — the user-triggered "download your journal" pipeline
 * (Sprint E).
 *
 * The heavy lifting (querying every user-owned table and decrypting every
 * encrypted column) already lives in ONE place: fetchExportPayload in
 * routes/account.ts. That is the single choke point every export flows through,
 * so a future sprint that adds a user-data table only has to wire it in there
 * and it appears in every export — no drift. This module is a pure PRESENTATION
 * layer on top of that payload:
 *
 *   • shapeMemoryExport()   → a clean, nested, portable JSON object
 *   • renderMemoryMarkdown()→ a warm, human-readable memoir of what Eos knows
 *
 * Both are pure functions of their inputs (no DB, no clock, no I/O), so the
 * deterministic unit tests can exercise them without a database.
 *
 * Privacy: every value handled here is the user's OWN plaintext, decrypted for
 * their own export — that is the whole point (they have the right to their
 * data in readable form). Nothing in here logs; the route that calls it logs
 * only a hashed user id + the chosen format, never the payload.
 */

export const MEMORY_EXPORT_FORMAT_VERSION = "1.0";

export const MEMORY_EXPORT_USER_NOTE =
  "This is everything Eos remembers about you. Your data is yours. Keep this " +
  "file somewhere safe. It works with any tool that reads JSON.";

// ─── Input shape ──────────────────────────────────────────────────────────────
// A structural subset of what fetchExportPayload (routes/account.ts) returns.
// Kept as a local interface rather than importing the route's return type so
// this module has no dependency on Express/route wiring and stays unit-testable.

interface Row {
  [key: string]: unknown;
}

export interface ExportSourcePayload {
  exportedAt: string;
  profile: Row | null;
  messages: Row[];
  memoryFacts: Row[];
  memoryFeelings: Row[];
  personalitySignals: Row[];
  wins: Row[];
  moodScores: Row[];
  reminders: Row[];
  habits: Row[];
  habitCompletions: Row[];
  goals: Row[];
  commitments: Row[];
  weeklyChapters: Row[];
  sealedNotes: Row[];
  storyThreads: Row[];
  crisisEvents: Row[];
  subscriptions: Row[];
}

/** Account-level facts that live on the users row (not the profile row). */
export interface AccountBasics {
  email: string | null;
  companionName: string;
  onboardingComplete: boolean;
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** The name the user gave their companion, falling back to "Eos". */
function companionNameOf(payload: ExportSourcePayload, basics: AccountBasics): string {
  const fromProfile = str(payload.profile?.companion_name).trim();
  if (fromProfile) return fromProfile;
  const fromBasics = str(basics.companionName).trim();
  return fromBasics || "Eos";
}

// ─── JSON shaper ────────────────────────────────────────────────────────────────
// Produces the nested, portable structure documented in the Sprint E spec.
// Internal serial ids are deliberately omitted — they carry no user-meaningful
// information and would leak row counts/ordering. Every field below is the
// user's own decrypted content or their own metadata.

export function shapeMemoryExport(payload: ExportSourcePayload, basics: AccountBasics) {
  const profile = payload.profile;

  return {
    export_metadata: {
      generated_at: payload.exportedAt,
      format_version: MEMORY_EXPORT_FORMAT_VERSION,
      user_note: MEMORY_EXPORT_USER_NOTE,
    },

    profile: {
      email: basics.email,
      companion_name: companionNameOf(payload, basics),
      preferred_language: profile?.preferred_language ?? null,
      voice_settings: profile
        ? {
            voice_id: profile.voice_id ?? null,
            voice_accent: profile.voice_accent ?? null,
            voice_gender: profile.voice_gender ?? null,
          }
        : null,
      onboarding_completed: basics.onboardingComplete,
      created_at: profile?.created_at ?? null,
    },

    memory: {
      facts: payload.memoryFacts.map((f) => ({
        fact: f.fact,
        category: f.category,
        created_at: f.created_at,
        // Sprint 2A importance columns — carried through so the user sees
        // exactly how a memory is weighted, not just its text.
        times_referenced: f.times_referenced,
        last_referenced_at: f.last_referenced_at,
        emotional_weight: f.emotional_weight,
        user_marked_important: f.user_marked_important,
      })),
      // Sprint 2C — feelings-in-context, the second memory layer beside facts.
      feelings: payload.memoryFeelings.map((f) => ({
        feeling: f.feeling,
        emotion: f.category,
        created_at: f.created_at,
        times_referenced: f.times_referenced,
        last_referenced_at: f.last_referenced_at,
        emotional_weight: f.emotional_weight,
        user_marked_important: f.user_marked_important,
      })),
      personality_signals: payload.personalitySignals.map((s) => ({
        signal: s.signal,
        observed_count: s.observed_count,
        is_active: s.is_active,
        created_at: s.created_at,
      })),
      wins: payload.wins.map((w) => ({
        content: w.content,
        created_at: w.created_at,
      })),
    },

    chapters: payload.weeklyChapters.map((c) => ({
      week_start: c.week_start,
      week_end: c.week_end,
      status: c.status,
      thread_opening: c.thread_opening,
      threshold_question: c.threshold_question,
      threshold_answer: c.threshold_answer,
      themes: c.themes,
      generated_at: c.generated_at,
      revealed_at: c.revealed_at,
    })),

    sealed_notes: payload.sealedNotes.map((n) => ({
      kind: n.kind,
      prompt: n.prompt,
      text: n.text,
      status: n.status,
      created_at: n.created_at,
      resolved_at: n.resolved_at,
    })),

    habits: payload.habits.map((h) => ({
      name: h.name,
      when_then: h.when_then,
      created_at: h.created_at,
      completions: payload.habitCompletions
        .filter((hc) => hc.habit_name === h.name)
        .map((hc) => hc.completed_date),
    })),

    commitments: payload.commitments.map((c) => ({
      content: c.content,
      cue: c.cue,
      state: c.state,
      created_at: c.created_at,
    })),

    goals: payload.goals.map((g) => ({
      title: g.title,
      description: g.description,
      is_complete: g.is_complete,
      created_at: g.created_at,
    })),

    mood_scores: payload.moodScores.map((m) => ({
      score: m.score,
      date: m.date,
    })),

    reminders: payload.reminders.map((r) => ({
      content: r.content,
      due_date: r.due_date,
      scheduled_time: r.scheduled_time,
      is_recurring: r.is_recurring,
      is_done: r.is_done,
      created_at: r.created_at,
    })),

    story_threads: payload.storyThreads.map((t) => ({
      label: t.label,
      state: t.state,
      first_seen_week: t.first_seen_week,
      last_seen_week: t.last_seen_week,
      created_at: t.created_at,
    })),

    messages: payload.messages.map((m) => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),

    // Metadata only — WHEN support resources were shown and which country's
    // helplines were served. Never any message content (Tier 1 policy); the
    // message itself lives in `messages` above.
    crisis_events: payload.crisisEvents.map((e) => ({
      detected_at: e.detected_at,
      country_served: e.country_served,
      source: e.source,
    })),

    // Membership metadata only — tier/status/dates. No payment method, no
    // provider ids.
    subscription: payload.subscriptions[0]
      ? {
          tier: payload.subscriptions[0].tier,
          status: payload.subscriptions[0].status,
          trial_ends_at: payload.subscriptions[0].trial_ends_at,
          current_period_ends_at: payload.subscriptions[0].current_period_ends_at,
          created_at: payload.subscriptions[0].created_at,
        }
      : null,
  };
}

export type MemoryExportJson = ReturnType<typeof shapeMemoryExport>;

// ─── Markdown memoir renderer ───────────────────────────────────────────────────
// Reads like a memoir of what the companion knows about the user — warm but
// complete — rather than a database dump. Uses the user's chosen companion name
// throughout.

function fmtDate(iso: unknown): string {
  const s = str(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function fmtDateTime(iso: unknown): string {
  const s = str(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return (
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

// Facts ranked the way retrieval ranks them, so the memoir opens with what
// matters most: user-starred first, then emotional weight, then how often the
// memory has come up again.
function rankedFacts(facts: Row[]): Row[] {
  return [...facts].sort((a, b) => {
    const ai = a.user_marked_important ? 1 : 0;
    const bi = b.user_marked_important ? 1 : 0;
    if (ai !== bi) return bi - ai;
    const aw = Number(a.emotional_weight ?? 0);
    const bw = Number(b.emotional_weight ?? 0);
    if (aw !== bw) return bw - aw;
    const ar = Number(a.times_referenced ?? 0);
    const br = Number(b.times_referenced ?? 0);
    return br - ar;
  });
}

export function renderMemoryMarkdown(
  payload: ExportSourcePayload,
  basics: AccountBasics,
): string {
  const name = companionNameOf(payload, basics);
  const profile = payload.profile;
  const lines: string[] = [];

  // ── Title + warm opening ──────────────────────────────────────────────────
  lines.push(`# Everything ${name} remembers about you`);
  lines.push("");
  lines.push(
    `This is your journal: everything ${name} holds about you, gathered in one ` +
      `place. It's yours to keep. There's no need to do anything with it; it's ` +
      `here simply because your words belong to you.`,
  );
  lines.push("");
  lines.push(`*Saved on ${fmtDate(payload.exportedAt)}.*`);
  lines.push("");

  // ── About you ─────────────────────────────────────────────────────────────
  lines.push("## About you");
  lines.push("");
  {
    const parts: string[] = [];
    if (basics.email) parts.push(`You're here as **${basics.email}**.`);
    parts.push(`Your companion's name is **${name}**.`);
    const lang = str(profile?.preferred_language);
    if (lang) parts.push(`She speaks with you in \`${lang}\`.`);
    const created = fmtDate(profile?.created_at);
    if (created) parts.push(`You began this journey on ${created}.`);
    lines.push(parts.join(" "));
  }
  lines.push("");

  // ── What she remembers ────────────────────────────────────────────────────
  lines.push(`## What ${name} remembers`);
  lines.push("");
  if (payload.memoryFacts.length === 0) {
    lines.push(`Nothing has been written down yet. The page is still open.`);
    lines.push("");
  } else {
    // Group by category, each group ranked most-important first.
    const byCategory = new Map<string, Row[]>();
    for (const f of rankedFacts(payload.memoryFacts)) {
      const cat = str(f.category) || "life";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(f);
    }
    for (const [category, facts] of byCategory) {
      lines.push(`### ${category}`);
      lines.push("");
      for (const f of facts) {
        const starred = f.user_marked_important ? " ⭐" : "";
        const weight = Number(f.emotional_weight ?? 0);
        const importance = ` _(importance ${weight.toFixed(2)})_`;
        lines.push(`- ${str(f.fact)}${starred}${importance}`);
      }
      lines.push("");
    }
  }

  // ── How things have felt (Sprint 2C) ──────────────────────────────────────
  if (payload.memoryFeelings.length > 0) {
    lines.push(`## How things have felt`);
    lines.push("");
    for (const f of rankedFacts(payload.memoryFeelings)) {
      const emotion = str(f.category);
      const label = emotion && emotion !== "other" ? ` _(${emotion})_` : "";
      lines.push(`- ${str(f.feeling)}${label}`);
    }
    lines.push("");
  }

  // ── Intentions and goals ──────────────────────────────────────────────────
  if (payload.goals.length > 0 || payload.commitments.length > 0) {
    lines.push("## Your intentions and goals");
    lines.push("");
    for (const g of payload.goals) {
      const done = g.is_complete ? " ✓" : "";
      lines.push(`- **${str(g.title)}**${done}`);
      const desc = str(g.description).trim();
      if (desc) lines.push(`  ${desc}`);
    }
    for (const c of payload.commitments) {
      const cue = str(c.cue).trim();
      lines.push(`- ${str(c.content)}${cue ? ` (*${cue}*)` : ""}`);
    }
    lines.push("");
  }

  // ── Habits ────────────────────────────────────────────────────────────────
  if (payload.habits.length > 0) {
    lines.push("## Your habits");
    lines.push("");
    for (const h of payload.habits) {
      const completions = payload.habitCompletions.filter(
        (hc) => hc.habit_name === h.name,
      ).length;
      const when = str(h.when_then).trim();
      lines.push(
        `- **${str(h.name)}**${when ? ` (${when})` : ""} ` +
          `_(${completions} completion${completions === 1 ? "" : "s"})_`,
      );
    }
    lines.push("");
  }

  // ── Chapters (most-recent first) ──────────────────────────────────────────
  if (payload.weeklyChapters.length > 0) {
    lines.push("## Your chapters");
    lines.push("");
    const recentFirst = [...payload.weeklyChapters].reverse();
    for (const ch of recentFirst) {
      lines.push(`### Week of ${fmtDate(ch.week_start)}`);
      lines.push("");
      const opening = str(ch.thread_opening).trim();
      if (opening) {
        lines.push(opening);
        lines.push("");
      }
    }
  }

  // ── Conversations ─────────────────────────────────────────────────────────
  lines.push("## Your conversations");
  lines.push("");
  if (payload.messages.length === 0) {
    lines.push(`No conversations yet. Whenever you're ready, ${name} is here.`);
    lines.push("");
  } else {
    for (const m of payload.messages) {
      const who = m.role === "assistant" ? `${name} said` : "You said";
      const when = fmtDateTime(m.created_at);
      lines.push(`**${who}**${when ? ` _(${when})_` : ""}:`);
      lines.push("");
      lines.push(`> ${str(m.content).replace(/\n/g, "\n> ")}`);
      lines.push("");
    }
  }

  // ── Metadata / on the record ──────────────────────────────────────────────
  lines.push("## On the record");
  lines.push("");
  {
    const crisisCount = payload.crisisEvents.length;
    if (crisisCount > 0) {
      lines.push(
        `- Support resources were shown to you ${crisisCount} time` +
          `${crisisCount === 1 ? "" : "s"}. ${name} will always step aside for real help.`,
      );
    } else {
      lines.push(`- No crisis-support moments are on record.`);
    }
    const sub = payload.subscriptions[0];
    if (sub) {
      lines.push(`- Membership: ${str(sub.tier)} (${str(sub.status)}).`);
    } else {
      lines.push(`- Membership: full access.`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`*${MEMORY_EXPORT_USER_NOTE.replace(/reads JSON\.$/, "reads text.")}*`);
  lines.push("");

  return lines.join("\n");
}

// ─── Filename ────────────────────────────────────────────────────────────────
// eos-memory-export-YYYYMMDD.json / .md — the date is compact (no dashes) per
// the Sprint E spec.

export function memoryExportFilename(format: "json" | "markdown", date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const ext = format === "markdown" ? "md" : "json";
  return `eos-memory-export-${yyyy}${mm}${dd}.${ext}`;
}
