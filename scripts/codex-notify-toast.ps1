param(
  [Parameter(Mandatory = $true)]
  [string]$Title,
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [Parameter(Mandatory = $true)]
  [string]$RequestId,
  [Parameter(Mandatory = $false)]
  [string]$QuestionId = "",
  [Parameter(Mandatory = $true)]
  [string]$OptionsJson,
  [Parameter(Mandatory = $true)]
  [string]$WorkspacePath
)

$ErrorActionPreference = 'Stop'

function Escape-Xml([string]$Value) {
  if ($null -eq $Value) {
    return ''
  }
  return $Value.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

function Build-NotifyUri([hashtable]$Pairs) {
  $segments = @()
  foreach ($key in $Pairs.Keys) {
    $val = [string]$Pairs[$key]
    if ([string]::IsNullOrWhiteSpace($val)) {
      continue
    }
    $encodedKey = [System.Uri]::EscapeDataString([string]$key)
    $encodedVal = [System.Uri]::EscapeDataString($val)
    $segments += "$encodedKey=$encodedVal"
  }
  $query = [string]::Join('&', $segments)
  return "codexnotify://action?$query"
}

$options = @()
if (-not [string]::IsNullOrWhiteSpace($OptionsJson)) {
  $parsed = $OptionsJson | ConvertFrom-Json
  if ($parsed -is [System.Array]) {
    $options = @($parsed)
  } elseif ($null -ne $parsed) {
    $options = @($parsed)
  }
}

$baseArgs = @{
  requestId = $RequestId
  questionId = $QuestionId
  workspace = $WorkspacePath
  focus = '1'
}

$launchUri = Build-NotifyUri ($baseArgs + @{ action = 'focus' })

$actionNodes = @()
foreach ($option in $options) {
  $label = [string]$option.label
  $value = [string]$option.value
  if ([string]::IsNullOrWhiteSpace($value)) {
    continue
  }

  $uri = Build-NotifyUri ($baseArgs + @{
    action = 'select'
    choice = $value
  })

  $actionNodes += "<action content=""$(Escape-Xml $label)"" arguments=""$(Escape-Xml $uri)"" activationType=""protocol"" />"
}

if ($actionNodes.Count -eq 0) {
  $fallbackUri = Build-NotifyUri ($baseArgs + @{ action = 'focus' })
  $actionNodes += "<action content=""Open VS Code"" arguments=""$(Escape-Xml $fallbackUri)"" activationType=""protocol"" />"
}

$actionsXml = [string]::Join('', $actionNodes)

$xml = @"
<toast activationType="protocol" launch="$(Escape-Xml $launchUri)">
  <visual>
    <binding template="ToastGeneric">
      <text>$(Escape-Xml $Title)</text>
      <text>$(Escape-Xml $Message)</text>
    </binding>
  </visual>
  <actions>$actionsXml</actions>
</toast>
"@

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null

$xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
$xmlDoc.LoadXml($xml)

$toast = [Windows.UI.Notifications.ToastNotification]::new($xmlDoc)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Windows.PowerShell')
$notifier.Show($toast)
