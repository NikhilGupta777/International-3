# AWS Live Audit — International-3 (VideoMaking Studio)

**Date:** 2026-07-22 · **Account:** `596596146505` · **Region:** `us-east-1`
**Method:** strictly read-only (`describe`/`list`/`get` + one `curl` healthz). No mutations.
**Authenticated as:** IAM user `NEW` (long-lived key `AKIA…XZFN`) via local AWS CLI.

Cross-checked live infra against `CLAUDE.md`, `whatnottodoaws.md`, and `deploy/aws-serverless/template.yml`.

---

## 🔴 CRITICAL — the June-16 incident conditions have been RE-CREATED (worse)

`whatnottodoaws.md` postmortem: the account was locked by AWS **3 times in 3 months**
because a **long-lived IAM key was accessible to an AI agent**, and it said the cures were
(a) kill long-lived keys, (b) never give keys to agents, (c) keep GuardDuty on. Live state:

1. **The key this CLI/agent is using (`NEW`) has full `AdministratorAccess`.**
   - Long-lived `AKIA…XZFN`, created **2026-06-17 — the day AFTER the lockout**, never rotated.
   - It is sitting in `~/.aws/credentials` on this machine, i.e. **available to any AI
     agent/tool run here** — the exact "key handed to an agent" root cause, now at *admin* scope.
2. **GuardDuty is OFF** — `list-detectors` returns `[]`. The postmortem said "keep it on —
   it's what flags compromised keys (it did its job here)." The detector that caught the
   previous 3 compromises has been disabled. So: fresh admin key exposed to agents **and**
   the safety net removed.
3. **A second undocumented long-lived key exists:** user `autom-mailer` (`AKIA…KGWC`,
   created 2026-07-10). *This one is correctly least-privileged* (inline `ses-send-only`),
   so it's low-risk — but it's undocumented automation.

**Recommended (do yourself — I will not touch IAM):**
- Stop using the `NEW` admin key from any agent/IDE. For local admin, prefer console/CloudShell
  or a short-lived scoped role. If a local key must exist, scope it down from `AdministratorAccess`.
- **Re-enable GuardDuty** in us-east-1.
- Rotate/retire `NEW`; confirm `autom-mailer` is intended.
- OIDC already works for CI (see below) — CI does **not** need any long-lived key.

---

## 🟢 What is correct / healthy

| Check | Live state | Verdict |
|---|---|---|
| Site health | `GET /api/healthz` → HTTP 200 `{"status":"ok"}` (7.8s cold) | UP |
| CloudFormation stack | `ytgrabber-green-serverless` = `UPDATE_COMPLETE`, updated 2026-07-20 | Healthy |
| Lambda Function URL | `AuthType: NONE`, `InvokeMode: RESPONSE_STREAM` | Matches design |
| CloudFront `/api*` | `Compress: false` | Correct (SSE-safe) |
| CloudFront api-origin | `OriginReadTimeout: 60` | Correct |
| GitHub OIDC | provider present; role `ytgrabber-green-gha-deployer` trusts `repo:NikhilGupta777/International-3:*`; **last used 2026-07-20** (matches last deploy) | Working — CI needs no static key |
| AWS Budget | "My Monthly Cost Budget" = $100 COST | Present (postmortem wanted one) |
| `autom-mailer` key | inline `ses-send-only` only | Least-privilege ✓ |

**Minor hardening:** the deployer role trust uses `sub = repo:NikhilGupta777/International-3:*`
(any branch/PR/environment). Consider scoping to `ref:refs/heads/main` or a deploy environment.

---

## 🟡 Doc-vs-reality drift found before the 2026-07-22 doc refresh

The initial audit found that CLAUDE.md's "Production Infrastructure" section under-documented the real account. Actual live state at audit time:

### Lambda
- `ytgrabber-green-api`: **3008 MB** memory, 900s timeout,
  5120 MB ephemeral, container image, **74 env vars**, State Active. The old doc value was **1536 MB** before refresh.
- **Undocumented Lambdas in the account:** `narayan-bhakt-bot-VmsWebhookFunction-*`,
  `narayan-bhakt-bot-TelegramFunction-*` (a separate Telegram bot SAM app), and
  `autom-watchdog` (nodejs20). None appear in CLAUDE.md.

### Env vars — naming has changed
- Live uses **plural consolidated** keys: `GEMINI_API_KEYS`, `NVIDIA_API_KEYS`,
  `OLLAMA_API_KEYS`, `GROQ_API_KEYS`, while the code still supports singular +
  numbered rotation (`GEMINI_API_KEY`, `NVIDIA_API_KEY`, etc.). Docs were refreshed
  to mention both forms.
