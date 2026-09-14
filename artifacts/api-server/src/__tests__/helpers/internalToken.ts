/**
 * Mints a valid internal sweep token for a test request, exactly as the
 * scheduler does: under the configured secret (INTERNAL_SWEEP_SECRET, or the
 * key derived from SESSION_SECRET), for the current hour, over the body
 * supertest will send — `.send(obj)` serialises with JSON.stringify, so the
 * digest is over that same string.
 */
import { mintInternalToken, type InternalPrefix } from "../../lib/internalAuth.js";
import { secretFor } from "../../lib/secrets.js";

export function internalToken(prefix: InternalPrefix, body: unknown, d: Date = new Date()): string {
  return mintInternalToken(secretFor("internal-sweep"), prefix, body === undefined ? undefined : JSON.stringify(body), d);
}
