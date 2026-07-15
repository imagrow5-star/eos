import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { EMBEDDED_FONTS_CSS } from "./report-fonts.js";

const router = Router();

// ─── HTML export renderer ─────────────────────────────────────────────────────

function esc(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    + " at "
    + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function moodEmoji(score: number): string {
  if (score >= 8) return "😊";
  if (score >= 6) return "🙂";
  if (score >= 4) return "😐";
  if (score >= 2) return "😔";
  return "😢";
}

function pathLabel(path: string | undefined): string {
  const map: Record<string, string> = {
    breakup: "Breakup support",
    bereavement: "Bereavement support",
    lonely: "Companionship",
    support: "Emotional support",
  };
  return map[path ?? ""] ?? (path ?? "Unknown");
}

interface ExportRow { [key: string]: unknown }

function buildHtmlReport(data: {
  exportedAt: string;
  range?: { from: string | null; to: string | null } | null;
  profile: ExportRow | null;
  messages: ExportRow[];
  memoryFacts: ExportRow[];
  wins: ExportRow[];
  habits: ExportRow[];
  habitCompletions: ExportRow[];
  goals: ExportRow[];
  moodScores: ExportRow[];
  commitments: ExportRow[];
  reminders: ExportRow[];
  personalitySignals: ExportRow[];
}): string {
  const { exportedAt, range, profile, messages, memoryFacts, wins, habits, habitCompletions, goals, moodScores, commitments, reminders, personalitySignals } = data;
  const companionName = esc(profile?.companion_name ?? "Eos");
  const userPath = pathLabel(profile?.user_path as string);

  // When a date range is applied, spell it out on the cover so the reader knows
  // this is a filtered slice of their history rather than the whole thing.
  const rangeLabel = range && (range.from || range.to)
    ? `Range: ${range.from ? fmtDate(range.from) : "the beginning"} – ${range.to ? fmtDate(range.to) : "today"}`
    : null;

  // ── Conversation thread ──────────────────────────────────────────────────────
  const conversationHtml = messages.length === 0
    ? `<p class="empty">No messages yet.</p>`
    : messages.map((m) => {
        const isCompanion = m.role === "assistant";
        const isMorningNote = m.is_morning_note;
        return `
        <div class="msg ${isCompanion ? "companion" : "user"}">
          ${isMorningNote ? `<span class="badge">Morning Note</span>` : ""}
          <div class="bubble">${esc(m.content)}</div>
          <div class="ts">${fmtDateTime(m.created_at as string)}</div>
        </div>`;
      }).join("\n");

  // ── Wins ─────────────────────────────────────────────────────────────────────
  const winsHtml = wins.length === 0
    ? `<p class="empty">No wins recorded yet.</p>`
    : `<ul>${wins.map((w) => `<li><span class="win-title">${esc(w.content)}</span> <span class="ts">${fmtDate(w.created_at as string)}</span></li>`).join("")}</ul>`;

  // ── Habits ───────────────────────────────────────────────────────────────────
  const completionsByHabit: Record<string, string[]> = {};
  for (const hc of habitCompletions) {
    const name = hc.habit_name as string;
    if (!completionsByHabit[name]) completionsByHabit[name] = [];
    completionsByHabit[name].push(hc.completed_date as string);
  }
  const habitsHtml = habits.length === 0
    ? `<p class="empty">No habits tracked yet.</p>`
    : habits.map((h) => {
        const name = h.name as string;
        const completions = completionsByHabit[name] ?? [];
        return `
        <div class="habit-card">
          <strong>${esc(name)}</strong>
          <span class="freq">${esc(h.when_then)}</span>
          <span class="ts">${completions.length} completion${completions.length !== 1 ? "s" : ""}</span>
        </div>`;
      }).join("\n");

  // ── Goals ────────────────────────────────────────────────────────────────────
  const goalsHtml = goals.length === 0
    ? `<p class="empty">No goals set yet.</p>`
    : goals.map((g) => {
        const statusLabel = g.is_complete ? "completed" : "active";
        return `
        <div class="goal-card status-${statusLabel}">
          <div class="goal-title">${esc(g.title)}</div>
          ${g.description ? `<div class="goal-desc">${esc(g.description)}</div>` : ""}
          <span class="goal-status">${statusLabel}</span>
        </div>`;
      }).join("\n");

  // ── Mood ─────────────────────────────────────────────────────────────────────
  const moodHtml = moodScores.length === 0
    ? `<p class="empty">No mood logs yet.</p>`
    : moodScores.map((m) => `
        <div class="mood-row">
          <span class="mood-emoji">${moodEmoji(m.score as number)}</span>
          <span class="mood-score">${m.score}/10</span>
          <span class="mood-date">${fmtDate(m.date as string)}</span>
        </div>`).join("\n");

  // ── Memory facts ─────────────────────────────────────────────────────────────
  const memoryHtml = memoryFacts.length === 0
    ? `<p class="empty">No memories recorded yet.</p>`
    : `<ul>${memoryFacts.map((f) => `<li>${esc(f.fact)}</li>`).join("")}</ul>`;

  // ── Commitments ───────────────────────────────────────────────────────────────
  const commitmentsHtml = commitments.length === 0
    ? `<p class="empty">No commitments yet.</p>`
    : `<ul>${commitments.map((c) => `<li><span class="win-title">${esc(c.content)}</span> <span class="ts">${fmtDate(c.created_at as string)}</span></li>`).join("")}</ul>`;

  // ── Reminders ─────────────────────────────────────────────────────────────────
  const remindersHtml = reminders.length === 0
    ? `<p class="empty">No reminders set.</p>`
    : `<ul>${reminders.map((r) => `<li><span class="win-title">${esc(r.content)}</span>${r.due_date ? ` <span class="ts">${fmtDate(r.due_date as string)}</span>` : ""}</li>`).join("")}</ul>`;

  // ── Personality signals ───────────────────────────────────────────────────────
  const signalsHtml = personalitySignals.length === 0
    ? `<p class="empty">No personality signals observed yet.</p>`
    : `<ul>${personalitySignals.map((s) => `<li>${esc(s.signal)}</li>`).join("")}</ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Eos Report</title>
  <style>
    /* Fonts are embedded as base64 woff2 data URIs (see report-fonts.ts) so the
       report renders with its intended typography even when opened offline. */
    ${EMBEDDED_FONTS_CSS}

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #faf8f5;
      color: #2d2a24;
      line-height: 1.6;
      padding: 40px 20px 80px;
    }

    .page { max-width: 740px; margin: 0 auto; }

    /* ── Cover ── */
    .cover {
      text-align: center;
      padding: 48px 0 40px;
      border-bottom: 1px solid #d4a85440;
      margin-bottom: 40px;
    }
    .wordmark {
      font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
      font-size: 28px;
      letter-spacing: 0.5em;
      color: #8c7348;
      margin-bottom: 12px;
    }
    .wordmark span { color: #d4a854; }
    .cover h1 {
      font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
      font-size: 22px;
      font-weight: 400;
      color: #5c5040;
      margin-bottom: 6px;
    }
    .cover .meta {
      font-size: 12px;
      color: #9c9080;
      letter-spacing: 0.08em;
    }

    /* ── Section ── */
    .section { margin-bottom: 44px; }
    .section-title {
      font-size: 10px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #9c9080;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid #d4a85428;
    }
    .empty { font-size: 13px; color: #b0a898; font-style: italic; }

    /* ── Conversation ── */
    .msg { margin-bottom: 16px; }
    .msg.companion { display: flex; flex-direction: column; align-items: flex-start; }
    .msg.user { display: flex; flex-direction: column; align-items: flex-end; }
    .bubble {
      max-width: 80%;
      padding: 11px 16px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.65;
      white-space: pre-wrap;
    }
    .companion .bubble {
      background: #fff;
      border: 1px solid #d4a85422;
      border-top-left-radius: 4px;
      font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
      font-size: 16px;
      color: #3a3328;
    }
    .user .bubble {
      background: #f0ede8;
      border: 1px solid #d4a85415;
      border-top-right-radius: 4px;
      color: #5c5040;
    }
    .ts { font-size: 10px; color: #b0a898; margin-top: 4px; }
    .badge {
      font-size: 9px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #d4a854;
      border: 1px solid #d4a85450;
      border-radius: 4px;
      padding: 2px 6px;
      margin-bottom: 4px;
    }

    /* ── Wins ── */
    ul { padding-left: 0; list-style: none; }
    ul li {
      padding: 8px 0;
      border-bottom: 1px solid #d4a85418;
      font-size: 14px;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .win-title { flex: 1; color: #3a3328; }

    /* ── Habits ── */
    .habit-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: #fff;
      border: 1px solid #d4a85422;
      border-radius: 10px;
      margin-bottom: 8px;
      font-size: 13.5px;
    }
    .habit-card strong { flex: 1; color: #3a3328; }
    .freq { font-size: 11px; color: #9c9080; border: 1px solid #d4a85430; border-radius: 4px; padding: 1px 6px; }

    /* ── Goals ── */
    .goal-card {
      padding: 12px 14px;
      border-radius: 10px;
      margin-bottom: 8px;
      border-left: 3px solid #d4a85460;
      background: #fff;
    }
    .goal-card.status-completed { border-left-color: #5c9e6e; }
    .goal-card.status-abandoned { border-left-color: #c0603a; }
    .goal-title { font-size: 14px; color: #3a3328; font-weight: 500; margin-bottom: 4px; }
    .goal-desc { font-size: 12.5px; color: #7a7060; margin-bottom: 6px; }
    .goal-status { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #9c9080; }

    /* ── Mood ── */
    .mood-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 0;
      border-bottom: 1px solid #d4a85418;
      font-size: 13.5px;
    }
    .mood-emoji { font-size: 18px; }
    .mood-score { font-weight: 500; color: #5c5040; min-width: 36px; }
    .mood-date { color: #9c9080; min-width: 120px; font-size: 12px; }
    .mood-note { color: #7a7060; font-style: italic; font-size: 12.5px; }

    /* ── Memory ── */
    ul li { gap: 8px; }

    /* ── Print ── */
    @media print {
      /* Preserve branded colours, borders and accents on paper */
      body {
        background: white;
        padding: 0;
        font-size: 12px;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      /* Single column that fills the printable page width */
      .page { max-width: 100%; }
      .bubble { max-width: 100%; }
      .cover { padding-top: 20px; page-break-after: avoid; break-after: avoid; }
      /* Keep headings attached to their content */
      .section-title { page-break-after: avoid; break-after: avoid; }
      /* Never split an individual entry across a page break */
      .msg, .habit-card, .goal-card, .mood-row, ul li {
        page-break-inside: avoid;
        break-inside: avoid;
      }
    }
  </style>
</head>
<body>
<div class="page">

  <div class="cover">
    <div class="wordmark">A S H <span>A</span></div>
    <h1>Your personal report — with ${companionName}</h1>
    <p class="meta">Journey: ${esc(userPath)} &nbsp;·&nbsp; Exported ${fmtDate(exportedAt)}</p>
    ${rangeLabel ? `<p class="meta">${esc(rangeLabel)}</p>` : ""}
  </div>

  <div class="section">
    <div class="section-title">Conversation history (${messages.length} messages)</div>
    ${conversationHtml}
  </div>

  <div class="section">
    <div class="section-title">Wins &amp; victories (${wins.length})</div>
    ${winsHtml}
  </div>

  <div class="section">
    <div class="section-title">Habits (${habits.length} tracked)</div>
    ${habitsHtml}
  </div>

  <div class="section">
    <div class="section-title">Goals (${goals.length})</div>
    ${goalsHtml}
  </div>

  <div class="section">
    <div class="section-title">Mood journal (${moodScores.length} entries)</div>
    ${moodHtml}
  </div>

  <div class="section">
    <div class="section-title">What ${companionName} knows about you (${memoryFacts.length} memories)</div>
    ${memoryHtml}
  </div>

  <div class="section">
    <div class="section-title">Commitments (${commitments.length})</div>
    ${commitmentsHtml}
  </div>

  <div class="section">
    <div class="section-title">Reminders (${reminders.length})</div>
    ${remindersHtml}
  </div>

  <div class="section">
    <div class="section-title">Personality insights (${personalitySignals.length})</div>
    ${signalsHtml}
  </div>

</div>
</body>
</html>`;
}

// ─── Shared export-data loader ────────────────────────────────────────────────
// Fetches every user-owned record used by both the downloadable export and the
// in-app readable report. Keeping this in one place means the report and the
// export can never drift apart.

// Builds an extra SQL fragment + params that restricts a query to an optional
// [from, to] date range. `column` is the date/timestamp column to filter on.
// `isDateType` true → the column is a DATE (compare inclusively); false → it's a
// TIMESTAMP, so `to` is treated as end-of-day (< to + 1 day) to include the
// whole final day. Params start at $startIndex so callers can slot them after
// the existing user_id placeholder.
function buildRangeClause(
  column: string,
  isDateType: boolean,
  range: DateRange,
  startIndex: number,
): { clause: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  let idx = startIndex;

  if (range.from) {
    const p = "$" + idx; // positional placeholder, e.g. "$2"
    clauses.push(`${column} >= ${p}`);
    params.push(range.from);
    idx++;
  }
  if (range.to) {
    const p = "$" + idx;
    if (isDateType) {
      clauses.push(`${column} <= ${p}`);
    } else {
      clauses.push(`${column} < (${p}::date + interval '1 day')`);
    }
    params.push(range.to);
    idx++;
  }

  return { clause: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

interface DateRange {
  from?: string; // YYYY-MM-DD, inclusive
  to?: string;   // YYYY-MM-DD, inclusive
}

async function fetchExportPayload(userId: number, range: DateRange = {}) {
  // Each dataset filters on its own natural date column. The profile is the
  // user's single settings record and is always included regardless of range.
  const messagesRange = buildRangeClause("created_at", false, range, 2);
  const memoryRange = buildRangeClause("created_at", false, range, 2);
  const winsRange = buildRangeClause("created_at", false, range, 2);
  const habitsRange = buildRangeClause("created_at", false, range, 2);
  const habitCompletionsRange = buildRangeClause("hc.completed_date", true, range, 2);
  const goalsRange = buildRangeClause("created_at", false, range, 2);
  const moodRange = buildRangeClause("date", true, range, 2);
  const commitmentsRange = buildRangeClause("created_at", false, range, 2);
  const remindersRange = buildRangeClause("created_at", false, range, 2);
  const signalsRange = buildRangeClause("created_at", false, range, 2);

  const [
    messagesResult,
    memoryResult,
    winsResult,
    habitsResult,
    habitCompletionsResult,
    goalsResult,
    moodResult,
    profileResult,
    commitmentsResult,
    remindersResult,
    personalitySignalsResult,
  ] = await Promise.all([
    pool.query(
      `SELECT role, content, is_morning_note, created_at FROM messages WHERE user_id = $1${messagesRange.clause} ORDER BY created_at ASC`,
      [userId, ...messagesRange.params],
    ),
    pool.query(
      `SELECT fact, created_at FROM memory_facts WHERE user_id = $1${memoryRange.clause} ORDER BY created_at ASC`,
      [userId, ...memoryRange.params],
    ),
    pool.query(
      `SELECT content, created_at FROM wins WHERE user_id = $1${winsRange.clause} ORDER BY created_at ASC`,
      [userId, ...winsRange.params],
    ),
    pool.query(
      `SELECT id, name, when_then, created_at FROM habits WHERE user_id = $1${habitsRange.clause} ORDER BY created_at ASC`,
      [userId, ...habitsRange.params],
    ),
    pool.query(
      `SELECT h.name AS habit_name, hc.completed_date FROM habit_completions hc
       JOIN habits h ON h.id = hc.habit_id
       WHERE h.user_id = $1${habitCompletionsRange.clause} ORDER BY hc.completed_date ASC`,
      [userId, ...habitCompletionsRange.params],
    ),
    pool.query(
      `SELECT title, description, is_complete, created_at FROM goals WHERE user_id = $1${goalsRange.clause} ORDER BY created_at ASC`,
      [userId, ...goalsRange.params],
    ),
    pool.query(
      `SELECT score, date FROM mood_scores WHERE user_id = $1${moodRange.clause} ORDER BY date ASC`,
      [userId, ...moodRange.params],
    ),
    pool.query(
      `SELECT companion_name, user_path, companion_gender, country, age_band, timezone, created_at FROM profile WHERE user_id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT content, cue, state, created_at FROM commitments WHERE user_id = $1${commitmentsRange.clause} ORDER BY created_at ASC`,
      [userId, ...commitmentsRange.params],
    ),
    pool.query(
      `SELECT content, due_date, is_done, scheduled_time, is_recurring, created_at FROM reminders WHERE user_id = $1${remindersRange.clause} ORDER BY created_at ASC`,
      [userId, ...remindersRange.params],
    ),
    pool.query(
      `SELECT signal, observed_count, is_active, created_at FROM personality_signals WHERE user_id = $1${signalsRange.clause} ORDER BY created_at ASC`,
      [userId, ...signalsRange.params],
    ),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    range: range.from || range.to ? { from: range.from ?? null, to: range.to ?? null } : null,
    profile: profileResult.rows[0] ?? null,
    messages: messagesResult.rows,
    memoryFacts: memoryResult.rows,
    wins: winsResult.rows,
    habits: habitsResult.rows,
    habitCompletions: habitCompletionsResult.rows,
    goals: goalsResult.rows,
    moodScores: moodResult.rows,
    commitments: commitmentsResult.rows,
    reminders: remindersResult.rows,
    personalitySignals: personalitySignalsResult.rows,
  };
}

// ─── GET /account/export ──────────────────────────────────────────────────────
// Returns either a JSON file or a styled HTML report depending on ?format=html.
// Both cover all user data for download (GDPR Art. 20).

// Accepts only YYYY-MM-DD; anything else is rejected so a bad value can never
// reach a query or silently return the full history.
function parseRangeParam(value: unknown): string | null | undefined {
  if (value === undefined) return undefined; // not provided
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null; // wrong shape
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible calendar dates (e.g. 2026-02-30): JS rolls them over to
  // the next month, so require the parsed date to round-trip back to the input.
  if (d.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function readRange(req: { query: Record<string, unknown> }): DateRange | { error: string } {
  const from = parseRangeParam(req.query.from);
  const to = parseRangeParam(req.query.to);
  if (from === null || to === null) {
    return { error: "Invalid date range. Use YYYY-MM-DD for 'from' and 'to'." };
  }
  if (from && to && from > to) {
    return { error: "The 'from' date must be on or before the 'to' date." };
  }
  return { from: from ?? undefined, to: to ?? undefined };
}

router.get("/account/export", async (req, res): Promise<void> => {
  const userId = (req as any).userId as number;
  const format = (req.query.format as string | undefined)?.toLowerCase();

  const range = readRange(req);
  if ("error" in range) {
    res.status(400).json({ error: range.error });
    return;
  }

  try {
    const exportPayload = await fetchExportPayload(userId, range);

    const dateSlug = new Date().toISOString().slice(0, 10);

    if (format === "html") {
      const html = buildHtmlReport(exportPayload);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="eos-report-${dateSlug}.html"`);
      res.send(html);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="eos-export-${dateSlug}.json"`);
      res.json(exportPayload);
    }

    logger.info({ userId, format: format ?? "json" }, "Account data exported");
  } catch (err) {
    logger.error({ err, userId }, "Failed to export account data");
    res.status(500).json({ error: "Failed to export your data. Please try again." });
  }
});

// ─── GET /account/report ──────────────────────────────────────────────────────
// Returns the same styled HTML report as ?format=html, but served inline (no
// download prompt) so it can be rendered directly inside the app — e.g. in an
// iframe overlay. Content is identical to the downloadable report.

router.get("/account/report", async (req, res): Promise<void> => {
  const userId = (req as any).userId as number;

  const range = readRange(req);
  if ("error" in range) {
    res.status(400).json({ error: range.error });
    return;
  }

  try {
    const exportPayload = await fetchExportPayload(userId, range);
    const html = buildHtmlReport(exportPayload);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
    logger.info({ userId }, "Account report viewed in-app");
  } catch (err) {
    logger.error({ err, userId }, "Failed to render account report");
    res.status(500).json({ error: "Failed to load your report. Please try again." });
  }
});

// ─── GET /account/export/summary ─────────────────────────────────────────────
// Returns lightweight counts used to show a preview card before the user
// downloads the full JSON export.

router.get("/account/export/summary", async (req, res): Promise<void> => {
  const userId = (req as any).userId as number;

  try {
    // The preview must mirror every user-owned category the full export
    // (fetchExportPayload) returns, so a user sees the complete picture of what
    // they'll download. The one export field with no count is the profile — it's
    // a single settings record, not a collection.
    const [
      msgResult,
      habitResult,
      moodResult,
      memResult,
      winResult,
      goalResult,
      commitmentResult,
      reminderResult,
      signalResult,
      habitCompletionResult,
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at
         FROM messages WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM habits WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM mood_scores WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM memory_facts WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM wins WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM goals WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM commitments WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM reminders WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM personality_signals WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM habit_completions hc
         JOIN habits h ON h.id = hc.habit_id
         WHERE h.user_id = $1`,
        [userId],
      ),
    ]);

    res.json({
      messageCount:  parseInt(msgResult.rows[0].count, 10),
      habitCount:    parseInt(habitResult.rows[0].count, 10),
      moodCount:     parseInt(moodResult.rows[0].count, 10),
      memoryCount:   parseInt(memResult.rows[0].count, 10),
      winCount:      parseInt(winResult.rows[0].count, 10),
      goalCount:     parseInt(goalResult.rows[0].count, 10),
      commitmentCount: parseInt(commitmentResult.rows[0].count, 10),
      reminderCount: parseInt(reminderResult.rows[0].count, 10),
      personalitySignalCount: parseInt(signalResult.rows[0].count, 10),
      habitCompletionCount: parseInt(habitCompletionResult.rows[0].count, 10),
      firstMessageAt: msgResult.rows[0].first_at ?? null,
      lastMessageAt:  msgResult.rows[0].last_at  ?? null,
    });
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch export summary");
    res.status(500).json({ error: "Could not load summary. Please try again." });
  }
});

export default router;
