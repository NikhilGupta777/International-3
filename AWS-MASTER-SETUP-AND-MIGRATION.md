# AWS New-Account Migration Master Runbook

**Authoritative source for migrating VideoMaking Studio to a new AWS account.**

Last audited: **2026-07-23 IST** from the repository and live AWS account
`596596146505` in `us-east-1`. Secret values are intentionally not recorded.

This document supersedes older AWS architecture and migration notes wherever they
disagree. The production CloudFormation stack was drift-checked during this audit and
reported `IN_SYNC` with zero drifted resources.

> Scope decision: GPU translation infrastructure is deliberately excluded. Do not
> recreate GPU compute environments, queues, AMIs, images, quotas, or job definitions in
> the new account. Keep GPU-only/lip-sync paths disabled. The core site, Lambda clip
> cutting, normal Fargate worker, CPU/non-GPU features, Super Agent, storage, auth, and
> external integrations remain in scope.

---

## 1. Migration success criteria

The migration is complete only when all of the following are true:

- `videomaking.in` and `www.videomaking.in` serve the new CloudFront distribution.
- Login, Google login, account allowlists, admin access, and Super Agent permissions work.
- Short eligible clips run through the Lambda fast path; long/slow jobs hand off to the
  normal AWS Batch Fargate worker.
- Downloads, uploads, workspace files, presets, thumbnails, subtitles, Pita Ji data,
  Bhagwat data, agent assets, and signed URLs use the new output bucket.
- Existing required DynamoDB records and S3 data are present in the new account.
- API, worker, and optional CPU translator container images exist in new-account ECR.
- GitHub Actions assumes a new-account IAM role with OIDC; no long-lived AWS key is used.
- Alarms have a confirmed notification subscriber.
- The old account remains available for rollback until the acceptance checklist passes.

---

## 2. Current production architecture

```text
Browser
  -> videomaking.in / www.videomaking.in
  -> CloudFront EDTEON6GFBEZH
       -> default: private S3 static-site bucket through OAC
       -> /api*: public Lambda Function URL in RESPONSE_STREAM mode
            -> Lambda ytgrabber-green-api
                 -> DynamoDB jobs/access/cooldowns
                 -> S3 output bucket malikaeditorr
                 -> self-invocation for short asynchronous work
                 -> AWS Batch Fargate for normal queued work
                      -> ECR worker image
                      -> SQS queue + DLQ

External services used by features:
  Google OAuth, Gemini, NVIDIA NIM, Ollama Cloud, Groq, AssemblyAI,
  E2B, HeyGen, NotebookLM, Web Push/VAPID, and Supabase Katha services.
```

The active CloudFront API origin is the Lambda Function URL. A legacy HTTP API, ALB,
and zero-desired-count ECS service also exist, but CloudFront does not point to them.
They are not required for the new account and should not be migrated unless a separate
rollback design explicitly chooses them.

---

## 3. Current-account inventory and new-account decision

### 3.1 CloudFormation-managed web/API plane

Stack: `ytgrabber-green-serverless`, status `UPDATE_COMPLETE`.

| Resource | Current value | New-account action |
|---|---|---|
| Lambda | `ytgrabber-green-api`, image, x86_64, 3008 MB, 900 s | Recreate through stack |
| Lambda ephemeral storage | 5120 MB | Preserve |
| Lambda Function URL | `AuthType=NONE`, `InvokeMode=RESPONSE_STREAM` | Recreate; URL changes |
| Async invoke config | max retries `0`, max event age `3600` s | Preserve through stack |
| Lambda role | `ytgrabber-green-api-role` | Recreate with new ARNs |
| Static S3 bucket | `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh` | Recreate through stack |
| Static bucket policy | CloudFront OAC-only | Recreate through stack |
| CloudFront | `EDTEON6GFBEZH` / `d2bcwj2idfdwb4.cloudfront.net` | Recreate; ID/domain change |
| CloudFront OAC | `E2PRJUW53MLP2P` | Recreate through stack |
| SPA rewrite function | `ytgrabber-green-spa-rewrite`, LIVE | Recreate through stack |
| Security headers policy | `c375bc42-b2e6-4443-9464-a5cdad24e2d0` | Recreate through stack |
| Cooldown table | `ytgrabber-green-cooldowns` | Recreate through stack |
| URL permissions | public Function URL invoke permissions | Recreate through stack |

