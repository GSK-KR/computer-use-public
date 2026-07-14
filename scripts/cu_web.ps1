param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Arg1 = '',
  [string]$Arg2 = '',
  [string]$Url = '',
  [ValidateRange(1024,65535)][int]$Port = 9224,
  [string]$RunnerPath = '',
  [string]$EvidenceOut = '',
  [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig
$ensureScript = Join-Path $PSScriptRoot 'ensure_windows_chrome_cdp.ps1'
if ([string]::IsNullOrWhiteSpace($RunnerPath)) { $RunnerPath = $cuConfig.webCdpScript }
if ([string]::IsNullOrWhiteSpace($EvidenceOut)) { $EvidenceOut = Join-Path $cuConfig.shotsDirWin 'web_last.png' }

if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) {
  throw "Chrome 자동화 실행 파일을 찾지 못했습니다: $RunnerPath"
}

$actualPort = $Port
$chromeState = $null
if (-not $NoAutoStart) {
  if (-not (Test-Path -LiteralPath $ensureScript -PathType Leaf)) {
    throw "Windows Chrome 자동 실행 파일을 찾지 못했습니다: $ensureScript"
  }
  $ensureArgs = @{
    PreferredPort = $Port
    ProfileDir = (Join-Path $cuConfig.stateDirWin 'chrome-cdp-profile')
    StateFile = (Join-Path $cuConfig.stateDirWin 'chrome_cdp.json')
  }
  if ($Action -eq 'goto' -and -not [string]::IsNullOrWhiteSpace($Arg1)) { $ensureArgs.StartUrl = $Arg1 }
  $ensureLines = @(& $ensureScript @ensureArgs)
  $ensureState = $ensureLines | Select-Object -Last 1 | ConvertFrom-Json
  $chromeState = $ensureState
  $actualPort = [int]$ensureState.port
  if (-not [bool]$ensureState.reused) {
    [Console]::Error.WriteLine("Windows Chrome을 자동으로 열었습니다. 연결 번호: $actualPort")
  }
} else {
  try { $chromeState = Get-Content -Raw -Encoding UTF8 (Join-Path $cuConfig.stateDirWin 'chrome_cdp.json') | ConvertFrom-Json } catch {}
}

$request = [ordered]@{
  action = $Action
  port = $actualPort
  evidenceOut = $EvidenceOut
}
if (-not [string]::IsNullOrWhiteSpace($Url)) {
  $request.url = $Url
} elseif ($Action -eq 'goto' -and -not [string]::IsNullOrWhiteSpace($Arg1)) {
  $request.url = $Arg1
}

$targetStateFile = Join-Path $cuConfig.stateDirWin 'chrome_cdp_target.json'
try {
  $targetState = Get-Content -Raw -Encoding UTF8 -LiteralPath $targetStateFile | ConvertFrom-Json
  $sameBrowser = $null -ne $chromeState -and [int]$targetState.pid -eq [int]$chromeState.pid -and [int]$targetState.port -eq $actualPort
  $sameRequestedUrl = [string]::IsNullOrWhiteSpace($Url) -or [string]$targetState.url -like ('*' + $Url + '*')
  if ($Action -ne 'pages' -and $sameBrowser -and ($Action -eq 'goto' -or $sameRequestedUrl) -and -not [string]::IsNullOrWhiteSpace([string]$targetState.targetId)) {
    $request.targetId = [string]$targetState.targetId
  }
} catch {}
switch ($Action) {
  { $_ -in @('find','clicktext','assert','waittext','eval','goto','identify') } { $request.text = $Arg1; break }
  { $_ -in @('click','check','validate') } { $request.selector = $Arg1; break }
  { $_ -in @('type','select','upload') } { $request.selector = $Arg1; $request.value = $Arg2; break }
  'shot' { if (-not [string]::IsNullOrWhiteSpace($Arg1)) { $request.out = $Arg1 }; break }
}

New-Item -ItemType Directory -Force -Path $cuConfig.shotsDirWin | Out-Null
New-Item -ItemType Directory -Force -Path $cuConfig.stateDirWin | Out-Null
$requestFile = Join-Path $cuConfig.stateDirWin ("web_request_{0}.json" -f $PID)
$json = $request | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($requestFile, $json, (New-Object System.Text.UTF8Encoding $false))

$previousLocation = Get-Location
try {
  Set-Location -LiteralPath $cuConfig.repoRootWin
  $runnerLines = @(& node $RunnerPath $requestFile)
  $exitCode = $LASTEXITCODE
  $runnerLines | ForEach-Object { Write-Output $_ }
  if ($exitCode -eq 0 -and $runnerLines.Count -gt 0) {
    try {
      $runnerResult = $runnerLines | Select-Object -Last 1 | ConvertFrom-Json
      if (-not [string]::IsNullOrWhiteSpace([string]$runnerResult.targetId) -and $null -ne $chromeState) {
        $targetState = [ordered]@{
          schema = 'computer-use.windows-chrome-target.v1'
          pid = [int]$chromeState.pid
          port = $actualPort
          targetId = [string]$runnerResult.targetId
          url = [string]$runnerResult.targetUrl
          checkedAt = [DateTime]::UtcNow.ToString('o')
        }
        $targetJson = $targetState | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($targetStateFile, $targetJson + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
      }
    } catch {}
  }
} finally {
  Set-Location -LiteralPath $previousLocation
  Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
}
exit $exitCode
