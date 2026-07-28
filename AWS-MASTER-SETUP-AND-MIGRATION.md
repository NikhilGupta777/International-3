# AWS New-Account Migration Master Runbook

**Authoritative source for migrating VideoMaking Studio to a new AWS account.**

Last audited: **2026-07-28 IST** from the repository and migration target account
`386318011485` in `us-east-1`. The source account was not called during the final
closeout documented in section 13.
Secret values are intentionally not recorded.

This document supersedes older AWS architecture and migration notes wherever they
disagree. The production CloudFormation stack was drift-checked during this audit and
reported `IN_SYNC` with zero drifted resources.

> Scope decision: GPU translation infrastructure is deliberately excluded. Do not
> recreate GPU compute environments, queues, AMIs, images, quotas, or job definitions in
> the new account. Keep GPU-only/lip-sync paths disabled. The core site, Lambda clip
> cutting, normal Fargate worker, CPU/non-GPU features, Super Agent, storage, auth, and
> external integrations remain in scope.

> Media-retention decision: during S3 migration, do not copy video or audio objects
> whose S3 `LastModified` timestamp is older than 120 hours at the time each migration
> pass starts. Apply this rule across every prefix, including `ytgrabber-green/`,
> `workspace/`, `translator/`, uploads, downloads, and clip outputs. Media extensions
> covered by the rule are `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.m4v`, `.mpeg`,
> `.mpg`, `.ts`, `.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, and `.wma`.
> Keep non-media state regardless of age, including JSON/metadata, subtitles, presets,
> secrets, images, thumbnails, and workspace documents. Recalculate the rolling cutoff
> for the final incremental pass; do not use a permanently hardcoded date.

## Target-account migration snapshot — 2026-07-26 IST

Source account `596596146505` remained strictly read-only during this migration. All
AWS mutations described below were made only in target account `386318011485`.

Completed and verified in the target account:

- Copied the exact live production API image tag `60d5c1cb` into target ECR. Source and
  target resolve to digest
  `sha256:e18c4d1bf4b05ec7b7fcc9cf2849ad782b4bfca1ef0989d450d44c43bf83b4fd`.
- Copied the exact live production worker image tag `60d5c1cb` into target ECR. Source
  and target resolve to digest
  `sha256:eacc56fb01adf533c6ff12b670df77d6aa0f755476ec1f828c9d6ed39b2b9a69`.
- Lambda `ytgrabber-green-api` now runs the immutable target API digest with 3008 MB
  memory, 900-second timeout, and 5120 MB ephemeral storage. Its 74 production
  environment entries were copied without logging values and transformed only for
  target-account resources/endpoints.
- A secret-safe final scan found zero old account IDs, old bucket names, old Lambda URL
  hostnames, or old CloudFront hostnames in the 74 Lambda environment entries or the
  32 Batch environment entries.
- Registered `ytgrabber-green-worker-job:3` from source live revision `747`, using the
  target worker image, target IAM roles, 2 vCPU, 4096 MB, and a 2700-second timeout.
  Lambda points to revision `3`.
- GPU/translation exclusions are explicit: `TRANSLATOR_ENABLED=false`,
  `TRANSLATOR_LIP_SYNC_ENABLED=false`, and `GOOGLE_GENAI_USE_VERTEXAI=false`. No GPU
  compute, queue, AMI, image, job definition, or GPU resource requirement was added.
- Lambda async invocation now matches production: zero retries and a 3600-second
  maximum event age.
- Copied the current 75-object production frontend to the target static bucket,
  removed seven stale target-only hashed assets with recoverable versioned deletes,
  and invalidated CloudFront. Production S3, target S3, and served CloudFront
  `index.html` all had SHA-256
  `2093fa447e9c612d76fc8ba8117e1fe6302a5e8a60f55f50e02750131b05c094`.
- Recreated and attached the production security-headers policy. Target CloudFront
  returns HTTP 200 plus HSTS, CSP, frame denial, no-referrer, nosniff, and
  Permissions-Policy headers.
- Copied all access and jobs metadata. Final parity snapshot at
  `2026-07-26T16:14:57Z`: access `29/29`, jobs `3165/3165`, cooldowns `0/0`.
  Sensitive record contents were never printed.
- Applied the rolling 120-hour media rule globally. Final S3 snapshot at the same time:
  1050 source objects; 863 approved objects / 3,099,827,444 bytes in target; 187 old
  media objects excluded; zero approved-object size mismatches; zero unapproved regular
  target objects. Eleven `migration-backup/` rollback objects remain intentionally.
- Source cookies and NotebookLM state were included as non-media state. The stale
  target-only Vertex credential object was removed by the final target reconciliation;
  its version remains recoverable because target versioning is enabled.
- Target output S3 now has versioning, AES256 default encryption, bucket-owner-enforced
  ownership, full public-access block, production-equivalent lifecycle, and CORS with
  GET/PUT/POST/DELETE/HEAD.
- Target access, jobs, and cooldown tables now have PITR and deletion protection.
- Target API and worker ECR repositories now use production's keep-last-3 lifecycle.
- Target Lambda, Batch, worker, and CodeBuild log groups have 30-day retention. The
  temporary migration Lambda, its empty log group, local transfer data, and ECR auth
  file were deleted after verification.
- Authenticated checks through target CloudFront passed: password login, session,
  Super Agent entitlement, skills, client access, `/api/healthz`, and
  `/api/auth/config`.
- A real revision-3 Fargate job succeeded with DynamoDB `done` and target S3 output.
  A separate 5-second clip completed through Lambda in 14.58 seconds with no Batch
  handoff. Exact smoke-test records and outputs were removed afterward.
- Lambda concurrency is 1000, normal Fargate max is 16 vCPU and scale-to-zero,
  CloudTrail is logging, six alarms exist, and the USD 100 monthly budget exists.
- Cost Explorer for target account July 1-26 showed effectively USD 0.00 net at query
  time. Billing can lag; versioned S3/ECR storage, PITR, requests, Lambda, Fargate, and
  CloudFront usage can create later charges. Quota and max-vCPU ceilings do not create
  24/7 compute charges by themselves.

Remaining before production traffic cutover:

- Run one final incremental S3 and DynamoDB pass after pausing source writes. The parity
  numbers above are a verified live snapshot, not a substitute for the cutover freeze.
- Target stack drift for `ApiFunction` and `ApiRole` was reconciled target-only on
  2026-07-26. CloudFormation finished `UPDATE_COMPLETE`; a new drift detection returned
  `IN_SYNC` with zero drifted resources. The exact image digest, 74-variable environment
  hash, role-policy hash, Function URL, response-headers policy, and authenticated
  behavior were unchanged after the update. Lambda version `2` and the pre-change
  template under `migration-backup/pre-cfn-reconcile-20260726T163016Z/` are rollback
  points.
- Do not treat this as authorization for a repository-driven full deploy. The live
  target stack now preserves the verified configuration, but the repository template
  still requires a separate reviewed update, and the manually created cooldown table,
  async invoke config, and response-headers policy are not all stack-owned resources.
  A stale local/full deploy can still undo working settings.
- The USD 100 target budget now has the same three notification rules and operator
  recipient as source. Because the original topic retained that endpoint as `Deleted`,
  replacement topic `ytgrabber-green-alerts-email` was created and attached to all six
  target alarms. Its email subscription is `PendingConfirmation`; the operator must
  accept AWS's confirmation email before alarm delivery can be tested.
- Acceptance testing on 2026-07-27 covered the allowed core tabs and is recorded below.
  Google OAuth's persistent AWS configuration and allowlists have exact source/target
  parity. A real Google login still needs a short-lived browser-issued ID token; AWS CLI
  profiles do not contain or mint that token. Remaining excluded surfaces are Pita Ji,
  HeyGen, Workspace/Drive, Translator, and Katha/Supabase. The latter four app
  areas were not exercised further after the owner's explicit exclusion; no GPU or
  translation test was run.
- GitHub/OIDC migration and ACM/custom-domain/external-DNS cutover remain deliberately
  deferred by the owner. Target therefore continues to use
  `dq163fbjr1do7.cloudfront.net` with the CloudFront default certificate.
- Target IAM user `newbackup` still has overlapping administrator policies and
  long-lived access keys. GuardDuty, Security Hub, and AWS Config are not enabled.
  Replace agent-accessible admin keys with short-lived scoped access and decide on the
  paid security services before cutover; no key was deleted automatically.

No source resource was changed or deleted. Old production remains the rollback system.

## Target CLI acceptance — 2026-07-27 IST

All checks in this section used AWS CLI or direct HTTP/API calls against target account
`386318011485` and `https://dq163fbjr1do7.cloudfront.net`. The old/source AWS profile
was not called, no browser automation was used, and no application code was edited.
The local `new-account` profile's invalid default output value (`\`) was corrected to
`json`; a follow-up STS call again resolved account `386318011485`.

