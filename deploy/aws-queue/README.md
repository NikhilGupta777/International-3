# Queue Worker Migration (Phase A)

This directory sets up queue infrastructure for the green environment without touching existing production traffic.

## What gets created

- SQS primary queue
- SQS dead-letter queue (DLQ)
- DynamoDB job-state table
- ECR repository for worker image
- CloudWatch log group for worker jobs

## 1) Create AWS resources

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\aws-queue\create-phase-a-resources.ps1 `
  -Region us-east-1 `
  -Prefix ytgrabber-green
```

## 2) Build and push worker image

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\aws-queue\push-worker-image.ps1 `
  -Region us-east-1 `
  -Prefix ytgrabber-green `
  -ImageTag v1
```

## 3) Next step (separate script)

After image push, create AWS Batch compute environment + job queue + job definition:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\aws-queue\create-phase-a-batch.ps1 `
  -Region us-east-1 `
  -Prefix ytgrabber-green `
  -ImageTag v1
```

Then point green API to enqueue jobs to the SQS queue.

## 4) Create monitoring alarms (recommended)

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\aws-queue\create-alarms.ps1 `
  -Region us-east-1 `
  -Prefix ytgrabber-green `
  -InstanceId i-xxxxxxxxxxxxxxxxx `
  -AlarmEmail ops@videomaking.in
```

This creates alarms for:

- queue depth
- oldest message age
- DLQ messages
- Batch failed jobs
- EC2 CPU + status checks (when `-InstanceId` is provided)

Historical primary coverage in this phase:

- `download`
- `clip-cut` (including legacy `download-clip`)

Live production state as of 2026-07-22:

- `YOUTUBE_QUEUE_PRIMARY_JOB_TYPES=bhagwat-analyze,bhagwat-render,clip-cut,subtitles`
- `YOUTUBE_BATCH_JOB_QUEUE=ytgrabber-green-job-queue`
- `YOUTUBE_BATCH_JOB_DEFINITION=ytgrabber-green-worker-job:744`
- Batch compute environment: `ytgrabber-green-compute-fargate`
- Max Fargate vCPUs: `16`
- Batch is not 24/7. Fargate capacity scales to zero and costs only when jobs run.
- Cost Explorer for 2026-07-01 through 2026-07-22 showed about `$0.0022` positive ECS/Fargate usage and effectively `$0.00` net unblended account cost after offsets/free-tier credits.
- Short clip cuts at or under `LAMBDA_CLIP_MAX_DURATION_SECONDS=420` try the Lambda fast path first; long clips and slow observed Lambda jobs use Batch.

Do not copy the old phase defaults into production without checking live Lambda env first:

```powershell
aws lambda get-function-configuration `
  --region us-east-1 `
  --function-name ytgrabber-green-api `
  --query "Environment.Variables.{YOUTUBE_QUEUE_PRIMARY_JOB_TYPES:YOUTUBE_QUEUE_PRIMARY_JOB_TYPES,YOUTUBE_BATCH_JOB_DEFINITION:YOUTUBE_BATCH_JOB_DEFINITION,LAMBDA_CLIP_MAX_DURATION_SECONDS:LAMBDA_CLIP_MAX_DURATION_SECONDS}"
```

This repository now includes a worker under:

- `artifacts/queue-worker`
