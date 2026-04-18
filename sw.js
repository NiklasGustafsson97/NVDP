// SECURITY (assessment M7): the `url` field in a push payload is supplied
// by whoever owns the push subscription. If a push server (or a subverted
// Edge Function) sends `url: "https://evil.com"`, the previous code would
// happily `clients.openWindow(...)` there on click. Constrain to our own
// origin: anything that isn't a same-origin path gets rewritten to `/`.

function safeNotificationURL(raw) {
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin !== self.location.origin) return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'NVDP';
  const options = {
    body: data.body || 'Du har fått en puff! Dags att träna! 💪',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: safeNotificationURL(data.url || '/') },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = safeNotificationURL(event.notification.data?.url || '/');
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
