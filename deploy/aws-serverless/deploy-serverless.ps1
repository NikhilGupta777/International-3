param(
  [string]$Region = "us-east-1",
  [string]$Prefix = "ytgrabber-green",
  [string]$EnvFilePath = ".\deploy\ec2\.env.green",
  [string]$ImageTag = "",
  [string]$ImageUri = "",
  [switch]$SkipImageBuild,
  [string]$StackName = "",
  [string]$SiteBucketName = "",
  [string]$SiteDomainName = "",
  [string]$CloudFrontCertificateArn = ""
)

$ErrorActionPreference = "Stop"

function Assert-LastExitCode {
  param([string]$Step)
  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

function Get-EnvMap {
  param([string]$Path)

  $resolved = Resolve-Path $Path
  $map = @{}

  foreach ($line in Get-Content $resolved) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $parts = $trimmed -split "=", 2
    if ($parts.Count -ne 2) { continue }
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$key] = $value
  }

  return $map
}

function Get-RequiredEnv {
  param(
    [hashtable]$EnvMap,
    [string]$Key
  )

  if (-not $EnvMap.ContainsKey($Key) -or [string]::IsNullOrWhiteSpace($EnvMap[$Key])) {
    throw "Missing required env value: $Key"
  }

  return $EnvMap[$Key]
}

function Get-OptionalEnv {
  param(
    [hashtable]$EnvMap,
    [string]$Key,
    [string]$Default = ""
  )

  if (-not $EnvMap.ContainsKey($Key)) {
    return $Default
  }

  $value = [string]$EnvMap[$Key]
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }

  return $value
}

