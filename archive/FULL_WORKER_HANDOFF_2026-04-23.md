# Full Worker Handoff - 2026-04-23

This document is the current handoff for a new worker or thread taking over the VideoMaking.in migration/debug effort. It is intended to replace ad hoc oral history and to prevent another agent from losing time by trusting stale docs, assuming repo equals production, or repeating failed deploy loops.

Two existing docs are now stale and partially contradictory:

- `MASTER_EXECUTION_BOOK.md`
- `AGENT_HANDOFF_2026-04-22.md`

Do not edit those files for this handoff. Read them only as historical artifacts. They contain useful names and earlier reasoning, but they no longer reflect the current repo/live relationship.

This handoff is based on four things combined:

1. The user-provided context for the last two days of work.
2. The current repository state on `main` at commit `971dcf771957216aa18f9843823867e346fa570d` dated 2026-04-23 IST.
3. Read-only inspection of relevant repo files and scratch scripts in this workspace.
4. Read-only AWS verification performed on 2026-04-23 against account `596596146505` in `us-east-1`.

Where something is verified live, it is called out as verified. Where something is inferred from repo state or recent scratch files, it is called out as inferred. Where something is still unclear, it is called out as uncertain.

## Product Goal And User Constraints

The product is VideoMaking.in, with primary flows:

- Download
- Best Clips
- Subtitles
- Clip Cut

The business/technical goal is not just "make the site work once." The actual goal is to finish the long-running migration away from older always-on EC2 plus Caddy plus docker-compose runtime paths and onto a cheaper and more controllable AWS architecture:

- CloudFront + S3 for the frontend
- Lambda + API Gateway for control-plane/API/auth/status
- AWS Batch queue workers for heavy processing
- DynamoDB for durable job state
- S3 for outputs and uploads

The user's constraints matter as much as the code:

- The user is frustrated after two days of mixed deploy/debug work.
- Another worker must be able to continue without rediscovering the same failures.
- We must not assume repo state equals production state.
- We must not assume CloudFormation state equals actual runtime state.
- We must not "clean up" by reverting unrelated changes in the repo.
- We must not touch old docs except by describing their staleness.
- The next worker should optimize for consolidation and reproducibility, not for one more improvised live patch.

## What The User Actually Meant And Repeatedly Asked For

This section matters because a lot of wasted time came from technically correct work that did not match the user's real operating priority.

The user repeatedly meant the following:

- They wanted the website itself to be the truth, not just the repo.
- They wanted the final architecture to eliminate unnecessary always-on cost, not just "make the current box work."
- They wanted all four tabs to work from the public site, with no cookie/bot/quota surprises visible to users.
- They wanted no silent drift between repo, GitHub `main`, and live AWS.
- They did not want another agent to start over from old assumptions, re-run dead-end experiments, or redo the same migration phases again.
- They strongly cared about practical continuity: if a job starts, refresh/reopen/history/activity should still make sense.
- They were specifically sensitive to the following user-facing failures:
  - `Queued - starting soon...` appearing forever
  - yt-dlp bot/cookie errors
  - subtitles/best-clips AI failures from bad key rotation or quota issues
  - older UI/mobile states still appearing on the public site after code changes
  - "repo has code but website does not"

In other words, the user's definition of success is:

- GitHub `main` contains the intended final code
- live website is actually running that intended code and architecture
- old deployment ambiguity is gone
- no obvious regressions remain in the main flows

That sounds obvious, but several earlier decisions optimized for local correctness or emergency runtime repair instead of that exact definition.

## Short Executive State

The most important truth is this:

Production currently appears to be functionally working for the core flows because the backend/runtime was patched directly in AWS, not because the entire repo was cleanly redeployed end-to-end from source.

That means there are effectively three realities right now:

1. Old historical EC2/Caddy/docker-compose deployment paths still exist in the repo and in old documentation.
2. `main` now contains a large migration/runtime snapshot commit with serverless, queue, worker, S3, and UI changes.
3. Live AWS runtime has additional direct changes and drift that are not guaranteed to be fully represented by the repo or by CloudFormation.

The user's stated recent smoke result is that Download, Clip Cut, Best Clips, and Subtitles all succeeded after refreshing yt-dlp cookies in S3 and wiring Lambda plus worker cookie usage correctly. I did not rerun those full end-to-end smokes in this session, but the repo, scratch files, and current AWS state are consistent with that recent outcome.

## Direct Live AWS Mutations That Were Done Outside A Clean Repo Deploy

This is one of the most important sections in the whole handoff.

The next worker must assume that the currently working runtime was achieved through direct live AWS mutations in addition to repo changes. That is the main reason repo/live drift exists.

The following direct-live actions are known or strongly evidenced:

- Lambda image was updated directly to a newer ECR image tag after the CloudFormation-managed image parameter path had already existed.
- Lambda environment variables were updated directly through `aws lambda update-function-configuration`.
- Lambda ended up with:
  - `YTDLP_COOKIES_BASE64` blank
  - `YTDLP_COOKIES_S3_KEY` set
  - queue-primary enabled for all four job types
- The S3 cookie object at:
  - `s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt`
  was refreshed directly from a newer browser cookie export.
- Batch worker job definition revisions were advanced live.
- The active worker revision became one that uses `YTDLP_COOKIES_S3_KEY` instead of relying on large inline cookie env overrides.
- Public smoke jobs were run against `videomaking.in` while those live updates were happening.

