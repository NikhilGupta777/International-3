import { Router, type Request, type Response } from "express";
import {
  addPushSubscription,
  getNotifyClientKey,
  getPushPublicKey,
  isPushNotificationEnabled,
  removePushSubscription,
} from "../lib/push-notifications";

const router = Router();

type SubscribeBody = {
  subscription?: {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: {
      p256dh?: string;
      auth?: string;
    };
  };
};

router.get("/notifications/config", (_req: Request, res: Response) => {
  const publicKey = getPushPublicKey();
  res.json({
    enabled: isPushNotificationEnabled(),
    publicKey,
  });
});

router.post("/notifications/subscribe", (req: Request, res: Response) => {
  if (!isPushNotificationEnabled()) {
    res.status(503).json({ error: "Push notifications are not configured" });
    return;
  }

  const body = req.body as SubscribeBody;
  const subscription = body.subscription;
  if (
    !subscription?.endpoint ||
    !subscription.keys?.p256dh ||
    !subscription.keys?.auth
  ) {
    res.status(400).json({ error: "Invalid push subscription payload" });
    return;
  }

  const clientKey = getNotifyClientKey(req);
  addPushSubscription(clientKey, {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  });
  res.json({ ok: true, clientKey });
});

router.post("/notifications/unsubscribe", (req: Request, res: Response) => {
  const endpoint = (req.body as { endpoint?: string })?.endpoint;
  if (!endpoint) {
    res.status(400).json({ error: "endpoint is required" });
    return;
  }
  const clientKey = getNotifyClientKey(req);
  removePushSubscription(clientKey, endpoint);
  res.json({ ok: true });
});

export default router;
