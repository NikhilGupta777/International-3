param(
  [string]$Region = "us-east-1",
  [string]$Prefix = "ytgrabber-green",
  [string]$ImageTag = "latest",
  [int]$MaxVcpus = 6,
  [string]$EnvFile = ""
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

function Ensure-IamRole([string]$RoleName, [string]$TrustPolicyJson) {
  $exists = $false
  try {
    $arn = aws iam get-role --role-name $RoleName --query "Role.Arn" --output text 2>$null
    if ($arn -and $arn -ne "None") { $exists = $true }
  } catch {}

  if (-not $exists) {
    $tmp = Join-Path $env:TEMP "$RoleName-trust.json"
    $TrustPolicyJson | Set-Content -Path $tmp -NoNewline
    aws iam create-role --role-name $RoleName --assume-role-policy-document "file://$tmp" | Out-Null
    Assert-LastExit "Create IAM role $RoleName"
    Remove-Item $tmp -Force
  }

  $roleArn = aws iam get-role --role-name $RoleName --query "Role.Arn" --output text
  Assert-LastExit "Read IAM role $RoleName"
  return $roleArn
}

function Ensure-PolicyAttachment([string]$RoleName, [string]$PolicyArn) {
  aws iam attach-role-policy --role-name $RoleName --policy-arn $PolicyArn | Out-Null
  Assert-LastExit "Attach policy $PolicyArn to $RoleName"
}

function Load-EnvFile([string]$Path) {
  $map = @{}
  if (-not $Path -or -not (Test-Path $Path)) { return $map }
  foreach ($line in Get-Content $Path) {
    $trim = $line.Trim()
    if (-not $trim -or $trim.StartsWith("#")) { continue }
    $idx = $trim.IndexOf("=")
    if ($idx -lt 1) { continue }
    $k = $trim.Substring(0, $idx).Trim()
    $v = $trim.Substring($idx + 1).Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $map[$k] = $v
  }
  return $map
}

function Get-ConfigValue([hashtable]$envMap, [string]$Name, [string]$Default = "") {
  $proc = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($proc)) { return $proc }
  if ($envMap.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($envMap[$Name])) {
    return [string]$envMap[$Name]
  }
  return $Default
}

Ensure-Command "aws"
$env:AWS_DEFAULT_REGION = $Region

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  $candidate = Join-Path (Join-Path $PSScriptRoot "..\ec2") ".env.green"
  if (Test-Path $candidate) { $EnvFile = $candidate }
}
$envMap = Load-EnvFile $EnvFile

$batchServiceRoleName = "$Prefix-batch-service-role"
$execRoleName = "$Prefix-batch-exec-role"
$taskRoleName = "$Prefix-worker-task-role"
$computeEnvName = "$Prefix-compute-fargate"
$jobQueueName = "$Prefix-job-queue"
$jobDefName = "$Prefix-worker-job"
$repoName = "$Prefix-worker"
$jobTable = "$Prefix-jobs"
$queueUrl = "https://queue.amazonaws.com/596596146505/$Prefix-jobs"
$logGroup = "/aws/batch/job/$Prefix-worker"

$repoUri = aws ecr describe-repositories --repository-names $repoName --region $Region --query "repositories[0].repositoryUri" --output text
Assert-LastExit "Resolve ECR repository"
$image = "$repoUri`:$ImageTag"

$subnetId = ""
$securityGroupId = ""

$greenInstanceId = aws ec2 describe-instances `
  --region $Region `
  --filters Name=tag:Name,Values=$Prefix Name=instance-state-name,Values=running `
  --query "Reservations[0].Instances[0].InstanceId" `
  --output text
Assert-LastExit "Find green instance"

if ($greenInstanceId -and $greenInstanceId -ne "None") {
  $subnetId = aws ec2 describe-instances `
    --region $Region `
    --instance-ids $greenInstanceId `
    --query "Reservations[0].Instances[0].SubnetId" `
    --output text
  Assert-LastExit "Resolve subnet id"

  $securityGroupId = aws ec2 describe-instances `
    --region $Region `
    --instance-ids $greenInstanceId `
    --query "Reservations[0].Instances[0].SecurityGroups[0].GroupId" `
    --output text
  Assert-LastExit "Resolve security group id"
} else {
  $subnetId = aws batch describe-compute-environments `
    --region $Region `
    --compute-environments $computeEnvName `
    --query "computeEnvironments[0].computeResources.subnets[0]" `
    --output text 2>$null
  $securityGroupId = aws batch describe-compute-environments `
    --region $Region `
    --compute-environments $computeEnvName `
    --query "computeEnvironments[0].computeResources.securityGroupIds[0]" `
    --output text 2>$null

  if (-not $subnetId -or $subnetId -eq "None" -or -not $securityGroupId -or $securityGroupId -eq "None") {
    throw "Could not resolve networking. No running instance tagged Name=$Prefix and compute env $computeEnvName has no subnet/security group."
  }
}

