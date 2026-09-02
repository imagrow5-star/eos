/**
 * Hume EVI → Eos CLM capture driver.
 *
 * The Hume playground cannot send session_settings, so it can never carry
 * our voice token — this script is how a test session reaches the CLM
 * endpoint authenticated. It opens Hume's EVI WebSocket, sends
 * session_settings carrying the voice token (as language_model_api_key →
 * arrives at our route as `Authorization: Bearer <token>`, and as
 * custom_session_id → arrives as a query parameter), then sends one text
 * turn. EVI calls our /api/hume-llm/v1/chat/completions, which answers the
 * canned line and logs the request body to Render as "hume-clm-capture".
 *
 * Wire shapes verified against the official `hume` SDK source (not
 * inferred): endpoint wss://api.hume.ai/v0/evi/chat with config_id/api_key
 * query params; messages {type:"session_settings", custom_session_id,
 * language_model_api_key} and {type:"user_input", text}.
 *
 * Run LOCALLY (your Hume key and voice token never leave your machine):
 *
 *   HUME_API_KEY=...    \   # Hume dashboard → API keys
 *   HUME_CONFIG_ID=...  \   # the EVI config with the custom LLM URL
 *   EOS_VOICE_TOKEN=... \   # from your logged-in session; see the docs
 *   pnpm --filter @workspace/scripts hume-clm-test
 *
 * Then grep the Render logs for "hume-clm-capture".
 */

const apiKey = process.env.HUME_API_KEY?.trim();
const configId = process.env.HUME_CONFIG_ID?.trim();
const voiceToken = process.env.EOS_VOICE_TOKEN?.trim();

if (!apiKey || !configId || !voiceToken) {
  console.error("Set HUME_API_KEY, HUME_CONFIG_ID and EOS_VOICE_TOKEN (see the file header).");
  process.exit(1);
}

const url =
  "wss://api.hume.ai/v0/evi/chat" +
  `?config_id=${encodeURIComponent(configId)}&api_key=${encodeURIComponent(apiKey)}`;

console.log("connecting to Hume EVI…");
const ws = new WebSocket(url);

const timeout = setTimeout(() => {
  console.error("timed out after 60s — check the config id and Hume account state");
  ws.close();
  process.exit(2);
}, 60_000);

ws.addEventListener("open", () => {
  console.log("connected — sending session_settings (token in both carriers) + one text turn");
  ws.send(
    JSON.stringify({
      type: "session_settings",
      custom_session_id: voiceToken,
      language_model_api_key: voiceToken,
    }),
  );
  ws.send(JSON.stringify({ type: "user_input", text: "Hello, this is a capture test." }));
});

ws.addEventListener("message", (ev) => {
  let msg: { type?: string; message?: { content?: string }; error?: unknown; code?: unknown };
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    console.log("(non-JSON frame)");
    return;
  }
  // Audio frames are huge and useless here; everything else is worth seeing.
  if (msg.type === "audio_output") return;
  console.log(`← ${msg.type}${msg.message?.content ? `: ${msg.message.content}` : ""}`);
  if (msg.type === "error") console.log("  full error:", JSON.stringify(msg));
  // The canned reply came back through EVI — the capture has landed.
  if (msg.type === "assistant_end") {
    console.log("\ndone — now grep the Render logs for: hume-clm-capture");
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener("close", (ev) => {
  console.log(`socket closed (code ${ev.code}${ev.reason ? `, reason: ${ev.reason}` : ""})`);
});

ws.addEventListener("error", () => {
  console.error("websocket error — check HUME_API_KEY and network");
});
