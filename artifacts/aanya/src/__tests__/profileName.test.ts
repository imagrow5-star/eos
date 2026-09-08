/**
 * Settings → "Your name" (lib/profileName.ts).
 *
 * The one thing that would feel broken: a voice call greeting someone by
 * their OLD name. A call session is minted with the name baked in (frozen
 * prompt + primed profile), and the UI prefetches sessions on call intent —
 * so a session prefetched BEFORE a rename must never be handed out after it.
 * These tests run the save choreography against the REAL
 * VoiceSessionPrefetcher, not a mock of invalidate().
 */

import { describe, it, expect, vi } from "vitest";
import { commitUserNameChange, normalizeUserName, USER_NAME_MAX } from "../lib/profileName";
import { VoiceSessionPrefetcher, type SessionFetchResult } from "../lib/voiceSessionPrefetch";

const OK: SessionFetchResult = {
  status: 200,
  body: { available: true, mode: "signed", signedUrl: "wss://x", userToken: "t" } as SessionFetchResult["body"],
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A prefetcher whose fetches resolve immediately, with a call counter. */
function warmPrefetcher() {
  const fetcher = vi.fn(async () => OK);
  const p = new VoiceSessionPrefetcher(fetcher, () => 1_000_000);
  return { p, fetcher };
}

describe("normalizeUserName (client mirror of the server rule)", () => {
  it("trims, collapses whitespace, strips control characters", () => {
    expect(normalizeUserName("  Priya   Nair ")).toEqual({ ok: true, value: "Priya Nair" });
    expect(normalizeUserName("Pri\u0000ya")).toEqual({ ok: true, value: "Priya" });
  });

  it("requires a name, with a note the row can show", () => {
    const r = normalizeUserName("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.note).toMatch(/enter a name/i);
  });

  it("caps at 40", () => {
    expect(normalizeUserName("a".repeat(USER_NAME_MAX)).ok).toBe(true);
    const r = normalizeUserName("a".repeat(USER_NAME_MAX + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.note).toMatch(/40/);
  });
});

describe("commitUserNameChange × the real VoiceSessionPrefetcher", () => {
  it("a session prefetched before the rename is never handed out after it", async () => {
    const { p, fetcher } = warmPrefetcher();
    p.prefetch();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1); // warm: one old-name session cached

    const saved: string[] = [];
    const r = commitUserNameChange({
      raw: " Sam ",
      current: "Samuel",
      prefetcher: p,
      save: (name, afterSaved) => {
        saved.push(name);
        afterSaved(); // server acknowledged
      },
    });
    expect(r).toEqual({ saved: true, note: null });
    expect(saved).toEqual(["Sam"]);

    // Pressing Voice now must NOT get the cached old-name session.
    const taken = await p.take();
    expect(taken.source).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a prefetch still in flight when the rename lands never gets cached", async () => {
    // The fetch resolves only when we say so — it was minted with the old name.
    let resolveOld!: (r: SessionFetchResult) => void;
    const fetcher = vi
      .fn<() => Promise<SessionFetchResult>>()
      .mockImplementationOnce(() => new Promise<SessionFetchResult>((res) => (resolveOld = res)))
      .mockImplementation(async () => OK);
    const p = new VoiceSessionPrefetcher(fetcher, () => 1_000_000);
    p.prefetch(); // in flight, old name

    commitUserNameChange({ raw: "Sam", current: "Samuel", prefetcher: p, save: (_n, after) => after() });
    resolveOld(OK); // the old-name session arrives late…
    await flush();

    const taken = await p.take(); // …and is not what gets handed out
    expect(taken.source).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a session minted DURING the save window is dropped once the server acknowledges", async () => {
    const { p, fetcher } = warmPrefetcher();
    let ack!: () => void;
    commitUserNameChange({
      raw: "Sam",
      current: "Samuel",
      prefetcher: p,
      save: (_name, afterSaved) => {
        ack = afterSaved; // the PUT is "in flight"
      },
    });
    // Call intent while the PUT is still in flight: this session still
    // carries the old name on the server side.
    p.prefetch();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    ack(); // server saved the new name → that mid-save session must go too
    const taken = await p.take();
    expect(taken.source).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("an unchanged name is a no-op: nothing saved, the warm session survives", async () => {
    const { p, fetcher } = warmPrefetcher();
    p.prefetch();
    await flush();

    const save = vi.fn();
    const r = commitUserNameChange({ raw: "  Samuel ", current: "Samuel", prefetcher: p, save });
    expect(r).toEqual({ saved: false, note: null });
    expect(save).not.toHaveBeenCalled();

    const taken = await p.take();
    expect(taken.source).toBe("prefetched"); // still warm — no pointless refetch
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("an invalid name is not saved and does not disturb the warm session", async () => {
    const { p, fetcher } = warmPrefetcher();
    p.prefetch();
    await flush();

    const save = vi.fn();
    const r = commitUserNameChange({ raw: "   ", current: "Samuel", prefetcher: p, save });
    expect(r.saved).toBe(false);
    expect(r.note).toMatch(/enter a name/i);
    expect(save).not.toHaveBeenCalled();

    const taken = await p.take();
    expect(taken.source).toBe("prefetched");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
