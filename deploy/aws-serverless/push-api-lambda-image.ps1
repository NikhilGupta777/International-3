param(
  [string]$Region = "us-east-1",
  [string]$Prefix = "ytgrabber-green",
  [string]$ImageTag = "latest"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$repositoryName = "$Prefix-api-lambda"

$repoJson = cmd /c "aws ecr describe-repositories --region $Region --repository-names $repositoryName 2>nul"

if ($LASTEXITCODE -ne 0 -or -not $repoJson) {
  aws ecr create-repository `
    --region $Region `
    --repository-name $repositoryName `
    --image-scanning-configuration scanOnPush=true `
    --image-tag-mutability MUTABLE | Out-Null

  $repoJson = aws ecr describe-repositories `
    --region $Region `
    --repository-names $repositoryName
}

$repositoryUri = ($repoJson | ConvertFrom-Json).repositories[0].repositoryUri
if (-not $repositoryUri) {
  throw "Failed to resolve ECR repository URI for $repositoryName"
}

aws ecr get-login-password --region $Region |
  docker login --username AWS --password-stdin ($repositoryUri.Split("/")[0]) | Out-Null

docker buildx build `
  --platform linux/amd64 `
  --provenance=false `
  --sbom=false `
  --push `
  -f (Join-Path $repoRoot "Dockerfile.api-lambda") `
  -t "${repositoryUri}:${ImageTag}" `
  $repoRoot
if ($LASTEXITCODE -ne 0) {
  throw "Docker buildx push failed for ${repositoryUri}:${ImageTag}"
}

Write-Output "${repositoryUri}:${ImageTag}"