Passed:

- Home auth/config, password login/session, Super Agent skills and a real streamed agent
  reply, Find Video health and a real streamed answer, client access, and API v1 health.
- Download metadata for a 213-second public video and a real format-18 download. The
  download completed at 100% with an 11,829,048-byte MP4.
- A fresh five-second Clip Cut completed through Lambda at 100%, produced a valid
  732,773-byte MP4, and had no Batch job ID.
- Timestamps completed through the Lambda worker at 100% with 11 chapters.
- Subtitles completed through Batch job `fb5f0e2a-456a-4266-a880-5cdcbc37a5e6` with
  exit code 0 and a 4,948-character SRT.
- Bhagwat authenticated successfully; a controlled ten-second analysis completed through
  Batch job `487e8a15-0e95-455c-bdc9-5fb3d38c2a75` with exit code 0, and its SSE status
  route emitted `done` with a persisted result.
- AI Studio project creation, retrieval/deletion, and a real assistant chat passed. The
  chat emitted `run_start`, project/user, thinking, thought, text, assistant, and `done`
  events. The temporary project was deleted.
- Best Clips completed with a transcript and the correct 213-second duration. It returned
  zero selected clips for the music-video test input, so transport/execution passed but
  result quality remains inconclusive for representative spoken content.
- Earlier target-only controlled checks in this migration also passed Share upload,
  Workspace create/read/delete, Google Drive status, and Super Agent/NotebookLM paths;
  Workspace/Drive was excluded from further testing when the owner requested it.

