param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Uri
)

$ErrorActionPreference = 'Stop'

function Parse-QueryString([string]$Query) {
  $result = @{}
  if ([string]::IsNullOrWhiteSpace($Query)) {
    return $result
  }

  $trimmed = $Query.TrimStart('?')
  foreach ($pair in $trimmed.Split('&', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $pieces = $pair.Split('=', 2)
    $key = [System.Net.WebUtility]::UrlDecode($pieces[0])
    $value = ''
    if ($pieces.Length -gt 1) {
      $value = [System.Net.WebUtility]::UrlDecode($pieces[1])
    }
    $result[$key] = $value
  }

  return $result
}

if ([string]::IsNullOrWhiteSpace($Uri)) {
  exit 1
}

$parsedUri = [System.Uri]::new($Uri)
$query = Parse-QueryString $parsedUri.Query

$stateRoot = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $env:TEMP } else { $env:LOCALAPPDATA }
$stateDir = Join-Path $stateRoot 'CodexNotify'
$queuePath = Join-Path $stateDir 'responses.jsonl'

if (-not (Test-Path $stateDir)) {
  New-Item -Path $stateDir -ItemType Directory -Force | Out-Null
}

$entry = [ordered]@{
  timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  requestId = $query['requestId']
  questionId = $query['questionId']
  choice = $query['choice']
  action = $query['action']
  workspace = $query['workspace']
}

Add-Content -Path $queuePath -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8

$shouldFocus = ($query['action'] -eq 'focus') -or ($query['focus'] -eq '1')
$workspace = [string]$query['workspace']

if ($shouldFocus -and -not [string]::IsNullOrWhiteSpace($workspace)) {
  $encodedPath = [System.Uri]::EscapeDataString($workspace)
  Start-Process "vscode://file/$encodedPath" | Out-Null
}
