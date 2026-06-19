# whatnottodoaws.md

**The June 16, 2026 AWS incident — what happened, why, and how to never repeat it.**

This is the postmortem for the day the site went fully down AND the AWS account
(`596596146505`) got restricted by AWS Trust & Safety. Read this before doing any
"quick fix" on production again.

---

## TL;DR (the one-paragraph version)

A long-lived IAM access key (`github-actions-deployer`, key `AKIA…7WJTMBEW`) was used
by automated tooling (GitHub Actions CI **and** an AI coding agent) to fire a rapid
burst of AWS API calls from US-based runners while trying to "repair" a broken Lambda
Function URL. AWS's automated abuse detection saw anomalous activity (US automation +
India logins) on a key it considered exposed, **flagged the key as compromised, and
restricted the whole account**. That restriction — not a code bug — is what took the
site down (every `/api/*` returned `403 AccessDeniedException`). The frantic CI "repair"
commits made it worse and burned 100% of the month's GitHub Actions minutes. Fix =
secure the account, get AWS to reinstate, redeploy clean. Prevention = **stop using
long-lived keys, never give keys to agents, stop panic-deploying.**

---

## Timeline of what actually happened

**The single turning point was 7:42 PM, when AWS locked the account. Everything that
"failed" after that failed because of the lock — not because of code or CI bugs.**

1. **Before 7:24 PM — normal.** The deployer key (`AKIA…7WJTMBEW`) was being used by CI
   **and the Codex AI agent** to push deploys. AWS's abuse detector (GuardDuty) was
   quietly watching the pattern build: a key used by **US-based automation** while the
   owner logs in from **India**, plus a rising burst of API calls.
