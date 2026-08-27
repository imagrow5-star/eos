/**
 * Push the subscription-gate cutoff far into the future for the test suite.
 *
 * Every suite creates its users "now", which is after the real production
 * cutoff — without this, each of them would be gated and every chat/voice
 * test would 402 at the door (the exact CI failure this file fixed). Test
 * users are the moral equivalent of grandfathered testers.
 *
 * The gate itself stays fully tested: subscription-gate.test.ts computes its
 * pre/post-cutoff dates RELATIVE to the configured constant, so the
 * mechanism is exercised regardless of where the cutoff sits.
 */
process.env.SUBSCRIPTION_REQUIRED_AFTER = "2099-01-01T00:00:00Z";
