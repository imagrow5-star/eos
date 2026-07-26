/**
 * The auth rate limiters (app.ts) read their limits from the environment so
 * tests can control them. Default them high here so the existing integration
 * suites — which fire many auth requests from one IP — never trip a 429.
 * rate-limit.test.ts overrides these with small values BEFORE dynamically
 * importing the app to exercise the 429 path deterministically.
 */
process.env.AUTH_RATE_LIMIT_MAX ??= "100000";
process.env.FORGOT_RATE_LIMIT_MAX ??= "100000";
