# VideoMaking.in Master Execution Book

Last updated: 2026-04-22 (IST)  
Owner: Codex + Project team  
Purpose: Keep one persistent tracker for what is done, what is pending, and what comes next.

---

## 1) Current Truth (Short)

- Serverless stack is live (`Lambda + API Gateway + S3 + CloudFront`) on `d2bcwj2idfdwb4.cloudfront.net`.
- Worker infra is active (AWS Batch + queue worker + DynamoDB + S3 output).
- `download`, `clip-cut`, `best-clips`, and `subtitles` are now worker-primary.
- Stale queued jobs are reconciled to terminal status instead of hanging forever.
- `videomaking.in` DNS is still pointed at always-on EC2, so 24/7 EC2 cost is still active until cutover.

---

## 2) Primary Plan (Mandatory First)

This is the only required plan to finish the architecture we discussed.

## P0 - Finish No-24/7 Architecture

- [x] P0.1 Move web frontend to `S3 + CloudFront`.
- [x] P0.2 Move API/auth/job-status endpoints to `Lambda + API Gateway`.
- [x] P0.3 Make `best-clips` fully worker-primary.
- [x] P0.4 Make `subtitles` fully worker-primary.
- [x] P0.5 Ensure shared durable job state (DynamoDB) for refresh/reopen continuity.
- [x] P0.6 Cut traffic to new stack and remove EC2 runtime path.

Acceptance for P0:
- Website works without always-on EC2 app/proxy/db path.
- Jobs run only through queue/workers.
- Refresh/reopen still shows running/completed jobs.
- 24/7 EC2 compute cost is eliminated from this app runtime path.

## P1 - Reliability Required for Production

- [x] P1.1 Fix clip-cut status lifecycle (`queued -> active -> ready/failed`) consistency.
- [x] P1.2 Fix clip-cut completion visibility in Activity/history after refresh.
- [x] P1.3 Stabilize cookie pipeline (`YTDLP_COOKIES_BASE64` load/validate/refresh runbook).
- [x] P1.4 Validate retry/cancel behavior so failures do not look stuck.
- [x] P1.5 Run end-to-end smoke tests on production (all tabs).

Acceptance for P1:
- 3 repeated tests per critical flow pass.
- Failures are clear and recoverable.
- No silent job disappearance.

## P2 - Cost Verification

- [ ] P2.1 Capture 7-day usage sample after P0/P1.
- [ ] P2.2 Publish monthly estimate based on actual events and transfer/storage.

Acceptance for P2:
- Cost model is tied to measured usage, not assumptions.

---

## 3) Secondary Plan (After Primary)

Do only after P0/P1/P2 are complete.

- [ ] S1 Mobile UI polish (login/help/tabs spacing, visual cleanup).
- [ ] S2 Copy and onboarding refinements.
- [ ] S3 Optional UX improvements for activity/help cards.
- [ ] S4 Additional monitoring dashboards/alerts polish.

---

## 4) Immediate Next Queue (Do in Order)

1. [ ] Execute P0.6 (point `videomaking.in` to CloudFront and decommission EC2 runtime path).
2. [x] Execute P1.3 (cookie pipeline runbook + rotation process).
3. [x] Execute P1.5 (repeatable smoke test pack on live domain after DNS cutover).
4. [ ] Execute P2 cost measurement.
5. [ ] Only then start Secondary Plan.

---

## 5) Update Log (Append Only)

Template:
- `YYYY-MM-DD HH:MM IST` - Change summary
  - Tasks touched:
  - Files/infra changed:
  - Verification:
  - Result:
  - Next:

Entries:
- `2026-04-16` - Initial master book created.
  - Tasks touched: baseline tracking
  - Files/infra changed: `MASTER_EXECUTION_BOOK.md`
  - Verification: n/a
  - Result: persistent tracker created
  - Next: align plan priority

- `2026-04-16` - Plan simplified to mandatory-first model.
  - Tasks touched: P0/P1/P2 + Secondary split
  - Files/infra changed: `MASTER_EXECUTION_BOOK.md`
  - Verification: manual review
  - Result: tracker now matches agreed primary objective (no-24/7 first)
  - Next: begin P0 implementation

