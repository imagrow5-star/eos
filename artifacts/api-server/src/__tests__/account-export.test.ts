/**
 * Integration tests: GET /api/account/export data completeness and isolation.
 *
 * Covers:
 *  1. All user-owned tables are included in the export JSON.
 *  2. User A's export contains only User A's rows — no bleed from User B.
 *  3. Removing a row between exports causes the export to reflect live state.
 *  4. Schema-coverage guard: every table with a user_id column is represented
 *     in the export payload or explicitly documented as an exception.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

// ─── DB connection ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions              WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM password_reset_tokens       WHERE user_id = ${uid};
    DELETE FROM email_verification_tokens   WHERE user_id = ${uid};
    DELETE FROM messages                    WHERE user_id = ${uid};
    DELETE FROM memory_facts                WHERE user_id = ${uid};
    DELETE FROM personality_signals         WHERE user_id = ${uid};
    DELETE FROM wins                        WHERE user_id = ${uid};
    DELETE FROM mood_scores                 WHERE user_id = ${uid};
    DELETE FROM reminders                   WHERE user_id = ${uid};
    DELETE FROM commitments                 WHERE user_id = ${uid};
    DELETE FROM habit_completions           WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid});
    DELETE FROM habits                      WHERE user_id = ${uid};
    DELETE FROM goals                       WHERE user_id = ${uid};
    DELETE FROM profile                     WHERE user_id = ${uid};
    DELETE FROM users                       WHERE id      = ${uid};
    COMMIT;
  `);
}

interface PopulatedUser {
  userId: number;
  habitId: number;
  goalId: number;
  messageContent: string;
  winContent: string;
  memoryFact: string;
  habitName: string;
  goalTitle: string;
  commitmentContent: string;
  reminderContent: string;
  personalitySignal: string;
}

/** Sign up a test user, verify their email, and populate all export-relevant tables. */
async function signupAndPopulate(
  agent: ReturnType<typeof request.agent>,
  email: string,
  tag: string,
): Promise<PopulatedUser> {
  const signupRes = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;

  // Mark the email as verified so the user passes requireVerified middleware
  await pool.query(
    `UPDATE users SET email_verified_at = NOW() WHERE id = $1`,
    [userId],
  );

  // profile — ensure it exists
  const profileExists = await pool.query(
    "SELECT id FROM profile WHERE user_id = $1 LIMIT 1",
    [userId],
  );
  if (!profileExists.rowCount) {
    await pool.query(
      `INSERT INTO profile (user_id, user_name, companion_name, user_path)
       VALUES ($1, $2, 'Asha', 'breakup')`,
      [userId, `User ${tag}`],
    );
  }

  // messages
  const messageContent = `hello from ${tag}`;
  await pool.query(
    `INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2)`,
    [userId, messageContent],
  );

  // memory_facts
  const memoryFact = `fact from ${tag}`;
  await pool.query(
    `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, $2, 'life')`,
    [userId, memoryFact],
  );

  // wins
  const winContent = `win from ${tag}`;
  await pool.query(
    `INSERT INTO wins (user_id, content) VALUES ($1, $2)`,
    [userId, winContent],
  );

  // habits + habit_completions
  const habitName = `Habit-${tag}`;
  const habitRow = await pool.query<{ id: number }>(
    `INSERT INTO habits (user_id, name, when_then, reason)
     VALUES ($1, $2, 'Every morning', 'Health') RETURNING id`,
    [userId, habitName],
  );
  const habitId = habitRow.rows[0]!.id;

  await pool.query(
    `INSERT INTO habit_completions (user_id, habit_id, completed_date)
     VALUES ($1, $2, '2026-07-14')`,
    [userId, habitId],
  );

  // goals
  const goalTitle = `Goal-${tag}`;
  const goalRow = await pool.query<{ id: number }>(
    `INSERT INTO goals (user_id, title, description)
     VALUES ($1, $2, 'Test goal desc') RETURNING id`,
    [userId, goalTitle],
  );
  const goalId = goalRow.rows[0]!.id;

  // mood_scores
  await pool.query(
    `INSERT INTO mood_scores (user_id, score, date) VALUES ($1, 7, '2026-07-14')`,
    [userId],
  );

  // commitments
  const commitmentContent = `commitment from ${tag}`;
  await pool.query(
    `INSERT INTO commitments (user_id, content, cue) VALUES ($1, $2, 'morning')`,
    [userId, commitmentContent],
  );

  // reminders
  const reminderContent = `reminder from ${tag}`;
  await pool.query(
    `INSERT INTO reminders (user_id, content) VALUES ($1, $2)`,
    [userId, reminderContent],
  );

  // personality_signals
  const personalitySignal = `signal-${tag}`;
  await pool.query(
    `INSERT INTO personality_signals (user_id, signal) VALUES ($1, $2)`,
    [userId, personalitySignal],
  );

  return {
    userId, habitId, goalId,
    messageContent, winContent, memoryFact,
    habitName, goalTitle,
    commitmentContent, reminderContent, personalitySignal,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TS = Date.now();
const EMAIL_A = `export-a-${TS}@example.invalid`;
const EMAIL_B = `export-b-${TS}@example.invalid`;

describe("GET /api/account/export", () => {
  afterEach(async () => {
    await Promise.all([cleanupUser(EMAIL_A), cleanupUser(EMAIL_B)]);
  });

  it("includes all user-owned data in the JSON export", async () => {
    const agentA = request.agent(app);
    const a = await signupAndPopulate(agentA, EMAIL_A, "A");

    const res = await agentA.get("/api/account/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    const body = res.body as {
      exportedAt: string;
      profile: Record<string, unknown> | null;
      messages: Record<string, unknown>[];
      memoryFacts: Record<string, unknown>[];
      wins: Record<string, unknown>[];
      habits: Record<string, unknown>[];
      habitCompletions: Record<string, unknown>[];
      goals: Record<string, unknown>[];
      moodScores: Record<string, unknown>[];
      commitments: Record<string, unknown>[];
      reminders: Record<string, unknown>[];
      personalitySignals: Record<string, unknown>[];
    };

    // Top-level shape
    expect(body.exportedAt).toBeDefined();
    expect(typeof body.exportedAt).toBe("string");

    // profile present
    expect(body.profile).not.toBeNull();

    // messages
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages.some((m) => m.content === a.messageContent)).toBe(true);

    // memory_facts
    expect(body.memoryFacts.length).toBeGreaterThanOrEqual(1);
    expect(body.memoryFacts.some((f) => f.fact === a.memoryFact)).toBe(true);

    // wins
    expect(body.wins.length).toBeGreaterThanOrEqual(1);
    expect(body.wins.some((w) => w.content === a.winContent)).toBe(true);

    // habits
    expect(body.habits.length).toBeGreaterThanOrEqual(1);
    expect(body.habits.some((h) => h.name === a.habitName)).toBe(true);

    // habit_completions
    expect(body.habitCompletions.length).toBeGreaterThanOrEqual(1);
    expect(body.habitCompletions.some((hc) => hc.habit_name === a.habitName)).toBe(true);

    // goals
    expect(body.goals.length).toBeGreaterThanOrEqual(1);
    expect(body.goals.some((g) => g.title === a.goalTitle)).toBe(true);

    // mood_scores
    expect(body.moodScores.length).toBeGreaterThanOrEqual(1);
    expect(body.moodScores.some((m) => m.score === 7)).toBe(true);

    // commitments
    expect(body.commitments.length).toBeGreaterThanOrEqual(1);
    expect(body.commitments.some((c) => c.content === a.commitmentContent)).toBe(true);

    // reminders
    expect(body.reminders.length).toBeGreaterThanOrEqual(1);
    expect(body.reminders.some((r) => r.content === a.reminderContent)).toBe(true);

    // personality_signals
    expect(body.personalitySignals.length).toBeGreaterThanOrEqual(1);
    expect(body.personalitySignals.some((s) => s.signal === a.personalitySignal)).toBe(true);
  });

  it("user A's export contains no data belonging to user B", async () => {
    const agentA = request.agent(app);
    const agentB = request.agent(app);

    const [a, b] = await Promise.all([
      signupAndPopulate(agentA, EMAIL_A, "A"),
      signupAndPopulate(agentB, EMAIL_B, "B"),
    ]);

    // Export as user A
    const res = await agentA.get("/api/account/export");
    expect(res.status).toBe(200);

    const body = res.body as {
      messages: { content: string }[];
      memoryFacts: { fact: string }[];
      wins: { content: string }[];
      habits: { name: string }[];
      habitCompletions: { habit_name: string }[];
      goals: { title: string }[];
      commitments: { content: string }[];
      reminders: { content: string }[];
      personalitySignals: { signal: string }[];
    };

    // A's own data is present
    expect(body.messages.some((m) => m.content === a.messageContent)).toBe(true);
    expect(body.wins.some((w) => w.content === a.winContent)).toBe(true);
    expect(body.memoryFacts.some((f) => f.fact === a.memoryFact)).toBe(true);
    expect(body.habits.some((h) => h.name === a.habitName)).toBe(true);
    expect(body.habitCompletions.some((hc) => hc.habit_name === a.habitName)).toBe(true);
    expect(body.goals.some((g) => g.title === a.goalTitle)).toBe(true);
    expect(body.commitments.some((c) => c.content === a.commitmentContent)).toBe(true);
    expect(body.reminders.some((r) => r.content === a.reminderContent)).toBe(true);
    expect(body.personalitySignals.some((s) => s.signal === a.personalitySignal)).toBe(true);

    // B's data must not appear in any section
    expect(body.messages.some((m) => m.content === b.messageContent)).toBe(false);
    expect(body.wins.some((w) => w.content === b.winContent)).toBe(false);
    expect(body.memoryFacts.some((f) => f.fact === b.memoryFact)).toBe(false);
    expect(body.habits.some((h) => h.name === b.habitName)).toBe(false);
    expect(body.habitCompletions.some((hc) => hc.habit_name === b.habitName)).toBe(false);
    expect(body.goals.some((g) => g.title === b.goalTitle)).toBe(false);
    expect(body.commitments.some((c) => c.content === b.commitmentContent)).toBe(false);
    expect(body.reminders.some((r) => r.content === b.reminderContent)).toBe(false);
    expect(body.personalitySignals.some((s) => s.signal === b.personalitySignal)).toBe(false);
  });

  it("export reflects live state — deleted rows disappear on the next call", async () => {
    const agentA = request.agent(app);
    const a = await signupAndPopulate(agentA, EMAIL_A, "A");

    // First export — win is present
    const before = await agentA.get("/api/account/export");
    expect(before.status).toBe(200);
    expect(
      (before.body.wins as { content: string }[]).some((w) => w.content === a.winContent),
    ).toBe(true);

    // Delete the win directly from the DB
    await pool.query(
      `DELETE FROM wins WHERE user_id = $1 AND content = $2`,
      [a.userId, a.winContent],
    );

    // Second export — win must be gone
    const after = await agentA.get("/api/account/export");
    expect(after.status).toBe(200);
    expect(
      (after.body.wins as { content: string }[]).some((w) => w.content === a.winContent),
    ).toBe(false);
  });

  it("returns 401 when the caller is not authenticated", async () => {
    const res = await request(app).get("/api/account/export");
    expect(res.status).toBe(401);
  });

  it("export payload covers every table that has a user_id column", async () => {
    /**
     * Schema-coverage guard (payload-derived).
     *
     * Instead of trusting a hand-maintained list of covered tables, this test
     * reads the ACTUAL JSON export payload and derives which tables it
     * represents from the payload's own keys (camelCase → snake_case). It then
     * asserts that every table with a `user_id` column is either represented in
     * that live payload or listed in INTENTIONAL_EXCEPTIONS with a reason.
     *
     * Because coverage is read from the real response, the guard fails in BOTH
     * directions:
     *   • a new user-owned table is added but no query is added to the export
     *     (the table has a user_id column but never appears in the payload), and
     *   • an existing query is removed from the export route (its key vanishes
     *     from the payload, so the table becomes uncovered again).
     *
     * Tables whose user_id is stored in a non-standard way (jsonb column, e.g.
     * user_sessions) never appear in the information_schema query below, so they
     * are covered by INTENTIONAL_EXCEPTIONS or ignored entirely.
     */

    // Tables with a user_id column that are intentionally excluded from the
    // export because they are internal/operational data rather than user
    // product data, or because they are handled differently.
    const INTENTIONAL_EXCEPTIONS: Record<string, string> = {
      password_reset_tokens: "Internal security tokens — not user product data; excluded from export for security.",
      email_verification_tokens: "Internal security tokens — not user product data; excluded from export for security.",
      // user_sessions stores userId inside a jsonb column, not a typed user_id
      // column, so it never appears in the information_schema query below.
    };

    // ── Fetch the REAL export payload for a freshly created user. Coverage is
    // read from the payload keys, not a static list, so the guard tracks the
    // route exactly. Payload keys are present even when a section has no rows.
    const guardAgent = request.agent(app);
    const guardEmail = `export-guard-${TS}@example.invalid`;
    let payloadKeys: string[] = [];
    try {
      const signupRes = await guardAgent
        .post("/api/auth/signup")
        .send({ email: guardEmail, password: "Test1234!" });
      expect(signupRes.status).toBe(201);
      await pool.query(
        `UPDATE users SET email_verified_at = NOW() WHERE id = $1`,
        [signupRes.body.user.id],
      );

      const exportRes = await guardAgent.get("/api/account/export");
      expect(exportRes.status).toBe(200);
      payloadKeys = Object.keys(exportRes.body as Record<string, unknown>);
    } finally {
      await cleanupUser(guardEmail);
    }

    // ── Load the schema: every table, and which tables have a user_id column.
    const [userIdResult, tablesResult] = await Promise.all([
      pool.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'user_id'
        ORDER BY table_name
      `),
      pool.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
      `),
    ]);
    const tablesWithUserId = userIdResult.rows.map((r) => r.table_name);
    const allTables = new Set(tablesResult.rows.map((r) => r.table_name));

    // ── Derive the covered tables from the payload's own keys. A key like
    // `memoryFacts` maps to the `memory_facts` table; `habitCompletions` →
    // `habit_completions`. Keys that aren't real tables (e.g. `exportedAt`,
    // `range`) are dropped by the allTables filter.
    const toSnakeCase = (k: string) =>
      k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
    const coveredFromPayload = new Set(
      payloadKeys.map(toSnakeCase).filter((t) => allTables.has(t)),
    );

    // Sanity: the payload must map to at least one real table, otherwise the
    // camelCase→snake_case assumption has silently broken and every table below
    // would look "uncovered" for the wrong reason.
    expect(
      coveredFromPayload.size,
      `No export payload key mapped to a real table. Payload keys were:\n  ` +
        `${payloadKeys.join("\n  ")}\n\nThe camelCase→snake_case mapping in ` +
        `this test may need updating.`,
    ).toBeGreaterThan(0);

    // ── Every user-owned table must appear in the live payload or be a
    // documented exception.
    const uncovered = tablesWithUserId.filter(
      (t) => !coveredFromPayload.has(t) && !(t in INTENTIONAL_EXCEPTIONS),
    );
    expect(
      uncovered,
      `The following tables have a user_id column but do NOT appear in the ` +
        `live GET /account/export payload:\n  ${uncovered.join("\n  ")}\n\n` +
        `Add a query for each in the export route (account.ts) so its rows are ` +
        `returned, or add it to INTENTIONAL_EXCEPTIONS in this test file with a ` +
        `reason it should stay out of the user-facing export.`,
    ).toEqual([]);

    // ── Inverse guard: an exception must still be a real table with a user_id
    // column, so stale entries get cleaned up after a rename/drop.
    const schemaSet = new Set(tablesWithUserId);
    const staleExceptions = Object.keys(INTENTIONAL_EXCEPTIONS).filter(
      (t) => !schemaSet.has(t),
    );
    expect(
      staleExceptions,
      `INTENTIONAL_EXCEPTIONS lists tables that no longer have a user_id ` +
        `column in the schema:\n  ${staleExceptions.join("\n  ")}\n\n` +
        `Remove or update these entries in this test file.`,
    ).toEqual([]);
  });
});

