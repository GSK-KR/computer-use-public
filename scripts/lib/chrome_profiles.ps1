# 계정별 전용 Chrome 프로필 해석. cu_web.ps1과 chrome_profiles.ps1이 함께 쓴다.
# 한 브라우저에서 계정을 바꾸면 그 계정에 묶인 다른 자동화가 깨진다. 그래서 계정마다 프로필 폴더와 연결 포트를 분리한다.
# 사용자의 일반 Chrome·Edge 프로필(User Data)은 어떤 경우에도 자동화 프로필로 쓰지 않는다.

function Get-ChromeProfileRegistryPath($Config) {
  return (Join-Path $Config.stateDirWin 'chrome_profiles.json')
}

function Read-ChromeProfileRegistry($Config) {
  $path = Get-ChromeProfileRegistryPath $Config
  $registry = [ordered]@{}
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $registry }
  try {
    $json = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json
    if ($null -ne $json.profiles) {
      foreach ($prop in $json.profiles.PSObject.Properties) { $registry[$prop.Name] = $prop.Value }
    }
  } catch {
    throw "프로필 목록 파일을 읽지 못했습니다: $path"
  }
  return $registry
}

function Save-ChromeProfileRegistry($Config, $Registry) {
  $path = Get-ChromeProfileRegistryPath $Config
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  $doc = [ordered]@{ schema = 'computer-use.chrome-profiles.v1'; profiles = $Registry }
  $json = $doc | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($path, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
}

function Test-ChromeProfileName([string]$Name) {
  return ($Name -cmatch '^[a-z0-9][a-z0-9_-]{0,31}$') -and $Name -ne 'default'
}

function ConvertTo-FullDir([string]$Path) {
  $clean = ([string]$Path).Trim().Trim('"').Trim()
  try { return ([System.IO.Path]::GetFullPath($clean)).TrimEnd('\') } catch { return $clean.TrimEnd('\') }
}

# Chrome 명령줄에서 --user-data-dir 값을 꺼낸다. "--user-data-dir=C:\a b" 처럼 전체가 따옴표인 경우도 처리한다.
function Get-CommandLineProfileDir([string]$CommandLine) {
  $m = [regex]::Match([string]$CommandLine, '--user-data-dir=(?:"(?<q>[^"]+)"|(?<u>.+?))(?="|\s--|$)')
  if (-not $m.Success) { return '' }
  if ($m.Groups['q'].Success) { return $m.Groups['q'].Value.Trim() }
  return $m.Groups['u'].Value.Trim()
}

function Test-PathInside([string]$Child, [string]$Parent) {
  if ([string]::IsNullOrWhiteSpace($Child) -or [string]::IsNullOrWhiteSpace($Parent)) { return $false }
  $c = ConvertTo-FullDir $Child
  $p = ConvertTo-FullDir $Parent
  return $c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase) -or $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-NormalBrowserUserDataDirs {
  $dirs = New-Object 'System.Collections.Generic.List[string]'
  if ($env:LOCALAPPDATA) {
    foreach ($rel in @('Google\Chrome\User Data', 'Google\Chrome Beta\User Data', 'Google\Chrome Dev\User Data', 'Google\Chrome SxS\User Data', 'Chromium\User Data', 'Microsoft\Edge\User Data')) {
      $dirs.Add((Join-Path $env:LOCALAPPDATA $rel))
    }
  }
  return $dirs
}

function Test-IsNormalBrowserProfile([string]$Dir) {
  foreach ($normal in Get-NormalBrowserUserDataDirs) {
    if (Test-PathInside $Dir $normal) { return $true }
  }
  return $false
}

# 결과: name, profileDir, stateFile, targetFile, preferredPort, external, registered, evidenceName
function Resolve-ChromeProfile($Config, [string]$Name = '', [string]$ProfileDir = '', [int]$DefaultPort = 9224) {
  $stateDir = $Config.stateDirWin
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name -eq 'default') {
    if (-not [string]::IsNullOrWhiteSpace($ProfileDir)) {
      throw '기존 프로필 폴더를 연결하려면 --profile 이름도 함께 지정하세요. 예: --profile shop-a --profile-dir C:\Chrome\shop-a'
    }
    return [pscustomobject]@{
      name = 'default'
      profileDir = (Join-Path $stateDir 'chrome-cdp-profile')
      stateFile = (Join-Path $stateDir 'chrome_cdp.json')
      targetFile = (Join-Path $stateDir 'chrome_cdp_target.json')
      preferredPort = $DefaultPort
      external = $false
      registered = $true
      evidenceName = 'web_last.png'
    }
  }
  if (-not (Test-ChromeProfileName $Name)) {
    throw "프로필 이름은 영문 소문자·숫자·-·_ 32자 이하여야 합니다(default 제외): $Name"
  }
  $registry = Read-ChromeProfileRegistry $Config
  $entry = $null
  if ($registry.Contains($Name)) { $entry = $registry[$Name] }
  $dir = ''
  if (-not [string]::IsNullOrWhiteSpace($ProfileDir)) { $dir = $ProfileDir }
  elseif ($null -ne $entry -and -not [string]::IsNullOrWhiteSpace([string]$entry.profileDir)) { $dir = [string]$entry.profileDir }
  else { $dir = Join-Path (Join-Path $stateDir 'chrome-cdp-profiles') $Name }
  if (-not [System.IO.Path]::IsPathRooted($dir)) { throw "프로필 폴더는 절대 경로여야 합니다: $dir" }
  $dir = ConvertTo-FullDir $dir
  if (Test-IsNormalBrowserProfile $dir) {
    throw "사용자의 일반 Chrome·Edge 프로필은 자동화에 쓰지 않습니다. 전용 폴더를 지정하세요: $dir"
  }
  $external = -not (Test-PathInside $dir $stateDir)
  $port = $DefaultPort + 16
  if ($null -ne $entry -and [int]$entry.port -ge 1024) { $port = [int]$entry.port }
  return [pscustomobject]@{
    name = $Name
    profileDir = $dir
    stateFile = (Join-Path $stateDir ("chrome_cdp_{0}.json" -f $Name))
    targetFile = (Join-Path $stateDir ("chrome_cdp_target_{0}.json" -f $Name))
    preferredPort = $port
    external = $external
    registered = ($null -ne $entry)
    evidenceName = ("web_last_{0}.png" -f $Name)
  }
}

function Register-ChromeProfile($Config, [string]$Name, [string]$ProfileDir = '', [int]$Port = 0, [string]$Note = '') {
  if (-not (Test-ChromeProfileName $Name)) {
    throw "프로필 이름은 영문 소문자·숫자·-·_ 32자 이하여야 합니다(default 제외): $Name"
  }
  $info = Resolve-ChromeProfile -Config $Config -Name $Name -ProfileDir $ProfileDir
  if ($info.external -and -not (Test-Path -LiteralPath $info.profileDir -PathType Container)) {
    throw "연결할 프로필 폴더가 없습니다. 빈 프로필을 새로 만들면 로그인 세션이 모두 사라진 것처럼 보이므로 경로를 먼저 확인하세요: $($info.profileDir)"
  }
  $registry = Read-ChromeProfileRegistry $Config
  $entry = [ordered]@{
    profileDir = $info.profileDir
    external = $info.external
    addedAt = [DateTime]::UtcNow.ToString('o')
  }
  if ($Port -ge 1024 -and $Port -le 65535) { $entry.port = $Port }
  if (-not [string]::IsNullOrWhiteSpace($Note)) { $entry.note = $Note }
  $registry[$Name] = $entry
  Save-ChromeProfileRegistry $Config $registry
  return $info
}

# Chrome 명령줄이 이 프로필 폴더를 쓰는지 경계까지 확인한다(shop-a와 shop-ab를 구분).
function Test-CommandLineUsesProfile([string]$CommandLine, [string]$ProfileDir) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $needle = [regex]::Escape($ProfileDir.TrimEnd('\'))
  return [regex]::IsMatch($CommandLine, '--user-data-dir="?' + $needle + '\\?(?:"|\s|$)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
