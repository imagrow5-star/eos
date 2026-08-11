import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, X, Download, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

// ─── Reflections (Memory page section) ────────────────────────────────────────
// Generate / list / view / download / delete the user's reflection reports.
// Talks to the Phase-1/2 endpoints via apiFetch (session-authed, same pattern
// as the rest of the Memory page). Responsive by construction: the header wraps,
// cards stack, action buttons wrap, and the report opens in a scrollable modal
// sized for small phones (max-h-[85vh]) through desktop (max-w-lg).

interface ReflectionListItem {
  id: number;
  periodStart: string;
  periodEnd: string;
  generatedBy: string;
  createdAt: string;
}
interface ReflectionFull extends ReflectionListItem {
  content: string;
}

const base = () => `${import.meta.env.BASE_URL}api/reflection`;

function fmtRange(startISO: string, endISO: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = new Date(startISO).toLocaleDateString(undefined, opts);
  const e = new Date(endISO).toLocaleDateString(undefined, { ...opts, year: "numeric" });
  return `${s} – ${e}`;
}

/** Strip inline Markdown emphasis so the rendered report reads clean. */
function stripInline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(?!\s)(.+?)\*/g, "$1$2").replace(/`(.+?)`/g, "$1");
}

/** Minimal, safe Markdown → JSX for the report body (no raw HTML). */
function renderReport(md: string) {
  return md.split(/\r?\n/).map((raw, i) => {
    const line = raw.trim();
    if (!line) return <div key={i} className="h-1.5" />;
    const heading = /^\*\*(.+)\*\*$/.exec(line) ?? /^#{1,6}\s+(.+)$/.exec(line);
    if (heading)
      return (
        <h4 key={i} className="font-serif text-[15px] text-foreground/90 mt-4 first:mt-0">
          {stripInline(heading[1]!)}
        </h4>
      );
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet)
      return (
        <p key={i} className="text-[13.5px] text-foreground/80 leading-relaxed pl-4 relative before:content-['•'] before:absolute before:left-0 before:text-primary-strong/60">
          {stripInline(bullet[1]!)}
        </p>
      );
    const quote = /^>\s?(.+)$/.exec(line);
    if (quote)
      return (
        <p key={i} className="text-[13.5px] text-foreground/70 italic border-l-2 border-primary/20 pl-3">
          “{stripInline(quote[1]!)}”
        </p>
      );
    return (
      <p key={i} className="text-[13.5px] text-foreground/80 leading-relaxed">
        {stripInline(line)}
      </p>
    );
  });
}

