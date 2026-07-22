# VideoMaking Studio — Deployment Runbook

For a complete new-account move, use [`AWS-MASTER-SETUP-AND-MIGRATION.md`](AWS-MASTER-SETUP-AND-MIGRATION.md) as the authoritative checklist.

## Architecture Summary

```
User → CloudFront (EDTEON6GFBEZH / videomaking.in)
         ├── /api/* → Lambda Function URL → Lambda (ytgrabber-green-api)
         └── /*     → S3 (ytgrabber-green-serverless-staticsitebucket-*)

Lambda → AWS Batch (ytgrabber-green-job-queue) → Fargate Worker
       → DynamoDB (ytgrabber-green-jobs) — job state tracking
       → S3 (malikaeditorr) — output files + cookies

Cookies: S3 object ytgrabber-green/secrets/ytdlp-cookies-base64.txt
```

---

## Current Production State (as of 2026-07-22)

| Resource              | Value                                                               |
|-----------------------|---------------------------------------------------------------------|
| Lambda image          | commit `84da200c`, digest `sha256:7d634b3d164fd30ad802edf93720a70fc1688e8b3359cf3a8c5808aa1966d31d` |
| Lambda config         | `3008 MB`, `900s`, last modified `2026-07-20T13:17:28Z`             |
| Worker image (ECR)    | `ytgrabber-green-worker:84da200c`                                   |
| Batch Job Definition  | `ytgrabber-green-worker-job:744`                                    |
| Batch compute         | `ytgrabber-green-compute-fargate`, max `16` vCPUs, scale-to-zero    |
| CloudFront            | `EDTEON6GFBEZH` / `d2bcwj2idfdwb4.cloudfront.net`                  |
| Lambda Function URL   | `https://3x4swcbqciemcdvfawhlsv7xiu0byxcs.lambda-url.us-east-1.on.aws/`, `InvokeMode=RESPONSE_STREAM`, `AuthType=NONE` |
| Region                | `us-east-1` / Account `596596146505`                                |
| Lambda quota          | Applied concurrency `1000`; quota request `1001` remains `CASE_OPENED` (`b45fb4bb5e2841748ab225a45d806248bg1HnYLc`) |

---

## How to Deploy (Full Stack)

```powershell
# 1. Build API Lambda image
$tag = "$(Get-Date -Format 'yyyyMMdd-HHmmss')"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 596596146505.dkr.ecr.us-east-1.amazonaws.com
pnpm --filter @workspace/api-server run build
docker build --platform linux/amd64 -f Dockerfile.api-lambda -t "596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:$tag" .
docker push "596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:$tag"

# 2. Deploy CloudFormation + frontend
.\deploy\aws-serverless\deploy-serverless.ps1 `
  -Region us-east-1 `
  -Prefix ytgrabber-green `
  -SkipImageBuild `
  -ImageUri "596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:$tag" `
  -EnvFilePath .\deploy\ec2\.env.green
```

## How to Update Worker Only

```powershell
# Option A: Retag existing live image (fast — no rebuild)
$digest = $(aws ecr describe-images --region us-east-1 --repository-name ytgrabber-green-worker `
  --output json | ConvertFrom-Json | Select-Object -ExpandProperty imageDetails `
  | Sort-Object imagePushedAt -Descending | Select-Object -First 1).imageDigest
$newTag = "$(Get-Date -Format 'yyyyMMdd')-worker"
# get manifest + put-image with new tag (see YTDLP_COOKIES_RUNBOOK.md)

# Option B: Full worker rebuild
$tag = "$(Get-Date -Format 'yyyyMMdd-HHmmss')"
.\deploy\aws-queue\push-worker-image.ps1 -ImageTag $tag
# Then register new Batch job definition + update Lambda env:
# YOUTUBE_BATCH_JOB_DEFINITION=ytgrabber-green-worker-job:<new_revision>
```

## Cookies — Updating YouTube Cookies

> See `deploy/aws-serverless/YTDLP_COOKIES_RUNBOOK.md` for details.

```powershell
# Base64-encode your new cookies.txt and upload to S3:
$encoded = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes(".\cookies.txt"))
Set-Content .\tmp-cookies-b64.txt $encoded -NoNewline
aws s3 cp .\tmp-cookies-b64.txt s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt
```

## Smoke Testing (All 4 Flows)

```powershell
$base = "https://d2bcwj2idfdwb4.cloudfront.net"  # or https://videomaking.in
$authUser = $env:WEBSITE_AUTH_USER
$authPass = $env:WEBSITE_AUTH_PASSWORD
if (-not $authPass) { throw "Set WEBSITE_AUTH_PASSWORD in your shell before smoke test" }
if (-not $authUser) { $authUser = "kalki_avatar" }
$loginBody = @{ username = $authUser; password = $authPass } | ConvertTo-Json -Compress
curl.exe -s -c .\cookies.txt -H "content-type: application/json" `
  --data-binary $loginBody `
  "$base/api/auth/login"