CloudFront details to preserve:

- Aliases: `videomaking.in`, `www.videomaking.in`.
- `/api*`: all normal API methods, HTTPS redirect, Lambda Function URL origin.
- Default behavior: static S3 origin through OAC.
- HTTP/2 and HTTP/3, `PriceClass_All`.
- TLS policy `TLSv1.2_2021`.
- CloudFront access logging is currently disabled and no WAF is attached.

### 3.2 Normal non-GPU job plane

| Resource | Current configuration | New-account action |
|---|---|---|
| SQS | `ytgrabber-green-jobs` | Recreate |
| DLQ | `ytgrabber-green-jobs-dlq` | Recreate |
| Main queue settings | 900 s visibility, 4-day retention, redrive after 3 receives, SQS-managed SSE | Preserve |
| Worker ECR | `ytgrabber-green-worker` | Rebuild or copy current image |
| Fargate compute | `ytgrabber-green-compute-fargate`, enabled/valid, max 16 vCPU, scale-to-zero | Recreate |
| Job queue | `ytgrabber-green-job-queue`, priority 10 | Recreate |
| Worker definition | `ytgrabber-green-worker-job:744`, 2 vCPU, 4096 MB, 2700 s | Register a new revision |
| Worker image | tag `84da200c`, digest begins `sha256:a629c607...` | Copy/rebuild by immutable tag |
| Worker IAM | task role + execution role + Batch service role | Recreate with scoped policies |
| Network | default VPC public subnet/security group; task public IP enabled | Recreate with explicit IDs |

The compute environment scales to zero. Its `maxvCpus=16` is a ceiling, not a 24/7
reservation.

### 3.3 DynamoDB

| Table | Schema and live state | Migration action |
|---|---|---|
| `ytgrabber-green-jobs` | PK `jobId` (S); GSI `status-createdAt-index`; on-demand; 3,090 items / ~2.8 MB; TTL disabled; PITR disabled | Copy if history/workspace metadata must survive; otherwise start empty only by explicit decision |
| `ytgrabber-green-access` | PK `pk` + SK `sk`; on-demand; 29 items; TTL `expiresAt`; PITR disabled | **Must copy** for users, admins, API keys/webhooks, and access state |
| `ytgrabber-green-cooldowns` | PK `pk`; on-demand; TTL `expiresAt`; currently empty | Recreate empty through CloudFormation |
| `ytgrabber-uploads` | PK `fileId`; empty and not selected by live Lambda | Do not migrate unless separately re-enabled |

None of the app tables currently has deletion protection or point-in-time recovery.
The jobs table does **not** auto-expire today. Do not assume its data is disposable.

Important provisioning gap: no current phase-A script creates
`ytgrabber-green-access`. The migration must create it explicitly before deploying the
API, or auth/API-key persistence will be incomplete.

### 3.4 S3

#### Output/data bucket: `malikaeditorr`

- `us-east-1`, about 1,020 objects / 3.48 GB at audit time.
- SSE-S3/AES256, bucket-owner-enforced object ownership.
- Versioning is disabled; replication and notifications are absent.
- Public-access-block flags are all false, although there is no public bucket policy.
- CORS currently allows all origins and GET/PUT/POST/DELETE/HEAD.
- Lifecycle rules:
  - `share/`: expire after 7 days.
  - `ytgrabber-green/youtube/clips/`: expire after 7 days.
  - `ytgrabber-green/youtube/downloads/`: expire after 1 day.

Runtime prefixes that must be considered:

| Prefix | Audit size | Decision |
|---|---:|---|
| `ytgrabber-green/` | 611 objects / ~2.42 GB | Copy; includes jobs, assets, presets, subtitles, Pita Ji, Bhagwat, secrets |
| `workspace/` | 345 objects / ~987 MB | Copy; Super Agent/workspace files |
| `heygen-posters/` | 60 objects / ~1.83 MB | Copy if HeyGen history/cache is needed |
| `translator/` | 1 object / ~45 KB | Copy only for retained non-GPU history |
| `deploy-bundles/` | 1 object / ~71 MB | Deployment artifact; not runtime-required |
| `codex-amplify-deploy/` | 2 objects / ~1.1 MB | Historical deployment artifact; not runtime-required |

