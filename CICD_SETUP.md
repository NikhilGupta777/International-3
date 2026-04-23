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

Add these 3 secrets:

| Secret Name | Value |
|-------------|-------|
| `AWS_ACCESS_KEY_ID` | Your AWS IAM access key (see below) |
| `AWS_SECRET_ACCESS_KEY` | Your AWS IAM secret key (see below) |
| `ENV_GREEN_CONTENT` | Full contents of `deploy/ec2/.env.green` (see below) |

---

### Step 2 — Create AWS IAM User for GitHub Actions

In AWS Console → IAM → Create user `github-actions-deployer`:

Attach these **inline policies**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:DescribeImages"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:us-east-1:596596146505:function:ytgrabber-green-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:GetTemplate"
      ],
      "Resource": "arn:aws:cloudformation:us-east-1:596596146505:stack/ytgrabber-green*/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:PutBucketPolicy"
      ],
      "Resource": [
        "arn:aws:s3:::malikaeditorr",
        "arn:aws:s3:::malikaeditorr/*",
        "arn:aws:s3:::ytgrabber-green-*",
        "arn:aws:s3:::ytgrabber-green-*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation",
        "cloudfront:GetDistribution"
      ],
      "Resource": "arn:aws:cloudfront::596596146505:distribution/EDTEON6GFBEZH"
    },
    {
      "Effect": "Allow",
      "Action": [
        "batch:DescribeJobDefinitions",
        "batch:RegisterJobDefinition"
      ],
      "Resource": "*"
    }
  ]
}
```

Then create **Access Key** → copy both values → paste into GitHub Secrets.

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
