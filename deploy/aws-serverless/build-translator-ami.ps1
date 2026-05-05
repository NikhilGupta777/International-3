<#
.SYNOPSIS
  Builds a custom ECS GPU AMI with the translator Docker image pre-pulled.
  Run this after every successful translator image build to eliminate the
  10-20 minute cold-start Docker pull on each Batch job.

.PARAMETER ImageTag
  The translator ECR image tag (default: resolves the latest pushed tag).

.PARAMETER Region
  AWS region (default: us-east-1).

.EXAMPLE
  .\build-translator-ami.ps1 -ImageTag "27d477c4"
#>

param(
  [string]$ImageTag    = "",
  [string]$Region      = "us-east-1",
  [string]$Prefix      = "ytgrabber-green",
  [string]$SubnetId    = "subnet-0e39d7f64d803f4d6",
  [string]$AccountId   = "596596146505"
)

$ErrorActionPreference = "Stop"
$EcrRepo = "$AccountId.dkr.ecr.$Region.amazonaws.com/$Prefix-translator"
$InstanceProfile = "$Prefix-ecs-instance-profile"

# ── 1. Resolve translator image URI ──────────────────────────────────────────
if (-not $ImageTag) {
  Write-Host "[1/7] Resolving latest translator image tag from ECR..."
  $ImageTag = (aws ecr describe-images `
    --repository-name "$Prefix-translator" `
    --region $Region `
    --query "sort_by(imageDetails, &imagePushedAt)[-1].imageTags[0]" `
    --output text 2>&1).Trim()
  if (-not $ImageTag -or $ImageTag -eq "None") {
    throw "Could not resolve latest translator image tag from ECR."
  }
}
$ImageUri = "${EcrRepo}:${ImageTag}"
Write-Host "[1/7] Using translator image: $ImageUri"

# ── 2. Find latest Amazon ECS-optimized GPU AMI ───────────────────────────────
Write-Host "[2/7] Finding latest ECS-optimized GPU AMI..."
$BaseAmi = (aws ec2 describe-images `
  --owners amazon `
  --region $Region `
  --filters "Name=name,Values=amzn2-ami-ecs-gpu-hvm-*-x86_64-ebs" `
            "Name=state,Values=available" `
  --query "sort_by(Images, &CreationDate)[-1].ImageId" `
  --output text 2>&1).Trim()
Write-Host "[2/7] Base AMI: $BaseAmi"

# ── 3. Build user-data to pull image on boot ──────────────────────────────────
$UserData = @"
#!/bin/bash
set -e
sleep 20
aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $AccountId.dkr.ecr.$Region.amazonaws.com
echo "Pulling $ImageUri ..."
docker pull $ImageUri
echo "ECS_IMAGE_PULL_BEHAVIOR=prefer-cached" >> /etc/ecs/ecs.config
echo "ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=24h" >> /etc/ecs/ecs.config
INSTANCE_ID=`$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 create-tags --region $Region --resources `$INSTANCE_ID --tags Key=ami-build-status,Value=ready
echo "Done."
"@
$UserDataB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($UserData))

# ── 4. Launch temp EC2 builder instance ──────────────────────────────────────
Write-Host "[3/7] Launching temp EC2 instance to pull translator image..."
$blockDevices = '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":200,"VolumeType":"gp3","DeleteOnTermination":true}}]'
[System.IO.File]::WriteAllText("$PWD\block_devices.json", $blockDevices, [Text.Encoding]::ASCII)

$launchResult = aws ec2 run-instances `
  --image-id $BaseAmi `
  --instance-type "g4dn.xlarge" `
  --iam-instance-profile "Name=$InstanceProfile" `
  --subnet-id $SubnetId `
  --block-device-mappings file://block_devices.json `
  --user-data $UserDataB64 `
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=translator-ami-builder},{Key=ami-build-status,Value=building}]" `
  --region $Region | ConvertFrom-Json

$InstanceId = $launchResult.Instances[0].InstanceId
Write-Host "[3/7] Instance launched: $InstanceId"
Remove-Item -ErrorAction SilentlyContinue .\block_devices.json

