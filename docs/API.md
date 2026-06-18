# VideoMaking Studio — Public API

Programmatic access to every studio service through a single API key.

## 1. Get a key

API keys are **admin-issued**. An admin (or an email an admin has granted via the
**Developer** tab) opens the Developer tab in the app and clicks **Generate key**.
The secret (`vms_live_…`) is shown **once** — copy it immediately.

Granting access:
- Admins always have the Developer tab.
- An admin can grant any email from the Admin panel ("API / Developer access"),
  or via `API_ACCESS_EMAILS` at deploy time.

## 2. Authenticate

Send the key as a bearer token on every request:

```
Authorization: Bearer vms_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

`X-API-Key: vms_live_…` is also accepted. A key works from anywhere — scripts,
servers, automations — and can reach any service it is scoped for (default: all).

## 3. Job model

Most operations are asynchronous. You `POST` to start a job and get back:

```json
{
  "jobId": "…",
  "status": "queued",
  "statusUrl": "/api/youtube/clips/status/…",
  "streamUrl": "/api/youtube/clips/stream/…",
  "eventsUrl": "/api/v1/jobs/…/events",
  "webhookRegistered": false
}
```

Track progress in any of three ways: poll `statusUrl`, subscribe to the SSE
`eventsUrl`, or register a webhook (below).

## 4. Endpoints (`/api/v1`)

| Operation | `POST /api/v1/...` | Input |
|-----------|--------------------|-------|
| Best clips | `clips` | `{ "url": "<youtube url>", "durations": [30,60], "auto": true }` |
| Clip cut | `clip-cut` | `{ "url": "<youtube url>", ... }` |
| Download | `download` | `{ "url": "<youtube url>", "audioOnly": false }` |
| Timestamps | `timestamps` | `{ "url": "<youtube url>" }` |
| Subtitles | `subtitles` | `{ "url": "<public media url>", "language": "auto" }` |
| Translate / dub | `translate` | `{ "url": "<public media url>", "targetLang": "Hindi" }` |

- `clips`, `clip-cut`, `download`, `timestamps` take a **YouTube URL**.
- `subtitles`, `translate` take a **publicly-accessible media URL**.

Other endpoints:
- `GET /api/v1` — machine-readable discovery catalog.
- `GET /api/v1/openapi.json` — full OpenAPI 3.1 spec (import into Postman/codegen).
- `GET /api/v1/jobs/{jobId}` — unified job status.
- `GET /api/v1/jobs/{jobId}/events` — unified SSE progress stream.

> The full set of canonical service endpoints (e.g. `/api/youtube/clips`) also
> accepts the same API key directly; `/api/v1` is the stable, documented surface.

### Example

```bash
curl -X POST https://videomaking.in/api/v1/clips \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID"}'
```

## 5. Webhooks

Include `webhookUrl` (https) in any create call to receive an HMAC-signed POST on
completion:

```
POST <your webhookUrl>
X-VMS-Event: job.completed | job.failed
X-VMS-Signature: sha256=<hex hmac of the raw body>

{ "jobId": "…", "status": "done", "ready": true, "timestamp": 1750000000000 }
```

Verify by computing `HMAC_SHA256(rawBody, WEBHOOK_SIGNING_SECRET)` and comparing
to the `X-VMS-Signature` value.

## 6. Limits

- Per-key rate limit (default `API_KEY_RATE_LIMIT_PER_MIN`, 120/min). Exceeding it
  returns `429` with a `Retry-After` header.
- Optional per-key monthly quota (`monthlyQuota` at creation). Exceeding it
  returns `429`.
- Optional expiry (`expiresInDays` at creation).
- Revoke a key any time from the Developer tab — it stops working within ~60s.

## 7. Server configuration

| Env var | Purpose |
|---------|---------|
| `ACCESS_TABLE` | DynamoDB table; stores keys + webhook registrations by default. |
| `API_KEYS_TABLE` | Optional dedicated table for keys/webhooks. |
| `API_ACCESS_EMAILS` | Emails granted Developer access (besides admins). |
| `API_KEY_RATE_LIMIT_PER_MIN` | Default per-key rate limit. |
| `WEBHOOK_SIGNING_SECRET` | HMAC secret for webhooks (falls back to `SESSION_SECRET`). |

Enable DynamoDB **TTL on the `expiresAt` attribute** so expiring keys and old
webhook registrations are cleaned up automatically.
