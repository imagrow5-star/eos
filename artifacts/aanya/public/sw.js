// Eos service worker — receives web pushes and opens the app on click.
// Kept dependency-free and tiny on purpose: all real logic lives server-side
// (opt-in checks, the 2-per-day cap, quiet hours). If this file changes, the
// browser updates it automatically on next visit.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* malformed payload — show nothing rather than junk */
    return;
  }
  const title = data.title || "Eos";
  const options = {
    body: data.body || "",
    icon: data.icon || "icon-192.png",
    badge: data.badge || "icon-192.png",
    tag: data.tag || undefined, // same-tag pushes replace, never stack
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const scope = new URL(self.registration.scope);
      const target = new URL(url.replace(/^\//, ""), scope).href;
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of wins) {
        if (client.url.startsWith(scope.origin) && "focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
