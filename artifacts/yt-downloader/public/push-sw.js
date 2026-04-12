self.addEventListener("push", (event) => {
  let payload = {
    title: "YTGrabber update",
    body: "A background job has finished.",
    url: "/",
    tag: "ytgrabber",
    silent: true,
  };

  try {
    if (event.data) {
      const parsed = event.data.json();
      payload = {
        ...payload,
        ...parsed,
      };
    }
  } catch {
    // Ignore malformed payloads and show fallback notification.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url: payload.url || "/" },
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      silent: payload.silent !== false,
      renotify: false,
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            return client.navigate(targetUrl);
          }
          return undefined;
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});