$batchServiceRoleArn = Ensure-IamRole -RoleName $batchServiceRoleName -TrustPolicyJson @'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "batch.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
'@
Ensure-PolicyAttachment -RoleName $batchServiceRoleName -PolicyArn "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"

$execRoleArn = Ensure-IamRole -RoleName $execRoleName -TrustPolicyJson @'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
'@
Ensure-PolicyAttachment -RoleName $execRoleName -PolicyArn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"

$taskRoleArn = Ensure-IamRole -RoleName $taskRoleName -TrustPolicyJson @'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
'@
Ensure-PolicyAttachment -RoleName $taskRoleName -PolicyArn "arn:aws:iam::aws:policy/AmazonSQSFullAccess"
Ensure-PolicyAttachment -RoleName $taskRoleName -PolicyArn "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"
Ensure-PolicyAttachment -RoleName $taskRoleName -PolicyArn "arn:aws:iam::aws:policy/AmazonS3FullAccess"

Start-Sleep -Seconds 10

$existingCompute = aws batch describe-compute-environments --region $Region --compute-environments $computeEnvName --query "computeEnvironments[0].computeEnvironmentArn" --output text 2>$null
if (-not $existingCompute -or $existingCompute -eq "None") {
  aws batch create-compute-environment `
    --region $Region `
    --compute-environment-name $computeEnvName `
    --type MANAGED `
    --state ENABLED `
    --service-role $batchServiceRoleArn `
    --compute-resources "type=FARGATE,maxvCpus=$MaxVcpus,subnets=[$subnetId],securityGroupIds=[$securityGroupId]" | Out-Null
  Assert-LastExit "Create Batch compute environment"
}

$maxChecks = 24
for ($i = 0; $i -lt $maxChecks; $i++) {
  $status = aws batch describe-compute-environments --region $Region --compute-environments $computeEnvName --query "computeEnvironments[0].status" --output text
  Assert-LastExit "Read compute environment status"
  if ($status -eq "VALID") { break }
  if ($status -eq "INVALID") {
    $reason = aws batch describe-compute-environments --region $Region --compute-environments $computeEnvName --query "computeEnvironments[0].statusReason" --output text
    throw "Compute environment is INVALID: $reason"
  }
  Start-Sleep -Seconds 10
}

