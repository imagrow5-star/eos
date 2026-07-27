/**
 * The auth rate limiters (app.ts) read their limits from the environment so
 * tests can control them. Default them high here so the existing integration
 * suites — which fire many auth requests from one IP — never trip a 429.
 * rate-limit.test.ts overrides these with small values BEFORE dynamically
 * importing the app to exercise the 429 path deterministically.
 */
process.env.AUTH_RATE_LIMIT_MAX ??= "100000";
process.env.FORGOT_RATE_LIMIT_MAX ??= "100000";

// Per-user usage ceilings on paid-API endpoints (middleware/usageLimits.ts).
// Same pattern: high defaults here; usage-limits.test.ts sets small values
// before dynamically importing the app to exercise the 429 path.
process.env.CHAT_LIMIT_PER_HOUR ??= "100000";
process.env.CHAT_LIMIT_PER_DAY ??= "100000";
process.env.TTS_LIMIT_PER_HOUR ??= "100000";
process.env.TTS_LIMIT_PER_DAY ??= "100000";
process.env.VOICE_SESSION_LIMIT_PER_HOUR ??= "100000";
process.env.VOICE_SESSION_LIMIT_PER_DAY ??= "100000";
process.env.VOICE_TURN_LIMIT_PER_HOUR ??= "100000";
process.env.VOICE_TURN_LIMIT_PER_DAY ??= "100000";