# Submit a clip-cut job and poll progress
$r = curl.exe -s -b .\cookies.txt -H "content-type: application/json" `
  --data-binary '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","startTime":5,"endTime":10,"quality":"360p"}' `
  "$base/api/youtube/clip-cut" | ConvertFrom-Json
curl.exe -s -b .\cookies.txt "$base/api/youtube/progress/$($r.jobId)"
```

### Lambda-Fast Clip Smoke Test

The production clip fast path is a dedicated self-invoked Lambda worker for eligible clips. Live settings:

- `LAMBDA_CLIP_MAX_DURATION_SECONDS=420`
- `MAX_CONCURRENT_CLIP_JOBS=3`
- slow Lambda clips can hand off to Batch

On 2026-07-22, a direct Lambda worker test for a 5-second clip completed in 11.41s with DynamoDB status `done`, progress `100`, and no Batch handoff.

## CloudWatch Alarms (Active)

| Alarm                                | Triggers When                        |
|--------------------------------------|--------------------------------------|
| `ytgrabber-green-lambda-5xx`         | > 5 Lambda errors per 5-minute period for 2 periods |
| `ytgrabber-green-lambda-throttles`   | > 3 Lambda throttles per 5-minute period for 2 periods |
| `ytgrabber-green-batch-failures`     | > 3 Batch failures in 5 min          |

> SNS topic `ytgrabber-green-alerts` exists but has zero confirmed subscribers. Queue/DLQ alarms reference it; Lambda and Batch failure alarms have no actions. Add and confirm a subscriber, then attach the topic to every critical alarm.

## 2026-07-22 Auth / Capacity Notes

- Production had no deploy or CloudFormation config change on 2026-07-22 morning. Last deploy was commit `84da200c` on 2026-07-20 18:47-18:48 IST.
- Lambda hit the account concurrency cap at 2026-07-22 02:32 IST: max concurrency `10`, throttles `5`.
- The applied Lambda account concurrency quota is now `1000` as verified 2026-07-23. Service Quotas previously rejected a direct `100` request because it was below the normal default; request `b45fb4bb5e2841748ab225a45d806248bg1HnYLc` for `1001` remains `CASE_OPENED`.
- Cost Explorer for 2026-07-01 through 2026-07-22 showed about `$0.0079` positive usage before offsets/free-tier credits and effectively `$0.00` net unblended cost. Batch max vCPUs and Lambda concurrency are ceilings, not 24/7 reserved spend.
- Super Agent is currently enabled in backend config. The 2026-07-22 frontend fix prevents failed or incomplete `/api/auth/session` responses from becoming a false "Super Agent is restricted" card: it retries, refuses to open the workspace with unknown entitlements, and offers a session Retry screen. The restricted card is frontend feature gating, not a clip-cut worker status.
- The fixed frontend was deployed to production through S3/CloudFront; invalidation `IAUHXXAW2Y46OG0GIYVG9BFJXC` completed and live index/session checks returned HTTP `200`.

## ECR Lifecycle Policy

Both `ytgrabber-green-api-lambda` and `ytgrabber-green-worker` are configured to:
- Keep last **3** images (`tagStatus=any`)
- Delete untagged images after **1 day**

## Key Files

| File                                         | Purpose                                    |
|----------------------------------------------|--------------------------------------------|
| `deploy/aws-serverless/deploy-serverless.ps1`| Full stack deploy (CFN + frontend + Lambda)|
| `deploy/aws-serverless/template.yml`         | CloudFormation template                    |
| `deploy/ec2/.env.green`                      | Production env vars (gitignored, local)    |
| `deploy/aws-queue/push-worker-image.ps1`     | Build + push worker Docker image           |
| `Dockerfile.api-lambda`                      | Lambda container image                     |
| `artifacts/queue-worker/Dockerfile`          | Batch Fargate worker image                 |