Confirmed defects and blockers:

- **New Tab Studio is broken in the deployed target image:** authenticated
  `POST /api/newtab-studio/chat` returns HTTP 404. The frontend tab is deployed, while
  the exact migrated production API image does not expose its backend route. Local
  uncommitted New Tab route work exists but was not modified or deployed during this
  audit. Fix requires reviewing that work, including the router registration, then
  building and deploying a new API image through a controlled target-only update.
- **Content Manager quota blocker resolved 2026-07-27:** the route now uses Super
  Agent's configured external-provider/model ladder first, including provider-level key
  rotation, then rotates through every configured Content Manager Gemini key. Complete
  attempts are buffered before exposure, with eight-second SSE heartbeats so CloudFront
  cannot close an idle fallback attempt. The default provider timeout is bounded at 30
  seconds (configurable from 10 to 60 seconds). Tool-call IDs are preserved across
  multi-turn fallback conversations.
- Structured pack generation now has a separate JSON-only system prompt, tolerates a
  harmless prose/fence wrapper around an outer JSON object, omits invalid empty
  `tools`/`tool_choice` fields for OpenAI-compatible providers, and rejects incomplete
  packs before declaring a provider successful. Required acceptance fields are five real
  titles with rationales, description, tags, complete upload time, at least one must-do,
  and at least one channel signal.
- The final target image is
  `sha256:e3b8a1694c614ec27ca8b24e2e6e0ae44788a7ba708408a37265c6e23b856695`.
  A live strict pack request completed in 150.15 seconds after four fallback transitions
  with HTTP 200, `result` and `done`, zero errors, five titles, a 665-character
  description, 197 characters of tags, three must-dos, one channel signal, and upload
  time. Earlier controlled runs proved plain conversation and fallback keepalive paths.
  All nine external-provider regression tests, API typecheck, and Lambda build passed.
