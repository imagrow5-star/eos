/**
 * splitCrisisBlock — multilanguage marker handling (Sprint 1.6).
 * The backend appends the helpline card in the USER'S language; the splitter
 * must find the card whichever of the eleven intro lines it starts with.
 */

import { describe, it, expect } from "vitest";
import {
  splitCrisisBlock,
  HELPLINE_BLOCK_MARKER,
  HELPLINE_BLOCK_MARKERS,
} from "../lib/crisisBlock";

describe("splitCrisisBlock", () => {
  it("knows all 11 language markers (en + 10 activated)", () => {
    expect(HELPLINE_BLOCK_MARKERS).toHaveLength(11);
    expect(HELPLINE_BLOCK_MARKERS[0]).toBe(HELPLINE_BLOCK_MARKER);
    for (const m of HELPLINE_BLOCK_MARKERS) {
      expect(m.startsWith("—\n")).toBe(true);
    }
  });

  it("splits an English block (unchanged behavior)", () => {
    const content = `I'm here with you.\n\n${HELPLINE_BLOCK_MARKER}\n- 988 — 988 — 24/7 (call)\nI'm not going anywhere. Take your time.`;
    const { body, block } = splitCrisisBlock(content);
    expect(body).toBe("I'm here with you.");
    expect(block!.startsWith(HELPLINE_BLOCK_MARKER)).toBe(true);
  });

  it("splits a German block", () => {
    const marker = "—\nJemand, der jetzt für dich da sein kann, wenn du dich melden möchtest:";
    const content = `Ich bin bei dir.\n\n${marker}\n- TelefonSeelsorge — 0800 111 0 111 — 24/7 (call)\nIch gehe nirgendwohin. Lass dir Zeit.`;
    const { body, block } = splitCrisisBlock(content);
    expect(body).toBe("Ich bin bei dir.");
    expect(block!.startsWith(marker)).toBe(true);
  });

  it("splits a Polish block", () => {
    const marker = "—\nKtoś, kto może być z Tobą teraz — jeśli chcesz się skontaktować:";
    const content = `Jestem tu z Tobą.\n\n${marker}\n- Centrum Wsparcia — 116 123 — 24/7 (call)\nNigdzie się nie wybieram. Nie spiesz się.`;
    const { body, block } = splitCrisisBlock(content);
    expect(body).toBe("Jestem tu z Tobą.");
    expect(block!.startsWith(marker)).toBe(true);
  });

  it("returns null block for ordinary messages in any language", () => {
    for (const text of ["hello there", "wie geht es dir heute?", "co słychać u ciebie?"]) {
      expect(splitCrisisBlock(text)).toEqual({ body: text, block: null });
    }
  });
});