The practical consequence is:

- do not assume that "deploy stack from repo" will preserve the currently working runtime unless the worker first reconciles those live changes back into the deploy path.

## Failure Chronology That Caused Most Of The Lost Time

The failures were not random. They happened in a fairly consistent chain.

### 1. Migration was partially real before it was fully reproducible

Queue-worker infra, DynamoDB durable state, Batch jobs, S3 outputs, and Lambda control-plane work were all real. But they did not land as one clean, reproducible, final deploy. This created a recurring false impression that "most of it is done" while production still depended on live patches and drift.

### 2. Repo contained two truths at once

The repo kept both:

- legacy EC2/Caddy/docker-compose deployment assumptions
- newer serverless/queue-worker deployment assumptions

This made it easy to reason incorrectly about what "deploy" meant in any given moment.

### 3. Docker/ECR/image build friction slowed the clean serverless path

Earlier work hit real build/deploy friction:

- Docker daemon was down during image build/push attempts
- ECR bootstrap logic was brittle in PowerShell
- PowerShell error behavior around native commands caused false-failure control flow
- image push scripts and Batch push logic hung or behaved inconsistently
- Lambda image formatting/buildx details caused additional deploy failures

These were not conceptual AWS architecture problems. They were tooling and packaging friction that delayed a clean end-to-end deploy.

### 4. CloudFormation and live runtime diverged

As the clean deploy path stalled, fixes were applied directly in AWS so the site could keep moving. That made the website more functional, but it also made repo and live state diverge further.

### 5. yt-dlp cookie handling was the biggest runtime trap

The most expensive technical mistake was treating cookies as if they could be passed around like normal tiny env vars.

Failures that came from this:

- bot/anti-abuse failures on YouTube fetches
- Batch `containerOverrides` payload size issues
- confusion between cookie file path, cookie base64 env, and cookie S3 object workflows
- uncertainty about whether Lambda or worker was actually reading the valid cookie source

The durable conclusion is:

- large yt-dlp cookies should be treated as a stored secret/blob path problem, not an inline override problem

### 6. UI symptoms hid backend state symptoms

Some user-facing problems looked like UI bugs but were actually state or queue timing issues:

- `Queued - starting soon...` for too long
- job disappears on refresh
- activity panel not reflecting completion immediately
- old screen still visible even after code changed

These failures were amplified by the fact that backend/runtime, frontend UI, and deploy work were all moving at once.

## Exact Local-Only Artifacts That Were Intentionally Not Pushed

At the time this handoff was created, the following classes of files were intentionally kept local and not pushed to GitHub:

- local scratch/runtime files:
  - `scratch/`
  - `tmp-api-cookies.txt`
  - `tmp-live-cookies.txt`
  - `tmp-live-smoke-cookies.txt`
  - `tmp-ytdlp-cookies-base64.txt`
- local env/runtime-only files:
  - `deploy/ec2/.env.green`
  - `deploy/ec2/.env.green.deploytmp`
- local tool output:
  - `.playwright-cli/`

This matters because another worker might otherwise incorrectly conclude "if it is not in repo, it was not used." Some of these files were used during live verification and recovery, but were correctly excluded from Git because they were local, secret-bearing, or disposable.

## Architecture Phases

The migration has happened in overlapping phases rather than one clean cut.

### Phase 0: Legacy Runtime

Historically the app ran through EC2 with Caddy and docker-compose. The repo still contains that path:

- `docker-compose.yml`
- `deploy/ec2/Caddyfile`
- `deploy/ec2/README.md`
- `deploy/ec2/deploy-green.ps1`
- `deploy/ec2/deploy-over-ssh.ps1`
- `deploy/ec2/provision-green.ps1`
- env examples under `deploy/ec2`

This path is why old docs talk about green deployments, Caddy, and EC2 runtime assumptions.

### Phase 1: Queue/Worker Introduction

The repo then gained AWS queue-worker infrastructure under:

- `deploy/aws-queue/*`
- `artifacts/queue-worker/*`
- `artifacts/api-server/src/lib/youtube-queue.ts`

Originally this appears to have started as a migration for only part of the product, then expanded. The queue model became the durable job/state path via DynamoDB and Batch.

### Phase 2: Serverless Control Plane

The repo gained the serverless control plane:

- `deploy/aws-serverless/template.yml`
- `deploy/aws-serverless/deploy-serverless.ps1`
- `deploy/aws-serverless/push-api-lambda-image.ps1`
- `Dockerfile.api-lambda`
- `artifacts/api-server/src/lambda.ts`

This moved API/auth/status paths to Lambda behind API Gateway and CloudFront, with S3-backed static frontend hosting.

### Phase 3: Frontend/UX Adaptation To Queue Reality

The frontend was then changed so activity/history panels could tolerate queue-backed jobs, refreshes, delayed status propagation, and durable history:

- `artifacts/yt-downloader/src/hooks/use-activity-feed.ts`
- `artifacts/yt-downloader/src/pages/Home.tsx`
- `artifacts/yt-downloader/src/components/BestClips.tsx`
- `artifacts/yt-downloader/src/components/ClipCutter.tsx`
- `artifacts/yt-downloader/src/components/GetSubtitles.tsx`
- related activity/history/push notification files

This matters because the migration was not only infra. UI assumptions also changed. That is one reason the big snapshot commit is hard to reason about.

