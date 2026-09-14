/**
 * The helpline card's first line when ONLY the semantic backstop fired.
 *
 * "what is the use of the living" matches no regex pattern; the Haiku
 * backstop (told to answer YES on ambiguity) fires, the reinforcement block
 * has Eos ask whether it's philosophical or about right now — and the card
 * used to open "Someone who can be with you right now", contradicting that
 * question. The card still fires on the same turn, every time; it now opens
 * "Whichever it is — these are here if you ever want them:" for a
 * backstop-only detection, and keeps its original first line for a regex hit.
 *
 * The classifier is mocked to YES here (the suite is keyless); the regex
 * path is exercised unmocked in the same file for the contrast.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

vi.mock("../services/crisis/semanticDetector.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/crisis/semanticDetector.js")>();
  return {
    ...real,
    detectCrisisSemantic: vi.fn(async () => ({ matched: true, available: true })),
  };
});

const DB = Boolean(process.env.DATABASE_URL);

function lastEvent(text: string, name: string): Record<string, unknown> | null {
  const re = new RegExp(`event: ${name}\\ndata: (.*)\\n`, "g");
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text))) last = m[1]!;
  return last ? (JSON.parse(last) as Record<string, unknown>) : null;
}

describe.skipIf(!DB)("helpline card intro by detection tier (demo route)", () => {
  let app: Express;
  beforeAll(async () => {
    app = (await import("../app.js")).default;
  });

  const post = (message: string) => request(app).post("/api/demo/message").send({ message, history: [] });

  it("a backstop-only detection opens the card with the ambiguous line, same turn", async () => {
    const res = await post("what is the use of the living");
    expect(res.status).toBe(200);
    const done = lastEvent(res.text, "done");
    expect(done).not.toBeNull();
    const block = done!.crisisHelplineBlock as string;
    expect(block).toMatch(/^—\nWhichever it is — these are here if you ever want them:\n- /);
    expect(block.endsWith("I'm not going anywhere. Take your time.")).toBe(true);
    expect(done!.content as string).toContain(block);
  });

  it("a regex hit keeps the original first line", async () => {
    const res = await post("I want to kill myself");
    expect(res.status).toBe(200);
    const block = lastEvent(res.text, "done")!.crisisHelplineBlock as string;
    expect(block).toMatch(/^—\nSomeone who can be with you right now/);
  });
});
