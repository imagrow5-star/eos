// ─── Send sound — a soft, warm chime when the USER sends a message ───────────
// Synthesized with Web Audio at play time (no asset file). Acoustic spec:
// two sine partials at 880 Hz + 1320 Hz (inside the pleasant ~700–2000 Hz
// band, nothing above 2 kHz — high frequencies are where sounds turn
// irritating), a SOFT ~20 ms attack (never a sharp click) and a quick
// exponential decay, all over in ~0.26 s at a low peak gain. A warm chime,
// not a zip or a ping — it must never startle someone at night.
//
// Per-device, DEFAULT ON: the chime is quiet enough to ship on for everyone,
// and anyone who wants silence turns it off in Settings → Appearance → Send
// sound (one tap). Only an explicit "off" silences; anything else (fresh
// user, garbage value) means on. Plays ONLY on user sends — never on Eos's
// replies.

const KEY = "eos-send-sound";

export function sendSoundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return false; // storage blocked → stay silent (never risk surprise noise)
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

function scheduleChime(ac: AudioContext): void {
  const t0 = ac.currentTime;

  const master = ac.createGain();
  master.connect(ac.destination);
  // Envelope: soft attack to a LOW peak, then quick exponential decay.
  master.gain.setValueAtTime(0.0001, t0);
  // Peak 0.08: ~3 dB quieter than the first cut — it plays for everyone by
  // default now, so err on the quiet side. Must never startle at night.
  master.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);

  // Warm dyad: A5 + its fifth, softer. Sine only — no upper harmonics.
  for (const [freq, amp] of [
    [880, 1],
    [1320, 0.35],
  ] as const) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.value = amp;
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  }
}

/** Play the send chime, if enabled. Never throws; silence on any failure.
 *
 * Autoplay/unlock: this is only ever called from inside a user gesture (the
 * send click/Enter, or the Settings toggle tap), which is exactly what
 * browsers require to start audio. The one real trap is the FIRST play: a
 * freshly created context can report "suspended", and notes scheduled before
 * resume() completes can be swallowed — so when suspended, we resume first
 * and schedule in the .then(). The gesture context is preserved through the
 * resume promise, and every later play schedules synchronously. */
export function playSendSound(force = false): void {
  if (!force && !sendSoundEnabled()) return;
  try {
    ctx ??= new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ac = ctx;
    if (ac.state === "suspended") {
      ac.resume().then(() => scheduleChime(ac)).catch(() => {});
    } else {
      scheduleChime(ac);
    }
  } catch {
    /* no AudioContext / autoplay blocked — sound-off must feel complete */
  }
}
