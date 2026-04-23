param(
  [string]$Region = "us-east-1",
  [string]$Prefix = "ytgrabber-green"
)

$ErrorActionPreference = "Stop"

function Ensure-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Assert-LastExit([string]$Context) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Context failed with exit code $LASTEXITCODE"
  }
}

function Get-QueueUrlOrNull([string]$QueueName, [string]$RegionName) {
  try {
    $url = aws sqs get-queue-url --queue-name $QueueName --region $RegionName --query QueueUrl --output text 2>$null
    if ($url -and $url -ne "None") { return $url }
  } catch {}
  return $null
}

Ensure-Command "aws"

$env:AWS_DEFAULT_REGION = $Region

$queueName = "$Prefix-jobs"
$dlqName = "$Prefix-jobs-dlq"
$tableName = "$Prefix-jobs"
$repoName = "$Prefix-worker"
$logGroup = "/aws/batch/job/$Prefix-worker"

Write-Host "Region: $Region"
Write-Host "Prefix: $Prefix"

# 1) DLQ
$dlqUrl = Get-QueueUrlOrNull -QueueName $dlqName -RegionName $Region
if (-not $dlqUrl) {
  Write-Host "Creating DLQ: $dlqName"
  $dlqUrl = aws sqs create-queue --queue-name $dlqName --region $Region --query QueueUrl --output text
  Assert-LastExit "Create DLQ queue"
} else {
  Write-Host "DLQ exists: $dlqName"
}

$dlqArn = aws sqs get-queue-attributes `
  --queue-url $dlqUrl `
  --region $Region `
  --attribute-names QueueArn `
  --query "Attributes.QueueArn" `
  --output text
Assert-LastExit "Get DLQ queue ARN"

# 2) Main queue
$queueUrl = Get-QueueUrlOrNull -QueueName $queueName -RegionName $Region
if (-not $queueUrl) {
  Write-Host "Creating main queue: $queueName"
  $queueUrl = aws sqs create-queue --queue-name $queueName --region $Region --query QueueUrl --output text
  Assert-LastExit "Create main queue"
} else {
  Write-Host "Main queue exists: $queueName"
}

$redrive = "{`"deadLetterTargetArn`":`"$dlqArn`",`"maxReceiveCount`":`"3`"}"
$tmpAttrs = Join-Path $env:TEMP "sqs-attrs-$Prefix.json"
@"
{
  "RedrivePolicy": $($redrive | ConvertTo-Json -Compress),
  "VisibilityTimeout": "900",
  "MessageRetentionPeriod": "345600"
}
"@ | Set-Content -Path $tmpAttrs -NoNewline

aws sqs set-queue-attributes `
  --queue-url $queueUrl `
  --region $Region `
  --attributes "file://$tmpAttrs" | Out-Null
Assert-LastExit "Set queue redrive policy"
Remove-Item $tmpAttrs -Force

$queueArn = aws sqs get-queue-attributes `
  --queue-url $queueUrl `
  --region $Region `
  --attribute-names QueueArn `
  --query "Attributes.QueueArn" `
  --output text
Assert-LastExit "Get main queue ARN"

# 3) DynamoDB table
$tableExists = $false
try {
  $existing = aws dynamodb describe-table --table-name $tableName --region $Region --query "Table.TableStatus" --output text 2>$null
  if ($existing -and $existing -ne "None") { $tableExists = $true }
} catch {}

if (-not $tableExists) {
  Write-Host "Creating DynamoDB table: $tableName"
  aws dynamodb create-table `
    --table-name $tableName `
    --region $Region `
    --billing-mode PAY_PER_REQUEST `
    --attribute-definitions AttributeName=jobId,AttributeType=S AttributeName=status,AttributeType=S AttributeName=createdAt,AttributeType=N `
    --key-schema AttributeName=jobId,KeyType=HASH `
    --global-secondary-indexes "IndexName=status-createdAt-index,KeySchema=[{AttributeName=status,KeyType=HASH},{AttributeName=createdAt,KeyType=RANGE}],Projection={ProjectionType=ALL}" | Out-Null
  Assert-LastExit "Create DynamoDB table"

  aws dynamodb wait table-exists --table-name $tableName --region $Region
  Assert-LastExit "Wait for DynamoDB table"
} else {
  Write-Host "DynamoDB table exists: $tableName"
}

# 4) ECR repository
$repoExists = $false
try {
  $repoCheck = aws ecr describe-repositories --repository-names $repoName --region $Region --query "repositories[0].repositoryArn" --output text 2>$null
  if ($repoCheck -and $repoCheck -ne "None") { $repoExists = $true }
} catch {}

if (-not $repoExists) {
  Write-Host "Creating ECR repo: $repoName"
  aws ecr create-repository --repository-name $repoName --region $Region | Out-Null
  Assert-LastExit "Create ECR repository"
} else {
  Write-Host "ECR repo exists: $repoName"
}

$repoUri = aws ecr describe-repositories `
  --repository-names $repoName `
  --region $Region `
  --query "repositories[0].repositoryUri" `
  --output text
Assert-LastExit "Describe ECR repository"

# 5) CloudWatch log group
$lgExists = $false
try {
  $lg = aws logs describe-log-groups --region $Region --log-group-name-prefix $logGroup --query "logGroups[?logGroupName=='$logGroup'] | length(@)" --output text
  if ($lg -eq "1") { $lgExists = $true }
} catch {}

if (-not $lgExists) {
  Write-Host "Creating log group: $logGroup"
  aws logs create-log-group --region $Region --log-group-name $logGroup
  Assert-LastExit "Create log group"
} else {
  Write-Host "Log group exists: $logGroup"
}

aws logs put-retention-policy --region $Region --log-group-name $logGroup --retention-in-days 14 | Out-Null
Assert-LastExit "Set log retention policy"

Write-Host ""
Write-Host "Phase A resources ready:"
Write-Host "  SQS Queue URL:    $queueUrl"
Write-Host "  SQS Queue ARN:    $queueArn"
Write-Host "  SQS DLQ URL:      $dlqUrl"
Write-Host "  DynamoDB Table:   $tableName"
Write-Host "  ECR Repo URI:     $repoUri"
Write-Host "  CW Log Group:     $logGroup"
