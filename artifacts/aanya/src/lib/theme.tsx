import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Mode-only theme provider. The multi-THEME system was retired — the whole
 * product uses the one calm palette (index.css :root). The single remaining
 * choice is an opt-in calm DARK mode for night use; cream light is the
 * default every user sees first.
 *
 * The choice is per-device (localStorage "eos-mode"), written ONLY on an
 * explicit toggle. public/theme-init.js reads the same key pre-paint so a
 * dark-mode user never sees a bright flash. Legacy "eos-theme" keys from
 * the old multi-theme picker are cleared.
 */

export type ThemeMode = "light" | "dark";

const MODE_KEY = "eos-mode";
const SHELL_COLORS: Record<ThemeMode, string> = {
  light: "#FBF7EF", // keep in sync with --background (light) in index.css
  dark: "#1A1E18", //  keep in sync with --background (dark) in index.css
};

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* storage blocked */
  }
  return "light";
}

function applyToDocument(mode: ThemeMode) {
  const el = document.documentElement;
  el.dataset.theme = "sage";
  el.dataset.mode = mode;
  el.style.removeProperty("background-color");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", SHELL_COLORS[mode]);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  useEffect(() => {
    applyToDocument(mode);
    try {
      localStorage.removeItem("eos-theme"); // legacy multi-theme key
    } catch {
      /* storage blocked */
    }
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    if (m !== "light" && m !== "dark") return;
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage blocked — applies for this visit only */
    }
  }, []);
  const toggleMode = useCallback(() => {
    setModeState((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, setMode, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