- `2026-04-22` - Worker-primary and serverless control-plane validation.
  - Tasks touched: P0.1, P0.2, P0.3, P0.4, P0.5, P1.1, P1.2, P1.4
  - Files/infra changed: queue worker runtime/exit behavior, Batch job definition `:14` (image `:latest`), API queue stale-state reconciliation, CloudFront+Lambda deployment
  - Verification: live API smoke tests for `clip-cut`, `best-clips`, `subtitles`; Batch statuses reached terminal; stale queued items now surface as `error`
  - Result: worker flows are stable on serverless entrypoint; remaining blocker is DNS cutover from EC2
  - Next: P0.6 (`videomaking.in` DNS cutover + EC2 retirement)

- `2026-04-22` - Live Gemini key-order hotfix on serverless stack.
  - Tasks touched: P1.5 (smoke stabilization)
  - Files/infra changed: `deploy/ec2/.env.green`, `deploy/ec2/.env.production`, Lambda env vars on `ytgrabber-green-api`, CloudFormation params (`GeminiApiKey*`) for `ytgrabber-green-serverless`
  - Verification: direct model probes (`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3-flash-preview`) show active primary keys; `best-clips` no longer fails with `API_KEY_INVALID`; `clip-cut` and `subtitles` queue flows progress from queued to running
  - Result: queue AI flows are unblocked on serverless endpoint
  - Next: complete P0.6 DNS cutover to remove always-on EC2 runtime cost

- `2026-04-22` - Subtitles retry hardening + serverless redeploy + smoke pass.
  - Tasks touched: P1.3, P1.5
  - Files/infra changed: `artifacts/api-server/src/routes/subtitles.ts`, `deploy/aws-serverless/YTDLP_COOKIES_RUNBOOK.md`, stack `ytgrabber-green-serverless` redeployed from compact-cookie env file
  - Verification: `scratch/final-smoke.ps1` (`clip-cut=done`, `subtitles=done`), `scratch/best-sub-check.ps1` (`best-clips=done`, `subtitles=done`) on `d2bcwj2idfdwb4.cloudfront.net`
  - Result: serverless queue flows stable after handling Gemini `UNAVAILABLE/503` as retryable in subtitles path
  - Next: execute P0.6 DNS cutover and retire EC2 runtime path

- `2026-04-22` - DNS/cert cutover preparation completed for P0.6.
  - Tasks touched: P0.6 prep
  - Files/infra changed: `deploy/aws-serverless/DNS_CUTOVER_CHECKLIST.md`, ACM cert request `arn:aws:acm:us-east-1:596596146505:certificate/62ff8b55-8a4b-4634-97e8-75924181c9f5`
  - Verification: cert request created; status currently `PENDING_VALIDATION`; current `videomaking.in` still resolves to `3.238.114.190` (EC2 path)
  - Result: cutover inputs are ready; waiting only on DNS validation CNAMEs + final DNS switch to CloudFront
  - Next: validate certificate issuance, apply custom domain to stack, update DNS records, then decommission EC2 runtime

- `2026-04-22` - Certificate issued and CloudFront custom domain attached.
  - Tasks touched: P0.6 (in progress)
  - Files/infra changed: stack `ytgrabber-green-serverless` updated with `SiteDomainName=www.videomaking.in` and ACM cert `arn:aws:acm:us-east-1:596596146505:certificate/62ff8b55-8a4b-4634-97e8-75924181c9f5`; frontend resynced; CloudFront invalidation `I3XLQJ5WK4086VQOTFCQ7XH6E9`
  - Verification: distribution `EDTEON6GFBEZH` is `Deployed`, alias contains `www.videomaking.in`, viewer cert set to requested ACM cert
  - Result: AWS side cutover is ready; remaining step is DNS CNAME switch for `www` from apex to CloudFront
  - Next: update DNS `www` target to `d2bcwj2idfdwb4.cloudfront.net`, verify live, then retire EC2 runtime path

- `2026-04-22` - Public cutover completed on `www` and EC2 runtime stopped.
  - Tasks touched: P0.6
  - Files/infra changed: DNS now has `www -> d2bcwj2idfdwb4.cloudfront.net`; EC2 instance `i-0347ac1cc850a2851` stopped
  - Verification: `https://www.videomaking.in` and `https://www.videomaking.in/api/healthz` serve via CloudFront/API; smoke jobs on `www` reached terminal states
  - Result: 24/7 EC2 compute path is removed; only remaining DNS cleanup is apex `@` record still pointing to old EC2 IP
  - Next: set apex redirect to `https://www.videomaking.in` (or other desired apex strategy) and remove stale `A @ -> 3.238.114.190`

---

## 6) Guardrails

- Do not mark done without verification evidence.
- Do not start secondary polish before primary architecture completion.
- If chat compacts, resume from Section 4.