// ─── HTML export (?format=html) ─────────────────────────────────────────────────

/** Sign up + verify a user WITHOUT populating any product data. */
async function signupEmptyUser(
  agent: ReturnType<typeof request.agent>,
  email: string,
): Promise<number> {
  const signupRes = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;
  await pool.query(
    `UPDATE users SET email_verified_at = NOW() WHERE id = $1`,
    [userId],
  );
  return userId;
}

const HTML_EMAIL_A = `export-html-a-${TS}@example.invalid`;
const HTML_EMAIL_EMPTY = `export-html-empty-${TS}@example.invalid`;

describe("GET /api/account/export?format=html", () => {
  afterEach(async () => {
    await Promise.all([cleanupUser(HTML_EMAIL_A), cleanupUser(HTML_EMAIL_EMPTY)]);
  });

  it("serves an HTML attachment with the right headers", async () => {
    const agentA = request.agent(app);
    await signupAndPopulate(agentA, HTML_EMAIL_A, "H");

    const res = await agentA.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(/\.html/);
    expect(res.text.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("renders every section heading and real data for a populated user", async () => {
    const agentA = request.agent(app);
    const a = await signupAndPopulate(agentA, HTML_EMAIL_A, "H");

    const res = await agentA.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    const html = res.text;

    // Branding: the report cover carries the Eos wordmark — the old "A S H A"
    // product name must never appear on a user-facing document again.
    expect(html).toContain("E O <span>S</span>");
    expect(html).not.toContain("A S H");

    // Every section heading is present
    expect(html).toContain("Conversation history");
    expect(html).toContain("Wins &amp; victories");
    expect(html).toContain("Habits");
    expect(html).toContain("Goals");
    expect(html).toContain("Mood journal");
    expect(html).toContain("knows about you"); // memory section
    expect(html).toContain("Commitments");
    expect(html).toContain("Reminders");
    expect(html).toContain("Personality insights");

    // Actual data values from each populated table appear in the report
    expect(html).toContain(a.messageContent);
    expect(html).toContain(a.winContent);
    expect(html).toContain(a.habitName);
    expect(html).toContain(a.goalTitle);
    expect(html).toContain(a.memoryFact);
    expect(html).toContain(a.commitmentContent);
    expect(html).toContain(a.reminderContent);
    expect(html).toContain(a.personalitySignal);

    // No empty-state fallbacks should appear when the user has data
    expect(html).not.toContain("No messages yet.");
    expect(html).not.toContain("No wins recorded yet.");
    expect(html).not.toContain("No habits tracked yet.");
    expect(html).not.toContain("No goals set yet.");
  });

  it("shows empty-state fallbacks for a user with no data", async () => {
    const agentEmpty = request.agent(app);
    await signupEmptyUser(agentEmpty, HTML_EMAIL_EMPTY);

    const res = await agentEmpty.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    const html = res.text;

    // Section headings still render...
    expect(html).toContain("Conversation history");
    expect(html).toContain("Mood journal");
    expect(html).toContain("Personality insights");

    // ...but each section shows its "empty" fallback string
    expect(html).toContain("No messages yet.");
    expect(html).toContain("No wins recorded yet.");
    expect(html).toContain("No habits tracked yet.");
    expect(html).toContain("No goals set yet.");
    expect(html).toContain("No mood logs yet.");
    expect(html).toContain("No memories recorded yet.");
    expect(html).toContain("No commitments yet.");
    expect(html).toContain("No reminders set.");
    expect(html).toContain("No personality signals observed yet.");
  });

  it("escapes HTML in user content to prevent broken markup / injection", async () => {
    const agentA = request.agent(app);
    const userId = await signupEmptyUser(agentA, HTML_EMAIL_A);
    const xss = `<script>alert('x')</script> & "quotes"`;
    await pool.query(
      `INSERT INTO wins (user_id, content) VALUES ($1, $2)`,
      [userId, xss],
    );

    const res = await agentA.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    const html = res.text;

    // The raw script tag must never appear unescaped in the output
    expect(html).not.toContain("<script>alert('x')</script>");
    // The escaped form should be present instead
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML report renders a section for every data category in the export payload", async () => {
    /**
     * Section-coverage guard (payload-derived) — the HTML twin of the JSON
     * "export payload covers every table that has a user_id column" guard above.
     *
     * The downloadable/printable HTML report renders a HARDCODED list of
     * sections. A newly added table can flow into the JSON export payload yet
     * never get a section in the report, so the printed report silently omits
     * that category. This guard reads the ACTUAL export payload keys and asserts
     * that each one either maps to a rendered report section or is explicitly
     * documented as intentionally report-excluded.
     *
     * It fails in both directions:
     *   • a new category is added to the export payload but no report section is
     *     added (its key appears in neither map below), and
     *   • an existing report section is removed from buildHtmlReport (its mapped
     *     title no longer appears in the rendered HTML).
     */

    // Payload keys that map to a rendered report section. Each value is a
    // substring that MUST appear in the rendered report when the category is
    // covered. If you add a data category to the export, add its section here
    // (and render it in buildHtmlReport in account.ts).
    const REPORT_SECTIONS: Record<string, string> = {
      messages: "Conversation history",
      wins: "Wins &amp; victories",
      habits: "Habits",
      goals: "Goals",
      moodScores: "Mood journal",
      memoryFacts: "knows about you",
      commitments: "Commitments",
      reminders: "Reminders",
      personalitySignals: "Personality insights",
      personalizationState: "Personalization state",
      weeklyChapters: "Weekly chapters",
      sealedNotes: "Sealed notes",
    };

    // Payload keys that are intentionally NOT their own report section, with the
    // reason why. Keeps the report honest without forcing a section for metadata
    // or data folded into another section.
    const REPORT_EXCLUDED: Record<string, string> = {
      exportedAt: "Export timestamp metadata — rendered in the cover, not a data category.",
      range: "Optional date-range metadata — rendered in the cover, not a data category.",
      profile: "Rendered in the report cover (companion name, journey) rather than a standalone section.",
      habitCompletions: "Folded into the Habits section as per-habit completion counts, not a standalone section.",
      chapterQuoteDismissals:
        "Administrative preference records (which quotes the user hid) — no readable content; present in the JSON export.",
      chapterOfferEvents:
        "Administrative accept/decline log for chapter offers — the goals themselves render in the Goals section; present in the JSON export.",
      storyThreads:
        "Internal narrative-indexing records (thread state machine) — evolving threads already render inside their chapter's Working-it-through section; raw states/streaks are diagnostic, present in the JSON export.",
      pushSubscriptions:
        "Browser push endpoint records (device tokens) — technical delivery plumbing with no readable content; present in the JSON export.",
      pushEvents:
        "Notification delivery log (kind + timestamp) — administrative cap-enforcement records; present in the JSON export.",
    };

    const agentA = request.agent(app);
    const a = await signupAndPopulate(agentA, HTML_EMAIL_A, "H");

    // Read the live export payload keys — coverage is derived from the real
    // response, not a static list, so this tracks the export route exactly.
    const jsonRes = await agentA.get("/api/account/export");
    expect(jsonRes.status).toBe(200);
    const payloadKeys = Object.keys(jsonRes.body as Record<string, unknown>);

    // Render the report for the same populated user.
    const htmlRes = await agentA.get("/api/account/export?format=html");
    expect(htmlRes.status).toBe(200);
    const html = htmlRes.text;

    // Sanity: A's real data must be present so we know the report actually
    // rendered rather than returning an error page.
    expect(html).toContain(a.messageContent);

    // ── Every payload key must map to a report section or be a documented
    // exclusion. A brand-new export category with no section lands here.
    const uncovered = payloadKeys.filter(
      (k) => !(k in REPORT_SECTIONS) && !(k in REPORT_EXCLUDED),
    );
    expect(
      uncovered,
      `The following export payload categories have NO section in the HTML ` +
        `report and are not documented as report-excluded:\n  ${uncovered.join("\n  ")}\n\n` +
        `Add a section for each in buildHtmlReport (account.ts) and map its ` +
        `payload key to a section-title substring in REPORT_SECTIONS in this ` +
        `test, or add it to REPORT_EXCLUDED with a reason it should stay out of ` +
        `the printable report.`,
    ).toEqual([]);

    // ── Each mapped section must actually be rendered. Removing a section from
    // buildHtmlReport while its key still lives in the payload lands here.
    for (const [key, marker] of Object.entries(REPORT_SECTIONS)) {
      if (!payloadKeys.includes(key)) continue;
      expect(
        html.includes(marker),
        `Export payload includes "${key}" but its report section ` +
          `("${marker}") is missing from the rendered HTML report. Restore the ` +
          `section in buildHtmlReport (account.ts) so this category is not ` +
          `silently dropped from the printable report.`,
      ).toBe(true);
    }

    // ── Inverse guard: a REPORT_SECTIONS / REPORT_EXCLUDED entry must still be a
    // real payload key, so stale mappings get cleaned up after a rename/removal.
    const payloadKeySet = new Set(payloadKeys);
    const staleMappings = [
      ...Object.keys(REPORT_SECTIONS),
      ...Object.keys(REPORT_EXCLUDED),
    ].filter((k) => !payloadKeySet.has(k));
    expect(
      staleMappings,
      `REPORT_SECTIONS / REPORT_EXCLUDED reference payload keys that no longer ` +
        `exist in the export:\n  ${staleMappings.join("\n  ")}\n\n` +
        `Remove or update these entries in this test file.`,
    ).toEqual([]);
  });
});
