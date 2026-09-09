/**
 * Eos — hourly scheduler: CLI entry point.
 *
 * All logic lives in ./run (importable, side-effect-free on import) so the
 * tests can execute the real main loop without this file's auto-execute and
 * process.exit behaviour. Env var documentation is in ./run.
 */

import { run } from "./run";

run()
  .then((outcomes) => process.exit(outcomes.some((o) => !o.ok) ? 1 : 0))
  .catch((err) => {
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        msg: "Fatal error in scheduler",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
