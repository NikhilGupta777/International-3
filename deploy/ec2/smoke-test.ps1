param(
  [Parameter(Mandatory = $true)][string]$BaseUrl
)

$ErrorActionPreference = "Stop"

function Assert-Status([string]$Url, [int]$ExpectedStatus) {
  $status = & curl.exe -s -o NUL -w "%{http_code}" $Url
  if ([int]$status -ne $ExpectedStatus) {
    throw "Expected $ExpectedStatus from $Url but got $status"
  }
  Write-Host "$Url -> $status"
}

Assert-Status "$BaseUrl/api/healthz" 200
Assert-Status "$BaseUrl/" 200

$api404 = & curl.exe -s "$BaseUrl/api/not-a-route"
Write-Host "/api/not-a-route response: $api404"

Write-Host "Smoke tests passed."
