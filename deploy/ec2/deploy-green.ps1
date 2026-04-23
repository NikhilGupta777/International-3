param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [string]$KeyPath = "",
  [string]$Branch = "main",
  [string]$RepoUrl = "https://github.com/NikhilGupta777/International-3.git",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($KeyPath)) {
  $KeyPath = Join-Path (Join-Path $PSScriptRoot "keys") "ytgrabber-green-key.pem"
}

$envPath = Join-Path $PSScriptRoot ".env.green"
if (-not (Test-Path $envPath)) {
  throw "Missing $envPath. Create it from .env.green.example before deploy."
}

$args = @(
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $PSScriptRoot "deploy-over-ssh.ps1"),
  "-HostName", $HostName,
  "-KeyPath", $KeyPath,
  "-RepoUrl", $RepoUrl,
  "-Branch", $Branch,
  "-RemoteDir", "/opt/ytgrabber-green",
  "-LocalEnvPath", $envPath
)
if ($SkipBuild) {
  $args += "-SkipBuild"
}

& powershell @args
