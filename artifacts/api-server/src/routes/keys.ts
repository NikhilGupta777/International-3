import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  isApiKeyStoreEnabled,
  validateScopes,
  API_KEY_SCOPE_CATALOG,
  type ApiKeyRecord,
} from "../lib/api-key-auth";
import { isApiAccessAllowed } from "../lib/auth-access";

// ─────────────────────────────────────────────────────────────────────────────
// API Key management (admin / granted users only)
//
// Mounted at /api/keys. The global /api gate already blocks API-key-authed
// callers from this segment, so only cookie sessions reach here. We additionally
// require the session to be an admin OR an explicitly granted email.
//
//   GET    /api/keys            list keys (admins: all, granted user: own only)
//   POST   /api/keys            create a key — returns the secret ONCE
//   DELETE /api/keys/:keyId     revoke a key
// ─────────────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

type AuthSession = {
  authenticated?: boolean;
  role?: "admin" | "user";
  email?: string;
};

function sessionOf(res: Response): AuthSession {
  return (res.locals.authSession ?? {}) as AuthSession;
}

function isAdminSession(res: Response): boolean {
  const s = sessionOf(res);
  return Boolean(s.authenticated && s.role === "admin");
}

/** Public, client-safe view of a key record (never includes the secret or _pk). */
function publicKey(record: ApiKeyRecord) {
  return {
    keyId: record.keyId,
    prefix: record.prefix,
    name: record.name,
    ownerEmail: record.ownerEmail,
    scopes: record.scopes,
    status: record.status,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    lastUsedAt: record.lastUsedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    rateLimitPerMin: record.rateLimitPerMin ?? null,
    monthlyQuota: record.monthlyQuota ?? null,
    usageMonth: record.usageMonth ?? 0,
    usageTotal: record.usageTotal ?? 0,
  };
}

// ── Gate: admin OR admin-granted email ───────────────────────────────────────
router.use((_req: Request, res: Response, next: NextFunction) => {
  const s = sessionOf(res);
  if (!s.authenticated) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (s.role === "admin" || isApiAccessAllowed(s.email)) {
    next();
    return;
  }
  res.status(403).json({ error: "Developer access is required to manage API keys" });
});

// ── Store availability guard ─────────────────────────────────────────────────
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isApiKeyStoreEnabled()) {
    res.status(503).json({
      error:
        "API key store is not configured. Set ACCESS_TABLE (or API_KEYS_TABLE) to enable API keys.",
    });
    return;
  }
  next();
});

// ── GET /keys/scopes — the assignable scope catalog (for the UI selector) ─────
router.get("/scopes", (_req: Request, res: Response) => {
  res.json({ scopes: API_KEY_SCOPE_CATALOG });
});

// ── GET /keys ─────────────────────────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response) => {
  try {
    const s = sessionOf(res);
    const owner = isAdminSession(res) ? undefined : s.email;
    const keys = await listApiKeys(owner);
    res.json({ ok: true, keys: keys.map(publicKey) });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Failed to list API keys" });
  }
});

// ── POST /keys ────────────────────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  try {
    const s = sessionOf(res);
    const body = req.body as {
      name?: unknown;
      scopes?: unknown;
      expiresInDays?: unknown;
      rateLimitPerMin?: unknown;
      monthlyQuota?: unknown;
    };

    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled key";

    let scopes: string[] | undefined;
    if (Array.isArray(body.scopes)) {
      const requested = body.scopes.filter((x): x is string => typeof x === "string");
      // Throws (→ 400) on any unknown scope so keys can't target internal services.
      const validated = validateScopes(requested);
      if (validated.length > 0) scopes = validated;
    }

    let expiresAt: number | undefined;
    const days = Number(body.expiresInDays);
    if (Number.isFinite(days) && days > 0) {
      expiresAt = Math.floor(Date.now() / 1000) + Math.floor(days * 86400);
    }

    const rateLimitPerMin = Number(body.rateLimitPerMin);
    const monthlyQuota = Number(body.monthlyQuota);

    // Owner of the key: granted users own their keys; admins own keys they mint.
    const ownerEmail = s.email ?? "admin";
    const createdBy = s.email ?? "admin";

    const { record, rawKey } = await createApiKey({
      name,
      ownerEmail,
      createdBy,
      scopes,
      expiresAt,
      rateLimitPerMin: Number.isFinite(rateLimitPerMin) && rateLimitPerMin > 0 ? rateLimitPerMin : undefined,
      monthlyQuota: Number.isFinite(monthlyQuota) && monthlyQuota > 0 ? monthlyQuota : undefined,
    });

    res.json({
      ok: true,
      // The secret is returned exactly once — it is never retrievable again.
      key: rawKey,
      keyInfo: publicKey(record),
    });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : "Failed to create API key" });
  }
});

// ── DELETE /keys/:keyId ───────────────────────────────────────────────────────
router.delete("/:keyId", async (req: Request, res: Response) => {
  try {
    const keyId = String(req.params.keyId ?? "").trim();
    if (!keyId) {
      res.status(400).json({ error: "keyId is required" });
      return;
    }

    // Non-admin users may only revoke keys they own.
    if (!isAdminSession(res)) {
      const s = sessionOf(res);
      const own = await listApiKeys(s.email);
      const target = own.find((k) => k.keyId === keyId);
      if (!target) {
        res.status(404).json({ error: "API key not found" });
        return;
      }
    }

    const revoked = await revokeApiKey(keyId);
    if (!revoked) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    res.json({ ok: true, keyId, status: "revoked" });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Failed to revoke API key" });
  }
});

export default router;
