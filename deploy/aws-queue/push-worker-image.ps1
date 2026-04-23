param(
  [string]$Region = "us-east-1",
  [string]$Prefix = "ytgrabber-green",
  [string]$ImageTag = "latest"
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

Ensure-Command "aws"
Ensure-Command "docker"

$repoName = "$Prefix-worker"
$repoUri = aws ecr describe-repositories `
  --repository-names $repoName `
  --region $Region `
  --query "repositories[0].repositoryUri" `
  --output text

if (-not $repoUri -or $repoUri -eq "None") {
  throw "ECR repository not found: $repoName. Run create-phase-a-resources.ps1 first."
}

Write-Host "Logging in to ECR..."
aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin ($repoUri.Split("/")[0]) | Out-Null
Assert-LastExit "ECR docker login"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$workerPath = Join-Path $root "artifacts\queue-worker"
 $workerDockerfile = Join-Path $workerPath "Dockerfile"

if (-not (Test-Path $workerPath)) {
  throw "Worker path not found: $workerPath"
}
if (-not (Test-Path $workerDockerfile)) {
  throw "Worker Dockerfile not found: $workerDockerfile"
}

Write-Host "Building worker image..."
docker build -f $workerDockerfile -t "${repoName}:${ImageTag}" $root
Assert-LastExit "Docker build"

Write-Host "Tagging image..."
docker tag "${repoName}:${ImageTag}" "${repoUri}:${ImageTag}"
Assert-LastExit "Docker tag"

Write-Host "Pushing image..."
docker push "${repoUri}:${ImageTag}"
Assert-LastExit "Docker push"

Write-Host ""
Write-Host "Worker image pushed:"
Write-Host "  ${repoUri}:${ImageTag}"
