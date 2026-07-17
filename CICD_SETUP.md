# CI/CD Setup Guide — GitHub → AWS Auto-Deploy

## How It Works

Every time you `git push` to the `main` branch:

```
Push to main
    ↓
GitHub Actions runs 4 parallel jobs:
    ├── Build API Lambda image   → push to ECR
    ├── Build Fargate Worker     → push to ECR + register new Batch job def
    └── Build Frontend           → upload to S3

All 3 done → Deploy job:
    ├── CloudFormation update    → Lambda + API Gateway
    ├── S3 sync                  → frontend files live
    └── CloudFront invalidation  → cache cleared, site is live instantly
```

⏱️ **Total deploy time: ~8-12 minutes**

---

## One-Time Setup (Do This Once)

### Step 1 — Add GitHub Secrets

Go to: **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

Add this secret:

| Secret Name | Value |
|-------------|-------|
| `ENV_GREEN_CONTENT` | Full contents of `deploy/ec2/.env.green` (see below) |
| `OLLAMA_API_KEY` | Ollama Cloud key for Copilot Ultra (`gpt-oss:120b`) |
| `OLLAMA_API_KEY_2` … `OLLAMA_API_KEY_4` | Optional Ollama failover keys; unhealthy keys are cooled down and rotated automatically |
| `GROQ_API_KEY` | Groq key for Copilot Fast (`llama-3.1-8b-instant`) |
| `GROQ_API_KEY_2` … `GROQ_API_KEY_4` | Optional Groq failover keys; unhealthy keys are cooled down and rotated automatically |

*(Note: We used to require `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` here, but they are no longer needed since we migrated to GitHub OIDC.)*

---

### Step 2 — Verify AWS OIDC Role

The repository uses OpenID Connect (OIDC) to authenticate with AWS. This means GitHub Actions assumes a temporary, short-lived IAM role (`ytgrabber-green-gha-deployer`) instead of using permanent credentials.

This role has already been provisioned in the AWS account using the `setup_oidc.ps1` script and is explicitly bound to the `NikhilGupta777/International-3` repository.

You do not need to configure any AWS credentials manually. The `.github/workflows/deploy.yml` workflow automatically assumes this role during deployment.

---

### Step 3 — Add ENV_GREEN_CONTENT Secret

Copy the **entire content** of your local `deploy/ec2/.env.green` file and paste it as the `ENV_GREEN_CONTENT` secret.

> ⚠️ The file is gitignored and never committed — this is the secure way to pass it.
> Every deploy auto-updates `YOUTUBE_BATCH_JOB_DEFINITION` with the new worker revision.

---

### Step 4 — Enable GitHub Actions Environment (Optional but Recommended)

Go to: **GitHub repo → Settings → Environments → New environment → `production`**

- Add **Required reviewers** if you want approval before deploy
- Or leave empty for fully automatic deploy on push

---

## Triggering a Deploy

### Auto (recommended)
```bash
git add .
git commit -m "your changes"
git push origin main
# → Deploy starts automatically
```

### Manual (from GitHub UI)
Go to: **GitHub repo → Actions → Deploy to Production → Run workflow**

---

## Monitoring a Deploy

**GitHub repo → Actions** → click the running workflow to see live logs per step.

Each step shows exactly what's happening:
- `Build API Lambda Image` — Docker build + ECR push
- `Build Fargate Worker` — Docker build + ECR push
- `Build Frontend` — Vite build
- `Deploy to AWS` — CloudFormation + S3 sync + CloudFront invalidation

---

## Rollback

If something breaks, go to **Actions** → find the last good deploy → **Re-run jobs**.
It will redeploy the exact images from that commit's SHA.

Or manually:
```powershell
# Point Lambda back to previous image
aws lambda update-function-code `
  --function-name ytgrabber-green-api `
  --image-uri 596596146505.dkr.ecr.us-east-1.amazonaws.com/ytgrabber-green-api-lambda:<previous-sha>
```
