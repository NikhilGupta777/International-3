param(
  [string]$Region = "us-east-1",
  [string]$InstanceType = "c6a.large",
  [int]$VolumeSizeGiB = 40,
  [string]$AllowedSshCidr = "",
  [switch]$OpenSshToWorld
)

$ErrorActionPreference = "Stop"

$args = @(
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $PSScriptRoot "provision-instance.ps1"),
  "-Region", $Region,
  "-ProjectName", "ytgrabber-green",
  "-InstanceType", $InstanceType,
  "-VolumeSizeGiB", $VolumeSizeGiB,
  "-KeyName", "ytgrabber-green-key"
)

if (-not [string]::IsNullOrWhiteSpace($AllowedSshCidr)) {
  $args += @("-AllowedSshCidr", $AllowedSshCidr)
}
if ($OpenSshToWorld) {
  $args += "-OpenSshToWorld"
}

& powershell @args
