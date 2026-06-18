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
- API keys cannot access `/api/admin` or `/api/keys`.
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

Create response:

```json
{
  "jobId": "04406909-8820-4cb6-8c7e-547ac51b6938",
  "status": "queued",
  "statusUrl": "/api/youtube/progress/04406909-8820-4cb6-8c7e-547ac51b6938",
  "streamUrl": "/api/youtube/progress/stream/04406909-8820-4cb6-8c7e-547ac51b6938",
  "eventsUrl": "/api/v1/jobs/04406909-8820-4cb6-8c7e-547ac51b6938/events",
  "webhookRegistered": false
}
```

Recommended client behavior:

1. Create a job.
2. Store `jobId`.
3. Poll `GET /api/v1/jobs/{jobId}` every 5-10 seconds, or listen to
   `GET /api/v1/jobs/{jobId}/events`.
4. Stop when status is terminal.
5. If successful, download the result from the returned file/result URL.

Observed statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Accepted but not started. |
| `queued` | Submitted to a queue or worker. |
| `running` | Worker is active. |
| `downloading` | YouTube/media download or clip extraction is active. |
| `generating` | AI or subtitle generation is active. |
| `translating` | Translation or dubbing is active. |
| `done` / `DONE` | Completed successfully. |
| `error` / `failed` / `FAILED` | Terminal failure. |
| `cancelled` / `CANCELLED` | Cancelled by user or worker. |
| `expired` / `EXPIRED` | Terminal expiry state. |

Status response:

```json
{
  "jobId": "JOB_ID",
  "status": "downloading",
  "message": "Cutting selected section...",
  "progressPct": 5,
  "ready": false,
  "resultUrl": null
}
```

Note: the current implementation uses `ready` to mean terminal in the unified
`/api/v1/jobs/{jobId}` response. Check `status` before assuming success.

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

The SSE endpoint polls the shared job table and has a 15-minute connection cap.
Reconnect or fall back to polling for longer jobs.

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
HMAC_SHA256(raw_request_body, WEBHOOK_SIGNING_SECRET)
```

and comparing it to the value after `sha256=`.

## Errors

Typical error responses:

```json
{ "error": "Invalid or revoked API key" }
```

```json
{ "error": "API key is not permitted to access this resource" }
```

```json
{ "error": "url is required" }
```

```json
{
  "jobId": "JOB_ID",
  "status": "error",
  "message": "Clip cut failed after 3 attempts: YouTube is not sending video data to our server right now.",
  "progressPct": 0,
  "ready": true,
  "resultUrl": null
}
```

HTTP status codes:

| Code | Meaning |
| --- | --- |
| `200` / `202` | Request accepted or status returned. |
| `400` | Invalid request body or missing required field. |
| `401` | Missing, invalid, revoked, or expired key. |
| `403` | Key scope does not allow the service. |
| `404` | Job or output not found. |
| `409` | Duplicate/conflicting job ID in service-specific flows. |
| `413` | Upload too large in upload flows. |
| `429` | Rate limit or quota exceeded. |
| `500` | Server-side failure. |
| `502` | Upstream worker, AI, queue, or media-processing failure. |
| `503` | Required service configuration missing. |

## Limits and quotas

Defaults are configured by deployment:

- Per-key rate limit defaults to `API_KEY_RATE_LIMIT_PER_MIN` or 120 requests
  per minute.
- A key may have a custom `rateLimitPerMin`.
- A key may have a monthly quota.
- Usage is tracked per calendar month and lifetime total.
- On rate-limit failure, the server may return `Retry-After`.

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

Service scopes are matched by the first path segment after `/api`.

Examples:

| Scope | Allows |
| --- | --- |
| `youtube` | `/api/youtube/...` and v1 operations forwarded to YouTube routes |
| `subtitles` | `/api/subtitles/...` |
| `translator` | `/api/translator/...` |
| `timestamps` | `/api/youtube/timestamps...` via canonical YouTube path |
| `uploads` | `/api/uploads/...` |
| `agent` | `/api/agent/...` |
| `thumbnail` | `/api/thumbnail/...` |
| `bhagwat` | `/api/bhagwat/...` |

Forbidden regardless of scope:

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

Current gap: there is no stable `/api/v1/jobs/{jobId}/cancel` endpoint. Cancel
exists on canonical service routes for YouTube, subtitles, and translator jobs.

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
  return res.json();
}

async function pollJob(jobId) {
  while (true) {
    const res = await fetch(`https://videomaking.in/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const job = await res.json();
    if (["done", "DONE", "error", "failed", "FAILED", "cancelled", "CANCELLED", "expired", "EXPIRED"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
}

const created = await createClipCut();
console.log(await pollJob(created.jobId));
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
job_id = created.json()["jobId"]

while True:
    status = requests.get(
        f"{BASE}/api/v1/jobs/{job_id}",
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=30,
    )
    status.raise_for_status()
    job = status.json()
    print(job)
    if job["status"] in {"done", "DONE", "error", "failed", "FAILED", "cancelled", "CANCELLED", "expired", "EXPIRED"}:
        break
    time.sleep(8)
```

## Operational caveats

- YouTube routes depend on reliable server-side YouTube access. Some videos may
  fail when YouTube does not provide video data to the server. Production should
  keep cookies, PO-token provider, or proxy configuration healthy.
- `/api/v1/jobs/{jobId}` reads from the shared job table. Some inline/in-memory
  jobs may only be visible through the operation-specific `statusUrl` returned
  at creation.
- `statusUrl` and `streamUrl` currently may point to canonical service routes
  such as `/api/youtube/progress/{jobId}`. `eventsUrl` stays under `/api/v1`.
- `ready: true` does not always mean success. Always check `status`.
- API-key rate limiting is in-memory per running server instance, while usage
  counters are flushed to DynamoDB periodically.

