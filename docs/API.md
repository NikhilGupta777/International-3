# VideoMaking Studio API

Programmatic access to studio services through one API key. Use this API from
scripts, servers, cron jobs, no-code automations, and backend integrations.

Base URL:

```text
https://videomaking.in
```

Stable public API prefix:

```text
/api/v1
```

## Quick start

Send your key as a bearer token. It works from anywhere - scripts, servers,
automations.

```bash
curl -X POST https://videomaking.in/api/v1/clips \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID"}'
```

Important naming:

- `POST /api/v1/clips` finds AI-selected best clips.
- `POST /api/v1/clip-cut` cuts one exact manual time range.

## API keys

API keys are issued from the Developer tab by an admin or an email that an admin
has granted Developer/API access.

Security behavior:

- Keys start with `vms_live_`.
- The raw key is shown once when created.
- The server stores only a SHA-256 hash and a short display prefix.
- Revoked or expired keys stop working after the verification cache refreshes
  (about 60 seconds).
- API keys are confined to public services only. Internal routes
  (`/api/admin`, `/api/keys`, `/api/workspace`, `/api/video-editor`,
  `/api/ops`, `/api/notebook`, `/api/pitaji`, `/api/notifications`) are blocked
  for every key, including `*`.
- A key scopes requests to its own client identity, so jobs and outputs are
  isolated per key.

Authentication headers:

```http
Authorization: Bearer vms_live_YOUR_KEY
```

Alternative:

```http
X-API-Key: vms_live_YOUR_KEY
```

Do not expose API keys in frontend code, mobile apps, public repositories,
browser local storage, screenshots, support tickets, or logs.

## Public endpoints

The stable public API currently exposes six job-creation operations:

| Operation | Method | Path | Input URL |
| --- | --- | --- | --- |
| Best clips | `POST` | `/api/v1/clips` | YouTube URL |
| Clip cut | `POST` | `/api/v1/clip-cut` | YouTube URL |
| Download | `POST` | `/api/v1/download` | YouTube URL |
| Timestamps | `POST` | `/api/v1/timestamps` | YouTube URL |
| Subtitles | `POST` | `/api/v1/subtitles` | Public media URL |
| Translate / dub | `POST` | `/api/v1/translate` | Public media URL |

Discovery:

```http
GET /api/v1
GET /api/v1/openapi.json
```

Status:

```http
GET /api/v1/jobs/{jobId}
GET /api/v1/jobs/{jobId}/events
```

The `/api/v1` routes forward to canonical service routes internally and return a
normalized job envelope.

## Job model

Most operations are asynchronous.

Create response (only stable v1 URLs are returned):

```json
{
  "jobId": "04406909-8820-4cb6-8c7e-547ac51b6938",
  "status": "queued",
  "rawStatus": "queued",
  "statusUrl": "https://videomaking.in/api/v1/jobs/04406909-8820-4cb6-8c7e-547ac51b6938",
  "eventsUrl": "https://videomaking.in/api/v1/jobs/04406909-8820-4cb6-8c7e-547ac51b6938/events",
  "cancelUrl": "https://videomaking.in/api/v1/jobs/04406909-8820-4cb6-8c7e-547ac51b6938/cancel",
  "webhookRegistered": false
}
```

Recommended client behavior:

1. Create a job.
2. Store `jobId` (or the returned `statusUrl`).
3. Poll `GET /api/v1/jobs/{jobId}` every 5-10 seconds, or listen to
   `GET /api/v1/jobs/{jobId}/events` (SSE). Both work for every operation.
4. Stop when `terminal` is true.
5. If `succeeded`, read the `result` object.

Public status enum (the raw worker status is preserved under `rawStatus`):

| Status | Meaning |
| --- | --- |
| `pending` | Accepted but not started. |
| `queued` | Submitted to a queue or worker. |
| `running` | Work is in progress (download / generate / translate). |
| `done` | Completed successfully (`succeeded: true`). |
| `error` | Terminal failure (`failed: true`). |
| `cancelled` | Cancelled by a user or worker. |
| `expired` | Terminal expiry state. |

Status response:

```json
{
  "jobId": "JOB_ID",
  "op": "clip-cut",
  "status": "running",
  "rawStatus": "downloading",
  "terminal": false,
  "succeeded": false,
  "failed": false,
  "ready": false,
  "message": "Cutting selected section...",
  "progressPct": 5,
  "result": null,
  "statusUrl": "https://videomaking.in/api/v1/jobs/JOB_ID",
  "eventsUrl": "https://videomaking.in/api/v1/jobs/JOB_ID/events",
  "cancelUrl": "https://videomaking.in/api/v1/jobs/JOB_ID/cancel"
}
```

`result` is populated only when `succeeded` is true. Its shape depends on the
operation: `{ type: "file", url }` for download/clip-cut, or
`clips` / `chapters` / `subtitles` / `translation` payloads for the others.
`ready` is kept as a back-compat alias of `terminal`.

## Cancel a job

```http
POST /api/v1/jobs/{jobId}/cancel
Authorization: Bearer vms_live_YOUR_KEY
```

Routes to the correct backend. Operations that do not support cancellation
(e.g. timestamps) return `400 NOT_CANCELLABLE`. The create response advertises
`cancelUrl` (null when unsupported).

## Idempotency

Send an `Idempotency-Key` header on any create request to make retries safe:

```bash
curl -X POST https://videomaking.in/api/v1/clips \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Idempotency-Key: 7e3f...client-generated" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID"}'
```

- Retrying with the **same key and body** replays the original job envelope
  (response header `Idempotent-Replayed: true`) instead of creating a duplicate.
- Reusing the **same key with a different body** returns `409 IDEMPOTENCY_KEY_REUSED`.
- Keys are scoped per API key and retained for 24 hours.

## Health

`GET /api/v1/health` is a lightweight, key-authenticated probe (also a quick way
to confirm a key works):

```json
{
  "ok": true,
  "service": "videomaking-studio-api",
  "version": "v1",
  "components": { "apiKeyStore": true, "jobRegistry": true, "idempotency": true }
}
```

## Uploads

To subtitle or translate your own media, upload it first, then pass the returned
public URL. Requires the `uploads` (or `*`) scope.

```http
POST /api/v1/uploads/presign      { filename, size, mimeType }  -> presigned URL(s) + fileId
POST /api/v1/uploads/complete     { fileId, parts? }            -> finalizes the upload
GET  /api/v1/uploads/{fileId}                                    -> file metadata / URL
DELETE /api/v1/uploads/{fileId}                                  -> remove the file
```

Then call subtitles/translate with the file's public URL. Limits: max 3 GB,
single PUT under 50 MB, 10 MB multipart parts, presigned download ~7 days.

## Best clips

Find AI-selected clip ideas from a YouTube video.

```http
POST /api/v1/clips
```

Body:

```json
{
  "url": "https://youtu.be/VIDEO_ID",
  "durations": [30, 60],
  "auto": true,
  "instructions": "Find devotional story moments",
  "webhookUrl": "https://example.com/vms-webhook"
}
```

Fields:

- `url` is required.
- `durations` is optional array of target clip lengths in seconds.
- `auto` is optional boolean.
- `instructions` is optional text that biases the AI selection.
- `webhookUrl` is optional HTTPS callback URL.

Example:

```bash
curl -X POST https://videomaking.in/api/v1/clips \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID","durations":[30,60],"auto":true}'
```

## Clip cut

Cut one exact range from a YouTube video.

```http
POST /api/v1/clip-cut
```

Body:

```json
{
  "url": "https://youtu.be/VIDEO_ID",
  "startTime": 0,
  "endTime": 30,
  "quality": "360p",
  "webhookUrl": "https://example.com/vms-webhook"
}
```

Rules:

- `url` is required.
- `startTime` and `endTime` are required numbers in seconds.
- `endTime` must be greater than `startTime`.
- A clip cannot exceed 60 minutes.
- `quality` is optional.

Example:

```bash
curl -X POST https://videomaking.in/api/v1/clip-cut \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID","startTime":0,"endTime":30,"quality":"360p"}'
```

## Download

Download a full YouTube video or audio track.

```http
POST /api/v1/download
```

Body:

```json
{
  "url": "https://youtu.be/VIDEO_ID",
  "formatId": "best",
  "audioOnly": false,
  "webhookUrl": "https://example.com/vms-webhook"
}
```

Fields:

