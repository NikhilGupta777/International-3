param(
  [Parameter(Mandatory = $true)][string]$Host,
  [Parameter(Mandatory = $true)][string]$KeyPath,
  [string]$User = "ubuntu",
  [string]$RepoUrl = "https://github.com/NikhilGupta777/International-3.git",
  [string]$Branch = "main",
  [string]$RemoteDir = "/opt/ytgrabber",
  [string]$LocalEnvPath = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Invoke-Remote([string]$Command) {
  & ssh -o StrictHostKeyChecking=accept-new -i $KeyPath "$User@$Host" $Command
}

if (-not (Test-Path $KeyPath)) {
  throw "Key file not found: $KeyPath"
}

if (-not [string]::IsNullOrWhiteSpace($LocalEnvPath)) {
  if (-not (Test-Path $LocalEnvPath)) {
    throw "Env file not found: $LocalEnvPath"
  }
}

Invoke-Remote "sudo mkdir -p $RemoteDir && sudo chown -R ${User}:${User} $RemoteDir"

Invoke-Remote @"
set -euo pipefail
if [ ! -d "$RemoteDir/.git" ]; then
  rm -rf "$RemoteDir"
  git clone --depth 1 --branch "$Branch" "$RepoUrl" "$RemoteDir"
else
  cd "$RemoteDir"
  git fetch origin "$Branch" --depth 1
  git checkout "$Branch"
  git reset --hard "origin/$Branch"
fi
"@

if (-not [string]::IsNullOrWhiteSpace($LocalEnvPath)) {
  & scp -o StrictHostKeyChecking=accept-new -i $KeyPath $LocalEnvPath "${User}@${Host}:$RemoteDir/.env"
}

$buildFlag = if ($SkipBuild) { "true" } else { "false" }
Invoke-Remote @"
set -euo pipefail
cd "$RemoteDir"
if [ "$buildFlag" != "true" ]; then
  sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml build --pull
fi
sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml up -d
sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml ps
"@

Write-Host ""
Write-Host "Deployment completed."
Write-Host "Health check URL: https://$Host/api/healthz"
