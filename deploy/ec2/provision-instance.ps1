param(
  [string]$Region = "us-east-1",
  [string]$ProjectName = "ytgrabber-prod",
  [string]$InstanceType = "c6a.xlarge",
  [int]$VolumeSizeGiB = 80,
  [string]$KeyName = "ytgrabber-prod-key",
  [string]$AllowedSshCidr = "",
  [switch]$OpenSshToWorld
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

Require-Command aws

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$keyDir = Join-Path $repoRoot "deploy\ec2\keys"
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null

if ([string]::IsNullOrWhiteSpace($AllowedSshCidr) -and -not $OpenSshToWorld) {
  try {
    $myIp = (Invoke-RestMethod -Uri "https://checkip.amazonaws.com").Trim()
    $AllowedSshCidr = "$myIp/32"
  } catch {
    throw "Could not auto-detect public IP. Pass -AllowedSshCidr explicitly."
  }
}

if ($OpenSshToWorld) {
  $AllowedSshCidr = "0.0.0.0/0"
}

$env:AWS_DEFAULT_REGION = $Region

$vpcId = aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query "Vpcs[0].VpcId" --output text
if (-not $vpcId -or $vpcId -eq "None") {
  throw "No default VPC found in region $Region."
}

$subnetId = aws ec2 describe-subnets --filters Name=vpc-id,Values=$vpcId Name=default-for-az,Values=true --query "Subnets[0].SubnetId" --output text
if (-not $subnetId -or $subnetId -eq "None") {
  throw "No default subnet found in default VPC $vpcId."
}

$sgName = "$ProjectName-sg"
$sgId = aws ec2 describe-security-groups --filters Name=group-name,Values=$sgName Name=vpc-id,Values=$vpcId --query "SecurityGroups[0].GroupId" --output text 2>$null
if (-not $sgId -or $sgId -eq "None") {
  $sgId = aws ec2 create-security-group --group-name $sgName --description "Security group for $ProjectName" --vpc-id $vpcId --query "GroupId" --output text
}

try { aws ec2 authorize-security-group-ingress --group-id $sgId --protocol tcp --port 80 --cidr 0.0.0.0/0 2>$null | Out-Null } catch {}
try { aws ec2 authorize-security-group-ingress --group-id $sgId --protocol tcp --port 443 --cidr 0.0.0.0/0 2>$null | Out-Null } catch {}
try { aws ec2 authorize-security-group-ingress --group-id $sgId --protocol tcp --port 22 --cidr $AllowedSshCidr 2>$null | Out-Null } catch {}

$keyPath = Join-Path $keyDir "$KeyName.pem"
$existingKey = $null
try {
  $existingKey = aws ec2 describe-key-pairs --key-names $KeyName --query "KeyPairs[0].KeyName" --output text 2>$null
} catch {
  $existingKey = $null
}
if ((-not $existingKey -or $existingKey -eq "None") -and -not (Test-Path $keyPath)) {
  $created = aws ec2 create-key-pair --key-name $KeyName --output json | ConvertFrom-Json
  $pem = $created.KeyMaterial
  Set-Content -Path $keyPath -Value $pem -NoNewline
}

if (-not (Test-Path $keyPath)) {
  throw "Key pair exists in AWS but local key file is missing: $keyPath"
}

try {
  & icacls $keyPath /inheritance:r /grant:r "$env:USERNAME`:R" | Out-Null
} catch {}

$amiId = aws ssm get-parameter --name "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id" --query "Parameter.Value" --output text
if (-not $amiId -or $amiId -eq "None") {
  throw "Could not resolve Ubuntu 24.04 AMI from SSM."
}

$userDataPath = Join-Path $repoRoot "deploy\ec2\user-data.sh"
if (-not (Test-Path $userDataPath)) {
  throw "Missing user-data script at $userDataPath"
}

$tagSpec = "ResourceType=instance,Tags=[{Key=Name,Value=$ProjectName},{Key=Project,Value=ytgrabber}]"
$run = aws ec2 run-instances `
  --image-id $amiId `
  --instance-type $InstanceType `
  --key-name $KeyName `
  --security-group-ids $sgId `
  --subnet-id $subnetId `
  --associate-public-ip-address `
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VolumeSizeGiB,VolumeType=gp3,DeleteOnTermination=true}" `
  --user-data ("file://" + $userDataPath) `
  --tag-specifications $tagSpec `
  --query "Instances[0].InstanceId" `
  --output text

if (-not $run -or $run -eq "None") {
  throw "Failed to create instance."
}
$instanceId = $run.Trim()

aws ec2 wait instance-running --instance-ids $instanceId
aws ec2 wait instance-status-ok --instance-ids $instanceId

$publicIp = aws ec2 describe-instances --instance-ids $instanceId --query "Reservations[0].Instances[0].PublicIpAddress" --output text

Write-Host ""
Write-Host "Provisioned EC2 instance:"
Write-Host "  InstanceId: $instanceId"
Write-Host "  PublicIP:   $publicIp"
Write-Host "  Region:     $Region"
Write-Host "  SSH key:    $keyPath"
Write-Host ""
Write-Host "SSH command:"
Write-Host "  ssh -i `"$keyPath`" ubuntu@$publicIp"
