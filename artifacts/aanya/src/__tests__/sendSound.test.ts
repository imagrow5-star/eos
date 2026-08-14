/**
 * Send-sound preference + fail-safety.
 *  - OFF by default (opt-in: no surprise noise).
 *  - Toggling stores the per-device choice.
 *  - Garbage / missing storage reads as OFF.
 *  - playSendSound never throws, even with no AudioContext (node env here),
 *    whether enabled, disabled, or forced — sound-off must feel complete.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sendSoundEnabled, setSendSoundEnabled, playSendSound } from "../lib/sendSound";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as unknown as Storage;

const hadStorage = "localStorage" in globalThis;
(globalThis as { localStorage?: Storage }).localStorage = fakeStorage;

afterAll(() => {
  if (!hadStorage) delete (globalThis as { localStorage?: Storage }).localStorage;
});

beforeEach(() => store.clear());

describe("send sound preference", () => {
  it("is OFF by default (opt-in)", () => {
    expect(sendSoundEnabled()).toBe(false);
  });

  it("turns on and off, persisted per-device", () => {
    setSendSoundEnabled(true);
    expect(store.get("eos-send-sound")).toBe("on");
    expect(sendSoundEnabled()).toBe(true);
    setSendSoundEnabled(false);
    expect(store.get("eos-send-sound")).toBe("off");
    expect(sendSoundEnabled()).toBe(false);
  });

  it("garbage stored value reads as OFF", () => {
    store.set("eos-send-sound", "banana");
    expect(sendSoundEnabled()).toBe(false);
  });
});

describe("playSendSound fail-safety (no AudioContext in this env)", () => {
  it("never throws: disabled, enabled, or forced", () => {
    expect(() => playSendSound()).not.toThrow();
    setSendSoundEnabled(true);
    expect(() => playSendSound()).not.toThrow();
    expect(() => playSendSound(true)).not.toThrow();
  });
});