### Phase 4: Live Runtime Hotfixing

After repo changes landed, production still did not fully stabilize through a single clean repo-driven deployment. The runtime was then patched directly in AWS to get the flows working. Based on verified AWS state plus scratch files, this phase included:

- direct Lambda environment/runtime changes
- direct Lambda image drift relative to CloudFormation stack parameters
- newer AWS Batch job definition revisions
- moving yt-dlp cookies into S3 and loading them from both Lambda and worker
- live smoke testing against CloudFront and the public domain

This is the current source of most confusion.

## What Landed In GitHub/Main

`main` currently points to commit `971dcf771957216aa18f9843823867e346fa570d` with message:

`Add AWS queue/serverless migration and production runtime fixes`

This commit is the large migration/runtime snapshot the user referenced. User context says it came from a safety branch; Git metadata in this clone shows it as the current main-tip commit rather than a merge commit. Operationally, treat it as the repo snapshot that attempted to collect the migration and runtime fixes in one place.

Diff size for that commit versus its parent:

- 51 files changed
- 6977 insertions
- 410 deletions

That size is part of the problem. Infra, runtime, API logic, worker logic, frontend behavior, deploy scripts, and docs all moved together.

## What Code Paths Were Changed

The meaningful code-path changes on repo `main` are these.

### API server and Lambda packaging

- `artifacts/api-server/src/app.ts`
  - login/auth handling
  - Lambda raw body parsing hardening
  - static-serving toggle for Lambda via `DISABLE_STATIC_SERVE`
  - API-only behavior behind CloudFront/API Gateway
- `artifacts/api-server/src/lambda.ts`
  - Lambda entrypoint
- `Dockerfile.api-lambda`
  - API image packaging for Lambda
- `artifacts/api-server/build.mjs`
  - build output adjustments for Lambda/serverless packaging

### Queue submission and state reconciliation

- `artifacts/api-server/src/lib/youtube-queue.ts`
  - Batch submit path
  - DynamoDB job-state writes
  - queue primary/shadow gating by job type
  - Batch job reconciliation for stale queued/running states
  - cancel/terminate flow
  - crucial fix direction: only small runtime metadata should go through `containerOverrides.environment`

This file is especially important because older docs claimed it had become zero bytes. That is no longer true in the current repo. The file is present and substantial on `main`, which is one reason the older handoff is stale.

### YouTube/download/clip routes

- `artifacts/api-server/src/routes/youtube.ts`
  - queue-aware handling for download, clip-cut, and best-clips flows
  - S3 output integration
  - yt-dlp cookie loading
  - yt-dlp fallback/client behavior
  - worker-primary control path

### Subtitles routes

- `artifacts/api-server/src/routes/subtitles.ts`
  - queue-aware subtitles generation
  - upload/S3 helpers
  - retry-oriented behavior for transient failures
  - durable status checks

### S3 storage integration

- `artifacts/api-server/src/lib/s3-storage.ts`
  - S3 upload/download helper path
  - signed downloads
  - cleanup path
  - storage key namespacing under object prefixes

### Queue worker runtime

- `artifacts/queue-worker/src/index.ts`
  - actual Batch worker execution
  - DynamoDB updates
  - S3 output writing
  - cookie loading from base64 and/or S3
  - job-type execution for download, clip-cut, subtitles, and best-clips related work
  - yt-dlp process execution and fallbacks

### Frontend behavior for queue-backed jobs

- `artifacts/yt-downloader/src/hooks/use-activity-feed.ts`
  - active/completed job sync with server
  - grace periods for transient `404` on queue-backed jobs
  - durable client-side history behavior
- `artifacts/yt-downloader/src/pages/Home.tsx`
  - active job restoration
  - push-notification wiring
  - tab flow integration
- `artifacts/yt-downloader/src/components/BestClips.tsx`
- `artifacts/yt-downloader/src/components/ClipCutter.tsx`
- `artifacts/yt-downloader/src/components/GetSubtitles.tsx`
- `artifacts/yt-downloader/src/components/FloatingActivityPanel.tsx`
- `artifacts/yt-downloader/src/components/GlobalHistoryPanel.tsx`

These frontend changes are real behavior changes, not cosmetic changes. They exist because refresh/reopen and long-running queue jobs broke older UI assumptions.

### Deploy tooling

- `deploy/aws-serverless/*`
  - CloudFormation-based serverless deploy path
  - Lambda image push
  - DNS/certificate and cookies runbooks
- `deploy/aws-queue/*`
  - Batch/ECR/alarms/resource creation
  - worker image push
  - test submit path

## AWS Services And Resources Involved

The currently relevant AWS and adjacent resources, using verified live names where available, are below.

### CloudFormation

Verified live stack:

- `ytgrabber-green-serverless`

Verified on 2026-04-23:

- status: `UPDATE_COMPLETE`
- last updated: 2026-04-22T17:52:04Z

Verified stack outputs:

- Lambda function: `ytgrabber-green-api`
- HTTP API endpoint: `https://1ru54qm40m.execute-api.us-east-1.amazonaws.com`
- CloudFront distribution id: `EDTEON6GFBEZH`
- CloudFront domain: `d2bcwj2idfdwb4.cloudfront.net`
- static site bucket: `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh`

