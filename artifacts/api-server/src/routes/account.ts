import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

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
  const { exportedAt, profile, messages, memoryFacts, wins, habits, habitCompletions, goals, moodScores, commitments, reminders, personalitySignals } = data;
  const companionName = esc(profile?.companion_name ?? "Asha");
  const userPath = pathLabel(profile?.user_path as string);

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
  <title>Your ASHA Report</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Inter:wght@400;500&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', sans-serif;
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
      font-family: 'Cormorant Garamond', serif;
      font-size: 28px;
      letter-spacing: 0.5em;
      color: #8c7348;
      margin-bottom: 12px;
    }
    .wordmark span { color: #d4a854; }
    .cover h1 {
      font-family: 'Cormorant Garamond', serif;
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
      font-family: 'Cormorant Garamond', serif;
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
      body { background: white; padding: 0; }
      .cover { padding-top: 20px; }
    }
  </style>
</head>
<body>
<div class="page">

  <div class="cover">
    <div class="wordmark">A S H <span>A</span></div>
    <h1>Your personal report — with ${companionName}</h1>
    <p class="meta">Journey: ${esc(userPath)} &nbsp;·&nbsp; Exported ${fmtDate(exportedAt)}</p>
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

async function fetchExportPayload(userId: number) {
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
      `SELECT role, content, is_morning_note, created_at FROM messages WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    pool.query(
      `SELECT fact, created_at FROM memory_facts WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    pool.query(
      `SELECT content, created_at FROM wins WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    pool.query(
      `SELECT id, name, when_then, created_at FROM habits WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    pool.query(
      `SELECT h.name AS habit_name, hc.completed_date FROM habit_completions hc
       JOIN habits h ON h.id = hc.habit_id
       WHERE h.user_id = $1 ORDER BY hc.completed_date ASC`,
      [userId],
    ),
    pool.query(
      `SELECT title, description, is_complete, created_at FROM goals WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    pool.query(
      `SELECT score, date FROM mood_scores WHERE user_id = $1 ORDER BY date ASC`,
      [userId],
    ),
    pool.query(
      `SELECT companion_name, user_path, companion_gender, country, age_band, timezone, created_at FROM profile WHERE user_id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT content, cue, state, created_at FROM commitments WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    pool.query(
      `SELECT content, due_date, is_done, scheduled_time, is_recurring, created_at FROM reminders WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    pool.query(
      `SELECT signal, observed_count, is_active, created_at FROM personality_signals WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
  ]);

  return {
    exportedAt: new Date().toISOString(),
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

router.get("/account/export", async (req, res): Promise<void> => {
  const userId = (req as any).userId as number;
  const format = (req.query.format as string | undefined)?.toLowerCase();

  try {
    const exportPayload = await fetchExportPayload(userId);

    const dateSlug = new Date().toISOString().slice(0, 10);

    if (format === "html") {
      const html = buildHtmlReport(exportPayload);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="asha-report-${dateSlug}.html"`);
      res.send(html);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="asha-export-${dateSlug}.json"`);
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

  try {
    const exportPayload = await fetchExportPayload(userId);
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
    const [msgResult, habitResult, moodResult, memResult] = await Promise.all([
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
    ]);

    res.json({
      messageCount: parseInt(msgResult.rows[0].count, 10),
      habitCount:   parseInt(habitResult.rows[0].count, 10),
      moodCount:    parseInt(moodResult.rows[0].count, 10),
      memoryCount:  parseInt(memResult.rows[0].count, 10),
      firstMessageAt: msgResult.rows[0].first_at ?? null,
      lastMessageAt:  msgResult.rows[0].last_at  ?? null,
    });
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch export summary");
    res.status(500).json({ error: "Could not load summary. Please try again." });
  }
});

export default router;
