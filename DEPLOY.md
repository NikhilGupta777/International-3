# VideoMaking Studio — Deployment Runbook

## Architecture Summary

```
User → CloudFront (EDTEON6GFBEZH / videomaking.in)
         ├── /api/* → API Gateway → Lambda (ytgrabber-green-api)
         └── /*     → S3 (ytgrabber-green-serverless-staticsitebucket-*)

Lambda → AWS Batch (ytgrabber-green-job-queue) → Fargate Worker
       → DynamoDB (ytgrabber-green-jobs) — job state tracking
       → S3 (malikaeditorr) — output files + cookies

Cookies: S3 object ytgrabber-green/secrets/ytdlp-cookies-base64.txt
```

---

## Current Production State (as of 2026-04-23)

| Resource              | Value                                                               |
|-----------------------|---------------------------------------------------------------------|
| Lambda image          | `ytgrabber-green-api-lambda:20260423-converge`                      |
| Worker image (ECR)    | `ytgrabber-green-worker:20260423-converge`                          |
| Batch Job Definition  | `ytgrabber-green-worker-job:20`                                     |
| CloudFront            | `EDTEON6GFBEZH` / `d2bcwj2idfdwb4.cloudfront.net`                  |
| API Gateway           | `1ru54qm40m.execute-api.us-east-1.amazonaws.com`                   |
| Region                | `us-east-1` / Account `596596146505`                                |

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

## CloudWatch Alarms (Active)

| Alarm                                | Triggers When                        |
|--------------------------------------|--------------------------------------|
| `ytgrabber-green-lambda-5xx`         | > 5 Lambda errors in 5 min           |
| `ytgrabber-green-lambda-throttles`   | > 3 Lambda throttles in 10 min       |
| `ytgrabber-green-batch-failures`     | > 3 Batch failures in 5 min          |

> No SNS topic is configured yet — alarms fire but no email notification. Add `--alarm-actions arn:aws:sns:...` when ready.

## ECR Lifecycle Policy

Both `ytgrabber-green-api-lambda` and `ytgrabber-green-worker` are configured to:
- Keep last **5** tagged images
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
