/**
 * /.well-known/security.txt (RFC 9116): how to reach us about a security
 * problem, machine-readable. Served from code rather than the static bundle
 * so it exists on every deployment, API-only ones included, and so a test
 * can fail the build when the Expires date is about to pass (the RFC
 * requires one, at most a year out; an expired file is treated as absent).
 *
 * Bump SECURITY_TXT_EXPIRES once a year. The human-readable policy it points
 * to is artifacts/aanya/public/security.html, served at /security.
 */
export const SECURITY_CONTACT = "mailto:hello@eoscompanion.com";
export const SECURITY_TXT_EXPIRES = "2027-09-01T00:00:00.000Z";

export function securityTxt(): string {
  return [
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    "Preferred-Languages: en",
    "Canonical: https://eoscompanion.com/.well-known/security.txt",
    "Policy: https://eoscompanion.com/security",
    "",
  ].join("\n");
}
