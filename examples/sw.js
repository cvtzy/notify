self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title || "New notification", {
    body: payload.body || "",
    tag: payload.tag || undefined,
    data: { url: payload.url || "/" },
    icon: payload.icon || undefined,
    badge: payload.badge || undefined
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const raw = event.notification.data?.url || "/";
    const target = new URL(raw, self.location.origin);
    if (target.origin !== self.location.origin) return;
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        await client.navigate(target.href);
        return;
      }
    }
    await clients.openWindow(target.href);
  })());
});
