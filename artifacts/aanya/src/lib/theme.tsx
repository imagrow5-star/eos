import { useEffect } from "react";

/**
 * Single-theme provider. The multi-theme system (amber/dawn/sage/twilight ×
 * light/dark) was retired: the whole product uses the calm landing-page
 * palette (index.css :root) everywhere, for every user.
 *
 * This provider stamps the document attributes once, keeps the browser
 * chrome color in sync, and clears any legacy stored preference so devices
 * that picked a theme under the old system land on the one palette too.
 * public/theme-init.js does the same pre-paint.
 */

const SHELL_COLOR = "#FBF7EF"; // keep in sync with --background in index.css

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = "sage";
    el.dataset.mode = "light";
    el.style.removeProperty("background-color");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", SHELL_COLOR);
    try {
      localStorage.removeItem("eos-theme");
      localStorage.removeItem("eos-mode");
    } catch {
      /* storage blocked — attributes above still applied */
    }
  }, []);
  return <>{children}</>;
}
