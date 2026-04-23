param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [Parameter(Mandatory = $true)][string]$KeyPath,
  [string]$User = "ubuntu",
  [string]$RepoUrl = "https://github.com/NikhilGupta777/International-3.git",
  [string]$Branch = "main",
  [string]$RemoteDir = "/opt/ytgrabber",
  [string]$LocalEnvPath = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Assert-LastExit([string]$context) {
  if ($LASTEXITCODE -ne 0) {
    throw "$context failed with exit code $LASTEXITCODE"
  }
}

function Resolve-Binary([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) {
    return $cmd.Source
  }
  $gitPath = "C:\Program Files\Git\usr\bin\$name.exe"
  if (Test-Path $gitPath) {
    return $gitPath
  }
  throw "Required executable not found: $name"
}

$SshBin = Resolve-Binary "ssh"
$ScpBin = Resolve-Binary "scp"

function Invoke-Remote([string]$Command) {
  & $SshBin -o StrictHostKeyChecking=accept-new -i $KeyPath "$User@$HostName" $Command
  Assert-LastExit "SSH command"
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
  sudo rm -rf "$RemoteDir"
  sudo git clone --depth 1 --branch "$Branch" "$RepoUrl" "$RemoteDir"
  sudo chown -R ${User}:${User} "$RemoteDir"
else
  cd "$RemoteDir"
  git fetch origin "$Branch" --depth 1
  git checkout "$Branch"
  git reset --hard "origin/$Branch"
fi
"@

if (-not [string]::IsNullOrWhiteSpace($LocalEnvPath)) {
  & $ScpBin -o StrictHostKeyChecking=accept-new -i $KeyPath $LocalEnvPath "${User}@${HostName}:$RemoteDir/.env"
  Assert-LastExit "SCP upload"
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
sudo docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
sudo docker builder prune -af --filter "until=168h" >/dev/null 2>&1 || true
"@

Write-Host ""
Write-Host "Deployment completed."
Write-Host "Health check URL: https://$HostName/api/healthz"
