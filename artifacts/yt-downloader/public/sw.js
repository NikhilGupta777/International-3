/* VideoMaking Studio — PWA Service Worker */
const CACHE_NAME = "vmstudio-v2";
const PRECACHE = ["/", "/index.html", "/app-logo.png", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only handle GET requests and same-origin / CDN assets.
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Never intercept API calls — always hit the network.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response &&
          response.status === 200 &&
          (event.request.mode === "navigate" ||
            url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|woff2?)$/))
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push notifications (re-use existing push-sw.js logic) ───────────────────
self.addEventListener("push", (event) => {
  let payload = {
    title: "VideoMaking Studio",
    body: "A background job has finished.",
    url: "/",
    tag: "vmstudio",
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
    })
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
      })
  );
});
