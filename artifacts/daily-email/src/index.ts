/**
 * Eos — Daily personalized email job: CLI entry point.
 *
 * All job logic lives in ./run (importable, side-effect-free on import) so
 * the run-level dry-run test can execute the main loop without this file's
 * auto-execute + process.exit behavior. Env var documentation is in ./run.
 */

import { pool } from "@workspace/db";
import { run } from "./run";

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        msg: "Fatal error in daily email job",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => {}));