Known secret objects:

- Present: `ytgrabber-green/secrets/ytdlp-cookies-base64.txt`.
- Present: `ytgrabber-green/secrets/notebooklm/storage_state.json`.
- Absent: `ytgrabber-green/secrets/vertex/service-account.json`; current Lambda has
  `GOOGLE_GENAI_USE_VERTEXAI=false`, so do not document this object as a current dependency.

#### Static frontend bucket

- About 75 objects / 6.9 MB.
- Versioning enabled; noncurrent versions expire after 7 days.
- All public-access-block flags enabled; CloudFront reads through OAC.
- Do not manually copy it. The new stack creates it and the deploy uploads a fresh build.

### 3.5 ECR images in scope

| Repository | Current production tag | Lifecycle |
|---|---|---|
| `ytgrabber-green-api-lambda` | `84da200c`; resolved digest `sha256:7d634b3d...` | keep last 3 |
| `ytgrabber-green-worker` | `84da200c`; digest `sha256:a629c607...` | keep last 3 |
| `ytgrabber-green-translator-cpu` | `84da200c`; optional non-GPU path | keep last 3 |

Do not use mutable `latest` for migration. Record source digest, copy or rebuild, push an
immutable tag, and point Lambda/Batch at that exact tag or digest.

The old docs that say ECR keeps five images are stale; live policies keep three.

### 3.6 IAM

Required roles:

- `<prefix>-api-role`: Lambda and optional ECS-task trust; logging, DynamoDB, S3,
  Batch submit/describe/terminate, self-invoke, and required ECR reads.
- `<prefix>-batch-service-role`: AWS Batch service role.
- `<prefix>-batch-exec-role`: ECS task execution/ECR/log delivery.
- `<prefix>-worker-task-role`: worker data-plane access.
- `<prefix>-gha-deployer`: GitHub OIDC deployment role.

Current security debt to fix during migration:

- Worker task role has `AmazonSQSFullAccess`, `AmazonDynamoDBFullAccess`, and
  `AmazonS3FullAccess`; replace them with resource-scoped permissions.
- The GitHub deployer currently has both a scoped inline policy **and**
  `AdministratorAccess`; remove `AdministratorAccess` after the scoped policy is verified.
- API role still trusts an unused App Runner principal.
- Several secrets are injected as plain container environment values. Prefer a secret
  store and task-definition `secrets` references where practical.

### 3.7 Logs, alarms, and notifications

- `/aws/lambda/ytgrabber-green-api`: no retention limit, about 60 MB stored.
- `/aws/batch/job`: actual Batch logs, no retention limit.
- `/aws/batch/job/ytgrabber-green-worker`: 14-day retention but currently unused by the
  active job definitions.
- `/ecs/ytgrabber-green-api-http`: dormant legacy service log group, no retention limit.
- Eight app alarms exist. Queue/DLQ/legacy EC2 alarms point to
  `ytgrabber-green-alerts`; Lambda and Batch failure alarms have no actions.
- The SNS topic has **zero confirmed subscriptions**, so nobody receives alerts.

For the new account, create one topic, subscribe the operator email, confirm it, attach
every critical alarm, and set explicit log retention (recommended 30 days).

### 3.8 Quotas and scale limits

- Lambda concurrent executions currently applied: `1000`; no function reserved
  concurrency is configured. A request for `1001` remains `CASE_OPENED`.
- Fargate On-Demand vCPU quota: `30`.
- Fargate Spot vCPU quota: `30`.
- Normal worker compute-environment ceiling: `16` vCPU.

Quota increases do not reserve capacity or cost money by themselves. Request equivalent
new-account quotas before load testing; new accounts may start lower.

### 3.9 Domain and certificate

