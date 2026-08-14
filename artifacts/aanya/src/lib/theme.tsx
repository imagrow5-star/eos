import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

/**
 * Theme provider — the runtime half of the token system in index.css.
 *
 * public/theme-init.js already stamped html[data-theme]/[data-mode] before
 * first paint; this provider owns the attributes from mount onward, persists
 * choices to localStorage AND the profile (so the choice follows the user
 * across devices), and keeps <meta name="theme-color"> in sync so the
 * browser chrome matches the shell.
 *
 * Cross-device rules:
 *  - A local explicit choice (localStorage) always wins on this device.
 *  - With no local choice, the profile's stored theme is adopted after auth
 *    (AuthGate calls adoptProfileTheme once the profile loads).
 *  - Every user-initiated change is written to localStorage immediately and
 *    PUT to /api/profile best-effort (ignored when logged out/offline).
 */

export type ThemeName = "dawn" | "sage" | "twilight";
export type ThemeMode = "light" | "dark";

// "amber" (Golden Amber) was retired with the calm redesign; stored "amber"
// choices fail validation below and fall back to the sage default.
export const AVAILABLE_THEMES: ThemeName[] = ["dawn", "sage", "twilight"];
export const THEME_LABELS: Record<ThemeName, string> = {
  dawn: "Dawn",
  sage: "Sage",
  twilight: "Twilight",
};
/** Swatch chip color per theme (the accent/user-bubble hue). */
export const THEME_SWATCHES: Record<ThemeName, string> = {
  dawn: "#E19B85",
  sage: "#567751",
  twilight: "#9C8FBE",
};

const THEME_KEY = "eos-theme";
const MODE_KEY = "eos-mode";
const DEFAULT_THEME: ThemeName = "sage"; // calm cream + green default, matches the landing page
const DEFAULT_MODE: ThemeMode = "light";

/** Browser-chrome color per theme+mode — keep in sync with index.css shells. */
const SHELL_COLORS: Record<string, string> = {
  "dawn/light": "#FBF3EE",
  "dawn/dark": "#241A19",
  "sage/light": "#FBF7EF",
  "sage/dark": "#1A1E18",
  "twilight/light": "#F3F0F7",
  "twilight/dark": "#1C1922",
};

interface ThemeContextValue {
  theme: ThemeName;
  mode: ThemeMode;
  setTheme: (t: ThemeName) => void;
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
  /** Adopt the profile's stored choice unless this device chose explicitly. */
  adoptProfileTheme: (t?: string | null, m?: string | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (valid as readonly string[]).includes(v)) return v as T;
  } catch {
    /* storage blocked — fall through */
  }
  return fallback;
}

function hasStored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function applyToDocument(theme: ThemeName, mode: ThemeMode) {
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.dataset.mode = mode;
  // theme-init.js may have inlined a dark shell color for the pre-CSS frame;
  // the stylesheet owns the background from here on.
  el.style.removeProperty("background-color");
  const meta = document.querySelector('meta[name="theme-color"]');
  const shell = SHELL_COLORS[`${theme}/${mode}`];
  if (meta && shell) meta.setAttribute("content", shell);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(() =>
    readStored(THEME_KEY, AVAILABLE_THEMES, DEFAULT_THEME),
  );
  const [mode, setModeState] = useState<ThemeMode>(() =>
    readStored(MODE_KEY, ["light", "dark"] as const, DEFAULT_MODE),
  );
  // True once the user picks on THIS device (or picked here previously).
  const explicitRef = useRef<boolean>(hasStored(THEME_KEY) || hasStored(MODE_KEY));
  // True only for user-initiated changes — gates the profile PUT so merely
  // loading the app (or adopting the profile's own value) never writes back.
  const dirtyRef = useRef(false);

  useEffect(() => {
    applyToDocument(theme, mode);
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    try {
      localStorage.setItem(THEME_KEY, theme);
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage blocked — theme still applies for this visit */
    }
    // Best-effort cross-device persistence; harmless 401 when logged out.
    apiFetch(`${import.meta.env.BASE_URL}api/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme, themeMode: mode }),
    }).catch(() => {});
  }, [theme, mode]);

  const setTheme = useCallback((t: ThemeName) => {
    if (!AVAILABLE_THEMES.includes(t)) return;
    explicitRef.current = true;
    dirtyRef.current = true;
    setThemeState(t);
  }, []);
  const setMode = useCallback((m: ThemeMode) => {
    explicitRef.current = true;
    dirtyRef.current = true;
    setModeState(m);
  }, []);
  const toggleMode = useCallback(() => {
    explicitRef.current = true;
    dirtyRef.current = true;
    setModeState((m) => (m === "light" ? "dark" : "light"));
  }, []);

  const adoptProfileTheme = useCallback((t?: string | null, m?: string | null) => {
    if (explicitRef.current) return; // this device already chose
    if (t && (AVAILABLE_THEMES as string[]).includes(t)) setThemeState(t as ThemeName);
    if (m === "light" || m === "dark") setModeState(m);
  }, []);

  return (
    <ThemeContext.Provider
      value={{ theme, mode, setTheme, setMode, toggleMode, adoptProfileTheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
