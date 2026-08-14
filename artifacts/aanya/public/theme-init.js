// Pre-paint theme init — ES5 ONLY, loaded synchronously in <head> so the
// palette applies before the first frame (no flash of wrong theme).
// External file (not inline) because the production CSP is script-src 'self'.
//
// ONE palette product-wide; the only choice is an opt-in calm dark mode
// ("eos-mode" in localStorage, default light). Legacy "eos-theme" keys from
// the retired multi-theme picker are cleared.
(function () {
  var mode = 'light';
  try {
    var m = localStorage.getItem('eos-mode');
    if (m === 'dark') mode = 'dark';
    localStorage.removeItem('eos-theme');
  } catch (e) {
    /* storage blocked — keep light */
  }
  var el = document.documentElement;
  el.setAttribute('data-theme', 'sage');
  el.setAttribute('data-mode', mode);
  // index.html pre-paints the cream shell; flip it when dark was chosen so a
  // slow stylesheet never flashes bright at a night user.
  if (mode === 'dark') el.style.backgroundColor = '#1A1E18';
})();