- DNS is external to Route 53; this AWS account has no hosted zone.
- Authoritative nameservers: `ns1.dns-parking.com`, `ns2.dns-parking.com`.
- `www.videomaking.in` currently CNAMEs to the old CloudFront domain.
- ACM certificate is in `us-east-1`, covers apex + `www`, is issued and in use.
- ACM certificates and CloudFront aliases are account-bound; request and validate a new
  certificate before cutover.

### 3.10 External services that do not move with AWS

| Service | App use | Migration requirement |
|---|---|---|
| Google OAuth | Browser sign-in | Preserve client ID; add temporary/new origin if testing on new CloudFront domain |
| Gemini API | AI, subtitles, thumbnails, helpers | Recreate GitHub secrets/key pool; check quotas/billing |
| NVIDIA NIM / Ollama Cloud / Groq | Super Agent primary/fallback models | Recreate configured keys; absent optional keys reduce fallback capacity |
| AssemblyAI | transcription fallbacks and long media | Preserve key securely |
| E2B | isolated Super Agent/assistant sandboxes | Preserve key securely |
| HeyGen | external translation/assets | Preserve key and account access |
| NotebookLM | Find Video integration | Preserve notebook ID, enabled flag, and S3 auth state; auth may expire |
| Web Push | browser notifications | Preserve VAPID key pair if re-enabling; live Lambda currently lacks VAPID vars |
| Supabase | Katha Scene Finder | Keep or migrate separately; not an AWS resource |

Supabase dependency details:

- Project: `edyttxzbywbpumtyixfz`.
- Table: `public.katha_references`.
- Storage bucket: `katha-images`.
- Edge function: `identify-katha` (`verify_jwt=false`).
- Function secret dependency: Gemini/Google API key pool.
- Current migration policies allow anonymous CRUD. Preserve functionality during AWS
  cutover, then review security separately.

---

## 4. What creates what

| Mechanism | Creates/updates |
|---|---|
| `deploy/aws-serverless/template.yml` | Lambda, URL, IAM API role, cooldown table, static S3, OAC, CloudFront function/distribution/security headers |
| `deploy/aws-serverless/deploy-serverless.ps1` | Builds/selects API image, deploys stack, applies output-bucket lifecycle, builds/uploads frontend, invalidates CloudFront |
| `deploy/aws-queue/create-phase-a-resources.ps1` | SQS + DLQ, jobs table, worker ECR, a dedicated log group |
| `deploy/aws-queue/create-phase-a-batch.ps1` | normal Fargate Batch roles, compute environment, queue, worker job definition |
| `.github/workflows/deploy.yml` | builds images, registers new job definitions, merges CI secrets/env, deploys stack/frontend |
| Manual migration steps | output bucket, access table, data copy, ACM, DNS, OIDC/IAM policy, alert subscriber |

Provisioning gaps that must not be missed:

- Access table creation is manual.
- Output bucket creation is manual.
- DNS and ACM validation are manual/external.
- Alert subscription confirmation is manual.
- CPU translator is optional and should be provisioned only if that non-GPU feature is
  intentionally retained.

---

## 5. Configuration and secret source of truth

### 5.1 Do not deploy from the local `.env.green` blindly

The ignored local `deploy/ec2/.env.green` has 41 keys and contains plaintext credentials.
It is stale relative to production, including an old worker job-definition revision.
Production Lambda has 74 environment keys because CI merges the file, GitHub secrets,
live/default values, and deployment parameters.

Before migration:

1. Rotate credentials that have been stored in plaintext locally, especially external AI
   service keys.
2. Build a new encrypted secret inventory; never commit values to Git.
3. Generate a new `SESSION_SECRET` unless preserving all existing sessions is required.
4. Generate a new `WEBHOOK_SIGNING_SECRET`; do not rely on fallback to session secret.
5. Keep password/auth values, API key pools, VAPID private key, cookies, and NotebookLM
   state out of Markdown and tickets.

### 5.2 Required configuration groups

Record values securely for these groups:

- Auth: `SESSION_SECRET`, `WEBSITE_AUTH_USER`, `WEBSITE_AUTH_PASSWORD`, Google auth
  enable/client ID, approved/admin/API-access emails, login limits.
