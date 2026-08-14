// Pre-paint theme init — ES5 ONLY, loaded synchronously in <head> so the
// palette applies before the first frame (no flash of wrong theme).
// External file (not inline) because the production CSP is script-src 'self'.
//
// The multi-theme system was retired: the product uses ONE calm light
// palette everywhere. Any legacy stored choice ("eos-theme"/"eos-mode",
// from the old picker) is cleared so every device lands on the one theme.
(function () {
  var el = document.documentElement;
  el.setAttribute('data-theme', 'sage');
  el.setAttribute('data-mode', 'light');
  try {
    localStorage.removeItem('eos-theme');
    localStorage.removeItem('eos-mode');
  } catch (e) {
    /* storage blocked — attributes above still applied */
  }
})();