- Live-only vars not in CLAUDE.md: `E2B_API_KEY`, `API_KEYS_TABLE`, `COOLDOWNS_TABLE`,
  `WEBHOOK_SIGNING_SECRET`, `SUPER_AGENT_ENABLED`, `TRANSLATOR_ENABLED`,
  `TRANSLATOR_LIP_SYNC_ENABLED`, `TRUST_PROXY_HOPS`, `LOGIN_BLOCK_MS`,
  `LOGIN_MAX_FAILURES`, `LOGIN_RATE_WINDOW_MS`, `PITAJI_FEATURE_ENABLED`,
  `API_ACCESS_EMAILS`, `S3_BUCKET_NAME` (in addition to `S3_BUCKET`),
  `UPLOADS_TABLE_KEY`, `API_KEY_RATE_LIMIT_PER_MIN`, `YOUTUBE_QUEUE_REGION`.
- `NVIDIA_API_KEYS` is live in prod — this is the same NVIDIA NIM credential family the
  Copilot "Ultra/Fast" modes use (glm-5.2 / gpt-oss-120b), consistent with CLAUDE.md's agent section.

### DynamoDB — 5 tables found
Live: `ytgrabber-green-jobs`, `ytgrabber-green-access`, `ytgrabber-green-cooldowns`,
`ytgrabber-uploads`, `narayan-bhakt-bot-BotTable-*`. Core docs were refreshed for
the relevant `ytgrabber-green-*` tables.

### Batch — 4 queues + 6 compute envs found
- Queues: `ytgrabber-green-job-queue`, `-gpu-queue`, `-gpu-fast-queue`, `-translator-cpu-queue` (all ENABLED/VALID).
- Compute envs: `compute-fargate` (FARGATE), `gpu-spot-v2`, `gpu-fast-v2` (EC2, 64 vCPU),
  `translator-cpu-compute` (SPOT) — ENABLED; `gpu-fast-compute` and `gpu-compute` — **DISABLED**
  (leftover/paused capacity worth confirming).

### ECR — 7 repos, doc lists 3
`ytgrabber-green-api-lambda`, `-worker`, `-translator`, plus undocumented:
`ytgrabber-green-translator-cpu`, `-translator-base`, `malika-editor`, and
**`ytgrabber-green-api-http`** — almost certainly the "emergency http api image" from the
June-16 panic spiral (postmortem). **Cleanup candidate.**

### S3 — 4 buckets, doc lists 2
`malikaeditorr` + static site bucket (documented); plus undocumented
`hyperframe-editor-596596146505-20260519` and `narayan-bhakt-bot-sam-596596146505`.

---

## Summary priority list
1. 🔴 Remove admin long-lived key from agent reach + re-enable GuardDuty (re-created incident risk).
2. 🟡 Confirm `autom-mailer` / `autom-watchdog` / `narayan-bhakt-bot` / `hyperframe-editor` are intended (undocumented automation & storage in a previously-compromised account).
3. 🟡 Delete leftover `ytgrabber-green-api-http` ECR repo + confirm the 2 DISABLED GPU compute envs.
4. 🟢 Refresh CLAUDE.md: Lambda 3008MB, plural API-key env vars, full table/queue/repo lists.
5. 🟢 Optional: scope OIDC trust `sub` to `main`/an environment instead of `*`.

*All checks above were read-only. No AWS resource was modified.*

---

## Addendum - 2026-07-22 13:55 IST

This addendum includes one AWS mutation explicitly requested by the owner: a Lambda
Service Quotas request. Everything else in this addendum was read-only audit or a
small production smoke test.

### Lambda concurrency quota request

Live applied quota before the request:

- Service: AWS Lambda
- Region: `us-east-1`
- Quota: `Concurrent executions` / `L-B99A9384`
- Applied value: `10`
- AWS default value: `1000`

The Service Quotas API rejected a direct request for `100` because it only accepts a
requested value greater than the AWS default of `1000`. A request for `1001` was then
submitted successfully.

- Request id: `b45fb4bb5e2841748ab225a45d806248bg1HnYLc`
- Desired value: `1001`
- Status after submission: `CASE_OPENED`

This quota increase does not create cost by itself. It only allows more simultaneous
Lambda execution when traffic or jobs actually use that capacity.

### Super Agent restricted screenshot audit

Screenshot observed text:

- Browser title/tab: `Super Agent | ...`
- UI card: `Super Agent is restricted`
- Detail: `Your account is not allowed to use Super Agent right now.`
- Phone status bar time: `7:06`

