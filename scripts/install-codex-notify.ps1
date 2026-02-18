param(
  [Parameter(Mandatory = $false)]
  [string]$SchemeName = 'codexnotify'
)

$ErrorActionPreference = 'Stop'

$handlerScript = Join-Path $PSScriptRoot 'codex-notify-handle.ps1'
if (-not (Test-Path $handlerScript)) {
  throw "Handler script not found: $handlerScript"
}

$schemeKey = "HKCU:\Software\Classes\$SchemeName"
$commandKey = Join-Path $schemeKey 'shell\open\command'

if (-not (Test-Path $schemeKey)) {
  New-Item -Path $schemeKey -Force | Out-Null
}

Set-ItemProperty -Path $schemeKey -Name '(default)' -Value "URL:$SchemeName Protocol"
New-ItemProperty -Path $schemeKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

if (-not (Test-Path $commandKey)) {
  New-Item -Path $commandKey -Force | Out-Null
}

$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powershellExe)) {
  $powershellExe = 'powershell.exe'
}

$command = "`"$powershellExe`" -NoProfile -ExecutionPolicy Bypass -File `"$handlerScript`" `"%1`""
Set-ItemProperty -Path $commandKey -Name '(default)' -Value $command

$stateRoot = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $env:TEMP } else { $env:LOCALAPPDATA }
$stateDir = Join-Path $stateRoot 'CodexNotify'
if (-not (Test-Path $stateDir)) {
  New-Item -Path $stateDir -ItemType Directory -Force | Out-Null
}

Write-Host "Installed URI handler '${SchemeName}://'."
Write-Host "Protocol command:"
Write-Host "  $command"
Write-Host ""
Write-Host 'Next step: run your session with'
Write-Host '  npm run codex:notify -- "<your prompt>"'
Write-Host ''
Write-Host 'Always-on mode (keep one process running):'
Write-Host '  npm run codex:notify:daemon'
