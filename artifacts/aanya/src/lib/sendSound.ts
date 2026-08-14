// ─── Send sound — a soft, warm chime when the USER sends a message ───────────
// Synthesized with Web Audio at play time (no asset file). Acoustic spec:
// two sine partials at 880 Hz + 1320 Hz (inside the pleasant ~700–2000 Hz
// band, nothing above 2 kHz — high frequencies are where sounds turn
// irritating), a SOFT ~20 ms attack (never a sharp click) and a quick
// exponential decay, all over in ~0.26 s at a low peak gain. A warm chime,
// not a zip or a ping — it must never startle someone at night.
//
// Opt-in and per-device: default OFF ("we don't make noise at people by
// surprise"), toggled in Settings → Appearance, stored in localStorage.
// Plays ONLY on user sends — never on Eos's replies.

const KEY = "eos-send-sound";

export function sendSoundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false; // storage blocked → stay silent (the safe default)
  }
}

export function setSendSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* storage blocked — the toggle still works for this visit via caller state */
  }
}

let ctx: AudioContext | null = null;

/** Play the send chime, if enabled. Never throws; silence on any failure. */
export function playSendSound(force = false): void {
  if (!force && !sendSoundEnabled()) return;
  try {
    ctx ??= new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime;

    const master = ctx.createGain();
    master.connect(ctx.destination);
    // Envelope: soft attack to a LOW peak, then quick exponential decay.
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(0.11, t0 + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);

    // Warm dyad: A5 + its fifth, softer. Sine only — no upper harmonics.
    for (const [freq, amp] of [
      [880, 1],
      [1320, 0.35],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = amp;
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + 0.3);
    }
  } catch {
    /* no AudioContext / autoplay blocked — sound-off must feel complete */
  }
}
