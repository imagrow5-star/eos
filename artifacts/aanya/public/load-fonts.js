/* Load Google Fonts WITHOUT blocking first paint.
 *
 * A plain <link rel="stylesheet"> to fonts.googleapis.com is render-blocking:
 * the browser holds the first paint until that CSS arrives (Lighthouse flagged
 * ~2s of blocking on a throttled connection). The usual fix — a
 * <link media="print" onload="this.media='all'"> swap — needs an inline event
 * handler, which the production CSP (script-src 'self') forbids. So a
 * same-origin script injects the stylesheet AFTER parse instead: the page
 * paints immediately in the fallback face and, because the font URL carries
 * &display=swap, swaps to the web font when it lands. preconnect (in the HTML
 * head) keeps the connection warm so the deferred fetch is quick.
 *
 * ES5 only — this ships to the same old engines browser-guard.js targets.
 * The font URL is passed as data-href on the <script> tag so one file serves
 * both the app (index.html) and the marketing page (welcome.html).
 */
(function () {
  var self = document.currentScript;
  var href = self && self.getAttribute("data-href");
  if (!href) return;
  var link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
})();
