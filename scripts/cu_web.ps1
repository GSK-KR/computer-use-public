param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Arg1 = '',
  [string]$Arg2 = '',
  [string]$Url = '',
  [ValidateRange(1024,65535)][int]$Port = 9224,
  [string]$RunnerPath = '',
  [string]$EvidenceOut = '',
  # 계정별 전용 프로필 이름. 비우면 기본 전용 프로필(state\chrome-cdp-profile)을 쓴다.
  [string]$ChromeProfile = '',
  # 이미 로그인해 둔 전용 프로필 폴더를 연결할 때만 쓴다(ChromeProfile 이름과 함께).
  [string]$ProfileDir = '',
  # node scripts\cu.mjs가 만든 요청 JSON. 글자·선택자·옵션을 명령줄 대신 UTF-8 파일로 전달한다.
  [string]$RequestFile = '',
  [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
. (Join-Path $PSScriptRoot 'lib\chrome_profiles.ps1')
$cuConfig = Get-ComputerUseConfig
$ensureScript = Join-Path $PSScriptRoot 'ensure_windows_chrome_cdp.ps1'
if ([string]::IsNullOrWhiteSpace($RunnerPath)) { $RunnerPath = $cuConfig.webCdpScript }

if (-not [string]::IsNullOrWhiteSpace($RequestFile)) {
  if (-not (Test-Path -LiteralPath $RequestFile -PathType Leaf)) { throw "웹 요청 파일을 찾지 못했습니다: $RequestFile" }
  $userRequest = Get-Content -Raw -Encoding UTF8 -LiteralPath $RequestFile | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($Url) -and $userRequest.url) { $Url = [string]$userRequest.url }
  if ([string]::IsNullOrWhiteSpace($ChromeProfile) -and $userRequest.profile) { $ChromeProfile = [string]$userRequest.profile }
  if ([string]::IsNullOrWhiteSpace($ProfileDir) -and $userRequest.profileDir) { $ProfileDir = [string]$userRequest.profileDir }
  if ([string]::IsNullOrWhiteSpace($Arg1) -and $null -ne $userRequest.arg1) { $Arg1 = [string]$userRequest.arg1 }
  if ([string]::IsNullOrWhiteSpace($Arg2) -and $null -ne $userRequest.arg2) { $Arg2 = [string]$userRequest.arg2 }
}

if ($Action -eq 'profiles') {
  & (Join-Path $PSScriptRoot 'chrome_profiles.ps1') -Action list
  exit $LASTEXITCODE
}

$profileInfo = Resolve-ChromeProfile -Config $cuConfig -Name $ChromeProfile -ProfileDir $ProfileDir -DefaultPort $Port
if ([string]::IsNullOrWhiteSpace($EvidenceOut)) { $EvidenceOut = Join-Path $cuConfig.shotsDirWin $profileInfo.evidenceName }

# 고정한 작업 탭을 풀어 다음 명령이 --url이나 새 탭으로 대상을 다시 고르게 한다(탭과 Chrome은 그대로 둔다).
if ($Action -eq 'unpin') {
  $existed = Test-Path -LiteralPath $profileInfo.targetFile -PathType Leaf
  Remove-Item -LiteralPath $profileInfo.targetFile -Force -ErrorAction SilentlyContinue
  Write-Output (([ordered]@{ ok = $true; action = 'unpin'; profile = $profileInfo.name; removed = $existed }) | ConvertTo-Json -Compress)
  exit 0
}

if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) {
  throw "Chrome 자동화 실행 파일을 찾지 못했습니다: $RunnerPath"
}

