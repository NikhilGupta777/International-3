/* Narayan Bhakt Studio service worker */
const CACHE_NAME = "nbstudio-v3";
const PRECACHE = ["/app-logo.png", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Always hit the network for API calls and app-shell navigations. The HTML
  // references hashed bundles, so a stale cached shell can crash after deploys.
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response &&
          response.status === 200 &&
          url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|woff2?)$/)
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Narayan Bhakt Studio",
    body: "A background job has finished.",
    url: "/",
    tag: "nbstudio",
    silent: false,
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url: payload.url || "/" },
      icon: "/app-logo.png",
      badge: "/favicon.svg",
      silent: payload.silent === true,
      renotify: false,
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client) return client.navigate(targetUrl);
            return undefined;
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
