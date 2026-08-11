import PDFDocument from "pdfkit";

// ─── Reflection report export formatting ──────────────────────────────────────
// The stored report is Markdown. These pure helpers turn one report into the
// three download formats (spec §7): Markdown (as-is), plain text, and PDF.
// Server-side only, no per-use API cost. Kept free of DB/HTTP so they unit-test
// directly, mirroring services/memoryExport.ts.

export type ReflectionExportFormat = "markdown" | "txt" | "pdf";

/** Normalise a user-supplied ?format= value to one of the three we support. */
export function normalizeFormat(raw: string | undefined): ReflectionExportFormat {
  const f = (raw ?? "").toLowerCase();
  if (f === "md" || f === "markdown") return "markdown";
  if (f === "pdf") return "pdf";
  return "txt";
}

export function reflectionContentType(format: ReflectionExportFormat): string {
  if (format === "markdown") return "text/markdown; charset=utf-8";
  if (format === "pdf") return "application/pdf";
  return "text/plain; charset=utf-8";
}

/** eos-reflection-YYYYMMDD.{md|txt|pdf} (mirrors memoryExportFilename). */
export function reflectionExportFilename(format: ReflectionExportFormat, date: Date): string {
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, "");
  const ext = format === "markdown" ? "md" : format;
  return `eos-reflection-${stamp}.${ext}`;
}

/** Human date like "Aug 4, 2026". */
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Strip inline Markdown emphasis/code markers, leaving the words intact. */
function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/(^|\s)\*(?!\s)(.+?)\*/g, "$1$2") // italic *...*
    .replace(/(^|\s)_(?!\s)(.+?)_/g, "$1$2") // italic _..._
    .replace(/`(.+?)`/g, "$1"); // inline code
}

interface Line {
  kind: "heading" | "bullet" | "quote" | "paragraph" | "blank";
  text: string;
}

/**
 * Parse the report Markdown into a small, defensive line model that doesn't
 * depend on the model emitting one exact flavour of Markdown. A heading is a
 * `#`-prefixed line OR a whole line wrapped in `**…**` (the shape the generator
 * tends to use for its four section titles).
 */
function parseLines(markdown: string): Line[] {
  return markdown.split(/\r?\n/).map((raw): Line => {
    const line = raw.trim();
    if (!line) return { kind: "blank", text: "" };
    if (/^#{1,6}\s+/.test(line)) return { kind: "heading", text: stripInline(line.replace(/^#{1,6}\s+/, "")) };
    if (/^\*\*[^*].*\*\*$/.test(line)) return { kind: "heading", text: stripInline(line) };
    if (/^([-*])\s+/.test(line)) return { kind: "bullet", text: stripInline(line.replace(/^([-*])\s+/, "")) };
    if (/^>\s?/.test(line)) return { kind: "quote", text: stripInline(line.replace(/^>\s?/, "")) };
    return { kind: "paragraph", text: stripInline(line) };
  });
}

/** Plain-text rendering for the .txt download — readable, no Markdown noise. */
export function reflectionToPlainText(markdown: string): string {
  const out: string[] = [];
  for (const l of parseLines(markdown)) {
    if (l.kind === "blank") out.push("");
    else if (l.kind === "heading") out.push(l.text.toUpperCase());
    else if (l.kind === "bullet") out.push(`  • ${l.text}`);
    else if (l.kind === "quote") out.push(`  "${l.text}"`);
    else out.push(l.text);
  }
  // Collapse 3+ blank lines to a single blank; trim trailing whitespace.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Render one report to a PDF Buffer with pdfkit's built-in Helvetica family (no
 * external fonts, so nothing to bundle). A4, generous margins, headings bold,
 * bullets indented, quotes italic — legible on a phone screen and a desktop
 * alike (standard PDF, opens in every platform viewer).
 */
export function reflectionToPdf(opts: {
  content: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt?: Date;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 56 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Title + period.
      doc.font("Helvetica-Bold").fontSize(22).fillColor("#1a1a1a").text("Your reflection");
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .fillColor("#6b6b6b")
        .text(`${fmtDate(opts.periodStart)} – ${fmtDate(opts.periodEnd)}`);
      doc.moveDown(1);

      for (const l of parseLines(opts.content)) {
        if (l.kind === "blank") {
          doc.moveDown(0.5);
        } else if (l.kind === "heading") {
          doc.moveDown(0.6);
          doc.font("Helvetica-Bold").fontSize(13.5).fillColor("#1a1a1a").text(l.text);
          doc.moveDown(0.2);
        } else if (l.kind === "bullet") {
          // Manual bullet — pdfkit's list() API is finicky across versions.
          doc.font("Helvetica").fontSize(11.5).fillColor("#2a2a2a").text(`•  ${l.text}`, { indent: 16 });
        } else if (l.kind === "quote") {
          doc.font("Helvetica-Oblique").fontSize(11.5).fillColor("#444").text(`“${l.text}”`, { indent: 16 });
        } else {
          doc.font("Helvetica").fontSize(11.5).fillColor("#2a2a2a").text(l.text, { align: "left" });
        }
      }

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}