- Admin and Developer endpoints correctly return 403 to the password session. Their
  persistent configuration is migrated: Google client ID/auth flags/admin seed match,
  and the DynamoDB allowlist matches exactly (39 users, 1 admin, 0 additional API-access
  users). Full acceptance still requires that approved admin to complete Google sign-in,
  which supplies a fresh short-lived ID token.
- New tests of HeyGen, Pita Ji, Workspace/Drive, and Translator were stopped by explicit
  owner instruction. Translation remains intentionally disabled and no GPU test ran.

Cleanup and post-test health:

- Exact current S3 objects for the new clip, subtitle, and download were deleted with
  versioned delete markers. All five persistent test job records were deleted; a full
  projected table scan found zero matching test IDs afterward. The Best Clips job was
  in-memory only. Batch history remains as normal AWS execution history.
- Over the two-hour test window, CloudWatch reported 93 Lambda invocations, zero Lambda
  errors, and zero throttles. No CloudWatch alarm was in `ALARM`. The target stack
  remained `UPDATE_COMPLETE`.
- Repository-wide `pnpm run typecheck` also passed for shared libraries, API server,
  frontend, queue worker, scripts, and mockup sandbox. This validates the current dirty
  working tree but does not mean its uncommitted New Tab implementation is deployed.
- After the Content Manager deployment, Lambda still had 74 environment entries with
  the exact pre-change hash
  `43848a8a8b1701c8900da6b46fd18ba3a5ded869aeffb6ee57763ec77dcc09db`,
  3008 MB memory, 900-second timeout, zero Lambda errors/throttles in the verification
  window, zero alarms in `ALARM`, HTTP 200 health/config, and stack
  `UPDATE_COMPLETE`. Existing migrated provider token values were reused without being
  printed or modified.

## Historical target-account progress — 2026-07-23 IST

Target account: `386318011485`, region `us-east-1`. This section records live work
already completed in the migration account. It does not change the source-production
inventory documented below. It is retained as an audit trail and is superseded by the
2026-07-26 snapshot above; its “remaining” items are not the current remaining list.

Completed and verified:

- CloudFormation stack `ytgrabber-green-serverless` is deployed with Lambda, Function
  URL, static S3, OAC, CloudFront distribution `E36OKTEHMEZQ4N`, and SPA rewrite.
- Target CloudFront domain is `dq163fbjr1do7.cloudfront.net`; `/api/healthz` and
  `/api/auth/config` return HTTP 200. The direct Lambda Function URL health check also
  returns HTTP 200.
- Lambda memory is 3008 MB, timeout 900 seconds, and ephemeral storage 5120 MB.
- Lambda fast-path cutoff is 420 seconds and normal Batch primary job types are
  `bhagwat-analyze,bhagwat-render,clip-cut,subtitles`.
- Current API image `migration-eb8a425-20260723-lambda` is deployed from a clean build
  of commit `eb8a425`; resolved target ECR digest is
  `sha256:6a8b3e49d5407cc955664257b40b703fab30e450385e8113c3f05501ec03537b`.
- `ytgrabber-green-cooldowns` is active with TTL on `expiresAt`. The API role has scoped
  cooldown-table access and scoped self-`lambda:InvokeFunction` permission.
- Authenticated Lambda-fast clip job `98723a6c-4583-42c3-8387-59e5ef99efc1`
  completed in 11.73 seconds, wrote a 413,450-byte MP4 to target S3, and created no
  Batch job.
- Current normal worker image `migration-eb8a425-20260723` is in target ECR at digest
  `sha256:d0b96c837a0e15b99375edbdbe95eb710682058c3ef00261cbad6012c79ad354`.
  Batch job definition revision 2 uses this image with 2 vCPU, 4096 MB, and a
  2700-second attempt timeout; Lambda points to revision 2.
- Direct Fargate acceptance job `codex-batch-smoke-7cae2bf1388f` succeeded with exit
  code 0, DynamoDB status `done`, and a 413,451-byte MP4 in target S3.
- The authenticated `/api/youtube/file/:jobId` route redirected to the target bucket and
  a ranged pre-signed S3 download returned HTTP 206.
- Password login, `/api/auth/session`, and `/api/agent/skills` returned HTTP 200;
  the session reported `authenticated=true` and `superAgentAllowed=true`.