Code path:

- `artifacts/yt-downloader/src/pages/Home.tsx` renders this card when
  `authFeatures?.superAgentAllowed !== true`.
- `authFeatures` comes from `/api/auth/session` in `artifacts/yt-downloader/src/App.tsx`.
- Backend computes `superAgentAllowed` in `artifacts/api-server/src/app.ts` from
  `canUseSuperAgent(session.email)`.
- Live backend config allows Super Agent:
  - `SUPER_AGENT_ENABLED=true`
  - `SUPER_AGENT_ALLOWED_EMAILS` is empty, which means the feature is not email-restricted.

Audit windows:

- `2026-07-22 06:45-07:25 IST` (matching the phone time if interpreted as morning):
  - Lambda invocations: `5`
  - Lambda errors: `0`
  - Lambda throttles: `0`
  - `/api/auth/session`: HTTP `200`
  - `/api/auth/config`: HTTP `200`
- `2026-07-22 09:20-09:40 IST`:
  - Lambda invocations: `18`
  - Lambda errors: `1`
  - Lambda throttles: `0`
  - `/api/auth/google`: one HTTP `403`
  - follow-on `/api/agent/skills` and `/api/youtube/client-access`: HTTP `401`
  - one short Lambda `ECONNRESET` invoke error
- `2026-07-22 13:10-13:57 IST`:
  - Lambda invocations: `36`
  - Lambda errors: `0`
  - Lambda throttles: `0`
  - `/api/auth/session`: HTTP `200`

Conclusion: the screenshot is not explained by a global Lambda/API outage at `7:06`
IST. The most likely code-level explanation remains the frontend stale-auth/features
state: a browser can keep `videomaking.authenticated=1` while `authFeatures` is null
after a transient session/features fetch failure, causing the restricted card to render
inside the authenticated app shell.

### Lambda-fast clip test

A direct production Lambda worker invocation was run for a 5-second test clip, bypassing
the browser UI and Batch:

- Job id: `codex-audit-clip-de7f25f478bf`
- Invocation type: direct Lambda worker event, `source=videomaking.clip-cut`
- Result: HTTP invoke status `200`, no `FunctionError`
- Elapsed: `11.41s`
- DynamoDB status: `done`
- Progress: `100`
- Output file present in S3: yes
- Batch handoff: no

Conclusion: the current Lambda fast path works for a short eligible clip.

### Cost check

AWS Cost Explorer for `2026-07-01` through `2026-07-22` showed only tiny positive
usage line items, with offsetting/free-tier credits making net unblended cost
effectively `$0.00`:

- `AWS Lambda`: `$0.0056287706`
- `Amazon Elastic Container Service`: `$0.0022455039`
- Other positive line items were below `$0.000001`
- Offsetting/free-tier line item: `AWS Data Transfer = -$0.0078751172`

Conclusion: Batch max vCPUs and Lambda concurrency quota are capacity ceilings,
not 24/7 spend. Cost starts when jobs/invocations actually run.

### Docs refreshed from live state

Updated docs:

- `GUIDE.md`
- `DEPLOY.md`
- `deploy/aws-queue/README.md`
- `CLAUDE.md`
- `CODEX-HANDOFF-CRITICAL.md`
- `CICD_SETUP.md`
- `AWS-MASTER-SETUP-AND-MIGRATION.md`
- `replit.md`

Corrected production facts:

- Lambda `ytgrabber-green-api`: `3008 MB`, `900s`, deployed from commit `84da200c`,
  resolved digest `sha256:7d634b3d164fd30ad802edf93720a70fc1688e8b3359cf3a8c5808aa1966d31d`.
- Batch job definition: `ytgrabber-green-worker-job:744`.
- Batch Fargate max vCPUs: `16`, scale-to-zero.
- Live primary queue job types:
  `bhagwat-analyze,bhagwat-render,clip-cut,subtitles`.
- `LAMBDA_CLIP_MAX_DURATION_SECONDS=420`.
- `SUBTITLES_LAMBDA_MAX_DURATION_SECONDS=780`.
- `MAX_CONCURRENT_CLIP_JOBS=3`.
- `SUPER_AGENT_ENABLED=true`.

### Frontend remediation implemented

The false-restriction path was fixed in `artifacts/yt-downloader/src/App.tsx` on
2026-07-22:

- Each `/api/auth/session` attempt now handles and retries its own network,
  non-2xx, malformed-JSON, or incomplete-response failure.
- An authenticated session must include a boolean `features.superAgentAllowed`
  before the workspace is opened.
