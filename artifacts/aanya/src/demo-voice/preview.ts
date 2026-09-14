/**
 * Preview stand-in for the real call — NOT part of the shipped bundle.
 *
 * Built only by hand (a vite config pointing at this entry) to review the
 * page's behaviour without Hume: a scripted exchange, with a reply that is
 * still being spoken when the minute runs out, so the cutoff can be seen
 * letting the sentence finish. The scripted lines are stage directions,
 * not the product's words.
 */

import type { HumeCallHandlers, HumeCallControls, HumeSessionInfo } from "@/lib/humeVoice";
import { initDemoVoice } from "./index";

const SPEED = Number(new URLSearchParams(location.search).get("speed") ?? "1");

function scriptedCall(_session: HumeSessionInfo, h: HumeCallHandlers): Promise<HumeCallControls> {
  let ended = false;
  const timers: number[] = [];
  const at = (ms: number, fn: () => void) => {
    timers.push(window.setTimeout(() => { if (!ended) fn(); }, ms / SPEED));
  };
  const say = (ms: number, text: string, speakMs: number) => {
    at(ms, () => { h.onAgentText(text); h.onMode("speaking"); });
    at(ms + speakMs, () => h.onMode("listening"));
  };

  say(600, "Hey, it's me. I'm right here.", 2600);
  at(6000, () => h.onUserText("I keep putting off calling my"));
  at(7200, () => h.onUserText("I keep putting off calling my mother. It's been three weeks."));
  say(8600, "Three weeks. That's long enough to start feeling like a thing. What happens when you think about picking up the phone?", 7000);
  at(22_000, () => h.onUserText("I don't know. It's like I'm waiting to feel ready."));
  say(24_000, "Waiting to feel ready. I notice you didn't say you don't want to. Is it her you're avoiding, or the version of you that shows up on those calls?", 9000);
  at(40_000, () => h.onUserText("The second one. I get short with her."));
  // This reply starts before the minute and is still going when it ends:
  // the mic stops at 60s, the sentence runs to ~64s, then the call ends.
  say(42_500, "That's honest. Getting short with someone usually means something older is in the room with you. You don't have to fix that tonight — but you could call and tell her exactly that, in one sentence. That you get short, and you don't want to.", 21_500);

  return Promise.resolve({
    endSession: async () => { ended = true; timers.forEach((t) => window.clearTimeout(t)); },
    setVolume: () => {},
    stopInput: () => {},
  });
}

initDemoVoice(scriptedCall);