$existingQueue = aws batch describe-job-queues --region $Region --job-queues $jobQueueName --query "jobQueues[0].jobQueueArn" --output text 2>$null
if (-not $existingQueue -or $existingQueue -eq "None") {
  aws batch create-job-queue `
    --region $Region `
    --job-queue-name $jobQueueName `
    --state ENABLED `
    --priority 10 `
    --compute-environment-order "order=1,computeEnvironment=$computeEnvName" | Out-Null
  Assert-LastExit "Create Batch job queue"
}

$containerEnvironment = @(
  @{ name = "AWS_REGION"; value = $Region },
  @{ name = "JOB_TABLE"; value = $jobTable },
  @{ name = "QUEUE_URL"; value = $queueUrl },
  @{ name = "S3_BUCKET"; value = (Get-ConfigValue $envMap "S3_BUCKET" "") },
  @{ name = "S3_REGION"; value = (Get-ConfigValue $envMap "S3_REGION" $Region) },
  @{ name = "S3_OBJECT_PREFIX"; value = (Get-ConfigValue $envMap "S3_OBJECT_PREFIX" $Prefix) },
  @{ name = "YTDLP_PROXY"; value = (Get-ConfigValue $envMap "YTDLP_PROXY" "") },
  @{ name = "YTDLP_POT_PROVIDER_URL"; value = (Get-ConfigValue $envMap "YTDLP_POT_PROVIDER_URL" "") },
  @{ name = "YTDLP_PO_TOKEN"; value = (Get-ConfigValue $envMap "YTDLP_PO_TOKEN" "") },
  @{ name = "YTDLP_VISITOR_DATA"; value = (Get-ConfigValue $envMap "YTDLP_VISITOR_DATA" "") },
  @{ name = "GEMINI_API_KEY"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY" "") },
  @{ name = "GEMINI_API_KEY_2"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_2" "") },
  @{ name = "GEMINI_API_KEY_3"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_3" "") },
  @{ name = "GEMINI_API_KEY_4"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_4" "") },
  @{ name = "GEMINI_API_KEY_5"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_5" "") },
  @{ name = "GEMINI_API_KEY_6"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_6" "") },
  @{ name = "GEMINI_API_KEY_7"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_7" "") },
  @{ name = "GEMINI_API_KEY_8"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_8" "") },
  @{ name = "GEMINI_API_KEY_9"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_9" "") },
  @{ name = "GEMINI_API_KEY_10"; value = (Get-ConfigValue $envMap "GEMINI_API_KEY_10" "") },
  @{ name = "GOOGLE_API_KEY"; value = (Get-ConfigValue $envMap "GOOGLE_API_KEY" "") },
  @{ name = "AI_INTEGRATIONS_GEMINI_BASE_URL"; value = (Get-ConfigValue $envMap "AI_INTEGRATIONS_GEMINI_BASE_URL" "") },
  @{ name = "AI_INTEGRATIONS_GEMINI_API_KEY"; value = (Get-ConfigValue $envMap "AI_INTEGRATIONS_GEMINI_API_KEY" "") },
  @{ name = "ASSEMBLYAI_API_KEY"; value = (Get-ConfigValue $envMap "ASSEMBLYAI_API_KEY" "") },
  @{ name = "VAPID_PUBLIC_KEY"; value = (Get-ConfigValue $envMap "VAPID_PUBLIC_KEY" "") },
  @{ name = "VAPID_PRIVATE_KEY"; value = (Get-ConfigValue $envMap "VAPID_PRIVATE_KEY" "") },
  @{ name = "VAPID_SUBJECT"; value = (Get-ConfigValue $envMap "VAPID_SUBJECT" "") }
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_.value) }

$cookiesBase64 = Get-ConfigValue $envMap "YTDLP_COOKIES_BASE64" ""
if (-not [string]::IsNullOrWhiteSpace($cookiesBase64)) {
  $cookieBucket = Get-ConfigValue $envMap "S3_BUCKET" ""
  $cookiePrefix = (Get-ConfigValue $envMap "S3_OBJECT_PREFIX" $Prefix).Trim("/")
  if ([string]::IsNullOrWhiteSpace($cookieBucket)) {
    throw "YTDLP_COOKIES_BASE64 is set but S3_BUCKET is empty, cannot store worker cookies outside Batch env"
  }
  $cookieKey = "$cookiePrefix/secrets/ytdlp-cookies-base64.txt"
  $cookieTmp = Join-Path $env:TEMP "$Prefix-ytdlp-cookies-base64.txt"
  $cookiesBase64 | Set-Content -Path $cookieTmp -NoNewline
  aws s3 cp $cookieTmp "s3://$cookieBucket/$cookieKey" --region $Region | Out-Null
  Assert-LastExit "Upload yt-dlp cookie secret to S3"
  Remove-Item $cookieTmp -Force -ErrorAction SilentlyContinue
  $containerEnvironment += @{ name = "YTDLP_COOKIES_S3_KEY"; value = $cookieKey }
}

$containerEnvironment = $containerEnvironment | Where-Object { -not [string]::IsNullOrWhiteSpace($_.value) }

$containerPropsObj = @{
  image = $image
  executionRoleArn = $execRoleArn
  jobRoleArn = $taskRoleArn
  resourceRequirements = @(
    @{ type = "VCPU"; value = "2" },
    @{ type = "MEMORY"; value = "4096" }
  )
  networkConfiguration = @{ assignPublicIp = "ENABLED" }
  logConfiguration = @{
    logDriver = "awslogs"
    options = @{
      "awslogs-group" = $logGroup
      "awslogs-region" = $Region
      "awslogs-stream-prefix" = $Prefix
    }
  }
  environment = $containerEnvironment
}

$containerProps = $containerPropsObj | ConvertTo-Json -Depth 8

$tmpContainer = Join-Path $env:TEMP "$Prefix-batch-container-props.json"
$containerProps | Set-Content -Path $tmpContainer -NoNewline
aws batch register-job-definition `
  --region $Region `
  --job-definition-name $jobDefName `
  --type container `
  --platform-capabilities FARGATE `
  --container-properties "file://$tmpContainer" | Out-Null
Assert-LastExit "Register Batch job definition"
Remove-Item $tmpContainer -Force

$computeArn = aws batch describe-compute-environments --region $Region --compute-environments $computeEnvName --query "computeEnvironments[0].computeEnvironmentArn" --output text
$jobQueueArn = aws batch describe-job-queues --region $Region --job-queues $jobQueueName --query "jobQueues[0].jobQueueArn" --output text
$jobDefArn = aws batch describe-job-definitions --region $Region --job-definition-name $jobDefName --status ACTIVE --query "jobDefinitions[0].jobDefinitionArn" --output text

Write-Host ""
Write-Host "Batch phase A ready:"
Write-Host "  Compute Env:   $computeArn"
Write-Host "  Job Queue:     $jobQueueArn"
Write-Host "  Job Def:       $jobDefArn"
Write-Host "  Worker Image:  $image"
Write-Host "  Subnet:        $subnetId"
Write-Host "  SecurityGroup: $securityGroupId"
