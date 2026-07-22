// Phase A privacy: VAPID keys now come EXCLUSIVELY from the environment —
// the push_config DB path is gone (database access must never grant push
// capability). Give every test run an ephemeral pair so push code paths can
// initialize without depending on workspace secrets.
import webpush from "web-push";

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const pair = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = pair.publicKey;
  process.env.VAPID_PRIVATE_KEY = pair.privateKey;
}
