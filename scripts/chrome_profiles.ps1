param(
  [ValidateSet('list','add','remove')][string]$Action = 'list',
  [string]$Name = '',
  [string]$Dir = '',
  [int]$Port = 0,
  [string]$Note = '',
  [switch]$ShowQuery
)

# 계정별 전용 Chrome 프로필 목록·등록·해제. 실행 중인 디버그 Chrome도 함께 보여 준다(읽기 전용, Chrome을 켜거나 끄지 않는다).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
. (Join-Path $PSScriptRoot 'lib\chrome_profiles.ps1')
$cuConfig = Get-ComputerUseConfig

function Write-JsonLine($Value) {
  Write-Output ($Value | ConvertTo-Json -Depth 8 -Compress)
}

# 주소의 쿼리에는 세션 토큰이 들어 있을 수 있어 기본으로 가린다.
function Format-TabUrl([string]$Value) {
  if ($ShowQuery) { return $Value.Substring(0, [Math]::Min(240, $Value.Length)) }
  $clean = ($Value -split '[?#]', 2)[0]
  return $clean.Substring(0, [Math]::Min(200, $clean.Length))
}

function Get-DebugChromes {
  $rows = New-Object System.Collections.ArrayList
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $line = [string]$_.CommandLine
    $line -match '--remote-debugging-port=\d+' -and $line -notmatch '(?:^|\s)--type='
  })
  foreach ($proc in $procs) {
    $line = [string]$proc.CommandLine
    $portMatch = [regex]::Match($line, '--remote-debugging-port=(\d+)')
    $dir = Get-CommandLineProfileDir $line
    $title = ''
    try { $title = (Get-Process -Id $proc.ProcessId -ErrorAction Stop).MainWindowTitle } catch {}
    $port = [int]$portMatch.Groups[1].Value
    $version = $null
    try { $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 } catch {}
    $tabs = @()
    if ($null -ne $version) {
      try {
        $list = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
        $tabs = @($list | Where-Object { $_.type -eq 'page' } | Select-Object -First 15 | ForEach-Object {
          [pscustomobject]@{ title = ([string]$_.title).Substring(0, [Math]::Min(80, ([string]$_.title).Length)); url = Format-TabUrl ([string]$_.url) }
        })
      } catch {}
    }
    $ua = if ($null -ne $version) { [string]$version.'User-Agent' } else { '' }
    [void]$rows.Add([pscustomobject]@{
      pid = [int]$proc.ProcessId
      port = $port
      profileDir = $dir
      windowTitle = $title
      cdp = ($null -ne $version)
      windowsChrome = ($ua -match 'Windows NT' -and $ua -notmatch 'HeadlessChrome')
      normalBrowserProfile = (-not [string]::IsNullOrWhiteSpace($dir)) -and (Test-IsNormalBrowserProfile $dir)
      tabs = $tabs
    })
  }
  return $rows
}

function Read-StateFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json } catch { return $null }
}

switch ($Action) {
  'add' {
    if ([string]::IsNullOrWhiteSpace($Name)) { throw '-Name이 필요합니다.' }
    $info = Register-ChromeProfile -Config $cuConfig -Name $Name -ProfileDir $Dir -Port $Port -Note $Note
    Write-JsonLine ([ordered]@{ ok = $true; action = 'add'; name = $info.name; profileDir = $info.profileDir; external = $info.external; preferredPort = $info.preferredPort })
    exit 0
  }
  'remove' {
    if ([string]::IsNullOrWhiteSpace($Name)) { throw '-Name이 필요합니다.' }
    $registry = Read-ChromeProfileRegistry $cuConfig
    $existed = $registry.Contains($Name)
    if ($existed) { $registry.Remove($Name); Save-ChromeProfileRegistry $cuConfig $registry }
    # 프로필 폴더(로그인 세션)는 지우지 않는다. 목록에서만 뺀다.
    Write-JsonLine ([ordered]@{ ok = $existed; action = 'remove'; name = $Name; profileFolderKept = $true })
    if ($existed) { exit 0 } else { exit 1 }
  }
  default {
    $running = @(Get-DebugChromes)
    $registry = Read-ChromeProfileRegistry $cuConfig
    $names = New-Object 'System.Collections.Generic.List[string]'
    $names.Add('default')
    foreach ($key in $registry.Keys) { if (-not $names.Contains([string]$key)) { $names.Add([string]$key) } }
    foreach ($candidate in @(Get-ChildItem -LiteralPath $cuConfig.stateDirWin -Filter 'chrome_cdp_*.json' -ErrorAction SilentlyContinue)) {
      $m = [regex]::Match($candidate.Name, '^chrome_cdp_(?!target)([a-z0-9][a-z0-9_-]{0,31})\.json$')
      if ($m.Success -and -not $names.Contains($m.Groups[1].Value)) { $names.Add($m.Groups[1].Value) }
    }
    $profiles = New-Object System.Collections.ArrayList
    $matched = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($profileName in $names) {
      $info = Resolve-ChromeProfile -Config $cuConfig -Name $profileName -DefaultPort $cuConfig.chromeCdpPort
      $state = Read-StateFile $info.stateFile
      $live = $running | Where-Object { -not [string]::IsNullOrWhiteSpace($_.profileDir) -and (Test-PathInside $_.profileDir $info.profileDir) -and (Test-PathInside $info.profileDir $_.profileDir) } | Select-Object -First 1
      if ($null -ne $live) { [void]$matched.Add([int]$live.pid) }
      $entry = $null
      if ($registry.Contains($profileName)) { $entry = $registry[$profileName] }
      [void]$profiles.Add([pscustomobject]@{
        name = $info.name
        profileDir = $info.profileDir
        external = $info.external
        registered = $info.registered
        exists = (Test-Path -LiteralPath $info.profileDir -PathType Container)
        note = if ($null -ne $entry) { [string]$entry.note } else { '' }
        lastPort = if ($null -ne $state) { $state.port } else { $null }
        running = $live
      })
    }
    $others = @($running | Where-Object { -not $matched.Contains([int]$_.pid) })
    Write-JsonLine ([ordered]@{
      ok = $true
      schema = 'computer-use.chrome-profiles.v1'
      registry = (Get-ChromeProfileRegistryPath $cuConfig)
      profiles = $profiles
      otherDebugChromes = $others
      hint = '다른 디버그 Chrome은 자동으로 쓰지 않습니다. 전용 폴더라면 cu web profile add 이름 --dir 폴더 로 등록한 뒤 --profile 이름 으로 사용합니다.'
    })
    exit 0
  }
}