2. **7:24 PM — last good deploy (#609, commit `f25632d`).** A frontend-only markdown
   change. Deployed green. **This did NOT break anything.**
3. **🔒 ~7:42 PM — AWS LOCKED THE ACCOUNT (the real turning point).** The detector hit
   its threshold, flagged the deployer key as compromised, restricted the account, and
   sent the two emails at 7:42–7:43 (cases `178161920500692`, `178161917000573`).
   **From this moment, the whole account was already locked.**
4. **8:04 PM onward — every deploy failed.** Not because of code — because the account
   was **already locked** and AWS was blocking the API calls. We were fighting a locked
   door, not a code problem. (Commit `3cc4fa5` also added a **duplicate Lambda
   permission** `ApiFunctionUrlPermissionPublicV2` that broke the CloudFormation deploy,
   but the lock was the dominant cause.)
5. **The panic spiral.** Not realizing the account was locked, a series of "fix(ci)"
   commits added a manual `aws lambda update-function-url-config` "direct repair" path
   that:
   - had a **bash heredoc inside a PowerShell step** (invalid — errored immediately),
   - treated the auth-type reset as **non-fatal** (`Write-Warning … continuing`),
   - thrashed the live Function URL auth into a broken state.
   An "emergency http api image" and App Runner/ECS migration attempts were also tried.
   None could ever work — the account was locked.
6. **Result:** site fully down (`403 AccessDeniedException` on all `/api/*`, caused by
   the lock), account restricted, **GitHub Actions minutes exhausted (3000/3000)**,
   hours wasted chasing a "code bug" that was really an account lock.

### Why it locked (not one deploy — a pattern)
GuardDuty does **not** trigger on a single push. It flags an anomalous **pattern** over
time. What it saw: the deployer key used by **automation/agents from US IPs** while
interactive logins came from **India**, building into a burst. The 7:24 deploy (and what
Codex was doing with the key around then) likely **tipped it over**, but the cause is the
*recurring pattern of key use* — which is exactly why it had already happened on
**2026-03-22** and **2026-04-24**. Same behavior, same flag, third time.

### This had happened before
AWS case history showed prior credential-compromise flags on **2026-03-22** and
**2026-04-24**. This was the **3rd time in 3 months** — a recurring leak that was never
truly fixed.

---

## Root causes (be honest about these)

1. **Long-lived IAM access keys exist at all.** Permanent `AKIA…` keys are the #1 thing
   that leaks. We had two (`github-actions-deployer`, `newaws`).
2. **A key was handed to automation that runs outside our control** — GitHub Actions
   and, critically, an **AI coding agent (Codex)** whose environment held the AWS
   secret. Any key given to a hosted agent is effectively shared with a third party.
3. **Panic-driven production changes.** Manual `aws lambda` commands bypassing
   CloudFormation, run in a loop, with non-fatal error handling — corrupted live state.
4. **No spending guardrails.** No GitHub Actions budget cap → repeated heavy Docker/AMI
   builds burned the entire month's minutes.
5. **A duplicate CloudFormation resource** (`ApiFunctionUrlPermissionPublicV2`) that
   silently broke the stack and triggered the whole spiral.

---

## What we did to recover (for reference)

- **Secured the account:** deleted both exposed keys, changed root password, reset root
  MFA, set a new password on `newaws`, verified no backdoor IAM users/roles, confirmed
  no rogue EC2/cost in any region ($11 MTD — clean).
- **Answered AWS cases** confirming remediation; opened a live chat for reinstatement.
- **Restored the code:** `template.yml` returned to the 7 PM baseline (duplicate
  permission removed), `deploy.yml` cleaned of the panic block, emergency files deleted,
  all real app work kept. Verified with typecheck + API build + frontend build.
- **Did NOT deploy anything** until the account was reinstated.

---

## ❌ WHAT NOT TO DO AGAIN

1. **Do NOT give your AWS secret key to any AI agent, cloud IDE, or hosted tool.**
   Codex/agents should never have `AWS_SECRET_ACCESS_KEY` in their environment. This is
   what caused the recurring compromise flags.
2. **Do NOT panic-deploy.** When prod breaks, **stop and diagnose first.** Don't run
   manual `aws lambda update-*` commands in a loop, and never bypass CloudFormation with
   ad-hoc CLI "repairs."
3. **Do NOT add non-fatal error handling to critical deploy steps.** A `Write-Warning …
   continuing` on an auth/permission command hides the exact failure that takes you down.
4. **Do NOT push to `main` to "test" a deploy** — it auto-triggers production. Test on a
   branch or locally.
5. **Do NOT keep retrying failed deploys.** If 2 deploys fail the same way, the problem
   is upstream (account, stack, or creds) — retrying just burns minutes and trips abuse
   detection.
6. **Do NOT commit scratch/credential files.** No `*.json` AWS dumps, `.env*`, policy
   files, or `cf-*.json` in the repo. (`.gitignore` them.)
7. **Do NOT duplicate CloudFormation resources.** One logical resource per real resource.

---

## ✅ FUTURE PRECAUTIONS (the real cures)

### 1. Kill long-lived keys → use GitHub OIDC (highest priority)
Replace the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` GitHub secrets with **OIDC
role assumption**. *(Note: This was completed on June 18, 2026. The repo now uses OIDC)*.
GitHub Actions now assumes a short-lived AWS role per run (expires in minutes).
**There is no permanent key to leak**, which eliminates this entire class of incident.

### 2. Never expose keys to agents/tools
- If an AI agent or external tool needs AWS, give it a **short-lived, tightly-scoped,
  time-boxed** credential — never the deployer key, never a root/admin key.
- Prefer running AWS commands yourself, or via CloudShell (uses your console session, no
  key to leak).

### 3. Lock down whatever keys must exist
- Least-privilege only (scope to exact actions/resources, like the existing
  `github-deployer-lambda-policy.json` did for Lambda).
- **Rotate every 90 days.** Delete unused keys immediately.
- Enable MFA on every IAM user with console access (and on root — done).

### 4. Add guardrails so abuse can't run wild
- **GitHub Actions:** set a spending budget (a $0 cap blocks overage and stops runaway
  builds). Don't trigger the ~20 GB translator image build unless its files changed.
- **AWS Budgets:** set a monthly budget alert (e.g. $50) so any cost spike emails you.
- **GuardDuty:** keep it on — it's what flags compromised keys (it did its job here).

### 5. Deploy safely
- Production deploys only from a **clean `main`**, via the reviewed workflow — not manual
  CLI repairs.
- For emergencies, the **single safe fix** for the Function URL is one idempotent command
  (set `--auth-type NONE` + re-add the public invoke permission), run **once**, then verify.
  Not in a loop, not with the result ignored.
- Keep CloudFormation as the source of truth. If you must touch a resource by hand, then
  reconcile the template so the next deploy doesn't fight you.

### 6. Have a runbook, not a panic
When prod is down:
1. **Check `curl https://…/api/healthz`** and read the exact error/headers first.
2. **Check the AWS account isn't restricted** (console banner, Support cases) and the
   CloudFormation stack status (`UPDATE_ROLLBACK_FAILED` etc.).
3. Only then make **one** targeted change, verify, and stop.

---

## Quick reference (this account)

- Account: `596596146505` · Region: `us-east-1` · Stack: `ytgrabber-green-serverless`
- API Lambda: `ytgrabber-green-api` · CloudFront API path must keep `Compress: false`
- Function URL must be `AuthType: NONE` + public `lambda:InvokeFunctionUrl` permission
- Health check: `https://d2bcwj2idfdwb4.cloudfront.net/api/healthz` → `{"status":"ok"}`
- AWS cases from this incident: `178161920500692`, `178161917000573`

**The single biggest lesson: long-lived keys + automation/agents + panic = account
lockout. Move to OIDC, never give keys to agents, and slow down when prod breaks.**
