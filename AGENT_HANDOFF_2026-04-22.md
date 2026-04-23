# VideoMaking.in Agent Handoff - 2026-04-22

This file is the starting point for any new Codex thread. Read it before changing code or AWS.

Do not paste raw secrets into chat or commit them. Secret values are intentionally redacted here. Use existing local env files, AWS env vars, or the user-provided secret files only when needed.

---

## 1. Workspace

- Local repo: `C:\Users\g_n-n\Desktop\apps\international-3 clone\International-3`
- Shell: PowerShell on Windows.
- Current production domain: `https://videomaking.in`
- CloudFront domain: `https://d2bcwj2idfdwb4.cloudfront.net`
- Main persistent tracker: `MASTER_EXECUTION_BOOK.md`
- This handoff file: `AGENT_HANDOFF_2026-04-22.md`

Important current local state:

- The working tree is dirty with many migration changes.
- `artifacts/api-server/src/lib/youtube-queue.ts` is currently zero bytes and must be restored before any API build.
- `artifacts/api-server/dist/lambda.mjs.map` exists and can be used to recover the source content for `src/lib/youtube-queue.ts`.
- Do not run destructive git commands. Many changes are intentional migration work.

---

## 2. Product Summary

VideoMaking Studio is a web app for:

- YouTube/full video download tab.
- Best Clips AI extraction tab.
- Subtitles generation tab.
- Clip Cut tab.
- Global Activity panel and browser notifications.
- Login-gated public site.

The primary architecture goal was to stop the always-on EC2 bill and move to:

- S3 + CloudFront for frontend.
- API Gateway + Lambda for auth/control/status.
- DynamoDB for durable job state.
- AWS Batch Fargate workers for heavy video/AI processing.
- S3 for uploaded media and generated outputs.

---

## 3. Current Live AWS State

Region: `us-east-1`

### CloudFormation

- Stack: `ytgrabber-green-serverless`
- Status: `UPDATE_COMPLETE`
- Last observed update: `2026-04-22T16:35:21.199Z`

Stack outputs:

- API Lambda: `ytgrabber-green-api`
- Static site bucket: `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh`
- HTTP API endpoint: `https://1ru54qm40m.execute-api.us-east-1.amazonaws.com`
- CloudFront distribution id: `EDTEON6GFBEZH`
- CloudFront domain: `d2bcwj2idfdwb4.cloudfront.net`

### CloudFront

- Distribution: `EDTEON6GFBEZH`
- Status: `Deployed`
- Aliases:
  - `videomaking.in`
  - `www.videomaking.in`
- Origins:
  - API Gateway: `1ru54qm40m.execute-api.us-east-1.amazonaws.com`
  - Static S3: `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh.s3.us-east-1.amazonaws.com`

Current health checks:

- `https://videomaking.in/api/healthz` returns `{"status":"ok"}`.
- `https://www.videomaking.in/api/healthz` returns `{"status":"ok"}`.

### API Gateway

- API name: `ytgrabber-green-http-api`
- API id: `1ru54qm40m`
- Endpoint: `https://1ru54qm40m.execute-api.us-east-1.amazonaws.com`
- Protocol: HTTP API

### Lambda

- Function: `ytgrabber-green-api`
- Package type: Image
- Image URI currently deployed: `596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:20260422-202131`
- Timeout: `29s`
- Memory: `1536 MB`

Important env var names present on Lambda:

- `SESSION_SECRET`
- `WEBSITE_AUTH_USER`
- `WEBSITE_AUTH_PASSWORD`
- `GEMINI_API_KEY` through `GEMINI_API_KEY_6`
- `ASSEMBLYAI_API_KEY`
- `YOUTUBE_QUEUE_PRIMARY_ENABLED`
- `YOUTUBE_QUEUE_PRIMARY_JOB_TYPES`
- `YOUTUBE_QUEUE_JOB_TABLE`
- `YOUTUBE_BATCH_JOB_QUEUE`
- `YOUTUBE_BATCH_JOB_DEFINITION`
- `S3_BUCKET`
- `S3_OBJECT_PREFIX`
- `RATE_LIMIT_BYPASS_IPS`
- `YTDLP_*`

Current intended Lambda cookie setup:

- `YTDLP_COOKIES_BASE64` should be blank in Lambda.
- Cookies should live on the Batch job definition, not be sent as per-job container overrides.

### DynamoDB

- Table: `ytgrabber-green-jobs`
- Purpose: Durable job status/result records for queue jobs so refresh/reopen can recover state.

### AWS Batch