- Lambda concurrent executions quota is applied at 1000. AWS case
  `178479729200992` is closed.
- Normal Fargate compute environment is enabled/valid with `maxvCpus=16`.
- Access-table TTL is enabled on `expiresAt`.
- Output bucket `videomaking-backup-386318011485` has encryption, public-access block,
  required temporary migration CORS, and clip/download/share lifecycle expiration.
- Multi-region CloudTrail `videomaking-management-events` is logging with validation.
- Monthly cost budget `videomaking-monthly-100-usd` exists with a USD 100 limit.
- Six baseline CloudWatch alarms are attached to SNS topic
  `ytgrabber-green-alerts`. The topic has no subscriber yet.
- `/aws/lambda/ytgrabber-green-api`, `/aws/batch/job`, and the active worker group
  `/aws/batch/job/ytgrabber-green-worker` have 30-day retention.

Remaining blockers and required work:

- Obtain old-account read access or a temporary cross-account migration policy. The
  target currently has only 1 access record, 11 sample/test job records, and 10 S3
  objects; this is not a production data migration.
- Copy the full required S3 prefixes and DynamoDB access records, optionally jobs
  history, then compare source/target counts and bytes. For S3, copy all required
  non-media state but exclude video/audio objects older than the rolling five-day
  cutoff. Run a final incremental copy at cutover using a newly calculated cutoff.
- Build and validate the complete secret/config inventory. Target Lambda currently has
  fewer environment keys than the 74 in audited source production. Do not copy values into
  this document or command output.
- Reconcile the manually created cooldown table through CloudFormation import or an
  equivalent controlled stack procedure. The repository template defines the table,
  but the deployed target stack does not yet own it.
- Reconcile CloudFormation drift and direct runtime updates: `ApiFunction.MemorySize`
  expects 1536 while live is 3008; the stack also expects worker revision 1, a 600-second
  cutoff, and the broader old routing list. `ApiRole` drift contains only the required
  cooldown-table and self-invoke permissions. Preserve all verified live values and the
  current API image in the next controlled stack deployment.
- Add and confirm an operator email subscription to `ytgrabber-green-alerts`; then test
  alarm delivery. Add a budget recipient as well.
- After the data import, enable DynamoDB PITR and deletion protection as intended.
- Complete the remaining authenticated acceptance tests: workspace, uploads, subtitles,
  Bhagwat, Pita Ji, Google login, and retained external integrations. Password login,
  Super Agent entitlement/skills, signed download, one short Lambda clip without Batch,
  and one normal Fargate job have passed.
- GitHub/OIDC workflow migration and ACM/domain/DNS cutover were explicitly deferred by
  the owner. They remain necessary before final production traffic cutover.

No GPU translation infrastructure is included in the target migration.

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
| Worker definition | `ytgrabber-green-worker-job:747`, 2 vCPU, 4096 MB, 2700 s | Target revision 3 cloned and tested |
| Worker image | tag `60d5c1cb`, digest `sha256:eacc56fb01ad...` | Exact immutable image copied |
| Worker IAM | task role + execution role + Batch service role | Recreate with scoped policies |
| Network | default VPC public subnet/security group; task public IP enabled | Recreate with explicit IDs |

The compute environment scales to zero. Its `maxvCpus=16` is a ceiling, not a 24/7
reservation.

### 3.3 DynamoDB

| Table | Schema and live state | Migration action |
|---|---|---|
| `ytgrabber-green-jobs` | PK `jobId` (S); GSI `status-createdAt-index`; on-demand; 3,165 items at the 2026-07-26 snapshot; TTL disabled; source PITR disabled | Copied to target; target PITR/deletion protection enabled |
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

- `us-east-1`, 1,050 objects / about 4.52 GB at the 2026-07-26 final snapshot.
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
| `ytgrabber-green-api-lambda` | `60d5c1cb`; resolved digest `sha256:e18c4d1bf4b0...` | copied exactly; target keeps last 3 |
| `ytgrabber-green-worker` | `60d5c1cb`; digest `sha256:eacc56fb01ad...` | copied exactly; target keeps last 3 |
| `ytgrabber-green-translator-cpu` | excluded from this migration | do not copy while translation remains disabled |

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