- Feature gates: admin, Super Agent, Pita Ji, translator/CPU-only decisions.
- Storage: new bucket, region, object prefix, signed URL TTL, cookies S3 key.
- Queue: region, jobs table, Batch queue, exact worker definition revision, routing job
  types, Lambda duration/time budgets and concurrency.
- AI: Gemini key pool, NVIDIA/Ollama/Groq pools, AssemblyAI, E2B, HeyGen, model names and
  output limits.
- Persistence: access, cooldown, jobs/uploads/API-key table selection.
- Notifications: VAPID public/private keys and subject.
- NotebookLM: enable flag, notebook ID, S3 auth key, timeouts.
- Public/domain: `videomaking.in`, CloudFront certificate ARN, Google authorized origins.

### 5.3 GitHub repository configuration

The repository uses GitHub OIDC, but legacy `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` repository secrets still exist and are not referenced by the
current workflow. Delete them after confirming OIDC.

Secrets referenced by the workflow but currently absent include optional provider slots
and standalone website/Bhagwat secrets; today some values arrive through
`ENV_GREEN_CONTENT`. For the new account, choose one documented source per secret and do
not depend on accidental fallback between repository secrets and the env blob.

Minimum CI items to recreate deliberately:

- `ENV_GREEN_CONTENT` or, preferably, individually managed secrets.
- Gemini key pool actually in use.
- Google client ID.
- E2B, HeyGen, active NVIDIA/Ollama/Groq keys.
- NotebookLM enabled flag, notebook ID, and auth payload if used.
- Any password/key not intentionally stored in the env blob.

Do not copy unused legacy broker, old AWS access-key, or obsolete provider secrets.

---

## 6. Hardcoded values that must be fixed before new-account deploy

Run this scan before migration and require zero unexpected hits:

```powershell
rg -n "596596146505|malikaeditorr|EDTEON6GFBEZH|d2bcwj2idfdwb4|62ff8b55" `
  .github deploy artifacts -g '!*.md' -g '!node_modules/**' -g '!dist/**'
```

Known current hardcodes:

- `.github/workflows/deploy.yml`: old account ID, deploy-role ARN, and ACM certificate ARN.
- `.github/workflows/upload-model-weights.yml`: old output bucket (not needed when GPU
  translation remains excluded, but it must not be run against the old bucket).
- `deploy/aws-serverless/build-translator-ami.ps1`: old account default; out of scope and
  must not be invoked.
- `.replit` and Replit artifact config: old output bucket.
- API fallback defaults in uploads/workspace/Google Drive code: old output bucket.
- Super Agent URL allowlist: old S3 and CloudFront hostnames.
- `deploy-policy.json`: old account, distribution, role, table, and bucket ARNs.
- Root diagnostic JSON files contain snapshots of old ARNs; do not use them as deploy
  inputs.

Preferred fix: parameterize account ID, bucket, certificate, distribution, and allowed
hosts through workflow variables/stack outputs. Do not do a blind repository-wide
replacement inside historical audit documents.

Template issue to resolve before the first new-account deployment:
`deploy/aws-serverless/template.yml` currently declares `VideoEditorBatchEnabled` twice.
Remove the duplicate and retain the intended default explicitly.

---

## 7. Ordered new-account migration

### Phase 0 — freeze and decisions

- Choose `<NEW_ACCOUNT_ID>`, `<NEW_OUTPUT_BUCKET>`, region `us-east-1`, and keep prefix
  `ytgrabber-green` unless there is a strong reason to rename it.
- Decide whether old job history is required; access data is mandatory.
- Decide whether optional CPU translation is retained. GPU paths remain disabled.
- Set a maintenance/cutover window and rollback owner.
- Lower external DNS TTL at least 24 hours before cutover.

### Phase 1 — secure account bootstrap

- Root MFA, admin role/user MFA, alternate contacts.
- Monthly cost budget and alert recipients.
- Enable CloudTrail, GuardDuty, AWS Config, and Security Hub as desired. The source
  account currently has none of these enabled, so do not assume they migrate.
- Request Lambda and Fargate quotas early. Target at least Lambda 1000 and Fargate
  On-Demand 30 vCPU for parity.
- Create GitHub OIDC provider and a scoped deploy role. Do not attach
  `AdministratorAccess`.

### Phase 2 — network

- Create or verify a VPC with public subnets in multiple AZs, an Internet Gateway,
  route tables, and a security group allowing required outbound HTTPS/DNS.
- Pass subnet and security-group IDs explicitly. Do not depend on finding a running EC2
  instance by tag.
- Normal Fargate jobs require public IP assignment in the current design.

### Phase 3 — output bucket

Create a globally unique bucket:

```powershell
aws s3api create-bucket --profile new-account --region us-east-1 `
  --bucket <NEW_OUTPUT_BUCKET>
aws s3api put-bucket-encryption --profile new-account --bucket <NEW_OUTPUT_BUCKET> `
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
```

Mirror lifecycle/CORS initially so behavior does not change during migration. After
testing pre-signed uploads, enable full public-access blocking and restrict CORS to the
production origins.

### Phase 4 — copy S3 state

Preferred direct cross-account method:

1. Temporarily grant the new-account migration role `s3:ListBucket` and `s3:GetObject`
   on the required old bucket/prefixes.
2. With new-account credentials, copy required prefixes:

```powershell
aws s3 sync s3://malikaeditorr/ytgrabber-green/ `
  s3://<NEW_OUTPUT_BUCKET>/ytgrabber-green/ --profile new-account --source-region us-east-1 --region us-east-1