- Compute environment: `ytgrabber-green-compute-fargate`
- State/status: `ENABLED` / `VALID`
- Type: `FARGATE`
- Max vCPUs: `6`
- This means up to about 3 workers at 2 vCPU each can run concurrently.
- Job queue: `ytgrabber-green-job-queue`
- Queue state/status: `ENABLED` / `VALID`
- Current job definition: `ytgrabber-green-worker-job:16`
- Worker image: `596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-worker:latest`
- Worker resources: `2 vCPU`, `4096 MB`
- Job definition env names:
  - `S3_BUCKET`
  - `AWS_REGION`
  - `S3_REGION`
  - `JOB_TABLE`
  - `S3_OBJECT_PREFIX`
  - `YTDLP_COOKIES_BASE64`
  - `QUEUE_URL`

### ECR

- API Lambda repo: `ytgrabber-green-api-lambda`
- Worker repo: `ytgrabber-green-worker`

Last known worker push:

- Digest: `sha256:c37b5586a5a9bc7edceb56241fb19810a827c0dd38e65af8a909496ac314c51f`

### S3

Buckets observed:

- `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh`
  - Static frontend hosting origin for CloudFront.
- `malikaeditorr`
  - Existing app output/upload bucket.

### CloudWatch Logs

Observed log groups:

- `/aws/lambda/ytgrabber-green-api`
- `/aws/batch/job/ytgrabber-green-worker`
- `/aws/batch/job`

### EC2

Latest query for non-terminated EC2 instances returned empty. This means the old always-on EC2 path appears stopped/removed from runtime. Re-check before deleting anything.

---

## 4. DNS State

Hostinger DNS was changed by the user.

Known intended records:

- `www` CNAME -> `d2bcwj2idfdwb4.cloudfront.net`
- `@` ALIAS -> `d2bcwj2idfdwb4.cloudfront.net`
- Old `A @ -> 3.238.114.190` was deleted by user.

The user prefers `videomaking.in` apex as the normal public URL.

Do not ask the user to add apex redirect unless testing proves apex does not work. CloudFront currently has both apex and `www` aliases.

---

## 5. Secret Handling

Never commit or paste raw values for:

- AWS access key/secret.
- Gemini keys.
- AssemblyAI key.
- Session secret.
- VAPID keys.
- Website auth password.
- YouTube cookie base64.
- YouTube cookies JSON.

Known secret variables used by app:

- `SESSION_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_API_KEY_2`
- `GEMINI_API_KEY_3`
- `GEMINI_API_KEY_4`
- `GEMINI_API_KEY_5`
- `GEMINI_API_KEY_6`
- `ASSEMBLYAI_API_KEY`
- `WEBSITE_AUTH_USER`
- `WEBSITE_AUTH_PASSWORD`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `YTDLP_COOKIES_BASE64`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_DEFAULT_REGION`

Website login credentials are known in the conversation, but do not write them here. If needed, use the existing local env files or ask the user in the active thread.

YouTube cookie files the user most recently supplied:

- `C:\Users\g_n-n\Downloads\www.youtube.com_cookies (2).json`
- `C:\Users\g_n-n\Downloads\cookies (1).json`

Earlier cookie file paths also exist in chat, but prefer the newest files above.

---

## 6. Critical Current Blocker

Live user-facing issue:

- Clip Cut and likely other YouTube worker jobs can fail with YouTube bot/cookie errors if the worker job definition does not receive valid cookies.
- A recent live test failed with AWS Batch error:
  - `Container Overrides length must be at most 8192`

Root cause:

- The API code path in `artifacts/api-server/src/lib/youtube-queue.ts` was forwarding large env vars, including `YTDLP_COOKIES_BASE64`, as per-job `containerOverrides.environment`.
- AWS Batch caps container override size at 8192 bytes.
- Correct design: keep large cookies in the Batch job definition env, and do not send them in per-job overrides.

Additional immediate local problem:

- `artifacts/api-server/src/lib/youtube-queue.ts` is zero bytes due to a failed patch/write.
- Restore this file before building API.

Recovery command idea:

```powershell
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('artifacts/api-server/dist/lambda.mjs.map','utf8')); const i=m.sources.findIndex(s=>s.includes('src/lib/youtube-queue.ts')); if(i<0) throw new Error('source not found'); fs.writeFileSync('artifacts/api-server/src/lib/youtube-queue.ts', m.sourcesContent[i]); console.log(m.sources[i], m.sourcesContent[i].length);"
```

After restore:

- Remove any `FORWARDED_WORKER_ENV_KEYS` logic.
- Remove any spread of forwarded env values into AWS Batch `containerOverrides.environment`.
- Keep only small per-job values in overrides, such as `JOB_ID` and `JOB_TYPE`.
- Rebuild API.
- Push new API Lambda image.
- Redeploy serverless stack with the new image.
- Retest Clip Cut.

---

## 7. Important Commands

Use these from repo root:

```powershell
cd "C:\Users\g_n-n\Desktop\apps\international-3 clone\International-3"
```

Check git state:

```powershell
git status --short
```

Check health:

```powershell
curl.exe -s -i https://videomaking.in/api/healthz
curl.exe -s -i https://www.videomaking.in/api/healthz
```

Check CloudFront:

```powershell
aws cloudfront get-distribution --id EDTEON6GFBEZH --query "Distribution.{Status:Status,DomainName:DomainName,Aliases:DistributionConfig.Aliases.Items}" --output json
```

Check Lambda:

```powershell
aws lambda get-function --region us-east-1 --function-name ytgrabber-green-api --output json
```

Check Batch:

```powershell
aws batch describe-compute-environments --region us-east-1 --compute-environments ytgrabber-green-compute-fargate --output json
aws batch describe-job-queues --region us-east-1 --job-queues ytgrabber-green-job-queue --output json
aws batch describe-job-definitions --region us-east-1 --job-definition-name ytgrabber-green-worker-job --status ACTIVE --output json
```

Build packages:

```powershell
pnpm --filter ./artifacts/api-server build
pnpm --filter ./artifacts/yt-downloader build
pnpm --filter ./artifacts/queue-worker build
```

If Docker Desktop is unstable:

```powershell
$desktop = "$Env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
Stop-Process -Name "Docker Desktop" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath $desktop
Start-Sleep -Seconds 25
docker context use desktop-linux
docker info --format "{{.ServerVersion}}"
```

Push API Lambda image:

```powershell
./deploy/aws-serverless/push-api-lambda-image.ps1 -Region us-east-1 -Prefix ytgrabber-green -ImageTag 20260422-fix-queue-env
```

Deploy stack with existing image URI:

```powershell
./deploy/aws-serverless/deploy-serverless.ps1 `
  -Region us-east-1 `
  -Prefix ytgrabber-green `
  -EnvFilePath ./deploy/ec2/.env.green.deploytmp `
  -SiteDomainName videomaking.in `
  -CloudFrontCertificateArn arn:aws:acm:us-east-1:596596146505:certificate/62ff8b55-8a4b-4634-97e8-75924181c9f5 `
  -SkipImageBuild `
  -ImageUri 596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:20260422-fix-queue-env
```

