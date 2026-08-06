// Old-browser guard — ES5 ONLY. This file must parse on ancient engines,
// so no arrow functions, template literals, let/const, or optional chaining.
//
// IMPORTANT: no eval / new Function here — the production CSP (script-src
// 'self', no 'unsafe-eval') blocks them, which would make every check throw
// and show the guard to everyone. We detect the era via API markers instead:
// an engine that has all of these also parses the es2019 syntax the bundle
// is built to (see build.target in vite.config.ts).
//
// Two layers:
//   1. Feature floor. CSSLayerBlockRule is the real gate: the stylesheet is
//      wrapped in cascade layers (Tailwind v4 — Chrome 99+ / Safari 15.4+),
//      and engines without them drop the theme wholesale. Every engine at
//      that level parses the bundle's syntax comfortably.
//   2. Watchdog: if nothing mounted into #root within 15s (bundle failed to
//      download, or crashed at runtime), show the same message rather than
//      a dead dark screen.
(function () {
  var guard = document.getElementById('browser-guard');
  function show() {
    if (guard) {
      guard.hidden = false;
      guard.style.display = 'flex';
    }
  }
  var ok =
    !!window.fetch &&
    !!window.Promise &&
    !!window.Promise.allSettled &&
    !!window.IntersectionObserver &&
    !!String.prototype.replaceAll &&
    'noModule' in document.createElement('script') &&
    typeof CSSLayerBlockRule !== 'undefined';
  if (!ok) {
    show();
    return;
  }
  setTimeout(function () {
    var root = document.getElementById('root');
    if (root && !root.firstChild) show();
  }, 15000);
})();
