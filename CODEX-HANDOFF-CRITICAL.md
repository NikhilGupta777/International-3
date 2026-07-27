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
- Vertex Gemini path is disabled in current production
- Clip-cut Lambda fast path is `420` seconds, i.e. clips up to 7 minutes try Lambda first
- API image is `60d5c1cb` at digest `sha256:e18c4d1bf4b0...`
- Queued worker job definition is `ytgrabber-green-worker-job:747`
- Worker image is `60d5c1cb` at digest `sha256:eacc56fb01ad...`
- Lambda account concurrency quota applied value is now `1000` (verified 2026-07-23); Service Quotas request `b45fb4bb5e2841748ab225a45d806248bg1HnYLc` asks for `1001` and remains `CASE_OPENED`

## New Account Migration — Current State

- Target AWS account: `386318011485`; use CLI profile `new-account`.
- The local `new-account` profile default output is `json` (corrected 2026-07-27) and
  STS resolves account `386318011485`.
- Never write to source account `596596146505` during migration work.
- Target CloudFront: `E36OKTEHMEZQ4N` / `https://dq163fbjr1do7.cloudfront.net`.
- Target output bucket: `videomaking-backup-386318011485`.
- Target Lambda runs the exact production API digest and has 74 transformed production
  environment entries.
- Target Batch job definition: `ytgrabber-green-worker-job:3`, cloned from source
  revision `747` and tested successfully.
- Translation/lip sync/Vertex are intentionally disabled; no GPU infrastructure exists
  in target.
- Frontend, access records, job history, and filtered S3 data were migrated and verified
  on 2026-07-26. Final snapshot: access 29, jobs 3165, cooldowns 0; S3 863 approved
  objects / 3,099,827,444 bytes; 187 media objects older than 120 hours excluded.
- Target DynamoDB tables have PITR and deletion protection. Target output S3 has
  versioning; `migration-backup/` contains rollback objects.
- Target CloudFront login/session/Super Agent passed; a 5-second Lambda clip finished in
  14.58 seconds without Batch; a revision-3 Fargate job succeeded.
- Target-only CLI acceptance on 2026-07-27 additionally passed real Download, a fresh
  Lambda Clip Cut, Timestamps, Batch Subtitles, Batch Bhagwat analysis, Find Video,
  Super Agent, and AI Studio chat. Exact test S3/DynamoDB artifacts were cleaned; the
  two new Batch jobs both exited 0. CloudWatch showed zero Lambda errors/throttles and
  no active alarm during the test window.
- Confirmed target gap: deployed New Tab Studio API returns 404. Best Clips executed
  successfully with a transcript but selected zero clips for the music-video test
  source, so quality needs a spoken-content test.
- Content Manager's Gemini 429 blocker was fixed and deployed target-only on 2026-07-27.
  It now uses the Super Agent external fallback ladder and key rotation before all
  configured Gemini keys, keeps buffered attempts alive over SSE, validates complete
  structured packs, and omits invalid empty tool configuration. Final live image digest:
  `sha256:e3b8a1694c614ec27ca8b24e2e6e0ae44788a7ba708408a37265c6e23b856695`.
  A strict live request returned all required pack fields with zero error events.
- Google OAuth flags, client ID, admin seed, and the 39-user/1-admin DynamoDB allowlist
  have exact source/target parity. AWS profiles cannot supply the short-lived Google ID
  token; full admin/developer acceptance needs the approved admin to complete browser
  sign-in. Per owner instruction, do not test HeyGen, Pita Ji, Workspace/Drive, or
  Translator in the next acceptance pass unless explicitly re-authorized.
- Target CloudFormation drift for `ApiFunction` and `ApiRole` was reconciled on
  2026-07-26. The stack is `UPDATE_COMPLETE`; drift detection is `IN_SYNC` with zero
  drifted resources. The live image, 74-value environment hash, IAM policy hash,
  Function URL, CloudFront headers, login, and Super Agent behavior were unchanged.
- Do not run a repository-driven full deployment yet. The live target stack is safe,
  but the repository template and ownership of manual cooldown/async/security-policy
  resources still need a separate reviewed change.
- Before DNS cutover: add and confirm a valid SNS email subscription, publish the two ACM
  validation CNAMEs in the external DNS provider, wait for certificate issuance, attach
  it to target CloudFront, pause source writes, rerun incremental S3/DynamoDB sync, and
  finish remaining feature tests. GitHub/OIDC remains owner-deferred.
- Target cost was effectively USD 0.00 net in Cost Explorer through July 26 at query
  time, but billing can lag and storage/PITR/actual compute usage can incur cost.
- On 2026-07-27 a target-only CloudFormation update fixed `Login origin rejected` on the
  CloudFront domain by setting `PUBLIC_SITE_URL=https://dq163fbjr1do7.cloudfront.net`.
  Password login/session now return HTTP 200; Function URL and CloudFront hostname did
  not change. Stack drift is `IN_SYNC` with zero drifted resources.
- The same pass copied the 16 newly missing source job records and 15 eligible S3 objects
  (1,322,622,067 bytes). Final comparison found zero source job IDs missing, zero eligible
  S3 keys missing, and zero size mismatches; 184 media objects older than 120 hours remain
  intentionally excluded.
- A subsequent full configuration comparison found functional parity across the normal
  non-GPU runtime and exact static-site parity (75 objects). The target-only active
  wildcard `Untitled key` was revoked. Target budget notification parity is restored;
  the attempted SNS email subscription became `Deleted` and is not deliverable. A target ACM certificate for apex
  and `www` was requested and awaits two CNAMEs at the external DNS provider. Non-media
  S3 parity is 819/819 with zero missing keys or size mismatches.

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
- `YoutubeBatchJobDefinition=ytgrabber-green-worker-job:747`
- `GoogleAuthEnabled=true`
- `GoogleGenaiUseVertexai=false`
- `SiteDomainName=videomaking.in`
- CloudFront certificate ARN present
