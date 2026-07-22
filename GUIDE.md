# Narayan Bhakt Studio — Complete Project Guide

> **The single document you need.** Architecture, development, deployment, debugging, and maintenance — all in one place.

---

## Table of Contents
 
1. [What This Project Is](#1-what-this-project-is)
2. [Architecture Overview](#2-architecture-overview)
3. [Repository Structure](#3-repository-structure)
4. [Local Development Setup](#4-local-development-setup)
5. [The 4 Core Flows](#5-the-4-core-flows)
6. [Deployment — Step by Step](#6-deployment--step-by-step)
7. [When New Code is Added](#7-when-new-code-is-added)
8. [AWS Infrastructure Reference](#8-aws-infrastructure-reference)
9. [Environment Variables Reference](#9-environment-variables-reference)
10. [YouTube Cookie Management](#10-youtube-cookie-management)
11. [Monitoring & Alarms](#11-monitoring--alarms)
12. [Troubleshooting](#12-troubleshooting)
13. [Cost Overview](#13-cost-overview)
14. [Security Notes](#14-security-notes)

---

## 1. What This Project Is

**Narayan Bhakt Studio** is a private media workspace hosted at `videomaking.in`. It provides:

- **Download** — Download YouTube videos in any quality to S3
- **Clip Cut** — Cut a precise time range from a YouTube video
- **Best Clips** — AI-powered analysis to find the most engaging timestamps
- **Subtitles** — Auto-generate accurate subtitle `.srt` files from YouTube audio

It is a **single-user private tool** (login required, one account). The stack was migrated from an always-on EC2 instance to a serverless AWS architecture to reduce costs — you only pay when jobs actually run.

---

## 2. Architecture Overview

```
User Browser
    │
    ▼
CloudFront (videomaking.in / www.videomaking.in)
    ├── /api/*  ──► Lambda Function URL ──► Lambda (api-server)
    │                                    │
    │                              ┌─────┴──────────────────────────┐
    │                              │                                │
    │                           Submits job                   Reads/writes
    │                              │                            job state
    │                              ▼                                │
    │                         AWS Batch                        DynamoDB
    │                     (Fargate worker)               (ytgrabber-green-jobs)
    │                              │
    │                         Processes video
    │                         (yt-dlp, ffmpeg,
    │                          AssemblyAI, Gemini)
    │                              │
    │                         Uploads output
    │                              │
    │                              ▼
    └── /*      ──► S3 (Static Site)        S3 (malikaeditorr)
                   Frontend HTML/JS/CSS      Output files + cookies
```

### Key Design Decisions

| Decision | Reason |
|----------|--------|
| Lambda for API | Handles auth, job submission, status polling — cheap, scales to zero |
| Fargate (Batch) for workers | Heavy work (yt-dlp, ffmpeg) needs more CPU/RAM and longer timeout than Lambda allows |
| S3 for cookies | YouTube cookies can be 4KB+ — too large for Lambda env vars / Batch containerOverrides |
| DynamoDB for job state | Simple key-value job tracking, no server to manage |
| CloudFront in front of everything | Single domain for both API and frontend, handles HTTPS, caching |

---

## 3. Repository Structure

```
International-3/
├── artifacts/
│   ├── api-server/          # Express.js API (runs as Lambda)
│   │   ├── src/
│   │   │   ├── app.ts       # Express app setup
│   │   │   ├── lambda.ts    # Lambda entrypoint
│   │   │   └── routes/
│   │   │       ├── youtube.ts    # Download, clip-cut, best-clips, info
│   │   │       ├── subtitles.ts  # Subtitle generation
│   │   │       ├── bhagwat.ts    # Bhagwat video editor
│   │   │       └── auth.ts       # Login/session
│   │   └── dist/            # Built output (gitignored)
│   │
│   ├── yt-downloader/       # React frontend (Vite + TypeScript)
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   └── pages/Home.tsx   # Main UI with 4 tabs
│   │   └── dist/public/     # Built frontend (gitignored)
│   │
│   └── queue-worker/        # Batch Fargate worker
│       ├── src/index.ts     # Handles all 4 job types
│       └── Dockerfile       # Worker container definition
│
├── lib/                     # Shared TypeScript packages
│   ├── api-spec/            # API type definitions
│   ├── api-zod/             # Zod validation schemas
│   ├── api-client-react/    # React API hooks
│   ├── db/                  # DynamoDB utilities
│   └── gemini/              # Gemini AI client
│
├── deploy/
│   ├── aws-serverless/
│   │   ├── deploy-serverless.ps1    # ← MAIN DEPLOY SCRIPT
│   │   ├── template.yml             # CloudFormation template
│   │   ├── push-api-lambda-image.ps1
│   │   └── ecr-lifecycle-policy.json
│   └── aws-queue/
│       ├── push-worker-image.ps1    # Build + push worker image
│       └── create-alarms.ps1
│
├── Dockerfile.api-lambda    # API Lambda container
├── GUIDE.md                 # ← You are here
├── DEPLOY.md                # Quick deploy reference
├── .env                     # Local dev env (gitignored)
├── .env.example             # Template for all variables
└── deploy/ec2/.env.green    # Production env vars (gitignored)
```

---

## 4. Local Development Setup

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- AWS CLI configured (`aws configure`)
- Docker Desktop (for building images)

### First-Time Setup

```powershell
# Install all dependencies
pnpm install

# Copy env template
cp .env.example .env
# Edit .env with your local values (see Section 9)
```

### Run Locally

```powershell
# Start the API server (port 3000)
pnpm --filter @workspace/api-server run dev

# In another terminal, start the frontend (port 5173)
pnpm --filter @workspace/yt-downloader run dev
```

Frontend at `http://localhost:5173` — it proxies `/api/*` to `localhost:3000`.

> **Important:** For local development, make sure `YOUTUBE_QUEUE_PRIMARY_ENABLED=false` in your `.env`. This tells the API server to run the `yt-dlp` job synchronously in your local terminal instead of trying to submit it to AWS Batch.

### Build Everything

```powershell
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/yt-downloader run build
```

---

## 5. The 4 Core Flows

### How a Job Works (End-to-End)

```
1. User submits form in browser
2. Frontend POSTs to `/api/youtube/clip-cut` (or download, clips, subtitles)
3. Lambda generates a jobId and writes initial job state to DynamoDB
4. Short eligible clip jobs run in a dedicated self-invoked Lambda worker; long clips and slow Lambda jobs use AWS Batch/Fargate
5. Frontend polls `/api/youtube/progress/:jobId` every few seconds
6. Lambda or the Batch worker pulls cookies from S3, runs yt-dlp/ffmpeg/AI, and writes progress to DynamoDB
7. Worker writes `running` -> `done` + output URL to DynamoDB
8. Frontend shows download link (signed S3 URL, valid 2 hours)
```

### Flow Details

| Flow | Endpoint | Worker Does |
|------|----------|-------------|
| **Download** | `POST /api/youtube/download` | yt-dlp downloads full video → uploads to S3 |
| **Clip Cut** | `POST /api/youtube/clip-cut` | yt-dlp download → ffmpeg trim → S3 |
| **Best Clips** | `POST /api/youtube/clips` | yt-dlp audio → transcription → Gemini AI analysis |
| **Subtitles** | `POST /api/subtitles/generate` | yt-dlp audio → AssemblyAI transcription → .srt |

### Job Status Flow

```
queued → running → done
              └──► error
```

### Cold Start

Fargate workers take **45-90 seconds** to spin up from cold. This is expected — you'll see "Queued - starting soon..." in the UI. Short clip cuts up to `LAMBDA_CLIP_MAX_DURATION_SECONDS=420` seconds use the Lambda fast path first, then hand off to Batch if the observed ffmpeg progress is too slow to finish safely.

---

## 6. Deployment — Step by Step

### Current Production Versions

| Resource | Tag/Revision |
|----------|-------------|
| Lambda API image | commit `84da200c`, digest `sha256:7d634b3d164fd30ad802edf93720a70fc1688e8b3359cf3a8c5808aa1966d31d` |
| Worker image | `ytgrabber-green-worker:84da200c` |
| Batch Job Definition | `ytgrabber-green-worker-job:744` |
| Last production deploy | 2026-07-20 18:47-18:48 IST |

### Full Deploy (Most Common)

Use this when you've made changes to **both frontend and backend**:

```powershell
# Step 1: Build the API
pnpm --filter @workspace/api-server run build

# Step 2: Build + push Lambda image + deploy CFN + sync frontend
$tag = Get-Date -Format "yyyyMMdd-HHmmss"
.\deploy\aws-serverless\deploy-serverless.ps1 `
  -ImageTag $tag `
  -EnvFilePath .\deploy\ec2\.env.green

# Step 3: Update .env.green to record the new tag for next time
# (edit YOUTUBE_BATCH_JOB_DEFINITION if worker also changed)
```

**That's it.** The script does:
1. Builds the frontend (Vite)
2. Builds and pushes the Lambda Docker image to ECR
3. Deploys/updates the CloudFormation stack
4. Syncs the frontend to S3
5. Invalidates CloudFront cache

### Frontend Only Deploy

When only UI files changed (no backend logic):

```powershell
pnpm --filter @workspace/yt-downloader run build

.\deploy\aws-serverless\deploy-serverless.ps1 `
  -SkipImageBuild `
  -ImageUri "<current image URI from aws lambda get-function --function-name ytgrabber-green-api>" `
  -EnvFilePath .\deploy\ec2\.env.green
```

Takes ~2 minutes. Much faster since no Docker build.

### Worker Only Deploy

When only `artifacts/queue-worker/` changed:

```powershell
# Step 1: Build + push new worker image
$tag = Get-Date -Format "yyyyMMdd-HHmmss"
.\deploy\aws-queue\push-worker-image.ps1 -ImageTag $tag

# Step 2: Register new Batch job definition revision
# (get containerProperties from current active def, update image, register)
# See DEPLOY.md for the full PowerShell snippet

# Step 3: Update Lambda env var
# YOUTUBE_BATCH_JOB_DEFINITION=ytgrabber-green-worker-job:<new_revision>
```

---

## 7. When New Code is Added

### The Golden Rule

> **Always use a timestamp image tag. Never push `:latest` alone.**
>
> Bad:  `docker push myrepo/worker:latest`
> Good: `docker push myrepo/worker:20260501-143022`

This is what caused all the original infrastructure drift. Mutable tags = no rollback, no provenance, no reproducibility.

### Decision Tree

```
Did you change code?
│
├── Only frontend (src/pages, components, CSS)?
│   └── Frontend-only deploy (fast, ~2 min)
│
├── Only api-server (routes, lib, lambda)?
│   └── Full deploy with new Lambda image tag
│
├── Only queue-worker (index.ts, Dockerfile)?
│   └── Worker image deploy + new Batch job def revision
│
└── Multiple areas?
    └── Full deploy (safest)
```

### After Every Deploy — Verify

```powershell
# Quick sanity check
curl.exe -s https://d2bcwj2idfdwb4.cloudfront.net/api/healthz
# Expected: {"status":"ok"}

# Login + submit a test clip-cut job
# (see Troubleshooting section for full smoke test script)
```

---

## 8. AWS Infrastructure Reference

### Resources

| Resource | Name | Purpose |
|----------|------|---------|
| CloudFront | `EDTEON6GFBEZH` | CDN + routing for videomaking.in |
| Lambda Function URL | `https://3x4swcbqciemcdvfawhlsv7xiu0byxcs.lambda-url.us-east-1.on.aws/` | CloudFront `/api*` origin; `InvokeMode=RESPONSE_STREAM`, `AuthType=NONE` |
| Lambda | `ytgrabber-green-api` | API server and Lambda-fast workers (3008 MB, 900s timeout) |
| Batch Job Queue | `ytgrabber-green-job-queue` | FIFO queue for worker jobs |
| Batch Compute | `ytgrabber-green-compute-fargate` | Fargate, 16 max vCPUs, scale-to-zero |
| Batch Job Def | `ytgrabber-green-worker-job:744` | Worker container spec |
| DynamoDB | `ytgrabber-green-jobs` | Job state tracking |
| S3 Static | `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh` | Frontend files |
| S3 Output | `malikaeditorr` | Video output + cookies |
| ECR API | `ytgrabber-green-api-lambda` | Lambda container images |
| ECR Worker | `ytgrabber-green-worker` | Worker container images |
| CloudFormation | `ytgrabber-green-serverless` | Manages all the above |

### ECR Lifecycle Policy

Both ECR repos auto-delete:
- Tagged images beyond the 5 most recent
- Untagged images after 1 day

### CloudWatch Alarms

| Alarm | Triggers |
|-------|---------|
| `ytgrabber-green-lambda-5xx` | > 5 Lambda errors per 5-minute period for 2 periods |
| `ytgrabber-green-lambda-throttles` | > 3 throttles per 5-minute period for 2 periods |
| `ytgrabber-green-batch-failures` | > 3 Batch failures in 5 min |

> Alarms are active. The SNS topic `ytgrabber-green-alerts` exists, but it has zero confirmed subscribers; Lambda and Batch failure alarms also have no alarm action. Alerts are therefore not reliably delivered. A single 5-minute Lambda throttle burst can still leave the alarm in OK because the current evaluation period count is 2.

### Lambda Concurrency Quota

As of the 2026-07-23 recheck, the live applied Lambda account concurrency quota in `us-east-1` is `1000`. Production previously hit the old applied limit of `10` at `2026-07-22 02:32 IST` and recorded 5 throttles. The earlier quota request remains open:

```powershell
aws service-quotas list-requested-service-quota-change-history-by-quota `
  --region us-east-1 `
  --service-code lambda `
  --quota-code L-B99A9384
```

Requested value: `1001`. Request id: `b45fb4bb5e2841748ab225a45d806248bg1HnYLc`. The request does not increase cost by itself; it only permits more simultaneous Lambda execution when traffic or jobs actually use it.

### Useful AWS CLI Commands

```powershell
# Check Lambda image version
aws lambda get-function --region us-east-1 --function-name ytgrabber-green-api --query "Code.ImageUri" --output text

# Check active Batch job definition
aws batch describe-job-definitions --region us-east-1 --job-definition-name ytgrabber-green-worker-job --status ACTIVE --query "jobDefinitions[0].{rev:revision,img:containerProperties.image}" --output json

# List recent Batch jobs
aws batch list-jobs --region us-east-1 --job-queue ytgrabber-green-job-queue --job-status RUNNING --output json

# Check CloudFormation stack status
aws cloudformation describe-stacks --region us-east-1 --stack-name ytgrabber-green-serverless --query "Stacks[0].StackStatus" --output text

# View recent Lambda errors (last 1 hour)
aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/ytgrabber-green-api --start-time (([DateTimeOffset]::UtcNow.AddHours(-1)).ToUnixTimeMilliseconds()) --filter-pattern "ERROR" --query "events[*].message" --output text
```

---

## 9. Environment Variables Reference

The production env lives in `deploy/ec2/.env.green` (gitignored — never commit this).

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | ✅ | Express session signing secret. Do NOT rotate — invalidates all sessions |
| `BHAGWAT_PASSWORD` | ✅ | Login password for the site |
| `GEMINI_API_KEY` | ✅ | Primary Gemini API key (Best Clips AI); code also supports numbered rotation |
| `GEMINI_API_KEY_2..13` | Optional | Additional keys for rotation to avoid rate limits |
| `GEMINI_API_KEYS` | ✅ prod compact form | CSV Gemini key pool expanded at Lambda cold start into `GEMINI_API_KEY[_N]` |
| `ASSEMBLYAI_API_KEY` | ✅ | AssemblyAI key for subtitle transcription |
| `S3_BUCKET` | ✅ | Output S3 bucket (`malikaeditorr`) |
| `S3_REGION` | ✅ | `us-east-1` |
| `S3_OBJECT_PREFIX` | ✅ | `ytgrabber-green` |
| `S3_SIGNED_URL_TTL_SEC` | Optional | Download link TTL, default 7200 (2 hours) |
| `YTDLP_COOKIES_S3_KEY` | ✅ | S3 path to cookies file (see Section 10) |
| `YTDLP_COOKIES_BASE64` | ❌ | Leave blank — cookies come from S3 |
| `YTDLP_POT_PROVIDER_URL` | ❌ | Leave blank — bgutil not running in Fargate |
| `YOUTUBE_QUEUE_PRIMARY_ENABLED` | ✅ | `true` |
| `YOUTUBE_QUEUE_PRIMARY_JOB_TYPES` | ✅ | live: `bhagwat-analyze,bhagwat-render,clip-cut,subtitles` |
| `YOUTUBE_QUEUE_JOB_TABLE` | ✅ | `ytgrabber-green-jobs` |
| `YOUTUBE_BATCH_JOB_QUEUE` | ✅ | `ytgrabber-green-job-queue` |
| `YOUTUBE_BATCH_JOB_DEFINITION` | ✅ | live: `ytgrabber-green-worker-job:744` (pin to revision!) |
| `LAMBDA_CLIP_MAX_DURATION_SECONDS` | ✅ | live: `420`; clips at or under this duration try Lambda fast path first |
| `SUBTITLES_LAMBDA_MAX_DURATION_SECONDS` | ✅ | live: `780` |
| `MAX_CONCURRENT_CLIP_JOBS` | ✅ | live: `3`; global clip worker lease limit before handoff to Batch |
| `SUPER_AGENT_ENABLED` | ✅ | live: `true`; empty `SUPER_AGENT_ALLOWED_EMAILS` means the feature is open to all authenticated users |
| `RATE_LIMIT_BYPASS_IPS` | Optional | Comma-separated IPs that bypass rate limits |
| `VAPID_PUBLIC_KEY` | Optional | Web push notifications |
| `VAPID_PRIVATE_KEY` | Optional | Web push notifications |

For local `.env`, set `YOUTUBE_QUEUE_PRIMARY_ENABLED=false` to skip Batch and run jobs in-process.

---

## 10. YouTube Cookie Management

YouTube requires authenticated cookies to download most videos. Cookies expire roughly every **30-90 days**.

### How Cookies Work in Production

1. Cookies are stored as a base64-encoded text file in S3:
   `s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt`
2. The Fargate worker downloads this file at job start
3. yt-dlp uses the decoded cookie file for all requests

### Updating Cookies (When Downloads Start Failing)

```powershell
# Step 1: Export fresh cookies from your browser
# Use a browser extension like "Get cookies.txt LOCALLY" on YouTube
# Save as cookies.txt (Netscape format)

# Step 2: Base64-encode and upload to S3
$bytes = [System.IO.File]::ReadAllBytes(".\cookies.txt")
$encoded = [Convert]::ToBase64String($bytes)
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText(".\tmp-cookies-b64.txt", $encoded, $utf8NoBom)
aws s3 cp .\tmp-cookies-b64.txt s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt

# Step 3: Verify (check file size > 0)
aws s3 ls s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt

# Step 4: Clean up local temp files
Remove-Item .\tmp-cookies-b64.txt
```

No restart needed — the worker fetches the S3 file fresh on every job.

### Signs Cookies Are Expired

- Downloads return `ERROR: Sign in to confirm you're not a bot`
- Best Clips jobs fail with YouTube auth errors
- Info endpoint still works (it doesn't need cookies)

---

## 11. Monitoring & Alarms

**Quick AWS Console Links (Click to open):**
- [CloudWatch Alarms](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:?~(alarmStateFilter~'ALARM))
- [Lambda API Logs](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fytgrabber-green-api)
- [Worker Logs (AWS Batch)](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Fbatch$252Fjob$252Fytgrabber-green-worker)
- [Batch Jobs Dashboard](https://us-east-1.console.aws.amazon.com/batch/home?region=us-east-1#jobs)

### Check Site Health

```powershell
# Via CloudFront (production)
curl.exe -s https://d2bcwj2idfdwb4.cloudfront.net/api/healthz

# Via Lambda Function URL (bypasses CloudFront, useful for debugging)
curl.exe -s https://3x4swcbqciemcdvfawhlsv7xiu0byxcs.lambda-url.us-east-1.on.aws/api/healthz
```

### Check Active Jobs

```powershell
# Running Batch jobs
aws batch list-jobs --region us-east-1 --job-queue ytgrabber-green-job-queue --job-status RUNNING

# Failed Batch jobs (last 24h)
aws batch list-jobs --region us-east-1 --job-queue ytgrabber-green-job-queue --job-status FAILED
```

### View Worker Logs

```powershell
# Find the log stream for a specific job
aws logs describe-log-streams --region us-east-1 `
  --log-group-name /aws/batch/job/ytgrabber-green-worker `
  --order-by LastEventTime --descending `
  --query "logStreams[0].logStreamName" --output text

# Then read it
aws logs get-log-events --region us-east-1 `
  --log-group-name /aws/batch/job/ytgrabber-green-worker `
  --log-stream-name <stream-name-from-above> `
  --query "events[*].message" --output text
```

### Full Smoke Test

```powershell
$base = "https://d2bcwj2idfdwb4.cloudfront.net"
$authUser = $env:WEBSITE_AUTH_USER
$authPass = $env:WEBSITE_AUTH_PASSWORD
if (-not $authPass) { throw "Set WEBSITE_AUTH_PASSWORD in your shell before smoke test" }
if (-not $authUser) { $authUser = "kalki_avatar" }
$loginBody = @{ username = $authUser; password = $authPass } | ConvertTo-Json -Compress

# Login
curl.exe -s -c .\test-cookies.txt `
  -H "content-type: application/json" `
  --data-binary $loginBody `
  "$base/api/auth/login"

# Submit clip-cut
$r = curl.exe -s -b .\test-cookies.txt `
  -H "content-type: application/json" `
  --data-binary '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","startTime":5,"endTime":10,"quality":"360p"}' `
  "$base/api/youtube/clip-cut" | ConvertFrom-Json

# Poll status
$jobId = $r.jobId
for($i=0; $i -lt 20; $i++) {
  Start-Sleep 8
  $s = curl.exe -s -b .\test-cookies.txt "$base/api/youtube/progress/$jobId" | ConvertFrom-Json
  Write-Output "Status: $($s.status)"
  if($s.status -match "done|error") { break }
}
```

---

## 12. Troubleshooting

### "videomaking.in not loading" from your machine

This is a known ISP routing issue on the development machine. Test directly against CloudFront instead:
```
https://d2bcwj2idfdwb4.cloudfront.net
```
The site works fine for all other users.

### Lambda returning 502/503

1. Check Lambda logs in CloudWatch
2. Verify the Lambda image is the correct one:
   ```powershell
   aws lambda get-function --region us-east-1 --function-name ytgrabber-green-api --query "Code.ImageUri" --output text
   ```
3. Check if CloudFormation stack is mid-update (can cause brief outages):
   ```powershell
   aws cloudformation describe-stacks --region us-east-1 --stack-name ytgrabber-green-serverless --query "Stacks[0].StackStatus" --output text
   ```
4. Check account-level Lambda concurrency before assuming a code bug:
   ```powershell
   aws lambda get-account-settings --region us-east-1 --query "AccountLimit"
   aws cloudwatch get-metric-statistics --region us-east-1 `
     --namespace AWS/Lambda `
     --metric-name Throttles `
     --dimensions Name=FunctionName,Value=ytgrabber-green-api `
     --start-time (Get-Date).ToUniversalTime().AddHours(-2).ToString("s") `
     --end-time (Get-Date).ToUniversalTime().ToString("s") `
     --period 60 `
     --statistics Sum
   ```

### Super Agent Shows "Restricted"

The UI message comes from `artifacts/yt-downloader/src/pages/Home.tsx`: the Super Agent panel renders the restricted card when `authFeatures?.superAgentAllowed !== true`. It is not a direct Lambda clip-cut error.

Current live backend config allows Super Agent:

- `SUPER_AGENT_ENABLED=true`
- `SUPER_AGENT_ALLOWED_EMAILS` is empty, which means allowed for authenticated users
- `/api/auth/session` returns `features.superAgentAllowed=true`

If a logged-in browser still shows the restricted card, check `/api/auth/session` around that exact time. Before the 2026-07-22 frontend fix, a transient failed session/features fetch could leave the frontend with stale `videomaking.authenticated=1` but `authFeatures=null`, so the user remained inside the app shell while restricted tabs rendered. The fixed client retries each session attempt independently, requires feature entitlements before opening the workspace, and shows a session-verification error with a Retry button when permissions are unknown. It only shows "restricted" after the backend explicitly returns `superAgentAllowed=false`. On 2026-07-22, a screenshot at phone time `7:06` was audited against `06:45-07:25 IST`: Lambda had 0 errors, 0 throttles, and `/api/auth/session` returned HTTP 200. A separate `09:28 IST` cluster had one Google `403`, follow-on `401`s, and one short `ECONNRESET` Lambda handler error.

### Browser Shows "Security Risk / SSL_ERROR_BAD_CERT_DOMAIN"

This happens if your custom domain (`videomaking.in`) points to CloudFront, but CloudFront doesn't have an SSL certificate attached for that domain.
1. Ensure an SSL certificate for `videomaking.in` and `*.videomaking.in` is issued in **AWS Certificate Manager (ACM)** in the `us-east-1` region.
2. In the AWS Console, go to **CloudFront** -> select your distribution -> **Edit**.
3. Under **Alternate domain names (CNAME)**, ensure `videomaking.in` and `www.videomaking.in` are listed.
4. Under **Custom SSL certificate**, select the ACM certificate and save changes.

### Jobs Stay "Queued" Forever

1. Check Batch compute environment is ENABLED:
   ```powershell
   aws batch describe-compute-environments --region us-east-1 --compute-environments ytgrabber-green-compute-fargate --query "computeEnvironments[0].status"
   ```
2. Check the job queue is ENABLED:
   ```powershell
   aws batch describe-job-queues --region us-east-1 --job-queues ytgrabber-green-job-queue --query "jobQueues[0].status"
   ```
3. Check Fargate vCPU limit — live max is 16 vCPUs. The compute environment scales to zero and only runs when jobs are submitted.

### Jobs Fail With YouTube Auth Error

Cookies are expired. See Section 10 — update the S3 cookie file.

### Deploy Fails Mid-Way (CloudFormation ROLLBACK)

```powershell
# Check what failed
aws cloudformation describe-stack-events `
  --region us-east-1 `
  --stack-name ytgrabber-green-serverless `
  --query "StackEvents[?ResourceStatus=='CREATE_FAILED' || ResourceStatus=='UPDATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" `
  --output table
```

If stuck in `ROLLBACK_COMPLETE`, the deploy script auto-deletes it on next run.

### Docker Build OOM (Bus Error / Core Dumped)

The worker Dockerfile can OOM Docker Desktop during `pnpm install`. Solutions:
1. Increase Docker Desktop memory in Settings → Resources (set to 6GB+)
2. The Dockerfile already uses `--filter @workspace/queue-worker...` to limit scope
3. Alternatively: retag the existing live image in ECR instead of rebuilding (see DEPLOY.md)

---

## 13. Cost Overview

This is a pay-per-use architecture. Batch/Fargate max vCPUs and Lambda concurrency quota are capacity ceilings, not 24/7 spend. You pay when requests/jobs actually run.

| Service | Cost Model | Estimated Monthly |
|---------|-----------|-------------------|
| Lambda | Per request + GB-seconds | < $1 (low traffic) |
| Fargate (Batch) | Per vCPU-second + GB-second | ~$0.05 per job |
| S3 (storage) | Per GB stored | Depends on output files |
| CloudFront | Per request + data transfer | < $1 (low traffic) |
| DynamoDB | Pay-per-request | < $0.01 |
| ECR | Per GB stored | < $0.50 (lifecycle policy keeps it lean) |

Cost Explorer check on 2026-07-22 for 2026-07-01 through 2026-07-22 showed positive usage of about `$0.0079` (`AWS Lambda` `$0.0056`, `Amazon Elastic Container Service` `$0.0022`) with offsetting/free-tier line items making net unblended cost effectively `$0.00`. Raising Lambda concurrency quota or Batch max vCPUs does not reserve capacity and does not create spend until invocations/jobs run.

**Biggest cost driver:** S3 storage of downloaded videos. Old files are cleaned up automatically by the cleanup logic in `youtube.ts`.

---

## 14. Security Notes

### What is Protected

- The entire site requires login (session cookie)
- Session secret is a 64-byte random value — do not rotate unless necessary (it invalidates all sessions)
- AWS credentials are IAM user credentials with scoped permissions (S3, Batch, DynamoDB, Lambda)

### ⚠️ Critical: Do Not Delete `.env.green`

The production secrets file lives at `deploy/ec2/.env.green`. **Do not delete the `deploy/ec2/` folder.** Even though the architecture is now serverless, the deployment script `deploy-serverless.ps1` expects this file to exist.
If this file is ever accidentally deleted from your hard drive, it can only be recovered by querying the live Lambda environment using the AWS CLI:
```powershell
aws lambda get-function-configuration --region us-east-1 --function-name ytgrabber-green-api --query "Environment.Variables" --output json
```

### What to Never Commit

These are in `.gitignore` and must stay out of git:

- `.env` (local secrets)
- `deploy/ec2/.env.green` (production secrets)
- `deploy/ec2/keys/` (SSH keys)
- `*.pem` files

### Cookie Security

YouTube cookies in S3 are the most sensitive piece — they give access to the YouTube account used for downloading. The S3 object is private (not public). Rotate cookies when they expire (not before), and never put them in environment variables or commit them.

### Rate Limiting

The API has rate limiting. Trusted IPs (e.g., your home IP) can be added to `RATE_LIMIT_BYPASS_IPS` in `.env.green` to skip limits.

---

## Quick Reference Card

```
Site:         https://videomaking.in
              https://d2bcwj2idfdwb4.cloudfront.net (use if domain fails)
API direct:   https://1ru54qm40m.execute-api.us-east-1.amazonaws.com
Login:        kalki_avatar / (see .env.green BHAGWAT_PASSWORD)

Deploy all:   .\deploy\aws-serverless\deploy-serverless.ps1 -ImageTag (Get-Date -Format yyyyMMdd-HHmmss) -EnvFilePath .\deploy\ec2\.env.green
Frontend only: .\deploy\aws-serverless\deploy-serverless.ps1 -SkipImageBuild -ImageUri <current-uri> -EnvFilePath .\deploy\ec2\.env.green
Health check: curl.exe -s https://d2bcwj2idfdwb4.cloudfront.net/api/healthz

Region:       us-east-1
Account:      596596146505
Lambda:       ytgrabber-green-api
Batch Queue:  ytgrabber-green-job-queue
DynamoDB:     ytgrabber-green-jobs
S3 Output:    malikaeditorr
CFN Stack:    ytgrabber-green-serverless
```