# ── 5. Wait for pull to complete ──────────────────────────────────────────────
Write-Host "[4/7] Waiting for image pull to complete (up to 30 min)..."
$maxWait = 36  # 36 × 50s = 30 min
for ($i = 1; $i -le $maxWait; $i++) {
  Start-Sleep -Seconds 50
  $tagValue = (aws ec2 describe-tags `
    --filters "Name=resource-id,Values=$InstanceId" "Name=key,Values=ami-build-status" `
    --query "Tags[0].Value" --output text --region $Region 2>&1).Trim()
  Write-Host "  [$i/$maxWait] Status: $tagValue"
  if ($tagValue -eq "ready") {
    Write-Host "[4/7] Image pull complete!"
    break
  }
  if ($i -eq $maxWait) {
    Write-Host "⚠️  Timed out waiting for pull. Proceeding anyway (image may be partial)."
  }
}

# ── 6. Create AMI from instance ───────────────────────────────────────────────
$AmiName = "$Prefix-translator-ami-$ImageTag"
Write-Host "[5/7] Creating AMI: $AmiName ..."
$AmiResult = aws ec2 create-image `
  --instance-id $InstanceId `
  --name $AmiName `
  --description "Translator GPU AMI — pre-pulled $ImageUri" `
  --no-reboot `
  --block-device-mappings file://block_devices.json `
  --region $Region | ConvertFrom-Json 2>&1

# block_devices deleted, recreate
[System.IO.File]::WriteAllText("$PWD\block_devices.json", $blockDevices, [Text.Encoding]::ASCII)
$AmiResult = aws ec2 create-image `
  --instance-id $InstanceId `
  --name $AmiName `
  --description "Translator GPU AMI — pre-pulled $ImageUri" `
  --no-reboot `
  --block-device-mappings file://block_devices.json `
  --region $Region | ConvertFrom-Json
Remove-Item -ErrorAction SilentlyContinue .\block_devices.json

$AmiId = $AmiResult.ImageId
Write-Host "[5/7] AMI creation started: $AmiId"

# Wait for AMI to be available
Write-Host "       Waiting for AMI $AmiId to become available..."
aws ec2 wait image-available --image-ids $AmiId --region $Region
Write-Host "       AMI ready: $AmiId"

# ── 7. Update Batch compute environments ─────────────────────────────────────
Write-Host "[6/7] Updating Batch compute environments to use AMI $AmiId ..."
foreach ($Ce in @("$Prefix-gpu-fast-compute", "$Prefix-gpu-compute")) {
  $updateJson = "{`"imageId`":`"$AmiId`"}"
  [System.IO.File]::WriteAllText("$PWD\ami_update.json", $updateJson, [Text.Encoding]::ASCII)
  $result = aws batch update-compute-environment `
    --compute-environment $Ce `
    --compute-resources file://ami_update.json `
    --region $Region 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ $Ce → $AmiId"
  } else {
    Write-Host "  ⚠️  $Ce: $result (may need launch template — AMI ID: $AmiId)"
  }
  Remove-Item -ErrorAction SilentlyContinue .\ami_update.json
}

# ── Terminate temp instance ───────────────────────────────────────────────────
aws ec2 terminate-instances --instance-ids $InstanceId --region $Region | Out-Null
Write-Host "[7/7] Temp instance $InstanceId terminated."

# ── Cleanup: deregister old AMIs (keep last 3) ───────────────────────────────
Write-Host "Cleaning up old AMIs (keeping last 3)..."
$oldAmis = (aws ec2 describe-images `
  --owners self `
  --filters "Name=name,Values=$Prefix-translator-ami-*" "Name=state,Values=available" `
  --query "sort_by(Images, &CreationDate)[:-3].[ImageId, BlockDeviceMappings[0].Ebs.SnapshotId]" `
  --output text --region $Region 2>&1) -split "`n"
foreach ($line in $oldAmis) {
  $parts = $line.Trim() -split "\s+"
  if ($parts.Count -ge 2) {
    aws ec2 deregister-image --image-id $parts[0] --region $Region 2>&1 | Out-Null
    aws ec2 delete-snapshot --snapshot-id $parts[1] --region $Region 2>&1 | Out-Null
    Write-Host "  Removed old AMI: $($parts[0])"
  }
}

Write-Host ""
Write-Host "============================================================"
Write-Host "✅ Custom translator GPU AMI ready!"
Write-Host "   AMI ID:  $AmiId"
Write-Host "   Image:   $ImageUri"
Write-Host ""
Write-Host "Next job cold starts will use pre-pulled image (~2-4 min)"
Write-Host "instead of pulling 20 GB from scratch (~10-20 min)."
Write-Host "============================================================"