aws s3 sync s3://malikaeditorr/workspace/ `
  s3://<NEW_OUTPUT_BUCKET>/workspace/ --profile new-account --source-region us-east-1 --region us-east-1
aws s3 sync s3://malikaeditorr/heygen-posters/ `
  s3://<NEW_OUTPUT_BUCKET>/heygen-posters/ --profile new-account --source-region us-east-1 --region us-east-1
```

3. Compare object counts and total bytes per prefix.
4. Verify cookie and NotebookLM objects with `head-object` without printing contents.
5. Remove the temporary cross-account read policy.

For the final cutover, run a second incremental sync after pausing writes.

### Phase 5 — data plane

Create normal queue/table/repository resources:

```powershell
.\deploy\aws-queue\create-phase-a-resources.ps1 `
  -Region us-east-1 -Prefix ytgrabber-green
```

Then explicitly create the access table:

```powershell
aws dynamodb create-table --profile new-account --region us-east-1 `
  --table-name ytgrabber-green-access `
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S `
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE `
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --profile new-account --region us-east-1 `
  --table-name ytgrabber-green-access `
  --time-to-live-specification Enabled=true,AttributeName=expiresAt
```

Copy all access-table items. For this small table, scan from the old profile, transform
each typed item into a `PutRequest`, and batch-write in groups of at most 25 to the new
profile. Re-scan both tables and compare item counts (`29` at audit time). Never log item
contents because records may contain sensitive API/webhook data.

If retaining jobs, copy the jobs table after its schema/GSI exists and compare item
counts. Enable PITR and deletion protection in the new account after import.

### Phase 6 — images

Build from the exact reviewed commit or copy the current immutable API/worker images.
For cross-account ECR copy, authenticate to both registries, pull by digest/tag, retag to
the new registry, and push. Apply the keep-last-3 lifecycle policy.

Required repositories:

- `ytgrabber-green-api-lambda`.
- `ytgrabber-green-worker`.
- Optional `ytgrabber-green-translator-cpu` only if the CPU feature is retained.

### Phase 7 — normal Batch Fargate

Use the phase-A Batch script with explicit network IDs and the new env file:

```powershell
.\deploy\aws-queue\create-phase-a-batch.ps1 `
  -Region us-east-1 -Prefix ytgrabber-green -ImageTag <IMMUTABLE_TAG> `
  -MaxVcpus 16 -SubnetId <PUBLIC_SUBNET_ID> `
  -SecurityGroupId <SECURITY_GROUP_ID> `
  -EnvFile .\deploy\ec2\.env.green
```

Capture the new worker job-definition revision and set
`YOUTUBE_BATCH_JOB_DEFINITION=ytgrabber-green-worker-job:<NEW_REVISION>`.

