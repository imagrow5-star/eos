// Pre-paint theme init — ES5 ONLY, loaded synchronously in <head> so the
// correct palette applies before the first frame (no flash of wrong theme).
// External file (not inline) because the production CSP is script-src 'self'.
//
// Source of truth for the *choice* is localStorage ("eos-theme"/"eos-mode",
// owned by src/lib/theme.tsx; the server profile is adopted after auth).
// Anything invalid or blocked falls back to the default sage/light (calm
// cream + green) — index.html pre-paints that cream shell.
// the page still paints correctly.
(function () {
  var THEMES = { dawn: 1, sage: 1, twilight: 1 }; // amber retired; falls back to sage
  var MODES = { light: 1, dark: 1 };
  // Dark shell color per theme — keep in sync with index.css backgrounds.
  var DARK_SHELL = {
    dawn: '#241A19',
    sage: '#1A1E18',
    twilight: '#1C1922',
  };
  var theme = 'sage'; // default: calm cream + green (sage, light)
  var mode = 'light';
  try {
    var t = localStorage.getItem('eos-theme');
    var m = localStorage.getItem('eos-mode');
    if (t && THEMES[t]) theme = t;
    if (m && MODES[m]) mode = m;
  } catch (e) {
    /* storage blocked — keep defaults */
  }
  var el = document.documentElement;
  el.setAttribute('data-theme', theme);
  el.setAttribute('data-mode', mode);
  // index.html inlines the twilight-light shell on <html> so the pre-CSS
  // frame is correct for the default; flip it here when dark was chosen so
  // a slow stylesheet never shows a bright flash to a dark-mode user.
  if (mode === 'dark') el.style.backgroundColor = DARK_SHELL[theme] || '#1C1922';
})();