Before either S3 pass, inventory source objects and calculate `now UTC - 120 hours`.
Copy all required non-media objects, but copy video/audio extensions listed in the
media-retention decision only when `LastModified` is at or after that cutoff. Plain
`aws s3 sync` cannot express a `LastModified` cutoff, so use a reviewed paginated
manifest/copy script or AWS SDK process; do not rely only on prefix include/exclude
patterns. Record eligible, skipped, copied, and failed object counts and bytes without
logging secret contents.

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

## 11. Target incremental reconciliation and login-origin repair — 2026-07-27 IST

- The old account was read-only throughout. A new live comparison found 16 source job
  records and 15 eligible S3 objects created after the prior snapshot. All 16 jobs and
  all 15 objects (1,322,622,067 bytes) were copied into the target. The rolling
  `now UTC - 120 hours` rule excluded 184 older media objects.
- Final live parity was: zero source job IDs missing in target; zero eligible S3 keys
  missing; zero eligible-object size mismatches. Target has two target-native job IDs
  from its own activity, which are not source-migration gaps.
- Password login on the CloudFront target had returned `Login origin rejected` because
  the API had no `PUBLIC_SITE_URL` and therefore trusted the old `videomaking.in` default.
  A reviewed target-only CloudFormation change added
  `PUBLIC_SITE_URL=https://dq163fbjr1do7.cloudfront.net`. Password login and the signed
  session then returned HTTP 200. The Function URL and CloudFront hostname were unchanged.
- The stack finished `UPDATE_COMPLETE`; drift detection
  `36c22410-8983-11f1-ada6-0affd079d93f` returned `IN_SYNC` with zero drifted resources.
  Lambda is active at 3008 MB / 900 seconds with 75 environment entries and no active
  CloudWatch alarm. The repository template and deploy parameter mapping now include
  `PublicSiteUrl`/`PUBLIC_SITE_URL` so a future reviewed deployment preserves this fix.

## 12. Final configuration comparison and cutover remediation — 2026-07-27 IST

- A fresh old/new audit kept source strictly read-only. Lambda compute/streaming/async
  settings, SQS/DLQ behavior, normal Fargate Batch resources, effective API IAM actions,
  Google/access configuration, CloudFront paths/security headers, S3 CORS/lifecycle,
  and all 75 static-site objects match functionally. Target API is intentionally newer
  because it contains the Content Manager fixes; target storage protections are stronger.
- The source worker advanced to revision 749/tag `d439597e`, but the commits since the
  target worker's `60d5c1cb` changed only frontend/docs. Worker source did not change;
  both definitions retain 2 vCPU, 4096 MB, 2700 seconds, and 32 environment entries,
  differing only in target account queue/bucket values.
- One target-native active `Untitled key` with wildcard scope and no expiry was found and
  revoked in place. Its audit record remains; the credential can no longer authenticate.
- Target budget notification parity is restored: three source-equivalent rules and the
  same operator recipient. The original SNS topic retained its endpoint as `Deleted`, so
  replacement topic `ytgrabber-green-alerts-email` was created and added to all six
  alarms. Its operator email subscription is pending confirmation.
- ACM certificate
  `arn:aws:acm:us-east-1:386318011485:certificate/d849e124-73a0-41bd-ae85-2a378a51ba43`
  was requested for `videomaking.in` and `www.videomaking.in`. It is pending two DNS
  CNAME validations at the external `dns-parking.com` nameservers; neither AWS account
  hosts the authoritative zone.
- Non-media parity is current: 819 source non-media objects, zero missing target keys,
  and zero size mismatches. Source job/access keys are all represented in target; target
  contains only target-native additions. A final repeat is still required after source
  writes are paused at the cutover boundary.

---

## Cutover completed — 2026-07-28

`videomaking.in` and `www.videomaking.in` now serve from account `386318011485`.

### What was done

1. **DNS (manual, Hostinger).** Apex `ALIAS @` and `CNAME www` repointed to
   `dq163fbjr1do7.cloudfront.net`. Both ACM validation CNAMEs
   (`_66f1c649ca9d94398ac8f8fe70dcb953`, `_7852a1d6163e9c05f74b482154a97f6f.www`)
   were retained.
