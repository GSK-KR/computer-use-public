param(
  [ValidateRange(1024,65535)][int]$PreferredPort = 9224,
  [string]$ProfileDir = '',
  [string]$StateFile = '',
  [string]$StartUrl = 'about:blank',
  [ValidateRange(1,100)][int]$PortScanCount = 40,
  [ValidateRange(3,60)][int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
  $ProfileDir = Join-Path $cuConfig.stateDirWin 'chrome-cdp-profile'
}
if ([string]::IsNullOrWhiteSpace($StateFile)) {
  $StateFile = Join-Path $cuConfig.stateDirWin 'chrome_cdp.json'
}
$startUri = $null
$validHttpUrl = [Uri]::TryCreate($StartUrl, [UriKind]::Absolute, [ref]$startUri) -and $startUri.Scheme -in @('http','https')
if ($StartUrl -ne 'about:blank' -and -not $validHttpUrl) { $StartUrl = 'about:blank' }

$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)
$StateFile = [System.IO.Path]::GetFullPath($StateFile)

function Find-ChromeExecutable {
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  if ($env:CU_CHROME_PATH) { $candidates.Add($env:CU_CHROME_PATH) }
  foreach ($registryPath in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
  )) {
    try {
      $registered = (Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop).'(default)'
      if ($registered) { $candidates.Add([string]$registered) }
    } catch {}
  }
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')) }
  if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')) }
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')) }
  return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Read-CdpState {
  if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $StateFile | ConvertFrom-Json } catch { return $null }
}

function Get-CdpVersion([int]$Port) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
  } catch {
    return $null
  }
}

function Test-WindowsChromeVersion($Version) {
  if ($null -eq $Version) { return $false }
  $browser = [string]$Version.Browser
  $userAgent = [string]$Version.'User-Agent'
  return ($browser -match '^Chrome/' -and $userAgent -match 'Windows NT' -and $userAgent -notmatch 'HeadlessChrome')
}

function Test-TcpPort([int]$Port) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(250)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $client) { $client.Close() }
  }
}

function Get-ProfileChromeProcesses {
  $needle = $ProfileDir.TrimEnd('\')
  return @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $line = [string]$_.CommandLine
    $line -and $line.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}

function Get-OwnedChromeProcess([int]$Port) {
  return Get-ProfileChromeProcesses | Where-Object {
    $line = [string]$_.CommandLine
    $portPattern = '(?:^|\s)"?--remote-debugging-port=' + $Port + '"?(?:\s|$)'
    $line -match $portPattern -and $line -notmatch '(?:^|\s)--type='
  } | Select-Object -First 1
}

function Test-ChromeWindowVisible($ProcessInfo) {
  if ($null -eq $ProcessInfo) { return $false }
  try {
    $process = Get-Process -Id ([int]$ProcessInfo.ProcessId) -ErrorAction Stop
    $process.Refresh()
    return $process.MainWindowHandle -ne 0
  } catch {
    return $false
  }
}

function Add-PortCandidate([System.Collections.Generic.List[int]]$List, [int]$Port) {
  if ($Port -ge 1024 -and $Port -le 65535 -and -not $List.Contains($Port)) { $List.Add($Port) }
}

function Write-CdpState($Version, [int]$Port, $ProcessInfo, [bool]$Visible, [bool]$Reused, [string]$ChromePath) {
  $parent = Split-Path -Parent $StateFile
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $state = [ordered]@{
    schema = 'computer-use.windows-chrome-cdp.v1'
    port = $Port
    profileDir = $ProfileDir
    chromePath = $ChromePath
    pid = if ($null -ne $ProcessInfo) { [int]$ProcessInfo.ProcessId } else { $null }
    visible = $Visible
    reused = $Reused
    browser = [string]$Version.Browser
    userAgent = [string]$Version.'User-Agent'
    checkedAt = [DateTime]::UtcNow.ToString('o')
  }
  $json = $state | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($StateFile, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
  Write-Output $json
}

$chromePath = Find-ChromeExecutable
if ([string]::IsNullOrWhiteSpace($chromePath)) {
  throw 'Google Chrome을 찾지 못했습니다. Windows에 Google Chrome을 설치한 뒤 웹 작업을 다시 실행하세요.'
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$state = Read-CdpState
$ports = New-Object 'System.Collections.Generic.List[int]'
if ($null -ne $state -and [string]$state.profileDir -eq $ProfileDir) {
  Add-PortCandidate $ports ([int]$state.port)
}
foreach ($process in Get-ProfileChromeProcesses) {
  $match = [regex]::Match([string]$process.CommandLine, '(?:^|\s)"?--remote-debugging-port=(\d+)"?(?:\s|$)')
  if ($match.Success) { Add-PortCandidate $ports ([int]$match.Groups[1].Value) }
}
for ($offset = 0; $offset -lt $PortScanCount; $offset++) {
  Add-PortCandidate $ports ($PreferredPort + $offset)
}

$launchPort = 0
foreach ($port in $ports) {
  $version = Get-CdpVersion $port
  $owned = Get-OwnedChromeProcess $port
  if ((Test-WindowsChromeVersion $version) -and $null -ne $owned) {
    $visible = Test-ChromeWindowVisible $owned
    if (-not $visible) {
      throw "전용 Chrome은 실행 중이지만 보이는 창을 확인하지 못했습니다. 전용 프로필 프로세스만 종료한 뒤 다시 시도하세요: $ProfileDir"
    }
    Write-CdpState $version $port $owned $visible $true $chromePath
    exit 0
  }
  if ($null -eq $version -and -not (Test-TcpPort $port)) {
    $launchPort = $port
    break
  }
}

if ($launchPort -le 0) {
  throw "사용 가능한 Chrome 연결 포트를 찾지 못했습니다. 시작 번호 $PreferredPort 부근의 포트를 확인하세요."
}

# 오래된 전용 프로필 프로세스만 새 연결을 막을 수 있다. 일반 Chrome 프로필은 종료하지 않는다.
foreach ($process in Get-ProfileChromeProcesses) {
  try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Milliseconds 400

$arguments = @(
  "--remote-debugging-port=$launchPort",
  '--remote-debugging-address=127.0.0.1',
  "--user-data-dir=$ProfileDir",
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  $StartUrl
)
$argumentLine = ($arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '

try {
  $shell = New-Object -ComObject Shell.Application
  $shell.ShellExecute($chromePath, $argumentLine, '', 'open', 1)
} catch {
  Start-Process -FilePath $chromePath -ArgumentList $arguments -WindowStyle Normal | Out-Null
}

$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
$version = $null
$owned = $null
$visible = $false
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $version = Get-CdpVersion $launchPort
  if (-not (Test-WindowsChromeVersion $version)) { continue }
  $owned = Get-OwnedChromeProcess $launchPort
  if ($null -eq $owned) { continue }
  $visible = Test-ChromeWindowVisible $owned
  if ($visible) { break }
}

if (-not (Test-WindowsChromeVersion $version)) {
  throw "Windows Chrome 디버그 연결을 열지 못했습니다. 전용 프로필: $ProfileDir, 포트: $launchPort"
}
if ($null -eq $owned) {
  throw "연결 포트는 열렸지만 전용 프로필의 Chrome 프로세스를 확인하지 못했습니다: $launchPort"
}
if (-not $visible) {
  throw "Chrome 연결은 열렸지만 Windows 화면에 보이는 창을 확인하지 못했습니다: $launchPort"
}

Write-CdpState $version $launchPort $owned $visible $false $chromePath