# 살아 있는지 확인하는 명령은 Chrome을 새로 켜지 않는다.
$probeOnly = $Action -in @('ping','health')
$actualPort = $profileInfo.preferredPort
$chromeState = $null
if (-not $NoAutoStart -and -not $probeOnly) {
  if (-not (Test-Path -LiteralPath $ensureScript -PathType Leaf)) {
    throw "Windows Chrome 자동 실행 파일을 찾지 못했습니다: $ensureScript"
  }
  $ensureArgs = @{
    PreferredPort = $profileInfo.preferredPort
    ProfileDir = $profileInfo.profileDir
    StateFile = $profileInfo.stateFile
  }
  if ($profileInfo.external) {
    $ensureArgs.RequireExisting = $true
    $ensureArgs.NoKill = $true
  }
  if ($Action -eq 'goto' -and -not [string]::IsNullOrWhiteSpace($Arg1)) { $ensureArgs.StartUrl = $Arg1 }
  $ensureLines = @(& $ensureScript @ensureArgs)
  $ensureState = $ensureLines | Select-Object -Last 1 | ConvertFrom-Json
  $chromeState = $ensureState
  $actualPort = [int]$ensureState.port
  if (-not [bool]$ensureState.reused) {
    [Console]::Error.WriteLine("Windows Chrome을 자동으로 열었습니다. 프로필: $($profileInfo.name), 연결 번호: $actualPort")
  }
} else {
  try { $chromeState = Get-Content -Raw -Encoding UTF8 -LiteralPath $profileInfo.stateFile | ConvertFrom-Json } catch {}
  if ($null -ne $chromeState -and [int]$chromeState.port -ge 1024) { $actualPort = [int]$chromeState.port }
}

$request = [ordered]@{
  action = $Action
  port = $actualPort
  evidenceOut = $EvidenceOut
  profile = $profileInfo.name
  stateDir = $cuConfig.stateDirWin
  shotsDir = $cuConfig.shotsDirWin
}
if (-not [string]::IsNullOrWhiteSpace($Url)) {
  $request.url = $Url
} elseif ($Action -eq 'goto' -and -not [string]::IsNullOrWhiteSpace($Arg1)) {
  $request.url = $Arg1
}

$targetStateFile = $profileInfo.targetFile
try {
  $targetState = Get-Content -Raw -Encoding UTF8 -LiteralPath $targetStateFile | ConvertFrom-Json
  $sameBrowser = $null -ne $chromeState -and [int]$targetState.pid -eq [int]$chromeState.pid -and [int]$targetState.port -eq $actualPort
  $sameRequestedUrl = [string]::IsNullOrWhiteSpace($Url) -or [string]$targetState.url -like ('*' + $Url + '*')
  if ($Action -notin @('pages','ping','health') -and $sameBrowser -and ($Action -eq 'goto' -or $sameRequestedUrl) -and -not [string]::IsNullOrWhiteSpace([string]$targetState.targetId)) {
    $request.targetId = [string]$targetState.targetId
  }
} catch {}
switch ($Action) {
  { $_ -in @('find','clicktext','assert','waittext','eval','goto','identify') } { $request.text = $Arg1; break }
  { $_ -in @('click','check','validate') } { $request.selector = $Arg1; break }
  { $_ -in @('type','select','upload') } { $request.selector = $Arg1; $request.value = $Arg2; break }
  'shot' { if (-not [string]::IsNullOrWhiteSpace($Arg1)) { $request.out = $Arg1 }; break }
}
if (-not [string]::IsNullOrWhiteSpace($Arg1)) { $request.arg1 = $Arg1 }
if (-not [string]::IsNullOrWhiteSpace($Arg2)) { $request.arg2 = $Arg2 }

New-Item -ItemType Directory -Force -Path $cuConfig.shotsDirWin | Out-Null
New-Item -ItemType Directory -Force -Path $cuConfig.stateDirWin | Out-Null
$runtimeFile = Join-Path $cuConfig.stateDirWin ("web_request_{0}.json" -f $PID)
$json = $request | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($runtimeFile, $json, (New-Object System.Text.UTF8Encoding $false))

$previousLocation = Get-Location
try {
  Set-Location -LiteralPath $cuConfig.repoRootWin
  if ([string]::IsNullOrWhiteSpace($RequestFile)) {
    $runnerLines = @(& node $RunnerPath $runtimeFile)
  } else {
    $runnerLines = @(& node $RunnerPath $runtimeFile $RequestFile)
  }
  $exitCode = $LASTEXITCODE
  $runnerLines | ForEach-Object { Write-Output $_ }
  if ($exitCode -eq 0 -and $runnerLines.Count -gt 0) {
    try {
      $runnerResult = $runnerLines | Select-Object -Last 1 | ConvertFrom-Json
      if (-not [string]::IsNullOrWhiteSpace([string]$runnerResult.targetId) -and $null -ne $chromeState) {
        $targetState = [ordered]@{
          schema = 'computer-use.windows-chrome-target.v1'
          profile = $profileInfo.name
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
  Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue
}
exit $exitCode