Important warning: the deployed CloudFormation template does not match the repo template exactly anymore. Live CloudFormation still exposes an older parameter named `YtdlpCookiesBase64`, while the current repo template on disk has moved to `YtdlpCookiesS3Key` and no longer defines that old parameter. This is direct evidence of repo/live drift.

### CloudFront

Verified live distribution:

- id: `EDTEON6GFBEZH`
- status: `Deployed`
- aliases: `videomaking.in`, `www.videomaking.in`

Verified origins:

- `1ru54qm40m.execute-api.us-east-1.amazonaws.com`
- `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh.s3.us-east-1.amazonaws.com`

Verified health check:

- `https://videomaking.in/api/healthz` returned `{"status":"ok"}` on 2026-04-23

This directly contradicts the stale claim in `MASTER_EXECUTION_BOOK.md` that apex/domain cutover was still incomplete in the older sense described there.

### Lambda

Verified live function:

- `ytgrabber-green-api`

Verified live config facts:

- package type: image
- timeout: 29 seconds
- memory: 1536 MB
- state: `Active`
- last modified: 2026-04-22T21:31:23Z

Verified live environment shape, without reproducing secrets:

- queue is primary-enabled
- primary job types are all four core flows: `best-clips, clip-cut, download, subtitles`
- `YTDLP_COOKIES_BASE64` is blank
- `YTDLP_COOKIES_S3_KEY` is set
- S3 output bucket/prefix are configured

Important drift detail:

- CloudFormation stack parameters still say the image URI parameter is `...:20260422-fix-queue-env2`
- Lambda code SHA matches the ECR image tag `20260423-ytdlp-bin-s3cookies`

That strongly suggests Lambda was updated live after the CloudFormation-declared image state. In other words, live Lambda is ahead of or different from what the stack parameters claim.

### API Gateway

Verified live HTTP API:

- id: `1ru54qm40m`
- endpoint: `https://1ru54qm40m.execute-api.us-east-1.amazonaws.com`

### AWS Batch

Verified compute environment:

- `ytgrabber-green-compute-fargate`
- state: `ENABLED`
- status: `VALID`
- type: `MANAGED`
- max vCPUs: `6`

Verified job queue:

- `ytgrabber-green-job-queue`
- state: `ENABLED`
- status: `VALID`

Verified active job definition revision in use:

- `ytgrabber-green-worker-job:19`
- image reference in job definition: `596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-worker:latest`

Verified worker env shape for revision 19 includes:

- `S3_BUCKET`
- `S3_REGION`
- `S3_OBJECT_PREFIX`
- `JOB_TABLE`
- `QUEUE_URL`
- `YTDLP_COOKIES_S3_KEY`
- Gemini/AssemblyAI related keys
- VAPID keys
- `YTDLP_POT_PROVIDER_URL`

Important operational problem here:

- the worker job definition uses mutable tag `:latest`

That makes provenance weaker than it should be. The worker code currently running in Batch is not as reproducibly pinned as it should be.

### DynamoDB

Verified table:

- `ytgrabber-green-jobs`
- status: `ACTIVE`
- billing mode: `PAY_PER_REQUEST`
- partition key: `jobId`

Observed item count at inspection time:

- 157

This table is the durable queue/job state backbone for refresh/reopen continuity.

### S3

Verified relevant buckets/paths:

- static site bucket: `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh`
- output bucket: `malikaeditorr`
- cookie secret object: `s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt`

Verified cookie object facts:

- it exists
- last modified: 2026-04-22 21:21:11 GMT
- size: 9964 bytes

That is a major clue. It matches the user's note that live stabilization happened after refreshing yt-dlp cookies in S3.

### ECR

Verified repositories:

- `ytgrabber-green-api-lambda`
- `ytgrabber-green-worker`

Verified relevant images:

- API image tag `20260423-ytdlp-bin-s3cookies` exists and matches the current Lambda code SHA.
- Worker image tag `latest` exists and was pushed after older immutable worker tags.
- Older worker digest `sha256:c37b5586...` still exists in ECR and matches earlier documentation.

### CloudWatch Logs

Expected/verified log groups in use:

- `/aws/lambda/ytgrabber-green-api`
- `/aws/batch/job/ytgrabber-green-worker`

### DNS / Certificate / External Provider

CloudFront is configured for both `videomaking.in` and `www.videomaking.in`.

The older docs discuss Hostinger DNS and certificate cutover as still pending or partially pending. That is stale in the narrow sense that the public apex health endpoint is currently answering through the new path. Do not let an agent restart DNS drama unless testing proves a real current DNS issue.

## Key Failures And Conflicts Encountered

This section is the part future workers are most likely to need.

### 1. Docker daemon down / local container friction

There was friction around container build and deploy loops on the local machine. This matters because the migration depended on building and pushing both API Lambda images and worker images. If Docker is down or flaky, repo-driven deploy work derails immediately and tempts the worker into one-off live AWS patching instead.

### 2. ECR push friction

There were repeated pushes for both Lambda and worker images. The ECR history shows many close-together tags, including hotfix-named images. This is a sign that image provenance became blurred during debugging. Once tags like `fix-queue-env`, `auth-body-fix`, `current-sync`, and `ytdlp-bin-s3cookies` start stacking up, it becomes hard to know what truly runs live without checking AWS directly.

### 3. Lambda environment and runtime drift

Lambda stopped being a pure function of repo + CloudFormation. The live function now reflects direct changes that are not cleanly captured by the repo deploy scripts alone. The most visible example is cookie handling:

- old/deployed stack template still references `YtdlpCookiesBase64`
- live Lambda environment uses blank `YTDLP_COOKIES_BASE64`
- live Lambda environment uses `YTDLP_COOKIES_S3_KEY`
- current repo template also expects the S3-key pattern

That means at least part of the live function state was corrected outside the original stack template lineage.

### 4. Oversized Batch env / container override failure

One of the most concrete failures was:

- `Container Overrides length must be at most 8192`

Root cause:

- large yt-dlp cookie data was being pushed through per-job `containerOverrides.environment` rather than staying in job-definition or external storage

Correct direction:

- small per-job metadata only in `containerOverrides`
- large cookie payload stored outside overrides
- Batch worker should load cookies from S3 or fixed env at job-definition level

This is now one of the core "do not repeat" lessons.

### 5. Cookie handling drift

Cookie handling changed across several conceptual stages:

1. raw or large cookie values in env
2. deploy-size concern for Lambda/CloudFormation
3. Batch override-size failure
4. move toward S3-hosted cookie payload
5. Lambda and worker both reading from S3-backed cookie path

The fact that the live S3 cookie object exists and is recent strongly suggests this was the winning operational fix.

### 6. Mixed deploy paths

This was not a single deploy system. It became a mixture of:

- repo changes
- CloudFormation deploys
- direct Lambda changes
- direct Batch job-definition registration
- ECR pushes
- S3 secret updates
- scratch PowerShell smoke scripts

That mixture is exactly why the user is frustrated. There was no single source of truth by the end.

### 7. Repo/live drift

This is the deepest issue, not just an inconvenience.

Examples now verified:

- CloudFormation live template shape differs from repo template shape.
- CloudFormation image parameter does not fully explain the currently running Lambda code.
- worker job definition is on revision 19 and uses mutable `:latest`.
- recent success depends on S3 cookie object state, not just committed code.

### 8. UI and infra changes were mixed together

The big snapshot commit bundled:

- infra creation
- serverless packaging
- queue state logic
- S3 storage
- auth fixes
- subtitles retries
- frontend queue-history behavior
- push notification changes

That made it much harder to isolate regressions. It also means "revert the last bad change" is not a serious strategy.

### 9. Stale docs created false confidence

`AGENT_HANDOFF_2026-04-22.md` is now dangerous if followed literally. It still describes:

- `youtube-queue.ts` as zero bytes
- older Batch revision assumptions
- earlier cookie/env assumptions

`MASTER_EXECUTION_BOOK.md` is also stale. It still discusses DNS and EC2/runtime cutover state in a way that no longer matches the verified public health result and current CloudFront alias setup.

## What Is Believed To Be Live Now

The following is either directly verified today or strongly supported by today's verified state plus the user's recent smoke-test summary.

### Verified live now

- Public health endpoint `https://videomaking.in/api/healthz` is healthy.
- CloudFront distribution `EDTEON6GFBEZH` is deployed and serves both apex and `www`.
- Lambda control plane is active and queue-primary for all four core flows.
- DynamoDB durable job table is active.
- Batch compute environment and queue are valid/enabled.
- Active worker job definition revision is `:19`.
- Both Lambda and worker are wired to use `YTDLP_COOKIES_S3_KEY`.
- The S3 cookie object exists and was refreshed recently on 2026-04-22.

### Very likely live now, based on user summary plus current runtime shape

- Download works through the queue-backed/serverless path.
- Clip Cut works through the queue-backed/serverless path.
- Best Clips works through the queue-backed/serverless path.
- Subtitles works through the queue-backed/serverless path.

The strongest support for that claim is:

- the user explicitly reported recent successful smokes for all four flows
- scratch files and smoke scripts from late 2026-04-22 / early 2026-04-23 show active testing of those flows
- current live cookie setup is consistent with the reported fix

## What Is Only In Repo/Main Now

The repo contains a coherent intended architecture, but not every part is guaranteed to be what production is running.

What is safely described as present on `main`:

- serverless deploy scripts and template
- queue infrastructure scripts
- API queue submission/reconciliation logic
- Batch worker implementation
- S3-backed storage logic
- Lambda packaging
- frontend activity/history adjustments
- updated runbooks for DNS/cookies

What is only "repo truth" and not automatically "live truth":

- exact current CloudFormation template parity
- exact current Lambda image provenance if redeployed from repo as-is
- exact current worker code provenance because live Batch uses `:latest`
- exact env/value mapping if a clean deploy is attempted from scratch

## What Was Actually Fixed Live

This is the practical heart of the last two days.

What appears to have actually fixed production live was not merely "merge code and deploy once." It was the combination of:

1. refreshing yt-dlp cookies
2. putting the cookie payload into S3
3. making Lambda use `YTDLP_COOKIES_S3_KEY`
4. making the worker use `YTDLP_COOKIES_S3_KEY`
5. ensuring the API no longer tried to shove oversized cookie data through Batch container overrides
6. validating the core flows again with smoke scripts

That is the effective live runtime fix pattern. If another worker forgets this and reintroduces inline or override-based cookie transport, they will likely recreate the same failures.

## What Remains Unresolved Or Uncertain

Several things are still not clean.

### 1. CloudFormation vs live runtime parity is unresolved

This is the single biggest unresolved technical issue. The live stack template shape and the repo template shape are not the same. A future repo-driven deploy could accidentally overwrite working live behavior unless the drift is reconciled first.

