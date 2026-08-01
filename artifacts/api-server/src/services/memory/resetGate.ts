/**
 * Feature gate for POST /api/memory/reset (Sprint: dedup & reset).
 *
 * The reset button wipes a user's memory for clean testing, so it is NOT shipped
 * to everyone — it's gated to an operator allowlist. This pure decision function
 * is the single source of truth for both the endpoint and the eligibility probe,
 * and is unit-tested without a DB.
 *
 *   • env var unset/blank        → "not_configured" (endpoint 404s for everyone;
 *                                   the feature effectively doesn't exist)
 *   • email not in the allowlist → "forbidden" (403)
 *   • email in the allowlist     → "allowed"
 *
 * Matching is case-insensitive and whitespace-tolerant so a Render env value
 * like " Founder@Example.com , dev@x.com " behaves as expected.
 */

export type ResetGateDecision = "not_configured" | "forbidden" | "allowed";

export function resetAllowlistDecision(
  email: string | null | undefined,
  rawAllowlist: string | undefined = process.env.MEMORY_RESET_ALLOWLIST,
): ResetGateDecision {
  if (!rawAllowlist || rawAllowlist.trim() === "") return "not_configured";

  const allow = new Set(
    rawAllowlist
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
  if (allow.size === 0) return "not_configured";

  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized && allow.has(normalized)) return "allowed";
  return "forbidden";
}
