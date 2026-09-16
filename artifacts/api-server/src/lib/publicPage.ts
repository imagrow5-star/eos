/**
 * Public static pages (landing, pricing, privacy, security, terms, refunds)
 * with the optional Cloudflare Web Analytics beacon.
 *
 * The beacon counts visits, pages and referrers. It sets no cookies and
 * identifies nobody, which is the only kind of analytics these pages carry;
 * the app itself, once signed in, loads nothing of the sort. The token comes
 * from the Cloudflare dashboard (Web Analytics → the site's JS snippet) and
 * is an environment variable, CF_BEACON_TOKEN, so no page has to be edited
 * when it changes and an unset token means no script at all.
 *
 * Pages are read from disk per request (they are small, and no-cache anyway)
 * so a deploy never serves a stale copy.
 */

import fs from "node:fs";
import type { Response } from "express";

/** Cloudflare beacon tokens are hex; anything else is refused, never injected. */
const TOKEN_RE = /^[a-f0-9]{16,64}$/i;

export function analyticsBeaconTag(token: string | undefined): string {
  const t = (token ?? "").trim();
  if (!TOKEN_RE.test(t)) return "";
  return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${t}"}'></script>`;
}

/** Inserts the beacon before </head>, once. Without a valid token the HTML is returned untouched. */
export function withAnalyticsBeacon(html: string, token: string | undefined): string {
  const tag = analyticsBeaconTag(token);
  if (!tag) return html;
  const at = html.search(/<\/head>/i);
  if (at < 0) return html;
  return `${html.slice(0, at)}${tag}\n${html.slice(at)}`;
}

/** Serve one public page, beacon included when CF_BEACON_TOKEN is set. */
export function sendPublicPage(res: Response, filePath: string): void {
  const html = fs.readFileSync(filePath, "utf8");
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(withAnalyticsBeacon(html, process.env.CF_BEACON_TOKEN));
}
