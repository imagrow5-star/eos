/**
 * Vitest setup: intercept all outbound Resend API calls.
 *
 * The route handlers fire real `fetch("https://api.resend.com/emails", ...)`
 * calls (fire-and-forget) during signup/reset/change-email flows. Without
 * this stub, every test run blasts hundreds of real sends at Resend — which
 * pollutes the account's email log, burns quota, and (worse) generates hard
 * bounces to fake @example.invalid addresses that damage the sending
 * domain's reputation and real-user deliverability.
 *
 * No test asserts on Resend responses (they poll DB state instead), so a
 * canned 200 is transparent to the suite.
 */
const realFetch = globalThis.fetch;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

// Every suppressed send is RECORDED so tests can read what a user's inbox
// would contain — required since auth tokens are hashed at rest (the raw
// token now exists ONLY inside the email body, never in the database).
export type RecordedEmail = { to: string[]; subject: string; html: string };
const recorded: RecordedEmail[] = [];
(globalThis as { __recordedEmails?: RecordedEmail[] }).__recordedEmails = recorded;

globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    try {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        to?: string | string[];
        subject?: string;
        html?: string;
      };
      recorded.push({
        to: Array.isArray(body.to) ? body.to : body.to ? [body.to] : [],
        subject: body.subject ?? "",
        html: body.html ?? "",
      });
    } catch {
      /* non-JSON body — record nothing, still suppress */
    }
    return Promise.resolve(
      new Response(JSON.stringify({ id: "suppressed-in-tests" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
