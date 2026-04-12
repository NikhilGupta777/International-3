const NOTIFY_CLIENT_KEY_STORAGE = "ytgrabber-notify-client-key";
const PUSH_ENDPOINT_STORAGE = "ytgrabber-push-endpoint";

type PushConfigResponse = {
  enabled: boolean;
  publicKey: string | null;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function getOrCreateNotifyClientId(): string {
  const existing = localStorage.getItem(NOTIFY_CLIENT_KEY_STORAGE);
  if (existing?.trim()) return existing;
  const next = randomClientId();
  localStorage.setItem(NOTIFY_CLIENT_KEY_STORAGE, next);
  return next;
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const raw = atob(padded);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export function installNotifyClientHeader(): void {
  const originalFetch = window.fetch.bind(window);
  if ((window as typeof window & { __notifyFetchPatched?: boolean }).__notifyFetchPatched) return;
  (window as typeof window & { __notifyFetchPatched?: boolean }).__notifyFetchPatched = true;
  const clientId = getOrCreateNotifyClientId();

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const isApiCall =
      requestUrl.startsWith("/api/") ||
      requestUrl.includes("/api/");
    if (!isApiCall) return originalFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-notify-client", clientId);
    return originalFetch(input, { ...init, headers });
  };
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

export async function getPushConfig(): Promise<PushConfigResponse | null> {
  try {
    const res = await fetch("/api/notifications/config");
    if (!res.ok) return null;
    const data = (await res.json()) as PushConfigResponse;
    return data;
  } catch {
    return null;
  }
}

export async function enablePushNotifications(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "unsupported" };
  }

  const cfg = await getPushConfig();
  if (!cfg?.enabled || !cfg.publicKey) {
    return { ok: false, reason: "not_configured" };
  }

  const registration = await registerPushServiceWorker();
  if (!registration) {
    return { ok: false, reason: "sw_failed" };
  }

  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "permission_denied" };
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey:
        base64UrlToUint8Array(cfg.publicKey) as unknown as BufferSource,
    });
  }

  const res = await fetch("/api/notifications/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
  if (!res.ok) {
    return { ok: false, reason: "server_rejected" };
  }

  localStorage.setItem(PUSH_ENDPOINT_STORAGE, subscription.endpoint);
  return { ok: true };
}

export function pushNotificationSupportSummary(): {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
} {
  if (
    !("Notification" in window) ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  ) {
    return { supported: false, permission: "unsupported" };
  }
  return { supported: true, permission: Notification.permission };
}
