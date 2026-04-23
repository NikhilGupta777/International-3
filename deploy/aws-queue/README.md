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

Current primary coverage in this phase:

- `download`
- `clip-cut` (including legacy `download-clip`)

Recommended env pinning:

- `YOUTUBE_QUEUE_PRIMARY_JOB_TYPES=download,clip-cut`
- `YOUTUBE_QUEUE_SHADOW_JOB_TYPES=download,clip-cut`

Not yet migrated to worker primary mode:

- `best-clips`
- `subtitles`

This repository now includes a worker under:

- `artifacts/queue-worker`
