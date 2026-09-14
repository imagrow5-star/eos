/**
 * The landing-page voice demo — "Or hear it — one minute, no signup."
 *
 * Built on its own (vite.demo.config.ts → dist/public/demo-voice.js) and
 * loaded by public/welcome.html, which is static: no React, no router, just
 * the same Hume call the app makes (lib/humeVoice.ts) driven from a few
 * elements on the page.
 *
 * The shape of a call:
 *   1. on load, ask the server whether a voice demo is available for this
 *      browser and address today — the button exists only if it is;
 *   2. on click, ask for the microphone first (a refusal costs nothing),
 *      then mint the call: the server reserves the minute, marks the
 *      browser, and returns Hume's short-lived access token and our call
 *      token;
 *   3. connect; a thin line fills over the minute; Eos's words and the
 *      person's appear as captions in the demo thread;
 *   4. at the minute the microphone stops; if Eos is mid-reply she finishes
 *      the sentence, then the call ends and the closing line appears —
 *      the same one the text demo shows.
 * Nothing said is kept anywhere: the thread lives in this page and goes
 * with it.
 */

import { startHumeCall, type HumeCallHandlers, type HumeCallControls, type HumeSessionInfo } from "@/lib/humeVoice";
import { CallCutoff } from "./cutoff";

/** The call driver — the real Hume call, or a scripted stand-in for preview. */
export type StartCall = (session: HumeSessionInfo, handlers: HumeCallHandlers) => Promise<HumeCallControls>;

type SessionResponse = {
  available: boolean;
  accessToken?: string;
  configId?: string;
  humeVoiceId?: string;
  token?: string;
  seconds?: number;
  error?: string;
};