- `url` is required.
- `formatId` is optional. If omitted, the server chooses a compatible best
  format.
- `audioOnly` is optional boolean.

Example:

```bash
curl -X POST https://videomaking.in/api/v1/download \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID","audioOnly":false}'
```

## Timestamps

Generate chapter timestamps for a YouTube video.

```http
POST /api/v1/timestamps
```

Body:

```json
{
  "url": "https://youtu.be/VIDEO_ID",
  "instructions": "Make detailed chapters",
  "webhookUrl": "https://example.com/vms-webhook"
}
```

Fields:

- `url` is required.
- `instructions` is optional.

Example:

```bash
curl -X POST https://videomaking.in/api/v1/timestamps \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID","instructions":"Make detailed chapters"}'
```

## Subtitles

Transcribe a public audio/video URL into subtitles.

```http
POST /api/v1/subtitles
```

Body:

```json
{
  "url": "https://example.com/video.mp4",
  "language": "auto",
  "translateTo": "hi",
  "webhookUrl": "https://example.com/vms-webhook"
}
```

Fields:

- `url` is required and must be publicly accessible.
- `language` is optional. Use `auto` or a language code.
- `translateTo` is optional target language for subtitle translation.

Example:

```bash
curl -X POST https://videomaking.in/api/v1/subtitles \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","language":"auto"}'
```

## Translate / dub

Translate and dub a public video URL.

```http
POST /api/v1/translate
```

Body:

```json
{
  "url": "https://example.com/video.mp4",
  "targetLang": "Hindi",
  "targetLangCode": "hi",
  "sourceLang": "auto",
  "voiceClone": true,
  "lipSync": false,
  "webhookUrl": "https://example.com/vms-webhook"
}
```

Fields:

- `url` is required and must be publicly accessible.
- `targetLang` defaults to `Hindi`.
- `targetLangCode` defaults to `hi`.
- `sourceLang` defaults to `auto`.
- `voiceClone` defaults to `true`.
- `lipSync` defaults to `false` and may be restricted by deployment or account
  capability.

Example:

```bash
curl -X POST https://videomaking.in/api/v1/translate \
  -H "Authorization: Bearer vms_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","targetLang":"Hindi","targetLangCode":"hi","voiceClone":true}'
```

## Polling

```bash
curl https://videomaking.in/api/v1/jobs/JOB_ID \
  -H "Authorization: Bearer vms_live_YOUR_KEY"
```

Poll every 5-10 seconds. For long translation jobs, use a longer client timeout
and keep polling until terminal.

## Server-Sent Events

```bash
curl -N https://videomaking.in/api/v1/jobs/JOB_ID/events \
  -H "Authorization: Bearer vms_live_YOUR_KEY"
```

Events:

- `status`: progress update.
- `done`: terminal status reached.

The SSE endpoint resolves the job's backend and polls its status (works for
every operation) with a 15-minute connection cap. Reconnect or fall back to
polling for longer jobs.

## Webhooks

Include `webhookUrl` in any create request:

```json
{
  "url": "https://youtu.be/VIDEO_ID",
  "startTime": 0,
  "endTime": 30,
  "webhookUrl": "https://example.com/vms-webhook"
}
```

Rules:

- Must be HTTPS.
- Cannot include username/password credentials.
- Cannot point to localhost, private IP ranges, reserved IP ranges, `.local`,
  `.localhost`, or `.internal` hosts.
- The server validates DNS resolution and rejects private/reserved targets.
- Registrations expire after 7 days when DynamoDB TTL is enabled.

Webhook request:

```http
POST https://example.com/vms-webhook
X-VMS-Event: job.completed
X-VMS-Signature: sha256=<hex hmac>
Content-Type: application/json
```

Body:

```json
{
  "jobId": "JOB_ID",
  "status": "done",
  "message": "Video ready",
  "ready": true,
  "timestamp": 1780000000000
}
```

Verify the signature by computing:

```text
HMAC_SHA256(raw_request_body, secret)
```

