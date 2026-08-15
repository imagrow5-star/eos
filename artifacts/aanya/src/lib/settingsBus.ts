/**
 * Settings open-request bus — lets the Shell's nav (present on every page)
 * open the Settings panel, which lives inside the Private-room page (Chat.tsx).
 *
 * Two paths, both covered:
 *  - Chat already mounted (user is on "/"): the window event fires and Chat's
 *    listener opens the panel immediately.
 *  - Chat not mounted (user on Journey/Chapters/Memory): the nav navigates to
 *    "/" and the sessionStorage flag survives the lazy-load; Chat consumes it
 *    on mount and opens the panel.
 *
 * sessionStorage (not localStorage) on purpose: a pending "open settings"
 * should never outlive the tab.
 */

const FLAG = "eos-open-settings";
export const OPEN_SETTINGS_EVENT = "eos:open-settings";

export function requestOpenSettings(): void {
  try {
    sessionStorage.setItem(FLAG, "1");
  } catch {
    /* blocked storage — the event alone still covers the mounted case */
  }
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}

/** Read-and-clear. Returns true at most once per request. */
export function consumeOpenSettingsRequest(): boolean {
  try {
    const requested = sessionStorage.getItem(FLAG) === "1";
    if (requested) sessionStorage.removeItem(FLAG);
    return requested;
  } catch {
    return false;
  }
}
