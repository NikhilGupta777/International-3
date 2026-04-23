param(
  [string]$Region = "us-east-1",
  [string]$Prefix = "ytgrabber-green"
)

$ErrorActionPreference = "Stop"

function Assert-LastExit([string]$Context) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Context failed with exit code $LASTEXITCODE"
  }
}

$jobId = [guid]::NewGuid().ToString()
$jobName = "$Prefix-smoke-" + (Get-Date -Format "yyyyMMddHHmmss")
$jobQueue = "$Prefix-job-queue"
$jobDef = "$Prefix-worker-job"
$table = "$Prefix-jobs"

$payloadObj = [ordered]@{
  jobId = $jobId
  jobType = "download"
  sourceUrl = "https://youtu.be/dQw4w9WgXcQ"
  requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
$payload = $payloadObj | ConvertTo-Json -Compress

$createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$itemJson = @"
{
  "jobId": { "S": "$jobId" },
  "status": { "S": "queued" },
  "message": { "S": "Submitted test job" },
  "createdAt": { "N": "$createdAt" },
  "updatedAt": { "N": "$updatedAt" }
}
"@
$tmpItem = Join-Path $env:TEMP "$Prefix-ddb-item.json"
$itemJson | Set-Content -Path $tmpItem -NoNewline

aws dynamodb put-item `
  --region $Region `
  --table-name $table `
  --item "file://$tmpItem" | Out-Null
Assert-LastExit "Put DynamoDB test item"
Remove-Item $tmpItem -Force

$overrides = @"
{
  "environment": [
    { "name": "JOB_PAYLOAD", "value": $($payload | ConvertTo-Json -Compress) },
    { "name": "JOB_TABLE", "value": "$table" },
    { "name": "AWS_REGION", "value": "$Region" }
  ]
}
"@

$tmpOverrides = Join-Path $env:TEMP "$Prefix-submit-overrides.json"
$overrides | Set-Content -Path $tmpOverrides -NoNewline

$submitted = aws batch submit-job `
  --region $Region `
  --job-name $jobName `
  --job-queue $jobQueue `
  --job-definition $jobDef `
  --container-overrides "file://$tmpOverrides" `
  --output json | ConvertFrom-Json
Assert-LastExit "Submit batch job"
Remove-Item $tmpOverrides -Force

$batchJobId = $submitted.jobId

Write-Host "Submitted batch job:"
Write-Host "  Batch Job ID: $batchJobId"
Write-Host "  Logical JobID: $jobId"

$status = ""
for ($i = 0; $i -lt 36; $i++) {
  $status = aws batch describe-jobs --region $Region --jobs $batchJobId --query "jobs[0].status" --output text
  Assert-LastExit "Read batch job status"
  Write-Host "  Status: $status"
  if ($status -in @("SUCCEEDED", "FAILED")) { break }
  Start-Sleep -Seconds 10
}

$keyJson = @"
{
  "jobId": { "S": "$jobId" }
}
"@
$tmpKey = Join-Path $env:TEMP "$Prefix-ddb-key.json"
$keyJson | Set-Content -Path $tmpKey -NoNewline

$ddbStatus = aws dynamodb get-item `
  --region $Region `
  --table-name $table `
  --key "file://$tmpKey" `
  --query "Item.status.S" `
  --output text
Assert-LastExit "Read DynamoDB status"
Remove-Item $tmpKey -Force

Write-Host ""
Write-Host "Final:"
Write-Host "  Batch status: $status"
Write-Host "  DynamoDB status: $ddbStatus"
