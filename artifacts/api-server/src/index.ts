import app from "./app";
import { logger } from "./lib/logger";
import { initVoiceLibrary } from "./services/voiceLibrary";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Initialise romantic community voices (non-blocking — failures logged and skipped)
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (apiKey) {
    initVoiceLibrary(apiKey).catch((e) =>
      logger.error({ err: e }, "Unexpected error in initVoiceLibrary"),
    );
  } else {
    logger.warn("ELEVENLABS_API_KEY not set — skipping voice library init");
  }
});