2. **Alias release (old account).** CloudFront `EDTEON6GFBEZH` had both alternate
   domain names removed and was switched to the default CloudFront certificate.
   The distribution remains **enabled and otherwise intact** as a rollback target.
   Pre-change config backup: `old-dist-BACKUP.json` (kept outside the repo).
3. **Alias attach (new account).** Change set `domain-cutover-20260728b` —
   162 parameters, 159 `UsePreviousValue`, overriding only `SiteDomainName`,
   `CloudFrontCertificateArn` and `PublicSiteUrl`. Result `UPDATE_COMPLETE`
   with 3 modifications and no replacements.

### Why two attempts failed first

- 09:55Z — CloudFront 409: *"incorrectly configured DNS record that points to
  another CloudFront distribution"*. DNS had not yet been changed.
- 18:51Z — CloudFront 409: *"One or more of the CNAMEs you provided are already
  associated with a different resource"*. DNS was correct by then; the old
  distribution still held the alias. **An alias cannot be moved between AWS
  accounts without releasing it from the source distribution first**
  (`associate-alias` is same-account only), which is why a short outage window
  is unavoidable.

### Verification

| Check | Result |
|---|---|
| Served cert serial, apex and www | `06AD7ADE8F080F09A00B57711A7CF645` = new account ACM cert (old was `0B3992C1…`) |
| apex / www / `/api/healthz` | 200 / 200 / `{"status":"ok"}` |
| Lambda env drift after stack update | 0 of 75 vars |
| Auth gate | 8 protected routes 401; `/api/admin/*` 403 |
| SPA rewrite | unknown routes → 200 |
| `/api*` behavior | `Compress: false`, `OriginReadTimeout: 60` (SSE-safe) |
| Alarms | 6, all `OK` |

### Rollback

Re-add both aliases to `EDTEON6GFBEZH` with cert `62ff8b55-…`, remove them from
`E36OKTEHMEZQ4N`, and repoint Hostinger to `d2bcwj2idfdwb4.cloudfront.net`.
Same downtime characteristics in reverse.

### Known drift, still outstanding

The deployed stack template is a migration snapshot (`LiveEnv001`–`LiveEnv074`,
`LiveApiImageUri`) and does not match `deploy/aws-serverless/template.yml`, which
has since gained 37 parameters and 3 resources. CI therefore **no longer runs
`cloudformation deploy`** — it updates the Lambda image and static site directly.
See the CI/CD section of `CLAUDE.md`. Reconciliation requires importing the
existing `ytgrabber-green-cooldowns` table into the stack and regenerating the
`ENV_GREEN_CONTENT` secret from the live function.


### Reconciliation step 1 — cooldowns table imported (2026-07-28)

`ytgrabber-green-cooldowns` existed in the account but was created outside the
stack, so `deploy/aws-serverless/template.yml` (which declares it) could never be
deployed — CloudFormation would attempt CREATE and fail on the existing name.

Imported via change set `import-cooldowns-20260728`
(`--change-set-type IMPORT`, `DeletionPolicy: Retain`). The live table's schema was
verified against the template definition first — `pk`/`S` HASH key,
`PAY_PER_REQUEST`, TTL `expiresAt` enabled — since import fails on mismatch. The
change set contained exactly one change (`Import CooldownsTable`) and no
modifications to any other resource. Result `IMPORT_COMPLETE`; the stack now
manages 11 resources and the table is unchanged (`ACTIVE`, 0 items).

Still outstanding before the repo template can be deployed: `ApiFunctionAsyncInvokeConfig`
and `StaticSecurityHeadersPolicy` are absent from the stack, 37 parameters are
missing, and the function environment must move off the `LiveEnv001`–`LiveEnv074`
snapshot onto named parameters — which rewrites all 75 env vars in one operation
and requires `ENV_GREEN_CONTENT` to be correct for this account.

## 13. Target-only production closeout — 2026-07-28 IST

This section supersedes earlier “remaining” lists where they conflict. Every AWS call
in this closeout used only profile `new-account` / account `386318011485`. The old
account was neither queried nor changed. Historical job migration is explicitly out of
scope by owner decision; the earlier eligible-media/job parity gaps are therefore not
cutover blockers. GPU/Translator, HeyGen, Pita Ji, and Workspace/Drive were not tested.