- A stale local login hint is never treated as proof of current permissions.
- Unknown permissions now produce a clear session-verification screen with a
  Retry button, not an account-restricted screen.
- Password and Google login session refreshes use the same completeness check.

Validation: frontend TypeScript typecheck and Vite production build both passed.

Production deployment verification:

- Static frontend synced to the resolved production S3 bucket only; Lambda and
  Batch were not changed.
- CloudFront invalidation `IAUHXXAW2Y46OG0GIYVG9BFJXC` completed.
- `https://videomaking.in/` returned HTTP `200` and referenced the new
  `index-CeCYjXEx.js` bundle.
- The live bundle contains the new session-verification recovery UI.
- `https://videomaking.in/api/auth/session` returned HTTP `200` after deploy.

---

## Addendum — 2026-07-26 target-account migration execution

This addendum supersedes earlier image/revision facts where production changed after
the original July 22 audit. Source account `596596146505` was accessed read-only. All
mutations were restricted to target account `386318011485`.

### Source state selected for migration

- Production stack updated July 25 and remained `UPDATE_COMPLETE`.
- Live API image: tag `60d5c1cb`, digest
  `sha256:e18c4d1bf4b05ec7b7fcc9cf2849ad782b4bfca1ef0989d450d44c43bf83b4fd`.
- Live worker reference: `ytgrabber-green-worker-job:747`, image tag `60d5c1cb`,
  digest
  `sha256:eacc56fb01adf533c6ff12b670df77d6aa0f755476ec1f828c9d6ed39b2b9a69`.
- Production Lambda had 74 environment variables and
  `GOOGLE_GENAI_USE_VERTEXAI=false`.

### Target state completed

- Exact API and worker digests copied to target ECR; keep-last-3 lifecycle applied.
- Lambda moved to the immutable production API digest. All 74 environment entries were
  migrated without printing values and mapped to target resources.
- Target Batch revision `3` cloned source revision `747`: 2 vCPU, 4096 MB, 2700-second
  timeout, no GPU resources. Translation, lip sync, and Vertex were kept disabled.
- Lambda async configuration now matches production: zero retries, 3600-second event
  age.
- Current 75-object frontend copied exactly; target CloudFront serves the same
  `index.html` hash and the production security-header set.
- Target output S3 enabled versioning and retained stricter full public blocking. CORS,
  lifecycle, ownership, and encryption behavior were reconciled for app compatibility.
- DynamoDB final parity: access `29/29`, jobs `3165/3165`, cooldowns `0/0`. All three
  target tables have PITR and deletion protection.
- Final rolling S3 cutoff snapshot at `2026-07-26T16:14:57Z`: 1,050 source objects;
  863 approved objects / 3,099,827,444 bytes in target; 187 old media objects excluded;
  zero approved-object mismatches and zero unapproved regular target objects. Eleven
  rollback objects under `migration-backup/` were intentionally retained.
- CloudFront health/config, password login, authenticated session, Super Agent
  entitlement, skills, and client access passed through the target distribution.
- Batch revision `3` completed a real Fargate download job successfully. A five-second
  clip completed through Lambda in 14.58 seconds with no Batch handoff. Exact smoke
  artifacts were removed afterward.
- Temporary migration Lambda, its log group, local object fragments, and registry auth
  file were removed after verification.

### Cost and remaining risks

- Target Cost Explorer for July 1-26 showed effectively USD 0.00 net when queried.
  Billing may lag. Versioned S3/ECR storage, PITR, requests, and actual Lambda/Fargate
  use can create later charges; capacity ceilings alone are not 24/7 charges.
- The `ApiFunction` and `ApiRole` drift was reconciled target-only later on 2026-07-26.
  CloudFormation completed `UPDATE_COMPLETE`, and a fresh drift scan returned `IN_SYNC`
  with zero drifted resources. Pre/post hashes proved the image, all 74 environment
  values, and role policy were unchanged; the Function URL and CloudFront security
  headers also remained unchanged. Repository-template alignment and ownership of the
  manual cooldown/async/security-policy resources still require a separate reviewed
  change before any repository-driven full deployment.
- SNS has zero subscriptions and the USD 100 budget has no notification rule or
  subscriber. An operator email is required to complete alert delivery.
- GitHub/OIDC and ACM/custom-domain/external-DNS cutover remain owner-deferred.
- The target admin CLI user and disabled GuardDuty/Security Hub/Config remain security
  follow-ups. No access key was automatically deleted or rotated.
- Because source production remains writable, run one more incremental DynamoDB/S3 pass
  after pausing writes immediately before DNS cutover.