and comparing it to the value after `sha256=`. The `secret` is the **per-key
webhook secret** returned once when the key was created (falls back to the
server's global `WEBHOOK_SIGNING_SECRET` for keys created before this feature).

Delivery status: `GET /api/v1/jobs/{jobId}/webhook` returns whether a webhook is
registered and its last delivery outcome:

```json
{
  "jobId": "JOB_ID",
  "registered": true,
  "delivered": true,
  "attempts": 1,
  "lastDeliveryStatus": "delivered",
  "lastDeliveryCode": 200,
  "lastDeliveryAt": 1780000000000
}
```

Delivery timing: YouTube download/clip-cut jobs deliver the moment they reach a
terminal state. Other operations (best-clips, timestamps, subtitles, translate)
deliver when the job is first observed terminal via the unified status or SSE
endpoint (delivery is at-most-once). If you rely solely on webhooks for those
operations, poll `GET /api/v1/jobs/{jobId}` (or open the SSE stream) at least
once after the work finishes.

## Errors

Every v1 error uses one structured shape with a stable machine-readable `code`
and a `retryable` flag:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded for this API key.",
    "retryable": true,
    "retryAfterSec": 42
  }
}
```

A failed job is not an HTTP error — poll/SSE returns `status: "error"` with
`failed: true`:

```json
{
  "jobId": "JOB_ID",
  "status": "error",
  "rawStatus": "failed",
  "terminal": true,
  "succeeded": false,
  "failed": true,
  "ready": true,
  "message": "Clip cut failed: YouTube is not sending video data right now.",
  "result": null
}
```

Error codes:

| Code | Meaning |
| --- | --- |
| `INVALID_API_KEY` | Missing, malformed, or revoked key (401). |
| `FORBIDDEN_SCOPE` | Key lacks the scope for this route (403). |
| `RATE_LIMIT_EXCEEDED` | Per-minute limit hit; see `Retry-After` (429, retryable). |
| `MONTHLY_QUOTA_EXCEEDED` | Monthly request quota reached (429). |
| `INVALID_REQUEST` | Bad parameters (400). |
| `JOB_NOT_FOUND` | Unknown jobId, or not owned by this key (404). |
| `NOT_CANCELLABLE` | The operation does not support cancellation (400). |
| `UPSTREAM_VALIDATION` | The underlying service rejected the input (400). |
| `UPSTREAM_ERROR` / `INTERNAL_ERROR` | Server-side failure (5xx, retryable). |

HTTP status codes:

| Code | Meaning |
| --- | --- |
| `200` / `202` | Request accepted or status returned. |
| `400` | Invalid request body or missing required field. |
| `401` | Missing, invalid, revoked, or expired key. |
| `403` | Key scope does not allow the service. |
| `404` | Job or output not found. |
| `429` | Rate limit or quota exceeded. |
| `500` | Server-side failure. |
| `502` | Upstream worker, AI, queue, or media-processing failure. |
| `503` | Required service configuration missing. |

## Limits and quotas

Every key-authenticated response carries rate-limit headers:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Requests allowed per minute for this key. |
| `X-RateLimit-Remaining` | Requests left in the current window. |
| `X-RateLimit-Reset` | Epoch seconds when the window resets. |
| `Retry-After` | Seconds to wait before retrying (sent on 429). |

Defaults are configured by deployment:

- Per-key rate limit defaults to `API_KEY_RATE_LIMIT_PER_MIN` or 120 requests
  per minute.
- A key may have a custom `rateLimitPerMin`.
- A key may have a monthly quota.
- Usage is tracked per calendar month and lifetime total.
- Limits are enforced per server instance (best-effort), so brief bursts may
  exceed the nominal limit under high concurrency.

YouTube clip-cut constraints:

- One clip range per `/api/v1/clip-cut` request.
- Maximum clip duration is 60 minutes.

Uploads route constraints, when using canonical upload routes:

- Maximum upload size is 3 GB.
- Single presigned PUT is used below 50 MB.
- Multipart upload uses 10 MB parts.
- Presigned upload URLs last about 2 hours.
- Presigned download URLs last about 7 days.

## Scopes

Full-access keys use:

```json
["*"]
```

`*` grants every **public** service segment. Scopes are validated at key
creation — unknown scopes are rejected. The assignable catalog
(`GET /api/keys/scopes`):

| Scope | Allows |
| --- | --- |
| `youtube` | All YouTube operations |
| `youtube:download` | `/api/youtube/download` only |
| `youtube:clip-cut` | `/api/youtube/clip-cut` only |
| `youtube:clips` | best-clips only |
| `youtube:timestamps` | chapter/timestamp generation only |
| `youtube:info` | metadata only |
| `subtitles` / `subtitles:create` | `/api/subtitles/...` |
| `translator` / `translator:create` | `/api/translator/...` |
| `uploads` / `uploads:create` | `/api/uploads/...` |
| `thumbnail` | `/api/thumbnail/...` |
| `agent` | `/api/agent/...` |
| `bhagwat` | `/api/bhagwat/...` |

Granular YouTube create-scopes are enforced individually; shared operations
(cancel / file / stream / status) are available to any `youtube` scope so a
narrow key can still manage and download its own jobs.

Blocked for **every** key, including `*` (hard allowlist boundary):

- `/api/workspace/...`
- `/api/video-editor/...`
- `/api/ops/...`
- `/api/notebook/...`
- `/api/pitaji/...`
- `/api/notifications/...`
- `/api/admin/...`
- `/api/keys/...`

## Canonical service routes

Public clients should prefer `/api/v1`. The app also exposes canonical service
routes used by the browser UI and by `/api/v1` forwarding. These may be useful
for advanced internal clients but are not as stable as `/api/v1`.

Examples:

```text
POST /api/youtube/download
POST /api/youtube/clip-cut
GET  /api/youtube/progress/{jobId}
POST /api/youtube/cancel/{jobId}
POST /api/youtube/clips
GET  /api/youtube/clips/status/{jobId}
POST /api/subtitles/generate-from-url
GET  /api/subtitles/status/{jobId}
POST /api/subtitles/cancel/{jobId}
POST /api/translator/submit-from-url
GET  /api/translator/status/{jobId}
POST /api/translator/cancel/{jobId}
POST /api/uploads/presign
POST /api/uploads/complete
GET  /api/uploads/file/{fileId}
```

Cancellation: `POST /api/v1/jobs/{jobId}/cancel` routes to the correct backend
(returns `400 NOT_CANCELLABLE` for operations that don't support it, e.g.
timestamps).

## Node.js example

```js
const API_KEY = process.env.VMS_API_KEY;

