// Vitest setup: make sure the data-encryption master key exists before any
// test imports the app.
//
// Tests run against the shared development database, so when the workspace
// already has DATA_ENCRYPTION_KEY (the real dev key) it MUST be used — rows
// written by tests stay readable by the dev server and vice versa. The
// ephemeral fallback below is only for keyless CI-style environments, where
// generated rows are cleaned up by the tests themselves.
import crypto from "node:crypto";

if (!process.env.DATA_ENCRYPTION_KEY || process.env.DATA_ENCRYPTION_KEY.trim() === "") {
  process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
}