### Phase 8 — IAM and OIDC

Create GitHub's OIDC provider and a deploy role trusted only for:

```text
repo:NikhilGupta777/International-3:*
audience: sts.amazonaws.com
```

Update every `role-to-assume`, account ID, ECR registry, IAM resource ARN, and
CloudFront/ACM input in workflows and `deploy-policy.json`. Use the scoped inline policy;
do not attach administrator access. Delete unused long-lived AWS repository secrets.

### Phase 9 — prepare the complete deploy environment

- Build the new encrypted env from the live key inventory and intended defaults.
- Replace bucket/table/queue/job-definition/account-specific values.
- Keep `LAMBDA_CLIP_MAX_DURATION_SECONDS=420`,
  `SUBTITLES_LAMBDA_MAX_DURATION_SECONDS=780`, and
  `MAX_CONCURRENT_CLIP_JOBS=3` unless intentionally tuning.
- Keep the current normal primary types:
  `bhagwat-analyze,bhagwat-render,clip-cut,subtitles`.
- Disable GPU-only/lip-sync paths.
- Validate every required secret is present without printing its value.

### Phase 10 — certificate and initial stack deploy

Request an ACM certificate in `us-east-1` for:

- `videomaking.in`
- `www.videomaking.in`

Add the new DNS validation CNAMEs at the external DNS provider and wait for `ISSUED`.
Then deploy:

```powershell
.\deploy\aws-serverless\deploy-serverless.ps1 `
  -Region us-east-1 -Prefix ytgrabber-green `
  -SkipImageBuild -ImageUri <NEW_ACCOUNT_API_IMAGE_URI> `
  -SiteDomainName videomaking.in `
  -CloudFrontCertificateArn <NEW_CERTIFICATE_ARN> `
  -EnvFilePath .\deploy\ec2\.env.green
```

Do not pass the old certificate ARN, bucket, role ARN, or image URI.

### Phase 11 — alarms and retention

```powershell
.\deploy\aws-queue\create-alarms.ps1 `
  -Region us-east-1 -Prefix ytgrabber-green -AlarmEmail <OPS_EMAIL>
```

Confirm the SNS email subscription. Attach the topic to Lambda errors/throttles, Batch
failures, queue depth/age, and DLQ alarms. Set 30-day retention on the Lambda and actual
`/aws/batch/job` log groups.

### Phase 12 — pre-DNS acceptance

Test through the new CloudFront domain before DNS:

- `/api/healthz` and `/api/auth/config` return 200.
- Password login and Google login.
- Session response includes feature entitlements.
- Super Agent opens for an allowed user and denial works for a denied user.
- One direct short Lambda clip; confirm no Batch handoff.
- One normal Batch clip/job; confirm queue, Batch, DynamoDB, S3 output, signed download.
- Subtitles, Bhagwat, Pita Ji, uploads, workspace, presets, thumbnails.
- External AI provider fallbacks, E2B, HeyGen, NotebookLM if enabled.
- Katha/Supabase flow.
- Alarm test reaches the confirmed operator.

### Phase 13 — cutover

1. Pause or minimize writes.
2. Run final incremental S3 and DynamoDB sync.
3. Update DNS apex/`www` to the new CloudFront distribution.
4. Invalidate new CloudFront and test both domains.
5. Monitor Lambda errors/throttles, queue age, DLQ, Batch failures, and auth failures.
6. Keep the old account intact for the rollback window.

### Phase 14 — rollback and decommission

Rollback is DNS back to the old CloudFront distribution while the old stack/data remain
available. Do not delete old resources until the agreed retention window ends and all
data counts, auth records, and output downloads are verified.

After acceptance, separately review and remove old unused resources, including the
legacy HTTP API, ALB, zero-count ECS service, obsolete ECR repositories, stale IAM
permissions, and unused access keys. Deletion is not part of this migration runbook and
requires an explicit owner decision.

---

## 8. Verification commands

