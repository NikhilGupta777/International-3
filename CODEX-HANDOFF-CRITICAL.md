# Codex Critical Handoff

Read this before touching deploy, AWS, or production config.

## Current Production

- AWS account: `596596146505`
- Region: `us-east-1`
- Stack: `ytgrabber-green-serverless`
- Domain: `https://videomaking.in`
- CloudFront distribution: `EDTEON6GFBEZH`
- CloudFront aliases:
  - `videomaking.in`
  - `www.videomaking.in`
- API Lambda: `ytgrabber-green-api`
- Main job table: `ytgrabber-green-jobs`
- Access/API-key table: `ytgrabber-green-access`
- Output bucket: `malikaeditorr`
- Critical S3 prefix: `s3://malikaeditorr/ytgrabber-green/`

Last verified good:

- Site `/` returns `200`
- `/api/healthz` returns `200`
- `/api/auth/config` has Google auth enabled
- Vertex Gemini path is enabled
- Clip-cut Lambda fast path is `420` seconds, i.e. clips up to 7 minutes try Lambda first
- Queued worker job definition is `ytgrabber-green-worker-job:744`
- Lambda account concurrency quota applied value is now `1000` (verified 2026-07-23); Service Quotas request `b45fb4bb5e2841748ab225a45d806248bg1HnYLc` asks for `1001` and remains `CASE_OPENED`

## Critical Backup

Clean critical-only backup:

`D:\awscritical-backup\ytgrabber-green-20260619-003503`

`D:\awscritical-backup\LATEST.txt` points to it.

It includes:

- CloudFormation template/config/resources
- Lambda config
- Batch queues, compute environments, job definitions
- CloudFront config
- DynamoDB descriptions and small scans
- ECR metadata only
- IAM roles/policies
- CloudWatch log group list
- Critical S3 secrets prefix

It intentionally excludes:

- user videos
- generated clips/subtitles/media
- audio/music
- images/thumbnails
- user workspace/download files
- full S3 copies
- ECR image layers
- translator model/image bulk

Do not commit or share this backup. It contains sensitive config/secrets.

## What Broke Production

The site was broken by manual deploys that used incomplete/stale local env files.

GitHub Actions normally builds a merged deploy env. Because Actions minutes were exhausted, manual deploy bypassed that. `deploy-serverless.ps1` sent all CloudFormation params, so blank/stale local values overwrote live values.

Things that got reset during the bad manual deploy:

- CloudFront custom domain/cert
- Google auth/client id
- Vertex config
- Gemini fallback values
- clip-cut Lambda fast-path limit
- some API/developer env values

Fix committed:

`f6382e0 fix(deploy): preserve existing stack params for blank env values`

This makes `deploy/aws-serverless/deploy-serverless.ps1` preserve existing CloudFormation params when a local optional override is blank.

## Safe Deploy Rules

Never run a blind full deploy with stale env.

Do not use this directly unless fully verified:

```powershell
.\deploy\aws-serverless\deploy-serverless.ps1 -EnvFilePath .\deploy\ec2\.env.green
```

For config-only changes, do a targeted CloudFormation update:

- use `--use-previous-template`
- set only the parameter being changed
- set `UsePreviousValue=true` for every other parameter

For frontend-only changes:

```powershell
pnpm --filter @workspace/yt-downloader run build
aws s3 sync artifacts\yt-downloader\dist\public s3://<site-bucket>/ --region us-east-1 --delete
aws cloudfront create-invalidation --distribution-id EDTEON6GFBEZH --paths "/*"
```

For API code changes:

1. Verify current live stack params first.
2. Use root `.env` only if it has been checked against live production.
3. Always pass domain and cert explicitly:

```powershell
.\deploy\aws-serverless\deploy-serverless.ps1 `
  -Region us-east-1 `
  -Prefix ytgrabber-green `
  -EnvFilePath .\.env `
  -ImageTag "manual-$(Get-Date -Format yyyyMMdd-HHmmss)" `
  -SiteDomainName videomaking.in `
  -CloudFrontCertificateArn arn:aws:acm:us-east-1:596596146505:certificate/62ff8b55-8a4b-4634-97e8-75924181c9f5
```

Do not commit:

- `.env`
- cookies
- Vertex credentials
- S3 secrets
- backup folders
- local generated media

## Known Remaining Issues

Not critical to current site uptime, but still left:

- Super Agent UI bugs:
  - mobile top black strip
  - markdown/canvas rendering issues
  - red cursor/line while tools run
  - black overlay when switching to agent or starting a message
  - Root cause fixed 2026-07-22: the frontend no longer opens Home from a stale login hint when `/api/auth/session` fails or omits feature entitlements. It retries per attempt and shows a session Retry screen; live backend currently allows Super Agent.
- DynamoDB continuous backups are enabled, but PITR is disabled for:
  - `ytgrabber-green-jobs`
  - `ytgrabber-green-access`
- Lambda CloudWatch log retention is unset.
- Translator is intentionally skipped for now.

## Quick Health Checks

```powershell
aws sts get-caller-identity
aws cloudformation describe-stacks --region us-east-1 --stack-name ytgrabber-green-serverless
aws lambda get-function-configuration --region us-east-1 --function-name ytgrabber-green-api
Invoke-WebRequest https://videomaking.in/api/healthz -UseBasicParsing
Invoke-WebRequest https://videomaking.in/api/auth/config -UseBasicParsing
```

Expected important values:

- `LambdaClipMaxDurationSeconds=420`
- `YoutubeBatchJobDefinition=ytgrabber-green-worker-job:744`
- `GoogleAuthEnabled=true`
- `GoogleGenaiUseVertexai=true`
- `SiteDomainName=videomaking.in`
- CloudFront certificate ARN present