async function createClipCut() {
  const res = await fetch("https://videomaking.in/api/v1/clip-cut", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: "https://youtu.be/VIDEO_ID",
      startTime: 0,
      endTime: 30,
      quality: "360p",
    }),
  });

  if (!res.ok) throw new Error(await res.text());
  return res.json(); // { jobId, statusUrl, ... }
}

async function pollJob(statusUrl) {
  while (true) {
    const res = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const job = await res.json();
    if (job.terminal) return job; // succeeded / failed are set
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
}

const created = await createClipCut();
const job = await pollJob(created.statusUrl);
console.log(job.succeeded ? job.result : job.message);
```

## Python example

```python
import os
import time
import requests

API_KEY = os.environ["VMS_API_KEY"]
BASE = "https://videomaking.in"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

created = requests.post(
    f"{BASE}/api/v1/clip-cut",
    headers=headers,
    json={
        "url": "https://youtu.be/VIDEO_ID",
        "startTime": 0,
        "endTime": 30,
        "quality": "360p",
    },
    timeout=60,
)
created.raise_for_status()
status_url = created.json()["statusUrl"]

while True:
    status = requests.get(status_url, headers={"Authorization": f"Bearer {API_KEY}"}, timeout=30)
    status.raise_for_status()
    job = status.json()
    if job["terminal"]:
        print(job["result"] if job["succeeded"] else job["message"])
        break
    time.sleep(8)
```

## Operational caveats

- YouTube routes depend on reliable server-side YouTube access. Some videos may
  fail when YouTube does not provide video data to the server. Production should
  keep cookies, PO-token provider, or proxy configuration healthy.
- `/api/v1/jobs/{jobId}` and `/events` work for every operation via the public
  job registry; older jobs created outside `/api/v1` fall back to the shared
  job table.
- The create envelope and status responses return absolute `/api/v1` URLs only
  (`statusUrl`, `eventsUrl`, `cancelUrl`) — internal service routes are never
  exposed.
- Prefer the `terminal` / `succeeded` / `failed` booleans. `ready` is a
  back-compat alias of `terminal`.
- API-key rate limiting is in-memory per running server instance, while usage
  counters are flushed to DynamoDB periodically.