Push worker image:

```powershell
./deploy/aws-queue/push-worker-image.ps1 -Region us-east-1 -Prefix ytgrabber-green -ImageTag latest
```

Register Batch job definition from env file:

```powershell
./deploy/aws-queue/create-phase-a-batch.ps1 -Region us-east-1 -Prefix ytgrabber-green -EnvFile ./deploy/ec2/.env.green.deploytmp
```

---

## 8. Live Test Flow

Use a temp cookie jar and a JSON body file to avoid PowerShell quote mistakes.

Login:

```powershell
$jar = Join-Path $env:TEMP "vm_cookiejar.txt"
Remove-Item $jar -Force -ErrorAction SilentlyContinue
$login = Join-Path $env:TEMP "vm-login.json"
# Write the real username/password JSON from env/known credentials, do not commit it.
curl.exe -s -c $jar -b $jar -H "content-type: application/json" --data-binary "@$login" https://videomaking.in/api/auth/login
```

Submit Clip Cut:

```powershell
$body = Join-Path $env:TEMP "vm-clipcut.json"
'{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","startTime":0,"endTime":20,"quality":"360p"}' | Set-Content -Path $body -NoNewline
curl.exe -s -b $jar -H "content-type: application/json" --data-binary "@$body" https://videomaking.in/api/youtube/clip-cut
```

Poll progress:

```powershell
for($i=1; $i -le 40; $i++){
  curl.exe -s -b $jar "https://videomaking.in/api/youtube/progress/<JOB_ID>"
  Start-Sleep -Seconds 8
}
```

Expected:

- `queued` briefly.
- `running` / progress messages.
- `done` with final download URL/result.
- No `Container Overrides length` error.
- No SPA `index.html` response from API status routes.

If job fails:

```powershell
aws batch describe-jobs --region us-east-1 --jobs <BATCH_JOB_ID> --output json
aws logs tail /aws/batch/job/ytgrabber-green-worker --region us-east-1 --since 30m
aws logs tail /aws/lambda/ytgrabber-green-api --region us-east-1 --since 30m
```

---

## 9. Known Code Areas

API server:

- `artifacts/api-server/src/app.ts`
- `artifacts/api-server/src/lambda.ts`
- `artifacts/api-server/src/routes/youtube.ts`
- `artifacts/api-server/src/routes/subtitles.ts`
- `artifacts/api-server/src/lib/youtube-queue.ts`
- `artifacts/api-server/src/lib/s3-storage.ts`
- `artifacts/api-server/src/lib/push-notifications.ts`

Frontend:

- `artifacts/yt-downloader/src/App.tsx`
- `artifacts/yt-downloader/src/pages/Home.tsx`
- `artifacts/yt-downloader/src/components/ClipCutter.tsx`
- `artifacts/yt-downloader/src/components/BestClips.tsx`
- `artifacts/yt-downloader/src/components/GetSubtitles.tsx`
- `artifacts/yt-downloader/src/components/FloatingActivityPanel.tsx`
- `artifacts/yt-downloader/src/components/GlobalHistoryPanel.tsx`
- `artifacts/yt-downloader/src/hooks/use-activity-feed.ts`
- `artifacts/yt-downloader/src/index.css`

Worker:

- `artifacts/queue-worker/src/index.ts`
- `artifacts/queue-worker/Dockerfile`

Deployment:

- `deploy/aws-serverless/template.yml`
- `deploy/aws-serverless/deploy-serverless.ps1`
- `deploy/aws-serverless/push-api-lambda-image.ps1`
- `deploy/aws-serverless/YTDLP_COOKIES_RUNBOOK.md`
- `deploy/aws-queue/create-phase-a-batch.ps1`
- `deploy/aws-queue/push-worker-image.ps1`
- `deploy/ec2/.env.green.deploytmp`

---

## 10. Previously Fixed / Important Behavioral Changes

Already implemented in the dirty working tree:

- Serverless API wrapper added.
- CloudFront custom aliases/cert added for apex and `www`.
- CloudFront SPA rewrite fixed so `/api/*` 404s are JSON instead of `index.html`.
- Queue-worker infra added.
- `download`, `clip-cut`, `best-clips`, and `subtitles` moved toward worker-primary.
- S3-first subtitle uploads added.
- YouTube cookies normalized from JSON browser export or Netscape format.
- Best Clips SSE fallback polling added.
- Mobile UI/login/help changes were worked on but still need visual verification.
- Rate-limit bypass IPs were added/changed multiple times.
- Push notification code exists but needs final browser/mobile validation.

Do not assume all above is deployed until the build/image tag confirms it.

---

## 11. Remaining Work, In Order

1. Restore `artifacts/api-server/src/lib/youtube-queue.ts` from sourcemap or another backup.
2. Fix Batch submission so large cookies are not sent in `containerOverrides`.
3. Rebuild API and push new Lambda image.
4. Redeploy serverless stack with the new API image.
5. Run live Clip Cut test on `videomaking.in`.
6. If YouTube still says bot/cookies, re-register Batch job def with newest cookie file as job definition env.
7. Add/fix Lambda IAM `s3:ListBucket` on `malikaeditorr` if cleanup/status logs still show AccessDenied.
8. Run live smoke tests for:
   - Clip Cut
   - Best Clips
   - Subtitles URL mode
   - Subtitles upload mode
   - Download tab availability for bypass IPs
   - Login mobile layout
   - Help modal mobile layout
   - Activity/history after refresh
   - Browser notification flow
9. Only after smoke passes, update `MASTER_EXECUTION_BOOK.md`.
10. Clean up old unused AWS resources after confirming no active traffic or needed data.

---

## 12. Do Not Delete Yet

Do not delete these until smoke tests pass and the user confirms:

- `malikaeditorr` S3 bucket.
- Static site bucket.
- DynamoDB jobs table.
- ECR repos.
- CloudFront distribution.
- API Gateway.
- Lambda function.
- Batch compute environment/job queue/job definitions.
- ACM cert.

Potential cleanup candidates after verification:

- Old stopped EC2 remnants, if any.
- Old EBS volumes/snapshots attached to previous EC2 path, if any.
- Old Elastic IPs, if any.
- Unused old CloudWatch log groups if not needed.
- Old ECR image tags after keeping at least one known-good rollback tag.

---

## 13. Current Cost Shape

The intended current architecture is mostly usage-based:

- CloudFront/S3 static hosting: low fixed/usage cost.
- API Gateway/Lambda: usage-based.
- DynamoDB: low usage-based/on-demand.
- Batch Fargate: billed while worker jobs run.
- S3 output storage/transfer: depends on clip sizes and retention.
- CloudWatch logs: small unless logs grow.
- ECR storage: small.

The old 24/7 EC2 compute path should not be active for runtime if the latest AWS query remains empty for non-terminated instances. Verify again before giving a final monthly estimate.

For the user’s expected use case of roughly 3-15 clip jobs/day, most monthly cost should come from Batch Fargate job runtime and data transfer, not 24/7 compute.

---

## 14. Communication Guidance

The user wants direct status, not vague reassurance.

When updating:

- State what is broken.
- State the concrete next action.
- State whether production is safe or still failing.
- Do not say "fully fixed" until live tests pass.
- Do not expose secrets.

