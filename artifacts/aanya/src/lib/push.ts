// Web-push client helpers — service-worker registration, subscribe, unsubscribe.
// All real policy lives server-side (opt-in flag, hard 2-per-day cap, morning
// windows); this file only handles the browser plumbing.

import { apiFetch } from "@/lib/api";

const BASE = import.meta.env.BASE_URL;

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS Safari only exposes push to installed (Add to Home Screen) apps. */
export function needsInstallFirst(): boolean {
  return isIOS() && !isStandalone();
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export type EnableResult = { ok: true } | { ok: false; reason: string };

export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) {
    return { ok: false, reason: "This browser doesn't support notifications." };
  }
  if (needsInstallFirst()) {
    return {
      ok: false,
      reason:
        "On iPhone or iPad, first add Eos to your Home Screen (Share → Add to Home Screen), then turn this on from the installed app.",
    };
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      reason: "Notifications are blocked for this site — allow them in your browser settings, then try again.",
    };
  }

  const reg = await navigator.serviceWorker.register(`${BASE}sw.js`);
  await navigator.serviceWorker.ready;

  const keyRes = await apiFetch(`${BASE}api/push/vapid-public-key`);
  if (!keyRes.ok) return { ok: false, reason: "Couldn't reach the server — try again in a moment." };
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    } catch {
      return { ok: false, reason: "Your browser refused the subscription — try again, or check site permissions." };
    }
  }

  const json = sub.toJSON();
  const save = await apiFetch(`${BASE}api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } },
    }),
  });
  if (!save.ok) return { ok: false, reason: "Couldn't save this device — try again." };
  return { ok: true };
}

export async function disablePush(): Promise<void> {
  let endpoint: string | undefined;
  if (pushSupported()) {
    try {
      const reg = await navigator.serviceWorker.getRegistration(BASE);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
      }
    } catch {
      /* fall through — still tell the server */
    }
  }
  // No endpoint (e.g. different browser than the one that subscribed) clears
  // ALL of the user's devices server-side and flips the opt-in flag off.
  await apiFetch(`${BASE}api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(endpoint ? { endpoint } : {}),
  }).catch(() => {});
}

export async function sendTestPush(): Promise<boolean> {
  const r = await apiFetch(`${BASE}api/push/test`, { method: "POST" });
  if (!r.ok) return false;
  const body = (await r.json().catch(() => null)) as { outcome?: string } | null;
  return body?.outcome === "sent";
}
