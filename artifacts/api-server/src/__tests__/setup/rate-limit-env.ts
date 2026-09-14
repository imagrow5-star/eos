/**
 * The auth rate limiters (app.ts) read their limits from the environment so
 * tests can control them. Default them high here so the existing integration
 * suites — which fire many auth requests from one IP — never trip a 429.
 * rate-limit.test.ts overrides these with small values BEFORE dynamically
 * importing the app to exercise the 429 path deterministically.
 */
process.env.AUTH_RATE_LIMIT_MAX ??= "100000";
process.env.FORGOT_RATE_LIMIT_MAX ??= "100000";
process.env.INTERNAL_RATE_LIMIT_MAX ??= "100000";

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

// Memory export (middleware/usageLimits.ts). Production default is 1/hour;
// keep it high in tests so integration suites can export more than once.
// memory-export.test.ts sets it to 1 before importing the app to exercise 429.
process.env.MEMORY_EXPORT_LIMIT_PER_HOUR ??= "100000";

// Memory reset (middleware/usageLimits.ts). Production default is 1/hour; high
// in tests so the reset integration suite can call it repeatedly. The dedicated
// rate-limit test sets it to 1 before importing the app to exercise 429.
process.env.MEMORY_RESET_LIMIT_PER_HOUR ??= "100000";

// Morning note, contextual greeting, account export (middleware/usageLimits.ts).
// High here; paid-endpoint-rate-limits.test.ts sets small values before
// importing the app to exercise the 429 path.
process.env.MORNING_NOTE_LIMIT_PER_HOUR ??= "100000";
process.env.MORNING_NOTE_LIMIT_PER_DAY ??= "100000";
process.env.CONTEXTUAL_GREETING_LIMIT_PER_HOUR ??= "100000";
process.env.CONTEXTUAL_GREETING_LIMIT_PER_DAY ??= "100000";
process.env.ACCOUNT_EXPORT_LIMIT_PER_HOUR ??= "100000";
process.env.ACCOUNT_EXPORT_SUMMARY_LIMIT_PER_HOUR ??= "100000";

// Landing-page demo (routes/demo.ts). demo.test.ts sets a small value before importing the app.
process.env.DEMO_TEXT_LIMIT_PER_HOUR ??= "100000";
// Landing-page voice demo (routes/demoVoice.ts): availability polls and mints per IP.
process.env.DEMO_VOICE_READ_LIMIT ??= "100000";
process.env.DEMO_VOICE_MINT_LIMIT_PER_HOUR ??= "100000";
