// Marks the document as JS-capable before first paint. The landing page's
// reveal-on-scroll animation hides sections until JavaScript reveals them;
// without this class (JavaScript off, or a script that failed to run) every
// section, pricing included, must simply be visible. Plain ES5 on purpose.
document.documentElement.className += ' js';
