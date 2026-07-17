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
$PSNativeCommandUseErrorActionPreference = $false

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

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $describeOutput = aws cloudformation describe-stacks `
      --region $Region `
      --stack-name $StackName 2>$null
    $describeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($describeExitCode -ne 0 -or -not $describeOutput) {
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

function Get-ExistingStackParameterMap {
  param(
    [string]$Region,
    [string]$StackName
  )

  $map = @{}
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $describeOutput = aws cloudformation describe-stacks `
      --region $Region `
      --stack-name $StackName 2>$null
    $describeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($describeExitCode -ne 0 -or -not $describeOutput) {
    return $map
  }

  $describeJson = $describeOutput | ConvertFrom-Json
  if (-not $describeJson -or -not $describeJson.Stacks -or $describeJson.Stacks.Count -eq 0) {
    return $map
  }

  foreach ($parameter in $describeJson.Stacks[0].Parameters) {
    $map[[string]$parameter.ParameterKey] = [string]$parameter.ParameterValue
  }

  return $map
}

function Remove-BlankExistingStackOverrides {
  param(
    [string[]]$Overrides,
    [hashtable]$ExistingParams
  )

  if (-not $ExistingParams -or $ExistingParams.Count -eq 0) {
    return $Overrides
  }

  $filtered = @()
  foreach ($override in $Overrides) {
    $parts = [string]$override -split "=", 2
    if ($parts.Count -ne 2) {
      $filtered += $override
      continue
    }

    $key = $parts[0]
    $value = $parts[1]
    if ([string]::IsNullOrWhiteSpace($value) -and $ExistingParams.ContainsKey($key)) {
      Write-Host "Preserving existing CloudFormation parameter because local override is blank: $key"
      continue
    }

    $filtered += $override
  }

  return $filtered
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$templatePath = Join-Path $PSScriptRoot "template.yml"
$envMap = Get-EnvMap -Path $EnvFilePath

# Preflight validation to fail fast on missing environment variables
$null = Get-RequiredEnv $envMap 'SESSION_SECRET'
$null = Get-RequiredEnv $envMap 'WEBSITE_AUTH_PASSWORD'
$null = Get-RequiredEnv $envMap 'S3_BUCKET'
$null = Get-RequiredEnv $envMap 'YOUTUBE_QUEUE_REGION'
$null = Get-RequiredEnv $envMap 'YOUTUBE_QUEUE_JOB_TABLE'
$null = Get-RequiredEnv $envMap 'YOUTUBE_BATCH_JOB_QUEUE'
$null = Get-RequiredEnv $envMap 'YOUTUBE_BATCH_JOB_DEFINITION'

if (-not $ImageTag) {
  $ImageTag = (Get-Date -Format "yyyyMMdd-HHmmss")
}

if (-not $StackName) {
  $StackName = "$Prefix-serverless"
}

$existingStackParams = Get-ExistingStackParameterMap -Region $Region -StackName $StackName

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

$requiredTypes = @("clip-cut", "bhagwat-analyze", "bhagwat-render")
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
  "GoogleAuthEnabled=$(Get-OptionalEnv $envMap 'GOOGLE_AUTH_ENABLED' 'false')"
  "GoogleClientId=$(Get-OptionalEnv $envMap 'GOOGLE_CLIENT_ID')"
  "ApprovedUserEmails=$(Get-OptionalEnv $envMap 'APPROVED_USER_EMAILS')"
  "ApprovedAdminEmails=$(Get-OptionalEnv $envMap 'APPROVED_ADMIN_EMAILS')"
  "AccessTable=$(Get-OptionalEnv $envMap 'ACCESS_TABLE' ($Prefix + '-access'))"
  "ApiKeysTable=$(Get-OptionalEnv $envMap 'API_KEYS_TABLE')"
  "ApiAccessEmails=$(Get-OptionalEnv $envMap 'API_ACCESS_EMAILS')"
  "ApiKeyRateLimitPerMin=$(Get-OptionalEnv $envMap 'API_KEY_RATE_LIMIT_PER_MIN' '120')"
  "WebhookSigningSecret=$(Get-OptionalEnv $envMap 'WEBHOOK_SIGNING_SECRET')"
  "AdminPanelEnabled=$(Get-OptionalEnv $envMap 'ADMIN_PANEL_ENABLED' 'false')"
  "TranslatorEnabled=$(Get-OptionalEnv $envMap 'TRANSLATOR_ENABLED' 'true')"
  "SuperAgentEnabled=$(Get-OptionalEnv $envMap 'SUPER_AGENT_ENABLED' 'true')"
  "PitajiFeatureEnabled=$(Get-OptionalEnv $envMap 'PITAJI_FEATURE_ENABLED' 'false')"
  "PitajiUsername=$(Get-OptionalEnv $envMap 'PITAJI_USERNAME' 'pitaji')"
  "PitajiPassword=$(Get-OptionalEnv $envMap 'PITAJI_PASSWORD')"
  "BhagwatPassword=$bhagwatPassword"
  "GeminiApiKey=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY')"
  "GeminiApiKey2=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_2')"
  "GeminiApiKey3=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_3')"
  "GeminiApiKey4=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_4')"
  "GeminiApiKey5=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_5')"
  "GeminiApiKey6=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_6')"
  "GeminiApiKey7=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_7')"
  "GeminiApiKey8=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_8')"
  "GeminiApiKey9=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_9')"
  "GeminiApiKey10=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_10')"
  "GeminiApiKey11=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_11')"
  "GeminiApiKey12=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_12')"
  "GeminiApiKey13=$(Get-OptionalEnv $envMap 'GEMINI_API_KEY_13')"
  "HeyGenApiKey=$(Get-OptionalEnv $envMap 'HEYGEN_API_KEY')"
  "HeyGenUploadMaxBytes=$(Get-OptionalEnv $envMap 'HEYGEN_UPLOAD_MAX_BYTES' '5242880')"
  "HeyGenSrtModel=$(Get-OptionalEnv $envMap 'HEYGEN_SRT_MODEL' 'gemini-3.5-flash')"
  "HeyGenRequestTimeoutMs=$(Get-OptionalEnv $envMap 'HEYGEN_REQUEST_TIMEOUT_MS' '60000')"
  "GoogleGenaiUseVertexai=$(Get-OptionalEnv $envMap 'GOOGLE_GENAI_USE_VERTEXAI' 'false')"
  "GoogleCloudProject=$(Get-OptionalEnv $envMap 'GOOGLE_CLOUD_PROJECT')"
  "GoogleCloudLocation=$(Get-OptionalEnv $envMap 'GOOGLE_CLOUD_LOCATION' 'global')"
  "OllamaApiKey=$(Get-OptionalEnv $envMap 'OLLAMA_API_KEY')"
  "OllamaApiKey2=$(Get-OptionalEnv $envMap 'OLLAMA_API_KEY_2')"
  "OllamaApiKey3=$(Get-OptionalEnv $envMap 'OLLAMA_API_KEY_3')"
  "OllamaApiKey4=$(Get-OptionalEnv $envMap 'OLLAMA_API_KEY_4')"
  "GroqApiKey=$(Get-OptionalEnv $envMap 'GROQ_API_KEY')"
  "GroqApiKey2=$(Get-OptionalEnv $envMap 'GROQ_API_KEY_2')"
  "GroqApiKey3=$(Get-OptionalEnv $envMap 'GROQ_API_KEY_3')"
  "GroqApiKey4=$(Get-OptionalEnv $envMap 'GROQ_API_KEY_4')"
  "CopilotUltraModel=$(Get-OptionalEnv $envMap 'COPILOT_ULTRA_MODEL' 'gpt-oss:120b')"
  "CopilotFastModel=$(Get-OptionalEnv $envMap 'COPILOT_FAST_MODEL' 'llama-3.1-8b-instant')"
  "CopilotUltraMaxOutputTokens=$(Get-OptionalEnv $envMap 'COPILOT_ULTRA_MAX_OUTPUT_TOKENS' '32000')"
  "CopilotFastMaxOutputTokens=$(Get-OptionalEnv $envMap 'COPILOT_FAST_MAX_OUTPUT_TOKENS' '1024')"
  "CopilotFastInputCharLimit=$(Get-OptionalEnv $envMap 'COPILOT_FAST_INPUT_CHAR_LIMIT' '10000')"
  "CopilotGeminiHelperModel=$(Get-OptionalEnv $envMap 'COPILOT_GEMINI_HELPER_MODEL' 'gemini-3.5-flash')"
  "AssemblyAiApiKey=$(Get-OptionalEnv $envMap 'ASSEMBLYAI_API_KEY')"
  "E2BApiKey=$(Get-OptionalEnv $envMap 'E2B_API_KEY')"
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
  "VideoEditorBatchEnabled=$(Get-OptionalEnv $envMap 'VIDEO_EDITOR_BATCH_ENABLED' 'false')"
  "VideoEditorBatchJobDefinition=$(Get-OptionalEnv $envMap 'VIDEO_EDITOR_BATCH_JOB_DEFINITION' (Get-RequiredEnv $envMap 'YOUTUBE_BATCH_JOB_DEFINITION'))"
  "TranslatorBatchJobQueue=$(Get-OptionalEnv $envMap 'TRANSLATOR_BATCH_JOB_QUEUE' 'ytgrabber-green-gpu-queue')"
  "TranslatorBatchJobQueueFast=$(Get-OptionalEnv $envMap 'TRANSLATOR_BATCH_JOB_QUEUE_FAST')"
  "TranslatorBatchJobDefinition=$(Get-OptionalEnv $envMap 'TRANSLATOR_BATCH_JOB_DEFINITION' 'ytgrabber-green-translator-job')"
  "TranslatorCpuBatchJobQueue=$(Get-OptionalEnv $envMap 'TRANSLATOR_CPU_BATCH_JOB_QUEUE')"
  "TranslatorCpuBatchJobDefinition=$(Get-OptionalEnv $envMap 'TRANSLATOR_CPU_BATCH_JOB_DEFINITION')"
  "TranslatorBatchTimeoutSeconds=$(Get-OptionalEnv $envMap 'TRANSLATOR_BATCH_TIMEOUT_SECONDS' '3000')"
  "TranslatorBatchFallbackTimeoutSeconds=$(Get-OptionalEnv $envMap 'TRANSLATOR_BATCH_FALLBACK_TIMEOUT_SECONDS' '3000')"
  "TranslatorMaxVideoSizeBytes=$(Get-OptionalEnv $envMap 'TRANSLATOR_MAX_VIDEO_SIZE_BYTES' '2147483648')"
  "TranslatorAllowRuntimeModelDownloads=$(Get-OptionalEnv $envMap 'TRANSLATOR_ALLOW_RUNTIME_MODEL_DOWNLOADS' '0')"
  "TranslatorCosyVoiceModelId=$(Get-OptionalEnv $envMap 'TRANSLATOR_COSYVOICE_MODEL_ID' 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512')"
  "TranslatorAllowVoiceCloneFallback=$(Get-OptionalEnv $envMap 'TRANSLATOR_ALLOW_VOICE_CLONE_FALLBACK' 'false')"
  "TranslatorAllowLipSyncFallback=$(Get-OptionalEnv $envMap 'TRANSLATOR_ALLOW_LIP_SYNC_FALLBACK' 'true')"
  "TranslatorLipSyncEnabled=$(Get-OptionalEnv $envMap 'TRANSLATOR_LIP_SYNC_ENABLED' 'false')"
  "YoutubeQueuePrimaryEnabled=true"
  "YoutubeQueueShadowEnabled=$(Get-OptionalEnv $envMap 'YOUTUBE_QUEUE_SHADOW_ENABLED' 'false')"
  "YoutubeQueuePrimaryJobTypes=$primaryJobTypes"
  "YoutubeQueueShadowJobTypes=$(Get-OptionalEnv $envMap 'YOUTUBE_QUEUE_SHADOW_JOB_TYPES' 'download,clip-cut')"
  "LambdaClipMaxDurationSeconds=$(Get-OptionalEnv $envMap 'LAMBDA_CLIP_MAX_DURATION_SECONDS' '600')"
  "LambdaClipCommandTimeoutMs=$(Get-OptionalEnv $envMap 'LAMBDA_CLIP_COMMAND_TIMEOUT_MS' '840000')"
  "LambdaClipStallTimeoutMs=$(Get-OptionalEnv $envMap 'LAMBDA_CLIP_STALL_TIMEOUT_MS' '60000')"
  "LambdaClipHandoffSampleMs=$(Get-OptionalEnv $envMap 'LAMBDA_CLIP_HANDOFF_SAMPLE_MS' '75000')"
  "LambdaClipHandoffNoProgressMs=$(Get-OptionalEnv $envMap 'LAMBDA_CLIP_HANDOFF_NO_PROGRESS_MS' '120000')"
  "LambdaClipSafeBudgetMs=$(Get-OptionalEnv $envMap 'LAMBDA_CLIP_SAFE_BUDGET_MS' '660000')"
  "LambdaClipCompletionReserveMs=$(Get-OptionalEnv $envMap 'LAMBDA_CLIP_COMPLETION_RESERVE_MS' '120000')"
  "YtdlpDownloadStallTimeoutMs=$(Get-OptionalEnv $envMap 'YTDLP_DOWNLOAD_STALL_TIMEOUT_MS' '60000')"
  "YtdlpMaxDownloadAttempts=$(Get-OptionalEnv $envMap 'YTDLP_MAX_DOWNLOAD_ATTEMPTS' '4')"
  "MaxConcurrentClipJobs=$(Get-OptionalEnv $envMap 'MAX_CONCURRENT_CLIP_JOBS' '3')"
  "SubtitlesForceLambda=$(Get-OptionalEnv $envMap 'SUBTITLES_FORCE_LAMBDA' 'false')"
  "SubtitlesLambdaMaxDurationSeconds=$(Get-OptionalEnv $envMap 'SUBTITLES_LAMBDA_MAX_DURATION_SECONDS' '780')"
  "NotebookLmEnabled=$(Get-OptionalEnv $envMap 'NOTEBOOKLM_ENABLED' 'false')"
  "NotebookLmNotebookId=$(Get-OptionalEnv $envMap 'NOTEBOOKLM_NOTEBOOK_ID')"
  "NotebookLmAuthJson=$(Get-OptionalEnv $envMap 'NOTEBOOKLM_AUTH_JSON')"
  "NotebookLmAuthS3Key=$(Get-OptionalEnv $envMap 'NOTEBOOKLM_AUTH_S3_KEY')"
  "NotebookLmTimeoutMs=$(Get-OptionalEnv $envMap 'NOTEBOOKLM_TIMEOUT_MS' '480000')"
  "NotebookLmTurnDelayMs=$(Get-OptionalEnv $envMap 'NOTEBOOKLM_TURN_DELAY_MS' '2500')"
  "NotebookLmLocalQueueLimit=$(Get-OptionalEnv $envMap 'NOTEBOOKLM_LOCAL_QUEUE_LIMIT' '12')"
  "RateLimitBypassIps=$(Get-OptionalEnv $envMap 'RATE_LIMIT_BYPASS_IPS')"
  "VapidPublicKey=$(Get-OptionalEnv $envMap 'VAPID_PUBLIC_KEY')"
  "VapidPrivateKey=$(Get-OptionalEnv $envMap 'VAPID_PRIVATE_KEY')"
  "VapidSubject=$(Get-OptionalEnv $envMap 'VAPID_SUBJECT' 'mailto:ops@videomaking.in')"
)

$parameterOverrides = Remove-BlankExistingStackOverrides `
  -Overrides $parameterOverrides `
  -ExistingParams $existingStackParams

Remove-RollbackCompleteStackIfNeeded -Region $Region -StackName $StackName

$deployOutput = aws cloudformation deploy `
  --region $Region `
  --stack-name $StackName `
  --template-file $templatePath `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides $parameterOverrides `
  --no-fail-on-empty-changeset 2>&1

if ($LASTEXITCODE -ne 0) {
  Write-Host "::error::cloudformation deploy failed"
  Write-Host ("::error::cloudformation deploy output: " + ($deployOutput -join " "))

  Write-Host "::group::CloudFormation failure events ($StackName)"
  aws cloudformation describe-stack-events `
    --region $Region `
    --stack-name $StackName `
    --max-items 80 `
    --query "StackEvents[?contains(ResourceStatus,'FAILED') || contains(ResourceStatus,'ROLLBACK')].[Timestamp,LogicalResourceId,ResourceType,ResourceStatus,ResourceStatusReason]" `
    --output table
  Write-Host "::endgroup::"

  throw "CloudFormation deploy failed for stack $StackName"
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

# The output bucket is external to this stack, so CloudFormation cannot own its
# lifecycle policy. Merge ClipCut retention rules without deleting unrelated
# rules maintained by other features/operators.
$outputBucket = Get-RequiredEnv $envMap 'S3_BUCKET'
$outputPrefix = (Get-OptionalEnv $envMap 'S3_OBJECT_PREFIX' $Prefix).Trim('/')
# $env:TEMP is not guaranteed to exist on Linux GitHub runners. Let .NET
# resolve the platform-specific temporary directory instead.
$lifecycleFile = Join-Path ([System.IO.Path]::GetTempPath()) "$Prefix-output-lifecycle.json"
try {
  $existingLifecycleRaw = aws s3api get-bucket-lifecycle-configuration `
    --bucket $outputBucket `
    --region $Region `
    --output json 2>&1
  $getLifecycleExitCode = $LASTEXITCODE
  $rules = @()
  $canMergeLifecycle = $getLifecycleExitCode -eq 0 -or
    (($existingLifecycleRaw -join "`n") -match 'NoSuchLifecycleConfiguration')
  if ($getLifecycleExitCode -eq 0 -and $existingLifecycleRaw) {
    $existingLifecycle = ($existingLifecycleRaw -join "`n") | ConvertFrom-Json
    $rules = @($existingLifecycle.Rules | Where-Object {
      $_.ID -notin @('videomaking-clipcut-clips-7d', 'videomaking-clipcut-downloads-1d')
    })
  }
  if (-not $canMergeLifecycle) {
    Write-Warning "Could not read existing output bucket lifecycle; refusing to overwrite unknown rules"
  } else {
    $rules += [pscustomobject]@{
      ID = 'videomaking-clipcut-clips-7d'
      Status = 'Enabled'
      Filter = [pscustomobject]@{ Prefix = "$outputPrefix/youtube/clips/" }
      Expiration = [pscustomobject]@{ Days = 7 }
    }
    $rules += [pscustomobject]@{
      ID = 'videomaking-clipcut-downloads-1d'
      Status = 'Enabled'
      Filter = [pscustomobject]@{ Prefix = "$outputPrefix/youtube/downloads/" }
      Expiration = [pscustomobject]@{ Days = 1 }
    }
    @{ Rules = $rules } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $lifecycleFile -NoNewline
    aws s3api put-bucket-lifecycle-configuration `
      --bucket $outputBucket `
      --region $Region `
      --lifecycle-configuration "file://$lifecycleFile" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Could not apply output bucket retention lifecycle; application cleanup remains enabled"
    }
  }
} finally {
  Remove-Item -LiteralPath $lifecycleFile -Force -ErrorAction SilentlyContinue
}

pnpm --filter @workspace/yt-downloader run build
Assert-LastExitCode "pnpm yt-downloader build"

# Sync hashed assets (JS/CSS/images) with long-lived cache — filenames change on every build
aws s3 sync `
  (Join-Path $repoRoot "artifacts\yt-downloader\dist\public") `
  "s3://$siteBucket/" `
  --region $Region `
  --delete `
  --exclude "*.html" `
  --cache-control "public, max-age=31536000, immutable" | Out-Null

# Sync HTML files with no-cache — ensures browsers always fetch fresh index.html after deploy
aws s3 sync `
  (Join-Path $repoRoot "artifacts\yt-downloader\dist\public") `
  "s3://$siteBucket/" `
  --region $Region `
  --delete `
  --exclude "*" --include "*.html" `
  --cache-control "no-cache, no-store, must-revalidate" `
  --content-type "text/html; charset=utf-8" | Out-Null

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