### 2. Lambda image provenance is not fully normalized

CloudFormation parameters point at one tag while the live Lambda code SHA matches a newer ECR image tag. That means the runtime may be depending on a direct image update path that is not reflected in the stack definition.

### 3. Worker provenance is weak because `:latest` is in the job definition

The live job definition points to `ytgrabber-green-worker:latest`. That makes rollback/comparison/debugging weaker than if the job definition used an immutable tag or digest.

### 4. The live deployed stack template is older than the repo template

This is not hypothetical. It was directly verified by the parameter mismatch around yt-dlp cookies.

### 5. `YTDLP_POT_PROVIDER_URL` in worker env may still be questionable

The live Batch worker env shape includes `YTDLP_POT_PROVIDER_URL`, and earlier patterns reference `http://bgutil-provider:4416`. In a standalone Batch Fargate worker, that local provider URL is suspicious unless some sidecar or networked provider exists, which is not evident from current repo deployment scripts. Because recent smokes reportedly passed after cookie refresh, this may currently be irrelevant in practice, but it is still a lurking inconsistency.

### 6. The exact line between "fixed in repo" and "fixed only in AWS" is still blurry

The repo clearly contains many of the intended fixes, but the currently working runtime was also hot-patched live. The next worker should assume there is still drift until proven otherwise by one clean, reproducible deploy and re-smoke.

### 7. Existing docs should not be trusted for step order

They are useful for names and historical context. They are not safe as operational runbooks anymore.

## What The Current Agent Was About To Do Next And Why

The correct next move was not "keep poking production until it works again." That phase already happened.

Based on the now-verified state, the current agent was effectively at the point where the next necessary action should have been:

1. freeze and document the real live AWS state
2. reconcile repo and CloudFormation to match the working live cookie/runtime setup
3. replace mutable/procedural drift with a clean repo-driven deploy path
4. rerun the same four smoke flows after that reproducible deploy

The reason is straightforward:

- live production appears working enough to stop emergency debugging
- the bigger remaining risk is a future deploy breaking the now-working runtime because the source of truth is split across repo, CloudFormation, Lambda direct updates, Batch revisions, and S3 secret objects

In practical terms, the next worker should start with a consolidation task, not a feature task:

First reconcile and codify the live cookie path, Lambda image, worker image, Batch revision assumptions, and stack template drift. Only after that should anyone consider this migration "done."

## Recommended Starting Point For The Next Worker

The next worker should treat this as a configuration-convergence problem, not a fresh bug hunt.

Recommended first actions:

1. Compare current repo `deploy/aws-serverless/template.yml` with the deployed stack template and normalize the cookie parameter model.
2. Decide what the canonical Lambda image tag should be, then make CloudFormation and live Lambda agree on it.
3. Replace worker `:latest` usage with an immutable image tag or digest in the Batch job definition path.
4. Preserve the S3 cookie object workflow and document it as the only supported large-cookie path.
5. Run the existing smoke pattern again for Download, Clip Cut, Best Clips, and Subtitles after that normalization.

The important strategic point is that the system is no longer in the "why is nothing working?" phase. It is in the "make the currently working state reproducible and safe" phase.

## Recommended Interpretation Of Current State

The current state should be interpreted as: the AWS migration basically succeeded functionally, but the success was finalized through direct live patching rather than a clean repo-to-production pipeline. The application is likely operational on the intended CloudFront + Lambda + Batch + DynamoDB + S3 architecture, but deploy reproducibility and source-of-truth discipline are still unfinished. The real remaining work is to eliminate repo/live/CloudFormation drift without regressing the now-working core flows.

## Key Commands Already Used And Worth Reusing

These are not the full two-day transcript. They are the commands that actually mattered and are worth keeping because they either worked, exposed real state, or helped avoid repeating blind guesses.

All commands below assume current workspace:

```powershell
cd "C:\Users\g_n-n\Desktop\apps\international-3 clone\International-3"
```

### 1. Git / repo state

Useful to understand whether work is only local, already committed, or already on `main`.

```powershell
git status --short
git branch --show-current
git log --oneline -n 8
git rev-parse HEAD
git remote -v
```

Useful when confirming `main` actually contains the intended migration snapshot:

```powershell
git checkout main
git log --oneline -n 5
```

### 2. CloudFormation / live stack inspection

These are the commands that clarified the real AWS state better than the old docs.

```powershell
aws cloudformation describe-stacks --region us-east-1 --stack-name ytgrabber-green-serverless
aws cloudformation get-template --region us-east-1 --stack-name ytgrabber-green-serverless
aws cloudformation describe-stack-events --region us-east-1 --stack-name ytgrabber-green-serverless
```

Use these to verify whether the deployed stack template still contains older parameter names such as `YtdlpCookiesBase64` or other drift relative to the repo template.

### 3. CloudFront / public site verification

These were useful to confirm the public path, API health, and domain routing:

```powershell
curl.exe -s https://videomaking.in/api/healthz
curl.exe -s https://www.videomaking.in/api/healthz
curl.exe -s https://d2bcwj2idfdwb4.cloudfront.net/api/healthz

aws cloudfront get-distribution --id EDTEON6GFBEZH
aws cloudfront list-distributions
```

### 4. Lambda inspection

These commands were repeatedly useful and should be reused instead of guessing Lambda state from docs.

