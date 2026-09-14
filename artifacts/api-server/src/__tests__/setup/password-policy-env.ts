// The Have I Been Pwned breach check (lib/passwordPolicy.ts) makes an HTTPS
// call whenever a password is set. CI has no network, and the check fails
// open after a 2.5 s timeout — which would add seconds to every signup in the
// suite. Switch it off here; login-hardening.test.ts exercises the check
// itself through the fetch seam, with the switch flipped back on locally.
process.env.PASSWORD_BREACH_CHECK ??= "off";