```powershell
# Identity guardrail: run before every phase
aws sts get-caller-identity --profile new-account

# Stack and Function URL
aws cloudformation describe-stacks --profile new-account --region us-east-1 `
  --stack-name ytgrabber-green-serverless `
  --query 'Stacks[0].StackStatus' --output text
aws lambda get-function-url-config --profile new-account --region us-east-1 `
  --function-name ytgrabber-green-api `
  --query '{Auth:AuthType,Mode:InvokeMode}' --output json

# Lambda configuration
aws lambda get-function-configuration --profile new-account --region us-east-1 `
  --function-name ytgrabber-green-api `
  --query '{Memory:MemorySize,Timeout:Timeout,Storage:EphemeralStorage.Size,State:State}'

# Batch
aws batch describe-compute-environments --profile new-account --region us-east-1 `
  --compute-environments ytgrabber-green-compute-fargate `
  --query 'computeEnvironments[0].{State:state,Status:status,Max:computeResources.maxvCpus}'
aws batch describe-job-queues --profile new-account --region us-east-1 `
  --job-queues ytgrabber-green-job-queue `
  --query 'jobQueues[0].{State:state,Status:status}'

# Tables and queue
aws dynamodb describe-table --profile new-account --region us-east-1 `
  --table-name ytgrabber-green-access --query 'Table.ItemCount'
aws sqs get-queue-attributes --profile new-account --region us-east-1 `
  --queue-url <NEW_QUEUE_URL> --attribute-names RedrivePolicy VisibilityTimeout

# S3 objects without revealing contents
aws s3api head-object --profile new-account --bucket <NEW_OUTPUT_BUCKET> `
  --key ytgrabber-green/secrets/ytdlp-cookies-base64.txt `
  --query '{Bytes:ContentLength,Encryption:ServerSideEncryption}'

# Public smoke checks
curl.exe -fsS https://<NEW_CLOUDFRONT_DOMAIN>/api/healthz
curl.exe -fsS https://<NEW_CLOUDFRONT_DOMAIN>/api/auth/config
```

After deployment, run CloudFormation drift detection and require `IN_SYNC`.

---

## 9. Go/no-go checklist

### Go

- [ ] Correct new-account identity verified before every write.
- [ ] Required quotas applied.
- [ ] Access table copied and item counts match.
- [ ] Required S3 prefixes copied and counts/bytes match.
- [ ] Cookie and optional NotebookLM state verified.
- [ ] API and worker images exist under immutable tags.
- [ ] Normal Fargate compute/queue/job definition are valid.
- [ ] Lambda env complete; no old account/bucket/ARN remains.
- [ ] OIDC deploy works without long-lived AWS keys or administrator policy.
- [ ] New ACM certificate issued and attached.
- [ ] SNS subscription confirmed and alarms tested.
- [ ] All feature smoke tests pass through new CloudFront.
- [ ] Rollback DNS values recorded.

### No-go

- Any auth/access records are missing.
- Any secret was copied into Git, Markdown, logs, or task output.
- Local stale `.env.green` is being used as the only source of truth.
- Old account ID, output bucket, certificate, distribution, or ECR URI remains in active
  deploy inputs.
- CloudFront opens the app but `/api*` points to the wrong origin.
- Batch queue is valid but its job definition references an old-account image or role.
- Alerts have no confirmed recipient.
- GPU-only paths remain enabled despite GPU infrastructure being excluded.

---

## 10. Audit findings requiring follow-up

1. Rotate external credentials stored in the ignored plaintext local env file.
2. Remove old long-lived AWS GitHub secrets after OIDC verification.
3. Remove `AdministratorAccess` from the GitHub deploy role.
4. Add scripted access-table creation and backup/PITR/deletion protection.
5. Parameterize all live account/bucket/certificate/distribution/allowed-host values.
6. Remove the duplicate `VideoEditorBatchEnabled` template parameter.
7. Connect every critical alarm to a confirmed subscriber.
8. Set retention on the actual Lambda and Batch log groups.
9. Review output-bucket public-access-block and wildcard CORS after compatibility tests.
10. Decide whether to retire old legacy HTTP API/ALB/ECS resources; do not copy them by
    default.

This runbook records configuration and procedure only. Secret values must live in an
approved secret manager or encrypted operational vault, never in this repository.
