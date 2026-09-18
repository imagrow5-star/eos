/**
 * Voice fire coalescing (services/voice/fireCoalescing.ts): keep one spoken
 * reply per turn across Hume's multi-fires, without ever silencing a real turn.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  decideFire,
  beginFire,
  attachController,
  markReplied,
  markAborted,
  __resetFireCoalescing,
  SUPPRESS_WINDOW_MS,
  COALESCE_WINDOW_MS,
  type PriorFire,
} from "../services/voice/fireCoalescing.js";

const T = 1_000_000; // fixed "now" base

describe("decideFire (pure)", () => {
  it("generates when there is no prior", () => {
    expect(decideFire(null, "hello", T)).toEqual({ action: "generate" });
  });

  it("suppresses an exact duplicate of a prior that already replied, in-window", () => {
    const prior: PriorFire = { content: "did you feed the cat", at: T, state: "replied" };
    const d = decideFire(prior, "did you feed the cat", T + 1300);
    expect(d).toMatchObject({ action: "suppress", kind: "duplicate", gapMs: 1300 });
    expect(d).toMatchObject({ matchedChars: "did you feed the cat".length });
  });

  it("suppresses a shorter prefix of a replied prior (a late fragment), in-window", () => {
    const prior: PriorFire = { content: "i went to petco and then home", at: T, state: "replied" };
    expect(decideFire(prior, "i went to petco", T + 800)).toMatchObject({ action: "suppress", kind: "prefix" });
  });

  it("SUPERSEDES rather than suppresses when the prior is still in flight", () => {
    // Never suppress against an in-flight prior — it might yet be aborted, which
    // would leave the turn silent. Abort it and let the new fire generate.
    const prior: PriorFire = { content: "you're testing me", at: T, state: "in_flight" };
    expect(decideFire(prior, "you're testing me", T + 900)).toMatchObject({
      action: "supersede",
      kind: "duplicate",
    });
  });

  it("supersedes when a continuation arrives while the fragment is in flight", () => {
    const prior: PriorFire = { content: "i keep thinking", at: T, state: "in_flight" };
    expect(decideFire(prior, "i keep thinking about the crash", T + 700)).toMatchObject({
      action: "supersede",
      kind: "continuation",
    });
  });

  it("generates a continuation whose fragment already finished (can't un-speak it)", () => {
    const prior: PriorFire = { content: "i keep thinking", at: T, state: "replied" };
    expect(decideFire(prior, "i keep thinking about the crash", T + 6000)).toEqual({ action: "generate" });
  });

  it("does NOT suppress a replied prior once the tight window has passed", () => {
    const prior: PriorFire = { content: "yes", at: T, state: "replied" };
    // A genuine repeated "yes" seconds later must survive.
    expect(decideFire(prior, "yes", T + SUPPRESS_WINDOW_MS + 1)).toEqual({ action: "generate" });
  });

  it("never suppresses against an aborted prior (it never spoke)", () => {
    const prior: PriorFire = { content: "i can't do this", at: T, state: "aborted" };
    expect(decideFire(prior, "i can't do this", T + 1000)).toEqual({ action: "generate" });
  });

  it("treats a different utterance as a fresh turn", () => {
    const prior: PriorFire = { content: "how are you", at: T, state: "replied" };
    expect(decideFire(prior, "what's the weather", T + 500)).toEqual({ action: "generate" });
  });

  it("treats anything past the outer window as a fresh turn", () => {
    const prior: PriorFire = { content: "hello", at: T, state: "in_flight" };
    expect(decideFire(prior, "hello", T + COALESCE_WINDOW_MS + 1)).toEqual({ action: "generate" });
  });
});

describe("registry: supersede + late end-marker safety", () => {
  beforeEach(() => __resetFireCoalescing());

  it("a superseded fire's late markAborted does NOT clobber the fire that replaced it", () => {
    const a1 = new AbortController();
    const fire1 = beginFire(1, 100, "you're testing me", a1, T);
    expect(fire1.decision.action).toBe("generate");

    // Fire 2 (exact duplicate) arrives while fire 1 is in flight → supersede,
    // aborting fire 1.
    const a2 = new AbortController();
    const fire2 = beginFire(1, 100, "you're testing me", a2, T + 900);
    expect(fire2.decision.action).toBe("supersede");
    expect(a1.signal.aborted).toBe(true); // prior aborted
    expect(a2.signal.aborted).toBe(false); // new one proceeds

    // Fire 1's generation now unwinds and marks itself aborted — with fire1's
    // token. It must NOT flip fire 2's entry to aborted.
    markAborted(1, 100, fire1.fireId!);

    // A third exact duplicate arrives after fire 2 replied, in-window → suppress
    // (proving fire 2's entry is intact and "replied", not clobbered to aborted).
    markReplied(1, 100, fire2.fireId!);
    const a3 = new AbortController();
    const fire3 = beginFire(1, 100, "you're testing me", a3, T + 1500);
    expect(fire3.decision.action).toBe("suppress");
    expect(fire3.fireId).toBeNull();
  });

  it("suppress leaves the slot on the prior and returns no fireId", () => {
    const a1 = new AbortController();
    const f1 = beginFire(2, 200, "hello there", a1, T);
    markReplied(2, 200, f1.fireId!);
    const f2 = beginFire(2, 200, "hello there", new AbortController(), T + 1000);
    expect(f2.decision.action).toBe("suppress");
    expect(f2.fireId).toBeNull();
  });

  it("attachController only binds the current fire", () => {
    const f1 = beginFire(3, 300, "one", null, T);
    // A later distinct turn takes the slot.
    markReplied(3, 300, f1.fireId!);
    const f2 = beginFire(3, 300, "two", null, T + 6000);
    const late = new AbortController();
    attachController(3, 300, f1.fireId!, late); // stale fireId → no-op
    // f2 is the current entry; a duplicate of "two" while in flight supersedes
    // and should try to abort f2's controller, not the stale one.
    const f2ctrl = new AbortController();
    attachController(3, 300, f2.fireId!, f2ctrl);
    beginFire(3, 300, "two", new AbortController(), T + 6500);
    expect(f2ctrl.signal.aborted).toBe(true);
    expect(late.signal.aborted).toBe(false);
  });

  it("separate calls don't interfere", () => {
    const f1 = beginFire(10, 1, "same words", new AbortController(), T);
    markReplied(10, 1, f1.fireId!);
    // Different call (different issuedAt) with identical content → generate.
    const other = beginFire(10, 2, "same words", new AbortController(), T + 500);
    expect(other.decision.action).toBe("generate");
  });
});