export default function ReflectionsSection() {
  const [reports, setReports] = useState<ReflectionListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReflectionFull | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(base());
      if (!r.ok) return;
      const data = (await r.json()) as ReflectionListItem[];
      if (Array.isArray(data)) setReports(data);
    } catch {
      /* offline / not ready — leave the section quiet */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const r = await apiFetch(`${base()}/generate`, { method: "POST" });
      if (r.status === 503) {
        setError("Reflections are taking a short break — please try again in a little while.");
        return;
      }
      if (r.status === 429) {
        setError("You just created a reflection — give it a little while before the next one.");
        return;
      }
      if (!r.ok) {
        setError("Couldn't create your reflection just now — try again in a minute.");
        return;
      }
      const data = (await r.json()) as { report?: ReflectionFull; status?: string };
      await load();
      if (data.report) setOpen(data.report);
      else if (data.status === "skipped") setError("There isn't quite enough here to reflect on yet — keep talking and try again soon.");
    } catch {
      setError("Couldn't create your reflection just now — try again in a minute.");
    } finally {
      setGenerating(false);
    }
  };

  const view = async (id: number) => {
    setBusyId(id);
    try {
      const r = await apiFetch(`${base()}/${id}`);
      if (r.ok) setOpen((await r.json()) as ReflectionFull);
    } finally {
      setBusyId(null);
    }
  };

  const download = async (id: number, format: "md" | "txt" | "pdf") => {
    try {
      const r = await apiFetch(`${base()}/${id}/export?format=${format}`);
      if (!r.ok) throw new Error("export failed");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const a = document.createElement("a");
      a.href = url;
      a.download = `eos-reflection-${stamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't prepare that download — try again in a minute.");
    }
  };

  const remove = async (id: number) => {
    setBusyId(id);
    try {
      const r = await apiFetch(`${base()}/${id}`, { method: "DELETE" });
      if (r.ok) {
        setReports((prev) => prev.filter((x) => x.id !== id));
        if (open?.id === id) setOpen(null);
      }
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  };

  return (
    <section className="space-y-4 pb-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-serif text-xl text-foreground/85">Reflections</h2>
        <button
          onClick={generate}
          disabled={generating}
          className="flex items-center gap-1.5 text-[11.5px] font-medium tracking-wider uppercase text-primary-strong/90 rounded-full border border-primary/25 bg-primary/8 hover:bg-primary/15 px-3.5 py-2 transition-colors disabled:opacity-50"
        >
          {generating ? (
            <motion.div
              className="w-3 h-3 border border-primary-strong/60 border-t-transparent rounded-full"
              animate={{ rotate: 360 }}
              transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
            />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          {generating ? "Reflecting…" : "New reflection"}
        </button>
      </div>

      <p className="text-[12.5px] text-muted-foreground/70 font-serif italic leading-relaxed max-w-md">
        A gentle look back at what you've talked about — in your own words, never a diagnosis.
      </p>

      {error && (
        <p className="text-[12.5px] text-amber-700 dark:text-amber-400/80 leading-relaxed">{error}</p>
      )}

      {loaded && reports.length === 0 && !error && (
        <div className="bg-card border border-primary/15 rounded-xl px-4 py-4">
          <p className="text-[13px] text-muted-foreground/70 leading-relaxed">
            No reflections yet. When you've talked things through for a bit, tap
            <span className="text-primary-strong/80"> New reflection</span> and I'll gather the threads.
          </p>
        </div>
      )}

      {reports.length > 0 && (
        <div className="space-y-2.5">
          {reports.map((r) => (
            <div key={r.id} className="bg-card border border-primary/15 rounded-xl px-4 py-3 space-y-2.5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm text-foreground/85">{fmtRange(r.periodStart, r.periodEnd)}</p>
                  <p className="text-[10.5px] text-muted-foreground/50 mt-0.5">
                    {new Date(r.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                    {r.generatedBy === "auto" ? " · weekly" : ""}
                  </p>
                </div>
                <button
                  onClick={() => view(r.id)}
                  disabled={busyId === r.id}
                  className="text-[11px] font-medium tracking-wider uppercase text-primary-strong/85 hover:text-primary-strong rounded-full border border-primary/20 hover:border-primary/40 px-3 py-1.5 transition-colors disabled:opacity-50 shrink-0"
                >
                  Read
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap pt-0.5 border-t border-primary/8">
                <span className="text-[10px] text-muted-foreground/45 tracking-wider uppercase pt-2">Download</span>
                {(["md", "txt", "pdf"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => download(r.id, f)}
                    className="mt-2 flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/60 hover:text-primary-strong/80 rounded-md border border-primary/15 hover:border-primary/35 px-2 py-1 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    {f}
                  </button>
                ))}
                <button
                  onClick={() => setConfirmDelete(r.id)}
                  className="mt-2 ml-auto flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/45 hover:text-destructive/80 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Read modal ─────────────────────────────────────────────────────── */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 sm:px-6"
          onClick={() => setOpen(null)}
        >
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-card border border-primary/20 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-xl"
          >
            <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-primary/10 shrink-0">
              <div className="min-w-0">
                <h3 className="font-serif text-[17px] text-foreground/90">Your reflection</h3>
                <p className="text-[11px] text-muted-foreground/55">{fmtRange(open.periodStart, open.periodEnd)}</p>
              </div>
              <button
                onClick={() => setOpen(null)}
                className="text-muted-foreground/50 hover:text-foreground/80 transition-colors shrink-0 p-1"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto px-5 sm:px-6 py-4 space-y-1.5">{renderReport(open.content)}</div>
            <div className="flex items-center gap-2 flex-wrap px-5 sm:px-6 py-3 border-t border-primary/10 shrink-0">
              <span className="text-[10px] text-muted-foreground/45 tracking-wider uppercase">Download</span>
              {(["md", "txt", "pdf"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => download(open.id, f)}
                  className="flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/60 hover:text-primary-strong/80 rounded-md border border-primary/15 hover:border-primary/35 px-2 py-1 transition-colors"
                >
                  <Download className="w-3 h-3" />
                  {f}
                </button>
              ))}
            </div>
          </motion.div>
        </div>
      )}

      {/* ── Delete confirm ─────────────────────────────────────────────────── */}
      {confirmDelete !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6">
          <div className="bg-card border border-primary/20 rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-xl">
            <h2 className="font-serif text-[19px] text-foreground/90">Delete this reflection?</h2>
            <p className="text-[13px] text-muted-foreground/85 leading-relaxed">
              This permanently removes this reflection. Your conversations and memories are untouched.
            </p>
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={busyId === confirmDelete}
                className="text-[12px] text-muted-foreground/60 hover:text-foreground/80 px-3 py-2 tracking-wider uppercase transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => remove(confirmDelete)}
                disabled={busyId === confirmDelete}
                className="flex items-center gap-1.5 text-[12px] text-destructive tracking-wider uppercase font-medium rounded-lg border border-destructive/25 bg-destructive/10 hover:bg-destructive/20 px-3 py-2 transition-colors disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