function Remove-RollbackCompleteStackIfNeeded {
  param(
    [string]$Region,
    [string]$StackName
  )

  $describeOutput = aws cloudformation describe-stacks `
    --region $Region `
    --stack-name $StackName 2>$null

  if ($LASTEXITCODE -ne 0 -or -not $describeOutput) {
    return
  }

  $describeJson = $describeOutput | ConvertFrom-Json
  if (-not $describeJson -or -not $describeJson.Stacks -or $describeJson.Stacks.Count -eq 0) {
    return
  }

  $status = [string]$describeJson.Stacks[0].StackStatus
  if ($status -ne "ROLLBACK_COMPLETE") {
    return
  }

  Write-Output "Deleting rollback-complete stack: $StackName"
  aws cloudformation delete-stack `
    --region $Region `
    --stack-name $StackName | Out-Null
  Assert-LastExitCode "cloudformation delete-stack"
  aws cloudformation wait stack-delete-complete `
    --region $Region `
    --stack-name $StackName
  Assert-LastExitCode "cloudformation wait stack-delete-complete"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$templatePath = Join-Path $PSScriptRoot "template.yml"
$envMap = Get-EnvMap -Path $EnvFilePath

if (-not $ImageTag) {
  $ImageTag = (Get-Date -Format "yyyyMMdd-HHmmss")
}

if (-not $StackName) {
  $StackName = "$Prefix-serverless"
}

$resolvedImageUri = $ImageUri
if (-not $SkipImageBuild) {
  $pushScript = Join-Path $PSScriptRoot "push-api-lambda-image.ps1"
  $resolvedImageUri = & $pushScript -Region $Region -Prefix $Prefix -ImageTag $ImageTag
  if (-not $resolvedImageUri) {
    throw "Failed to build/push API Lambda image"
  }
}

if (-not $resolvedImageUri) {
  throw "ImageUri is required when -SkipImageBuild is used."
}

$primaryJobTypes = if ($envMap.ContainsKey("YOUTUBE_QUEUE_PRIMARY_JOB_TYPES") -and $envMap["YOUTUBE_QUEUE_PRIMARY_JOB_TYPES"]) {
  $envMap["YOUTUBE_QUEUE_PRIMARY_JOB_TYPES"]
} else {
  "clip-cut"
}

$bhagwatPassword = Get-OptionalEnv $envMap 'BHAGWAT_PASSWORD'
if (-not $bhagwatPassword) {
  $existingBhagwatPasswordFromStack = aws cloudformation describe-stacks `
    --region $Region `
    --stack-name $StackName `
    --query "Stacks[0].Parameters[?ParameterKey=='BhagwatPassword'].ParameterValue | [0]" `
    --output text 2>$null
  if (
    $LASTEXITCODE -eq 0 -and
    $existingBhagwatPasswordFromStack -and
    $existingBhagwatPasswordFromStack -ne "None" -and
    $existingBhagwatPasswordFromStack -ne "****"
  ) {
    $bhagwatPassword = $existingBhagwatPasswordFromStack
  }
}
if (-not $bhagwatPassword) {
  $apiFunctionName = "$Prefix-api"
  $existingBhagwatPassword = aws lambda get-function-configuration `
    --region $Region `
    --function-name $apiFunctionName `
    --query "Environment.Variables.BHAGWAT_PASSWORD" `
    --output text 2>$null
  if ($LASTEXITCODE -eq 0 -and $existingBhagwatPassword -and $existingBhagwatPassword -ne "None") {
    $bhagwatPassword = $existingBhagwatPassword
  }
}
if (-not $bhagwatPassword) {
  throw "Missing required env value: BHAGWAT_PASSWORD"
}

$requiredTypes = @("clip-cut", "best-clips", "bhagwat-analyze", "bhagwat-render")
$primarySet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($item in ($primaryJobTypes -split ",")) {
  $trimmed = $item.Trim()
  if ($trimmed) { [void]$primarySet.Add($trimmed) }
}
foreach ($item in $requiredTypes) {
  [void]$primarySet.Add($item)
}
$primaryJobTypes = (@($primarySet) | Sort-Object) -join ","

$parameterOverrides = @(
  "Prefix=$Prefix"
  "ImageUri=$resolvedImageUri"
  "SiteBucketName=$SiteBucketName"
  "SiteDomainName=$SiteDomainName"
  "CloudFrontCertificateArn=$CloudFrontCertificateArn"
  "SessionSecret=$(Get-RequiredEnv $envMap 'SESSION_SECRET')"
  "WebsiteAuthUser=$(Get-OptionalEnv $envMap 'WEBSITE_AUTH_USER' 'kalki_avatar')"
  "WebsiteAuthPassword=$(Get-RequiredEnv $envMap 'WEBSITE_AUTH_PASSWORD')"
  "BhagwatPassword=$bhagwatPassword"
  "GeminiApiKey=$(Get-RequiredEnv $envMap 'GEMINI_API_KEY')"
  "GeminiApiKey2=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_2')"
  "GeminiApiKey3=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_3')"
  "GeminiApiKey4=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_4')"
  "GeminiApiKey5=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_5')"
  "GeminiApiKey6=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_6')"
  "AssemblyAiApiKey=$(Get-OptionalEnv $envMap 'ASSEMBLYAI_API_KEY')"
  "YtdlpCookiesFile=$(Get-OptionalEnv $envMap 'YTDLP_COOKIES_FILE' '/tmp/yt-cookies.txt')"
  "YtdlpCookiesS3Key=$(Get-OptionalEnv $envMap 'YTDLP_COOKIES_S3_KEY')"
  "YtdlpPoToken=$(Get-OptionalEnv $envMap 'YTDLP_PO_TOKEN')"
  "YtdlpVisitorData=$(Get-OptionalEnv $envMap 'YTDLP_VISITOR_DATA')"
  "YtdlpPotProviderUrl=$(Get-OptionalEnv $envMap 'YTDLP_POT_PROVIDER_URL')"
  "YtdlpProxy=$(Get-OptionalEnv $envMap 'YTDLP_PROXY')"
  "OutputBucketName=$(Get-RequiredEnv $envMap 'S3_BUCKET')"
  "OutputBucketRegion=$(Get-OptionalEnv $envMap 'S3_REGION' $Region)"
  "OutputObjectPrefix=$(Get-OptionalEnv $envMap 'S3_OBJECT_PREFIX' $Prefix)"
  "SignedUrlTtlSec=$(Get-OptionalEnv $envMap 'S3_SIGNED_URL_TTL_SEC' '7200')"
  "YoutubeQueueRegion=$(Get-RequiredEnv $envMap 'YOUTUBE_QUEUE_REGION')"
  "YoutubeQueueJobTable=$(Get-RequiredEnv $envMap 'YOUTUBE_QUEUE_JOB_TABLE')"
  "YoutubeBatchJobQueue=$(Get-RequiredEnv $envMap 'YOUTUBE_BATCH_JOB_QUEUE')"
  "YoutubeBatchJobDefinition=$(Get-RequiredEnv $envMap 'YOUTUBE_BATCH_JOB_DEFINITION')"
  "YoutubeQueuePrimaryEnabled=true"
  "YoutubeQueueShadowEnabled=$(Get-OptionalEnv $envMap 'YOUTUBE_QUEUE_SHADOW_ENABLED' 'false')"
  "YoutubeQueuePrimaryJobTypes=$primaryJobTypes"
  "YoutubeQueueShadowJobTypes=$(Get-OptionalEnv $envMap 'YOUTUBE_QUEUE_SHADOW_JOB_TYPES' 'download,clip-cut')"
  "SubtitlesForceLambda=$(Get-OptionalEnv $envMap 'SUBTITLES_FORCE_LAMBDA' 'true')"
  "RateLimitBypassIps=$(Get-OptionalEnv $envMap 'RATE_LIMIT_BYPASS_IPS')"
  "VapidPublicKey=$(Get-OptionalEnv $envMap 'VAPID_PUBLIC_KEY')"
  "VapidPrivateKey=$(Get-OptionalEnv $envMap 'VAPID_PRIVATE_KEY')"
  "VapidSubject=$(Get-OptionalEnv $envMap 'VAPID_SUBJECT' 'mailto:ops@videomaking.in')"
)

Remove-RollbackCompleteStackIfNeeded -Region $Region -StackName $StackName

$deployOutput = aws cloudformation deploy `
  --region $Region `
  --stack-name $StackName `
  --template-file $templatePath `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides $parameterOverrides `
  --no-fail-on-empty-changeset 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error ("cloudformation deploy output: " + ($deployOutput -join " "))
  Assert-LastExitCode "cloudformation deploy"
}

$stackJson = aws cloudformation describe-stacks `
  --region $Region `
  --stack-name $StackName | ConvertFrom-Json
Assert-LastExitCode "cloudformation describe-stacks"
if (-not $stackJson -or -not $stackJson.Stacks -or $stackJson.Stacks.Count -eq 0) {
  throw "CloudFormation stack was not created: $StackName"
}
$outputs = @{}
foreach ($output in $stackJson.Stacks[0].Outputs) {
  $outputs[$output.OutputKey] = $output.OutputValue
}

$siteBucket = $outputs["StaticSiteBucketName"]
$distributionId = $outputs["CloudFrontDistributionId"]
$cloudFrontDomain = $outputs["CloudFrontDomainName"]

if (-not $siteBucket -or -not $distributionId) {
  throw "Failed to resolve CloudFormation outputs"
}

pnpm --filter @workspace/yt-downloader run build
Assert-LastExitCode "pnpm yt-downloader build"

aws s3 sync `
  (Join-Path $repoRoot "artifacts\yt-downloader\dist\public") `
  "s3://$siteBucket/" `
  --region $Region `
  --delete | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "aws s3 sync failed with exit code $LASTEXITCODE (continuing without static sync)"
}

aws cloudfront create-invalidation `
  --distribution-id $distributionId `
  --paths "/*" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "aws cloudfront create-invalidation failed with exit code $LASTEXITCODE"
}

Write-Output ""
Write-Output "Serverless deploy complete"
Write-Output "Stack: $StackName"
Write-Output "CloudFront: $cloudFrontDomain"
Write-Output "DistributionId: $distributionId"
Write-Output "SiteBucket: $siteBucket"
