import type { Request } from "express";
import webpush, { type PushSubscription } from "web-push";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./logger";

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  silent?: boolean;
};

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
const vapidSubject =
  process.env.VAPID_SUBJECT?.trim() ?? "mailto:ops@videomaking.in";

const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);
const subscriptionsByClient = new Map<string, Map<string, PushSubscription>>();
const PUSH_SUBSCRIPTIONS_FILE =
  process.env.PUSH_SUBSCRIPTIONS_FILE?.trim() ||
  join(process.cwd(), "tmp", "push-subscriptions.json");

if (pushEnabled) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else {
  logger.warn(
    "Web Push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable browser push notifications",
  );
}

function persistSubscriptions(): void {
  try {
    const data: Record<string, PushSubscription[]> = {};
    for (const [clientKey, bucket] of subscriptionsByClient.entries()) {
      data[clientKey] = Array.from(bucket.values());
    }
    mkdirSync(dirname(PUSH_SUBSCRIPTIONS_FILE), { recursive: true });
    writeFileSync(PUSH_SUBSCRIPTIONS_FILE, JSON.stringify(data), "utf8");
  } catch (err) {
    logger.warn({ err }, "Failed to persist push subscriptions");
  }
}

function restoreSubscriptions(): void {
  if (!pushEnabled) return;
  try {
    if (!existsSync(PUSH_SUBSCRIPTIONS_FILE)) return;
    const raw = readFileSync(PUSH_SUBSCRIPTIONS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, PushSubscription[]>;
    for (const [clientKey, subscriptions] of Object.entries(parsed)) {
      if (!Array.isArray(subscriptions) || subscriptions.length === 0) continue;
      const bucket = new Map<string, PushSubscription>();
      for (const sub of subscriptions) {
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) continue;
        bucket.set(sub.endpoint, sub);
      }
      if (bucket.size > 0) {
        subscriptionsByClient.set(clientKey, bucket);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to restore push subscriptions");
  }
}

restoreSubscriptions();

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function sanitizeClientKey(value: string): string {
  return value.trim().replace(/[^\w\-.:]/g, "").slice(0, 128);
}

export function getNotifyClientKey(req: Request): string {
  const raw =
    req.header("x-notify-client") ||
    req.header("x-client-id") ||
    req.header("x-device-id");
  if (raw) {
    const cleaned = sanitizeClientKey(raw);
    if (cleaned) return `client:${cleaned}`;
  }
  const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = normalizeIp(forwarded || req.ip || req.socket.remoteAddress || "unknown");
  return `ip:${ip}`;
}

export function isPushNotificationEnabled(): boolean {
  return pushEnabled;
}

export function getPushPublicKey(): string | null {
  return pushEnabled ? vapidPublicKey : null;
}

export function addPushSubscription(
  clientKey: string,
  subscription: PushSubscription,
): void {
  if (!pushEnabled) return;
  const endpoint = subscription.endpoint?.trim();
  if (!endpoint) return;
  const bucket = subscriptionsByClient.get(clientKey) ?? new Map<string, PushSubscription>();
  bucket.set(endpoint, subscription);
  subscriptionsByClient.set(clientKey, bucket);
  persistSubscriptions();
}

export function removePushSubscription(
  clientKey: string,
  endpoint: string,
): void {
  const bucket = subscriptionsByClient.get(clientKey);
  if (!bucket) return;
  bucket.delete(endpoint);
  if (bucket.size === 0) subscriptionsByClient.delete(clientKey);
  persistSubscriptions();
}

export async function notifyClientPush(
  clientKey: string | null | undefined,
  payload: PushPayload,
): Promise<void> {
  if (!pushEnabled || !clientKey) return;
  const bucket = subscriptionsByClient.get(clientKey);
  if (!bucket || bucket.size === 0) return;

  const message = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    tag: payload.tag ?? "ytgrabber",
    silent: payload.silent ?? false,
  });

  const invalidEndpoints: string[] = [];

  await Promise.all(
    Array.from(bucket.values()).map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, message, {
          TTL: 60 * 60,
          urgency: "normal",
        });
      } catch (err: any) {
        const statusCode = Number(err?.statusCode ?? 0);
        if (statusCode === 404 || statusCode === 410) {
          invalidEndpoints.push(subscription.endpoint);
          return;
        }
        logger.warn(
          { err, endpoint: subscription.endpoint, clientKey },
          "Failed to send web push notification",
        );
      }
    }),
  );

  for (const endpoint of invalidEndpoints) {
    bucket.delete(endpoint);
  }
  if (bucket.size === 0) {
    subscriptionsByClient.delete(clientKey);
  }
  if (invalidEndpoints.length > 0) {
    persistSubscriptions();
  }
}
