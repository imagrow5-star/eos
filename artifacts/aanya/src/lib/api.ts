/**
 * Drop-in replacement for fetch() for all API calls.
 * Always sends credentials (the session cookie) so the server can
 * recognise the logged-in user on every request.
 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { credentials: "include", ...init });
}
