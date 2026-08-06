import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Theme provider — the runtime half of the token system in index.css.
 *
 * public/theme-init.js already stamped html[data-theme]/[data-mode] before
 * first paint; this provider owns the attributes from mount onward, persists
 * choices to localStorage, and keeps <meta name="theme-color"> in sync so the
 * browser chrome matches the shell.
 *
 * Phase A ships Dawn (light default / dark). The API is already shaped for
 * Phase B: THEMES grows to ['dawn','amber','sage','twilight'] and the palette
 * blocks land in index.css — nothing here changes shape.
 */

export type ThemeName = "dawn" | "amber" | "sage" | "twilight";
export type ThemeMode = "light" | "dark";

/** Themes that actually have palette blocks in index.css today. */
export const AVAILABLE_THEMES: ThemeName[] = ["dawn"];
export const THEME_LABELS: Record<ThemeName, string> = {
  dawn: "Dawn",
  amber: "Golden Amber",
  sage: "Sage",
  twilight: "Twilight",
};

const THEME_KEY = "eos-theme";
const MODE_KEY = "eos-mode";

/** Browser-chrome color per theme+mode — keep in sync with index.css shells. */
const SHELL_COLORS: Record<string, string> = {
  "dawn/light": "#FBF3EE",
  "dawn/dark": "#241A19",
};

interface ThemeContextValue {
  theme: ThemeName;
  mode: ThemeMode;
  setTheme: (t: ThemeName) => void;
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
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
    readStored(THEME_KEY, AVAILABLE_THEMES, "dawn"),
  );
  const [mode, setModeState] = useState<ThemeMode>(() =>
    readStored(MODE_KEY, ["light", "dark"] as const, "light"),
  );

  useEffect(() => {
    applyToDocument(theme, mode);
    try {
      localStorage.setItem(THEME_KEY, theme);
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage blocked — theme still applies for this visit */
    }
  }, [theme, mode]);

  const setTheme = useCallback((t: ThemeName) => {
    if (AVAILABLE_THEMES.includes(t)) setThemeState(t);
  }, []);
  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const toggleMode = useCallback(
    () => setModeState((m) => (m === "light" ? "dark" : "light")),
    [],
  );

  return (
    <ThemeContext.Provider value={{ theme, mode, setTheme, setMode, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
