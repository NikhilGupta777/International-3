# VideoMaking Studio — Complete Project Guide

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

**VideoMaking Studio** is a private media workspace hosted at `videomaking.in`. It provides:

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
    ├── /api/*  ──► API Gateway ──► Lambda (api-server)
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

> **Note:** Local dev uses direct yt-dlp execution (not Batch). Jobs run synchronously in the API process. This is fine for testing but won't behave exactly like production.

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
2. Frontend POSTs to /api/youtube/clip-cut (or download, clips, subtitles)
3. Lambda generates a jobId, writes "queued" to DynamoDB
4. Lambda submits an AWS Batch job (Fargate worker starts)
5. Frontend polls /api/youtube/progress/:jobId every few seconds
6. Worker pulls cookies from S3, runs yt-dlp/ffmpeg/AI
7. Worker writes "running" → "done" + outputUrl to DynamoDB
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

Fargate workers take **45-90 seconds** to spin up from cold. This is expected — you'll see "Queued - starting soon..." in the UI. Subsequent jobs in the same session are faster.

---

## 6. Deployment — Step by Step

### Current Production Versions

| Resource | Tag/Revision |
|----------|-------------|
| Lambda API image | `20260423-converge` |
| Worker image | `20260423-converge` |
| Batch Job Definition | `ytgrabber-green-worker-job:20` |

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
  -ImageUri "596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:20260423-converge" `
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
| API Gateway | `1ru54qm40m` | HTTP API in front of Lambda |
| Lambda | `ytgrabber-green-api` | API server (1536MB, 29s timeout) |
| Batch Job Queue | `ytgrabber-green-job-queue` | FIFO queue for worker jobs |
| Batch Compute | `ytgrabber-green-compute-fargate` | Fargate, 6 max vCPUs |
| Batch Job Def | `ytgrabber-green-worker-job` | Worker container spec |
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
| `ytgrabber-green-lambda-5xx` | > 5 Lambda errors in 5 min |
| `ytgrabber-green-lambda-throttles` | > 3 throttles in 10 min |
| `ytgrabber-green-batch-failures` | > 3 Batch failures in 5 min |

> Alarms are active but **no SNS email is configured yet**. Add one when needed.

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
| `GEMINI_API_KEY` | ✅ | Primary Gemini API key (Best Clips AI) |
| `GEMINI_API_KEY_2..6` | Optional | Additional keys for rotation to avoid rate limits |
| `ASSEMBLYAI_API_KEY` | ✅ | AssemblyAI key for subtitle transcription |
| `S3_BUCKET` | ✅ | Output S3 bucket (`malikaeditorr`) |
| `S3_REGION` | ✅ | `us-east-1` |
| `S3_OBJECT_PREFIX` | ✅ | `ytgrabber-green` |
| `S3_SIGNED_URL_TTL_SEC` | Optional | Download link TTL, default 7200 (2 hours) |
| `YTDLP_COOKIES_S3_KEY` | ✅ | S3 path to cookies file (see Section 10) |
| `YTDLP_COOKIES_BASE64` | ❌ | Leave blank — cookies come from S3 |
| `YTDLP_POT_PROVIDER_URL` | ❌ | Leave blank — bgutil not running in Fargate |
| `YOUTUBE_QUEUE_PRIMARY_ENABLED` | ✅ | `true` |
| `YOUTUBE_QUEUE_PRIMARY_JOB_TYPES` | ✅ | `download,clip-cut,subtitles,best-clips` |
| `YOUTUBE_QUEUE_JOB_TABLE` | ✅ | `ytgrabber-green-jobs` |
| `YOUTUBE_BATCH_JOB_QUEUE` | ✅ | `ytgrabber-green-job-queue` |
| `YOUTUBE_BATCH_JOB_DEFINITION` | ✅ | `ytgrabber-green-worker-job:20` (pin to revision!) |
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

### Check Site Health

```powershell
# Via CloudFront (production)
curl.exe -s https://d2bcwj2idfdwb4.cloudfront.net/api/healthz

# Via API Gateway (bypasses CloudFront, useful for debugging)
curl.exe -s https://1ru54qm40m.execute-api.us-east-1.amazonaws.com/api/healthz
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

# Login
curl.exe -s -c .\test-cookies.txt `
  -H "content-type: application/json" `
  --data-binary '{"username":"kalki_avatar","password":"kalkiavatar#2026"}' `
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
3. Check Fargate vCPU limit — max is 6 vCPUs, each worker uses 2. So max 3 concurrent workers.

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

This is a pay-per-use architecture. You pay nothing when nobody is using the site.

| Service | Cost Model | Estimated Monthly |
|---------|-----------|-------------------|
| Lambda | Per request + GB-seconds | < $1 (low traffic) |
| Fargate (Batch) | Per vCPU-second + GB-second | ~$0.05 per job |
| S3 (storage) | Per GB stored | Depends on output files |
| CloudFront | Per request + data transfer | < $1 (low traffic) |
| DynamoDB | Pay-per-request | < $0.01 |
| API Gateway | Per request | < $0.01 |
| ECR | Per GB stored | < $0.50 (lifecycle policy keeps it lean) |

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