```powershell
aws lambda get-function-configuration --region us-east-1 --function-name ytgrabber-green-api
aws lambda get-function --region us-east-1 --function-name ytgrabber-green-api
aws lambda wait function-updated --region us-east-1 --function-name ytgrabber-green-api
```

Direct Lambda image update pattern that was used successfully:

```powershell
aws lambda update-function-code `
  --region us-east-1 `
  --function-name ytgrabber-green-api `
  --image-uri 596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:20260423-ytdlp-bin-s3cookies
```

Direct Lambda env update pattern that ultimately worked better than the broken shorthand escaping approach:

```powershell
$cfg = aws lambda get-function-configuration --region us-east-1 --function-name ytgrabber-green-api | ConvertFrom-Json
$vars = @{}
$cfg.Environment.Variables.PSObject.Properties | ForEach-Object { $vars[$_.Name] = [string]$_.Value }
$vars['SESSION_SECRET'] = '<real-session-secret>'
$vars['YTDLP_COOKIES_S3_KEY'] = 'ytgrabber-green/secrets/ytdlp-cookies-base64.txt'
$payload = @{ FunctionName='ytgrabber-green-api'; Environment=@{ Variables=$vars } } | ConvertTo-Json -Compress -Depth 8
Set-Content '.\tmp-lambda-update.json' $payload -NoNewline
aws lambda update-function-configuration --region us-east-1 --cli-input-json file://tmp-lambda-update.json
```

Important lesson:

- do not use the ad hoc `Variables={A=B,C=D}` style when values contain `=` or similar escaping-sensitive characters unless you are absolutely sure of the escaping.
- the JSON file approach is safer.

### 5. ECR / Docker / image push

Useful to verify repos:

```powershell
aws ecr describe-repositories --region us-east-1
aws ecr describe-repositories --region us-east-1 --repository-names ytgrabber-green-api-lambda
aws ecr describe-repositories --region us-east-1 --repository-names ytgrabber-green-worker
```

Useful login pattern:

```powershell
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 596596146505.dkr.ecr.us-east-1.amazonaws.com
```

The Lambda-safe API image push script path used in this repo:

```powershell
.\deploy\aws-serverless\push-api-lambda-image.ps1 -Region us-east-1 -Prefix ytgrabber-green -ImageTag 20260423-ytdlp-bin-s3cookies
```

The worker push script path that existed, but direct push/build patterns also mattered during troubleshooting:

```powershell
.\deploy\aws-queue\push-worker-image.ps1 -Region us-east-1 -Prefix ytgrabber-green -ImageTag latest
```

Relevant direct buildx pattern that came up during troubleshooting:

```powershell
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push -f artifacts/queue-worker/Dockerfile -t 596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-worker:latest .
```

Important lesson:

- Docker daemon availability was a real blocker.
- OCI/provenance/attestation defaults can matter for Lambda image compatibility.

### 6. AWS Batch / worker inspection

These were the commands that exposed the real worker path and active revision state:

```powershell
aws batch describe-compute-environments --region us-east-1
aws batch describe-job-queues --region us-east-1
aws batch describe-job-definitions --region us-east-1 --job-definition-name ytgrabber-green-worker-job --status ACTIVE
aws batch list-jobs --region us-east-1 --job-queue ytgrabber-green-job-queue --job-status RUNNING
aws batch list-jobs --region us-east-1 --job-queue ytgrabber-green-job-queue --job-status SUCCEEDED
aws batch list-jobs --region us-east-1 --job-queue ytgrabber-green-job-queue --job-status FAILED
aws batch describe-jobs --region us-east-1 --jobs <job-id>
```

What these were used for:

- verifying active revision `ytgrabber-green-worker-job:19`
- confirming the job definition points at worker `:latest`
- confirming `YTDLP_COOKIES_S3_KEY` is set at the worker layer
- matching public job IDs with Batch job IDs and terminal state

### 7. S3 cookie refresh

This was one of the most practically important successful fixes.

The user provided newer cookie export files locally. The successful refresh pattern was:

```powershell
$raw = Get-Content 'C:\Users\g_n-n\Downloads\www.youtube.com_cookies (2).json' -Raw
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw))
Set-Content '.\tmp-ytdlp-cookies-base64.txt' $b64 -NoNewline
aws s3 cp .\tmp-ytdlp-cookies-base64.txt s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt --region us-east-1
```

Useful verification:

```powershell
aws s3 ls s3://malikaeditorr/ytgrabber-green/secrets/ --region us-east-1
```

Important lesson:

- use the newer, smaller YouTube-specific cookie export where possible
- S3 cookie object workflow is better than inline env override workflow for large cookies

### 8. Auth and session checks against the public domain

Useful login pattern for smoke tests:

```powershell
Set-Content .\tmp-login.json '{"username":"<user>","password":"<pass>"}' -NoNewline
curl.exe -s -c .\tmp-live-cookies.txt -H "content-type: application/json" --data-binary "@tmp-login.json" https://videomaking.in/api/auth/login
curl.exe -s -b .\tmp-live-cookies.txt https://videomaking.in/api/auth/session
```

This matters because all subsequent smoke tests reused the session cookie jar.

### 9. Public API smoke patterns

#### YouTube info

Useful for checking Lambda-side yt-dlp behavior without going through the whole UI:

```powershell
Set-Content .\tmp-info.json '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' -NoNewline
curl.exe -s -i -b .\tmp-live-cookies.txt -H "content-type: application/json" --data-binary "@tmp-info.json" https://videomaking.in/api/youtube/info
```

This was useful because it verified the standalone `yt-dlp` binary path in Lambda.

#### Clip Cut submit

```powershell
Set-Content '.\tmp-clipcut.json' '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","startTime":0,"endTime":5,"quality":"best"}' -NoNewline
curl.exe -s -b .\tmp-live-cookies.txt -H "content-type: application/json" --data-binary "@tmp-clipcut.json" https://videomaking.in/api/youtube/clip-cut
```

Clip Cut progress poll:

```powershell
$job='b9c278bb-05bd-4b1c-827d-e17792ce4e50'
for($i=0;$i -lt 40;$i++){
  $resp = curl.exe -s -b .\tmp-live-cookies.txt https://videomaking.in/api/youtube/progress/$job
  Write-Output $resp
  if($resp -match '"status":"(done|error|cancelled|expired)"'){ break }
  Start-Sleep -Seconds 3
}
```

#### Best Clips submit

```powershell
Set-Content '.\tmp-bestclips.json' '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","durations":[60],"auto":false}' -NoNewline
curl.exe -s -b .\tmp-live-cookies.txt -H "content-type: application/json" --data-binary "@tmp-bestclips.json" https://videomaking.in/api/youtube/clips
```

Best Clips status poll:

```powershell
$job='6ccb86bc-ab6b-4146-80d3-04e36757d4ef'
for($i=0;$i -lt 40;$i++){
  $resp = curl.exe -s -b .\tmp-live-cookies.txt https://videomaking.in/api/youtube/clips/status/$job
  Write-Output $resp
  if($resp -match '"status":"(done|error|cancelled|expired|not_found)"'){ break }
  Start-Sleep -Seconds 3
}
```

#### Download submit

```powershell
Set-Content '.\tmp-download.json' '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","formatId":"134+140"}' -NoNewline
curl.exe -s -b .\tmp-live-cookies.txt -H "content-type: application/json" --data-binary "@tmp-download.json" https://videomaking.in/api/youtube/download
```

Download progress poll:

```powershell
$job='9b9a648b-a5da-4b9a-b35a-b2e5598c936c'
for($i=0;$i -lt 50;$i++){
  $resp = curl.exe -s -b .\tmp-live-cookies.txt https://videomaking.in/api/youtube/progress/$job
  Write-Output $resp
  if($resp -match '"status":"(done|error|cancelled|expired)"'){ break }
  Start-Sleep -Seconds 3
}
```

#### Subtitles submit

```powershell
Set-Content '.\tmp-subtitles.json' '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","language":"auto"}' -NoNewline
curl.exe -s -b .\tmp-live-cookies.txt -H "content-type: application/json" --data-binary "@tmp-subtitles.json" https://videomaking.in/api/subtitles/generate
```

Subtitles status poll:

```powershell
$job='821e29d2-59e3-471f-9d5d-b6a5ce73152e'
for($i=0;$i -lt 60;$i++){
  $resp = curl.exe -s -b .\tmp-live-cookies.txt https://videomaking.in/api/subtitles/status/$job
  Write-Output $resp
  if($resp -match '"status":"(done|error|cancelled|expired|not_found)"'){ break }
  Start-Sleep -Seconds 3
}
```

### 10. Repo search/read commands that helped

Useful when confirming actual route names or status endpoints instead of guessing:

```powershell
Select-String -Path 'artifacts\api-server\src\routes\youtube.ts' -Pattern 'clip-cut|best-clips|router.post|router.get|/api/youtube/' -CaseSensitive:$false
Select-String -Path 'artifacts\api-server\src\routes\subtitles.ts' -Pattern 'router.post\(|router.get\(' -CaseSensitive:$false
```

And when `rg` was unavailable or blocked on this host, PowerShell `Select-String` was the more reliable fallback.

### 11. Helpful anti-confusion commands

These were useful to disprove stale assumptions quickly:

```powershell
aws cloudformation get-template --region us-east-1 --stack-name ytgrabber-green-serverless
aws lambda get-function-configuration --region us-east-1 --function-name ytgrabber-green-api
aws batch describe-job-definitions --region us-east-1 --job-definition-name ytgrabber-green-worker-job --status ACTIVE
curl.exe -s https://videomaking.in/api/healthz
git status --short
git log --oneline -n 5
```

These six commands together gave a better picture of reality than either stale docs or memory.

## What Not To Repeat

- Do not trust `MASTER_EXECUTION_BOOK.md` or `AGENT_HANDOFF_2026-04-22.md` as current truth.
- Do not assume repo `main` exactly matches live AWS.
- Do not assume CloudFormation stack parameters exactly match live Lambda runtime.
- Do not put large yt-dlp cookie payloads into Batch container overrides.
- Do not move cookies back into per-job overrides just because it seems convenient.
- Do not rely on mutable `:latest` tags for worker provenance longer than necessary.
- Do not mix another round of UI changes with deployment/debug work unless absolutely required.
- Do not restart EC2/Caddy/docker-compose work unless current production evidence proves the serverless path is broken.
- Do not "clean up" by reverting unrelated repo changes.
- Do not call the migration complete until one clean repo-driven deploy reproduces the current working runtime and the four core flows pass again.