### Live production state

- `https://videomaking.in`, `https://www.videomaking.in`, and
  `https://videomaking.in/api/healthz` return HTTP 200; health reports `ok`.
- CloudFront distribution `E36OKTEHMEZQ4N`
  (`dq163fbjr1do7.cloudfront.net`) owns both production aliases. ACM certificate
  `d849e124-73a0-41bd-ae85-2a378a51ba43` is `ISSUED` and in use by that distribution.
- The old distribution has no production aliases and remains enabled only as a rollback
  target. Do not change or remove it without separate authorization.
- The final API image is
  `386318011485.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:89ee9903`.
  The active normal worker is Batch definition `ytgrabber-green-worker-job:11`, using
  `386318011485.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-worker:89ee9903`.

### Subtitle failure root cause and verified fix

Two production subtitle jobs failed because Gemini returned repeated HTTP 503
high-demand/quota responses. The first fallback implementation still failed because a
primary-model 503 put every key into a global cooldown during that same request, so the
alternate model skipped all keys. Commits `f35b681c` and `89ee990` now:

- use an environment-configurable text model ladder, defaulting to
  `gemini-3.5-flash,gemini-2.5-flash`;
- preserve alternate-model attempts for keys that were not cooling before the request;
- retain deterministic SRT structural checks; and
- deliver the translated SRT with a warning when only the optional AI verification pass
  is unavailable.

GitHub deployment run `30363120699` succeeded. A real CLI-only production smoke test
then completed upload, transcription, Hindi translation, verification, and delivery in
about 90 seconds. Its exact S3 output and both the failed and successful test job records
were removed; a follow-up prefix query found zero matching S3 objects.

The locally modified New Tab implementation was typechecked and reviewed but remains
undeployed. It creates/plans project records, while its Phase 2 execution runner and
cancellation are explicitly not implemented; deploying it now would create projects
that never execute clips.

### GitHub deployment security

- GitHub OIDC role `ytgrabber-green-gha-deployer` no longer has
  `AdministratorAccess` or any other attached managed policy.
- Its inline `deploy` policy is repository-controlled in `deploy-policy.json` and is
  limited to the target ECR repositories, target Lambda, target static/output S3 paths,
  target CloudFront distribution, live stack read, Batch job-definition registration,
  and passing only the two Batch runtime roles. AWS Access Analyzer reports zero policy
  findings.
- The first least-privilege test exposed one required action,
  `batch:TagResource`; only that action was added. Full OIDC workflow run `30364032848`
  then passed ECR builds/pushes, Batch registration, Lambda update, static S3 sync,
  CloudFront invalidation, and ECR lifecycle application.
- Obsolete repository secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` were
  deleted. Deployments are OIDC-only.
- IAM user `newbackup` still has the active key used by local profile `new-account`.
  Do not deactivate it until an alternate CLI login (for example IAM Identity Center or
  another short-lived credential path) is configured and proven; then rotate/remove it.

### CloudFormation ownership boundary

The imported stack is healthy: status `IMPORT_COMPLETE`, 11 owned resources, and zero
drifted resources. It still has 162 migration-snapshot parameters, whereas repository
`deploy/aws-serverless/template.yml` has 121 named parameters and additionally defines
`ApiFunctionAsyncInvokeConfig` and `StaticSecurityHeadersPolicy`. A blind repository
deploy was deliberately not executed because it would rewrite the complete Lambda
environment and change resource ownership in one operation.

Required safe follow-up: generate the target account's complete named parameter set
from live configuration without logging secrets, create a no-execute UPDATE change set,
require zero replacements/deletions and explicit review of both additions, then execute
and rerun drift plus authenticated acceptance. Until then, CI's direct Lambda/static
deployment path is the verified production path.

### Remaining human-only item

SNS topic `ytgrabber-green-alerts-email` is connected to all six alarms, but its email
subscription remains `PendingConfirmation`. The operator must click the AWS confirmation
email; only then can end-to-end alarm delivery be tested. This is the sole required
human action recorded by this closeout.