const STATUS_POLL_MS = 3000;
const TICK_MS = 200;
const GENERIC_ERROR = "Something went wrong. Please try again.";

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function initDemoVoice(startCall: StartCall = startHumeCall): void {
  const block = byId<HTMLDivElement>("demo-voice");
  const button = byId<HTMLButtonElement>("demo-voice-btn");
  const err = byId<HTMLParagraphElement>("demo-voice-err");
  const call = byId<HTMLDivElement>("demo-call");
  const fill = byId<HTMLDivElement>("demo-call-fill");
  const status = byId<HTMLSpanElement>("demo-call-status");
  const endButton = byId<HTMLButtonElement>("demo-call-end");
  const thread = byId<HTMLDivElement>("demo-thread");
  const form = byId<HTMLFormElement>("demo-form");
  const closing = byId<HTMLParagraphElement>("demo-end");
  if (!block || !button || !err || !call || !fill || !status || !endButton || !thread || !form || !closing) return;

  // Old browsers without the pieces a call needs never see the button.
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof WebSocket === "undefined") return;

  fetch("/api/demo/voice/availability", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((body: { available?: boolean }) => {
      if (body?.available === true) block.hidden = false;
    })
    .catch(() => {
      /* stays hidden */
    });

  const showErr = (message: string) => {
    err.textContent = message;
    err.hidden = false;
  };
  const setStatus = (text: string, live: boolean) => {
    status.textContent = text;
    status.classList.toggle("is-live", live);
  };
  const bubble = (cls: "you" | "eos", text: string) => {
    const el = document.createElement("div");
    el.className = `msg ${cls}`;
    el.textContent = text;
    thread.appendChild(el);
    return el;
  };

  // An arrow, not a function declaration: TypeScript keeps the null checks
  // above only inside closures created after them.
  const run = async (): Promise<void> => {
    button.disabled = true;
    err.hidden = true;

    // Microphone first. A refusal here costs the person nothing — no call
    // has been minted, so today's try is still theirs.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      showErr("Eos needs your microphone for this. Allow it and try again.");
      button.disabled = false;
      return;
    }

    let session: SessionResponse;
    try {
      const res = await fetch("/api/demo/voice/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      session = (await res.json()) as SessionResponse;
      if (!res.ok || !session.available) {
        if (session?.error) showErr(session.error);
        else block.hidden = true; // quietly: the minute was taken in the meantime
        button.disabled = false;
        return;
      }
    } catch {
      showErr(GENERIC_ERROR);
      button.disabled = false;
      return;
    }
    const token = session.token!;

    block.hidden = true;
    form.hidden = true;
    call.hidden = false;
    fill.style.width = "0%";
    setStatus("Connecting…", false);

    let controls: HumeCallControls | null = null;
    let cutoff: CallCutoff | null = null;
    let ticker: number | null = null;
    let poller: number | null = null;
    let youBubble: HTMLDivElement | null = null;
    let cardShown = false;
    let finished = false;

    const report = (reason: "ended" | "limit" | "failed", beacon = false) => {
      const payload = JSON.stringify({ token, reason });
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon("/api/demo/voice/end", new Blob([payload], { type: "application/json" }));
        return;
      }
      void fetch("/api/demo/voice/end", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).catch(() => {
        /* the server settles the full minute on its own */
      });
    };

    const onLeave = () => {
      if (!finished) report(cutoff?.hitLimit() ? "limit" : "ended", true);
    };
    window.addEventListener("pagehide", onLeave);

    const finish = (reason: "ended" | "limit" | "failed") => {
      if (finished) return;
      finished = true;
      cutoff?.finish();
      if (ticker !== null) window.clearInterval(ticker);
      if (poller !== null) window.clearInterval(poller);
      window.removeEventListener("pagehide", onLeave);
      void controls?.endSession();
      report(reason);
      call.hidden = true;
      if (reason === "failed") {
        // The server frees today's try; offer it again.
        block.hidden = false;
        button.disabled = false;
        form.hidden = false;
        showErr("The call couldn't connect. Try again, or say it in text.");
        return;
      }
      fill.style.width = "100%";
      closing.hidden = false;
      closing.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    const act = (action: "none" | "stop-input" | "end") => {
      if (action === "stop-input") {
        controls?.stopInput();
        setStatus("Eos is finishing", true);
      } else if (action === "end") {
        finish("limit");
      }
    };

    const handlers: HumeCallHandlers = {
      onMode: (mode) => {
        if (finished) return;
        const action = cutoff?.noteMode(mode) ?? "none";
        if (cutoff?.phase === "live") setStatus(mode === "speaking" ? "Eos is speaking" : "Listening", true);
        act(action);
      },
      onUserText: (text) => {
        if (finished || !text) return;
        if (!youBubble) youBubble = bubble("you", text);
        else youBubble.textContent = text;
      },
      onAgentText: (text) => {
        if (finished || !text) return;
        bubble("eos", text);
        youBubble = null;
      },
      onDisconnect: () => finish(cutoff ? (cutoff.hitLimit() ? "limit" : "ended") : "failed"),
      onError: () => {
        /* the close event decides; nothing to show mid-sentence */
      },
    };

    try {
      controls = await startCall(
        {
          accessToken: session.accessToken!,
          configId: session.configId!,
          userToken: token,
          ...(session.humeVoiceId ? { humeVoiceId: session.humeVoiceId } : {}),
        },
        handlers,
      );
    } catch {
      finish("failed");
      return;
    }
    if (finished) return;

    cutoff = new CallCutoff(Date.now());
    setStatus("Listening", true);
    ticker = window.setInterval(() => {
      if (!cutoff) return;
      const now = Date.now();
      fill.style.width = `${(cutoff.progress(now) * 100).toFixed(1)}%`;
      act(cutoff.tick(now));
    }, TICK_MS);

    // The helpline card, when the crisis floor fires on a spoken turn.
    poller = window.setInterval(() => {
      fetch(`/api/demo/voice/status?token=${encodeURIComponent(token)}`, { credentials: "same-origin" })
        .then((r) => r.json())
        .then((body: { crisisHelplineBlock?: string }) => {
          if (cardShown || !body?.crisisHelplineBlock) return;
          cardShown = true;
          const help = document.createElement("div");
          help.className = "demo-help";
          help.textContent = body.crisisHelplineBlock.replace(/^—\n/, "");
          thread.appendChild(help);
        })
        .catch(() => {
          /* try again next poll */
        });
    }, STATUS_POLL_MS);

    endButton.onclick = () => finish("ended");
  };

  button.addEventListener("click", () => {
    void run();
  });
}
