import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, reflectionReportsTable } from "@workspace/db";
import { fetchExportPayload } from "./account.js";
import { generateReflectionReport } from "../services/reflection/generateReport.js";
import { reflectionGenerateUsageLimits } from "../middleware/usageLimits.js";
import {
  normalizeFormat,
  reflectionContentType,
  reflectionExportFilename,
  reflectionToPlainText,
  reflectionToPdf,
} from "../services/reflection/exportReport.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

// ─── Reflection reports ───────────────────────────────────────────────────────
// A periodic reflection built from what the user already said. This route is a
// thin orchestrator: it reuses the EXISTING export loader (fetchExportPayload)
// for the period's data and hands it to the generation service — no parallel
// export/data pipeline. Auth (requireAuth + requireVerified) is enforced
// upstream in routes/index.ts, so req.userId is always the caller and every
// query below is keyed on it.

const router: IRouter = Router();

const DEFAULT_PERIOD_DAYS = 7;

/** YYYY-MM-DD in UTC — the inclusive-date shape fetchExportPayload expects. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// POST /reflection/generate — on-demand generation. Always runs (the button
// never refuses); a paid pair of LLM calls, so it's rate-limited.
router.post(
  "/reflection/generate",
  ...reflectionGenerateUsageLimits,
  async (req, res): Promise<void> => {
    const userId = req.userId;
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    try {
      const payload = await fetchExportPayload(userId, { from: ymd(periodStart), to: ymd(periodEnd) });
      const outcome = await generateReflectionReport({
        userId,
        payload,
        periodStart,
        periodEnd,
        generatedBy: "on_demand",
      });

      if (outcome.status === "unavailable") {
        res
          .status(503)
          .json({ error: "Reflection is temporarily unavailable — please try again shortly." });
        return;
      }
      if (outcome.status === "skipped_insufficient") {
        // On-demand never returns this, but handle it defensively.
        res.status(200).json({ status: "skipped", reason: "not_enough_conversation" });
        return;
      }

      const r = outcome.report;
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.info({ uh, reportId: r.id }, "Reflection report generated");
      } catch {
        /* logging must never crash the caller */
      }
      res.status(201).json({
        report: {
          id: r.id,
          content: r.content,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          generatedBy: r.generatedBy,
          createdAt: r.createdAt,
        },
      });
    } catch (err) {
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.error({ err, uh }, "Reflection generate failed");
      } catch {
        /* logging must never crash the caller */
      }
      res
        .status(500)
        .json({ error: "Couldn't build your reflection — try again in a minute." });
    }
  },
);

// GET /reflection — list the caller's reports, newest first. Metadata only (no
// content) so the list stays light and avoids decrypting every report body.
router.get("/reflection", async (req, res): Promise<void> => {
  const userId = req.userId;
  const rows = await db
    .select({
      id: reflectionReportsTable.id,
      periodStart: reflectionReportsTable.periodStart,
      periodEnd: reflectionReportsTable.periodEnd,
      generatedBy: reflectionReportsTable.generatedBy,
      createdAt: reflectionReportsTable.createdAt,
    })
    .from(reflectionReportsTable)
    .where(eq(reflectionReportsTable.userId, userId))
    .orderBy(desc(reflectionReportsTable.createdAt));
  res.json(rows);
});

// GET /reflection/:id — full report (decrypted content), ownership-checked.
router.get("/reflection/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [row] = await db
    .select()
    .from(reflectionReportsTable)
    .where(and(eq(reflectionReportsTable.id, id), eq(reflectionReportsTable.userId, userId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({
    id: row.id,
    content: row.content,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt,
  });
});

// GET /reflection/:id/export?format=md|txt|pdf — download one report as a file.
// A pure DB read + server-side formatting (no per-use API cost), ownership-
// checked. The user takes the file anywhere (Notes, Obsidian, Docs, …).
router.get("/reflection/:id/export", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [row] = await db
    .select()
    .from(reflectionReportsTable)
    .where(and(eq(reflectionReportsTable.id, id), eq(reflectionReportsTable.userId, userId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const format = normalizeFormat(req.query.format as string | undefined);
  const filename = reflectionExportFilename(format, new Date(row.createdAt));

  try {
    res.setHeader("Content-Type", reflectionContentType(format));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (format === "markdown") {
      res.send(row.content);
    } else if (format === "txt") {
      res.send(reflectionToPlainText(row.content));
    } else {
      const pdf = await reflectionToPdf({
        content: row.content,
        periodStart: new Date(row.periodStart),
        periodEnd: new Date(row.periodEnd),
        createdAt: new Date(row.createdAt),
      });
      res.setHeader("Content-Length", String(pdf.length));
      res.end(pdf);
    }
  } catch (err) {
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.error({ err, uh, format }, "Reflection export failed");
    } catch {
      /* logging must never crash the caller */
    }
    res.status(500).json({ error: "Couldn't prepare that download — try again in a minute." });
  }
});

// DELETE /reflection/:id — hard delete, ownership-checked.
router.delete("/reflection/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const deleted = await db
    .delete(reflectionReportsTable)
    .where(and(eq(reflectionReportsTable.id, id), eq(reflectionReportsTable.userId, userId)))
    .returning({ id: reflectionReportsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
