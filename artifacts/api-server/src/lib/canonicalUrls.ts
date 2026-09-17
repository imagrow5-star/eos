/**
 * One URL per public page, for crawlers.
 *
 * Search Console flagged "duplicate without user-selected canonical". Two
 * things let a crawler reach the same page at two addresses: the static
 * middleware serves every page by file name (/welcome.html is /, and so on),
 * and www.eoscompanion.com may answer alongside the apex. Both are collapsed
 * here with permanent redirects, and each public page also carries a
 * <link rel="canonical"> in its own head. Pure functions, under test.
 */

export const CANONICAL_HOST = "eoscompanion.com";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

/** Static file name → the clean path it is served at. */
export const HTML_TWINS: Readonly<Record<string, string>> = {
  "/index.html": "/",
  "/welcome.html": "/",
  "/pricing.html": "/pricing",
  "/privacy.html": "/privacy",
  "/security.html": "/security",
  "/terms.html": "/terms",
  "/refunds.html": "/refunds",
};

/** The clean path for a request to a file-name twin, or null when it is not one. */
export function cleanPathForTwin(pathname: string): string | null {
  return HTML_TWINS[pathname.toLowerCase()] ?? null;
}

/**
 * Where a request on the www host should go: the same path and query on the
 * apex, or null when the host is already right (or is not ours at all — a
 * preview host or localhost is left alone).
 */
export function apexRedirectFor(hostname: string | undefined, originalUrl: string): string | null {
  if ((hostname ?? "").toLowerCase() !== `www.${CANONICAL_HOST}`) return null;
  return `${CANONICAL_ORIGIN}${originalUrl.startsWith("/") ? originalUrl : `/${originalUrl}`}`;
}
