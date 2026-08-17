/**
 * Voice call-path warmup wiring guard.
 *
 * Connection speed depends on warming three things BEFORE the tap: the
 * session bootstrap (token + signed URL), the lazy realtimeVoice SDK chunk,
 * and doing both at screen-time (mount/foreground) — not only on hover,
 * because mobile taps land ~100ms after touchstart. A refactor that drops
 * any of these silently re-adds hundreds of ms to connecting. Source-level
 * pins, same pattern as ttsAutoplay's wiring guard.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const chatSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../pages/Chat.tsx"),
  "utf8",
);

describe("voice warmup wiring (Chat.tsx)", () => {
  it("warmVoiceCallPath prefetches BOTH the session and the SDK module", () => {
    const warmFn = chatSrc.match(/const warmVoiceCallPath = useCallback\(\(\) => \{[\s\S]*?\}, \[/)?.[0];
    expect(warmFn, "warmVoiceCallPath must exist").toBeTruthy();
    expect(warmFn).toContain("voiceSessionPrefetcher.prefetch()");
    expect(warmFn).toContain('import("@/lib/realtimeVoice")');
  });

  it("the Voice button warms on hover, focus, AND touchstart", () => {
    expect(chatSrc).toContain("onPointerEnter={warmVoiceCallPath}");
    expect(chatSrc).toContain("onFocus={warmVoiceCallPath}");
    expect(chatSrc).toContain("onTouchStart={warmVoiceCallPath}");
  });

  it("the call path also warms at screen-time: mount + tab-foreground", () => {
    // The mount/visibility effect — gated on voiceCallEnabled so disabled
    // deployments never mint tokens for nothing.
    const effect = chatSrc.match(
      /useEffect\(\(\) => \{\s*if \(!voiceCallEnabled\) return;\s*warmVoiceCallPath\(\);[\s\S]*?visibilitychange[\s\S]*?\}, \[voiceCallEnabled, warmVoiceCallPath\]\);/,
    )?.[0];
    expect(effect, "mount + visibilitychange warmup effect must exist").toBeTruthy();
    expect(effect).toContain('document.addEventListener("visibilitychange"');
    expect(effect).toContain('document.removeEventListener("visibilitychange"');
  });
});
