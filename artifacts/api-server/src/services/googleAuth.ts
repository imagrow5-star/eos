/**
 * Google OAuth 2.0 (authorization-code flow) — the thin gateway the auth
 * routes talk to.
 *
 * Uses Google's official google-auth-library: `verifyIdToken` validates the
 * ID token's SIGNATURE against Google's published certificates, plus expiry,
 * issuer (accounts.google.com), and audience (must equal GOOGLE_CLIENT_ID) —
 * a forged or tampered token throws and never reaches account logic.
 *
 * Cleanly disabled when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are absent:
 * `isGoogleAuthConfigured()` feeds the public availability endpoint (the
 * frontend hides the button) and the routes answer with a friendly redirect
 * instead of crashing.
 *
 * Injectable for tests (same pattern as push.ts `_setWebPushForTests`):
 * `_setGoogleAuthGatewayForTests` swaps the network-facing part so route
 * logic — state checks, account linking, session regeneration — is tested
 * end-to-end with zero Google traffic.
 */

import { OAuth2Client } from "google-auth-library";

export interface GoogleIdentity {
  /** The Google account's email address. */
  email: string;
  /** Google's own assertion that it verified this email. */
  emailVerified: boolean;
  /** Display name for the new-account profile (given name preferred). */
  name: string | null;
}

export interface GoogleAuthGateway {
  /** URL of Google's consent screen for this app + redirect + CSRF state. */
  generateAuthUrl(redirectUri: string, state: string): string;
  /** Exchanges the callback code and fully verifies the ID token. */
  exchangeCode(code: string, redirectUri: string): Promise<GoogleIdentity>;
}

export function isGoogleAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim(),
  );
}

function realGateway(clientId: string, clientSecret: string): GoogleAuthGateway {
  return {
    generateAuthUrl(redirectUri, state) {
      const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
      return client.generateAuthUrl({
        // Only what account creation needs — no wider Google account access.
        scope: ["openid", "email", "profile"],
        state,
        // Let multi-account users pick — matches "Continue with Google" UX.
        prompt: "select_account",
      });
    },

    async exchangeCode(code, redirectUri) {
      const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) {
        throw new Error("Google token exchange returned no id_token");
      }
      // Signature (Google certs), expiry, issuer, and audience all verified
      // here — verifyIdToken throws on any mismatch.
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error("Google id_token carried no email");
      return {
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.given_name ?? payload.name ?? null,
      };
    },
  };
}

let _testOverride: GoogleAuthGateway | null = null;

/** Test hook — inject a fake gateway. Pass null to restore the real one. */
export function _setGoogleAuthGatewayForTests(mock: GoogleAuthGateway | null): void {
  _testOverride = mock;
}

/** The gateway for this request, or null when the feature is not configured. */
export function getGoogleAuthGateway(): GoogleAuthGateway | null {
  if (_testOverride) return _testOverride;
  if (!isGoogleAuthConfigured()) return null;
  return realGateway(process.env.GOOGLE_CLIENT_ID!.trim(), process.env.GOOGLE_CLIENT_SECRET!.trim());
}
