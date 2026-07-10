# ============================================================================
# install_windows.ps1 -- first-run setup for the local Computer-Use web console.
# Writes state\config.json, creates an optional Desktop bootstrap launcher, runs doctor,
# and can start the console. It does not copy private artifacts.
# ============================================================================
param(
  [int]$Port = 8766,
  [switch]$NoDesktopShortcut,
  [switch]$NoStart,
  [switch]$ConfigOnly
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\path_config.ps1')

$repoRootWin = Split-Path -Parent $PSScriptRoot
$config = Get-ComputerUseConfig -RepoRoot $repoRootWin
$stateDir = Join-Path $repoRootWin 'state'
$shotsDir = Join-Path $repoRootWin 'shots'
$runsDir = Join-Path $repoRootWin 'runs'

function Show-StorageSetupHelp {
  Write-Host ""
  Write-Host "백업 저장 폴더를 준비하지 못했습니다." -ForegroundColor Red
  Write-Host "ZIP 파일 안에서 바로 실행했거나, 압축을 푼 위치에 저장 권한이 없을 수 있습니다." -ForegroundColor Yellow
  Write-Host "압축을 푼 폴더 전체를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요." -ForegroundColor Yellow
  Write-Host "OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요." -ForegroundColor Yellow
  Write-Host "scripts와 web 폴더가 1_백업_시작.bat 옆에 보여야 합니다." -ForegroundColor Yellow
  Write-Host "아무 값도 입력하지 않습니다." -ForegroundColor Yellow
  Write-Host ""
}

function Assert-StorageDirectoryWritable {
  param([string]$Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $probe = Join-Path $Path ('.computer-use-write-test-' + [System.Guid]::NewGuid().ToString('N') + '.tmp')
  [System.IO.File]::WriteAllText($probe, 'ok', [System.Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $probe -Force
}

function Assert-LocalStorageReady {
  try {
    foreach ($dir in @($stateDir, $shotsDir, $runsDir)) {
      Assert-StorageDirectoryWritable $dir
    }
  } catch {
    Show-StorageSetupHelp
    exit 1
  }
}

Assert-LocalStorageReady

function Write-NodeInstallShortcut {
  $shortcut = "[InternetShortcut]`r`nURL=https://nodejs.org/`r`n"
  $paths = @(
    (Join-Path $repoRootWin '4_실행도구_설치.url'),
    (Join-Path $stateDir '4_실행도구_설치.url'),
    (Join-Path $repoRootWin '백업 화면 실행 도구 설치.url'),
    (Join-Path $stateDir '백업 화면 실행 도구 설치.url')
  )
  foreach ($path in $paths) {
    try {
      $dir = Split-Path -Parent $path
      if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
      }
      [System.IO.File]::WriteAllText($path, $shortcut, [System.Text.Encoding]::ASCII)
    } catch {
      # The command-line install hint below remains available if shortcut creation is blocked.
    }
  }
}

function Write-InstallTroubleshootingFile {
  Write-NodeInstallShortcut
  $rootPath = Join-Path $repoRootWin '3_문제_확인.txt'
  $statePath = Join-Path $stateDir '3_문제_확인.txt'
  $url = "http://127.0.0.1:$Port/"
  $text = @"
카카오톡/위챗 백업 문제 확인

대부분은 아래 3가지만 하면 해결됩니다.
- 1_백업_시작.bat를 다시 더블클릭합니다.
- 브라우저가 안 열리면 새로 만들어지는 2_백업_화면.url을 더블클릭합니다.
- 계속 막히면 4_실행도구_설치.url을 더블클릭해 설치한 뒤 1_백업_시작.bat를 다시 실행합니다.

1. 먼저 1_백업_시작.bat를 다시 더블클릭합니다. Windows가 파일 확장자를 숨기면 1_백업_시작으로 보일 수 있습니다.
2. 브라우저가 자동으로 열리지 않으면 이번 실행에서 새로 만들어진 2_백업_화면.url을 더블클릭합니다.
   위챗만 바로 열려면 2_1_위챗_백업.url, 카카오톡만 바로 열려면 2_2_카카오톡_백업.url을 더블클릭합니다.
   여러 방을 한 번에 저장하려면 2_3_위챗_통째백업.url 또는 2_4_카카오톡_통째백업.url을 더블클릭합니다.
3. 위챗 백업은 시작 화면, 왼쪽 메뉴, 결과 화면의 위챗 백업 버튼에서 들어갑니다.
4. 여러 방을 한 번에 저장하려면 첫 화면의 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인을 누릅니다.
   누른 뒤 앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 둡니다.
5. 무언가를 입력하라는 화면이 보여도 아무 값도 찾거나 입력하지 않습니다.
6. 따로 입력할 내용이 없습니다. 값을 붙여 넣는 절차가 없습니다. 오래된 화면이면 이 BAT를 다시 실행합니다.
7. Windows가 실행 확인 창을 띄우면 GitHub Releases에서 받은 공개 ZIP인지 확인한 뒤 실행 또는 허용을 누릅니다. 모르는 출처에서 받은 파일이면 실행하지 않습니다.
8. 기본 카카오톡/위챗 백업에는 WSL이 필요하지 않습니다.
9. 웹 화면은 하나입니다. 결과 보기 화면에서도 위챗 백업과 카카오톡 백업으로 돌아갈 수 있습니다.
10. 앱 상태나 문자 인식 확인은 막힐 때만 자세히 보기 안에 있습니다.
11. 위챗이나 카카오톡이 설치되어 있지 않으면 시작 화면, 백업 화면, 준비 확인 화면의 공식 설치 페이지 버튼을 누르고 설치와 로그인을 마친 뒤 상태 새로고침을 누르세요.
12. 준비가 끝난 상태면 첫 화면의 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인이 백업 화면의 준비 체크 위치로 이동합니다. 앱 창과 왼쪽 목록 준비를 체크한 뒤 전체 목록 확인을 누릅니다. 앱이나 문자 인식이 막혀 있으면 화면에 보이는 앱 열기 또는 문자 인식 설정을 먼저 누릅니다.
    바로 클릭하지 않고 전체 목록 확인으로 후보 방 이름을 먼저 보여 준 뒤, 후보가 맞을 때 목록 백업 실행으로 이어집니다.
13. 방 개수 상한 또는 페이지 상한에 도달했다는 안내가 보이면 전체 목록이 끝났다고 보장하기 어렵습니다.
14. 전체 목록 확인 단계라면 완료 카드의 상한 늘려 전체 목록 다시 확인을 먼저 누릅니다.
15. 가능한 상한을 이미 최대로 올린 상태에서 현재 후보만 저장해도 되면 현재 후보로 목록 백업 실행을 누릅니다.
16. 목록 백업 실행 뒤라면 저장된 결과 보기와 확인 필요 방 보기로 빠진 방을 본 뒤 다시 백업합니다.
17. 위챗 문자 인식 준비가 필요하다고 나오면 백업 화면의 중국어 문자 인식 설치를 먼저 누릅니다. Windows 권한 확인 창이 뜨면 예를 누르고, 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요.
18. 자동 설치가 막히면 Windows 언어 설정 열기를 누르고 언어 추가에서 중국어를 검색합니다. 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치하고 문자 인식 기능은 선택 해제하지 않습니다. 설치 뒤 상태 새로고침을 누르세요.
19. 카카오톡 문자 인식 준비가 필요하다고 나오면 한국어 문자 인식 설치를 먼저 누르고, 막히면 Windows 언어 설정에서 한국어를 기본 선택 그대로 설치하세요.
20. 저장할 수 없다는 안내가 나오면 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.
    "백업 저장 폴더를 준비하지 못했습니다"가 보이면 ZIP 파일 안에서 바로 실행했거나 압축을 푼 위치에 저장 권한이 없는 상태입니다. 폴더 전체를 바탕화면이나 문서로 옮긴 뒤 다시 실행하세요.
21. 앱에서 백업할 방을 선택하고 앱 창을 앞에 둔 뒤 브라우저로 돌아와 방 선택 완료, 앱 창 앞에 둠 체크박스를 선택하고 백업을 누릅니다. 백업이 시작되면 끝날 때까지 카카오톡/위챗 창을 최소화하거나 다른 창으로 가리지 마세요.
22. 결과가 비어 있으면 결과 새로고침을 누르고, 계속 비어 있으면 같은 백업 다시 실행, 백업 폴더 열기, 진행 기록을 확인하세요.
    백업 전 준비 상태만 보내야 하면 4_준비_보고서.bat를 실행하세요.
    검증 보고서에 "요청 시간이 초과됐습니다"가 보이면 브라우저와 검은 창을 닫고 1_백업_시작.bat를 다시 실행하세요.
23. 백업 화면 실행 도구 설치가 막히면 먼저 4_실행도구_설치.url을 더블클릭합니다. 설치 페이지가 열리지 않을 때만 아래 명령을 사용합니다.
24. 계속 안 되면 먼저 이 파일의 빠른 해결 3단계를 보여 주세요.
25. 아래 원본 문제 확인 기록은 지원 담당자가 따로 요청했을 때만 전달합니다.

백업 화면 주소 후보: $url

설치 페이지 바로가기:
- $repoRootWin\4_실행도구_설치.url

설치 페이지가 열리지 않을 때만 쓰는 명령:
winget install OpenJS.NodeJS.LTS

원본 문제 확인 기록(요청받았을 때만):
- $stateDir\console_server_*.log
- $stateDir\console_server_*.err.log
- $stateDir\console_server.log
- $stateDir\console_server.err.log

주의:
- 원본 문제 확인 기록에는 내 컴퓨터의 폴더 경로와 오류 원문이 들어갈 수 있습니다.
- 백업 화면이 열리는 경우에는 진행 기록 화면의 보기용 기록 저장을 먼저 사용하세요.
- 카카오톡/위챗 대화 내용이나 스크린샷은 직접 확인한 뒤 필요한 경우에만 공유하세요.
"@
  try {
    if (-not (Test-Path -LiteralPath $rootPath -PathType Leaf)) {
      [System.IO.File]::WriteAllText($rootPath, $text, (New-Object System.Text.UTF8Encoding $false))
    }
    [System.IO.File]::WriteAllText($statePath, $text, (New-Object System.Text.UTF8Encoding $false))
  } catch {
    Write-Host "문제 확인 파일을 쓰지 못했습니다. 1_백업_시작.bat를 다시 실행해 주세요." -ForegroundColor Yellow
  }
}

Write-InstallTroubleshootingFile

function Invoke-WslText {
  param([string[]]$Args)
  try {
    $out = & wsl.exe @Args 2>&1
    if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ ok = $false; text = ($out -join "`n") } }
    return [pscustomobject]@{ ok = $true; text = ($out -join "`n") }
  } catch {
    return [pscustomobject]@{ ok = $false; text = $_.Exception.Message }
  }
}

function Test-WslCommand {
  param([string]$Name, [string]$Command)
  $r = Invoke-WslText -Args @('-e','bash','-lc', $Command)
  $status = if ($r.ok) { 'PASS' } else { 'REVIEW' }
  [pscustomobject]@{ name = $Name; status = $status; detail = $r.text.Trim() }
}

function Test-WindowsCommand {
  param([string]$Name, [string]$Command, [string[]]$Args = @('--version'))
  try {
    $out = & $Command @Args 2>&1
    if ($LASTEXITCODE -eq 0) {
      return [pscustomobject]@{ name = $Name; status = 'PASS'; detail = (($out -join "`n").Trim()) }
    }
    return [pscustomobject]@{ name = $Name; status = 'REVIEW'; detail = (($out -join "`n").Trim()) }
  } catch {
    return [pscustomobject]@{ name = $Name; status = 'REVIEW'; detail = $_.Exception.Message }
  }
}

function Format-CheckStatus {
  param([string]$Status)
  switch ($Status) {
    'PASS' { return '준비됨' }
    'REVIEW' { return '선택 기능' }
    'FAIL' { return '확인 필요' }
    default { return $Status }
  }
}

function Get-CheckStatusColor {
  param([string]$Status)
  switch ($Status) {
    'PASS' { return 'Green' }
    'REVIEW' { return 'DarkYellow' }
    'FAIL' { return 'Red' }
    default { return 'Gray' }
  }
}

function Format-CheckDetail {
  param($Check)
  if ($Check.status -eq 'PASS') {
    return '준비됐습니다'
  }
  switch ($Check.name) {
    '백업 화면 실행 도구' { return '자동 설치가 막히면 4_실행도구_설치.url을 더블클릭하세요' }
    'Windows 기본 실행' { return 'Windows 기본 실행 상태를 확인하세요' }
    '고급 기능 실행 환경' { return '기본 백업에는 없어도 됩니다' }
    '고급 기능 실행 도구' { return '예전 백업 파일 검사나 추가 검수 같은 선택 기능을 쓸 때만 준비하세요' }
    '고급 기능 자료 처리 도구' { return '예전 백업 파일 검사나 추가 검수 같은 선택 기능을 쓸 때만 준비하세요' }
    '예전 파일 확인 도구' { return '예전 백업 파일 검사를 쓸 때만 준비하세요' }
    '고급 자동 실행 선택 기능' { return '고급 자동 실행이 필요할 때만 준비하세요' }
    default { return '필요할 때 준비하세요' }
  }
}

function Get-WindowsNodeCommand {
  $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  if ($null -ne $node) { return $node.Source }
  $common = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $common) { return $common }
  return $null
}

function Update-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machine, $user) -join ';'
}

function Try-InstallWindowsNode {
  if (Get-WindowsNodeCommand) { return $true }
  $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
  if ($null -eq $winget) { return $false }
  Write-Host "백업 화면 실행 도구가 없어 자동 설치를 시도합니다. 설치 창이 뜨면 허용하세요." -ForegroundColor Yellow
  $args = @('install','--id','OpenJS.NodeJS.LTS','-e','--accept-package-agreements','--accept-source-agreements')
  try {
    & $winget.Source @args
    if ($LASTEXITCODE -ne 0) {
      Write-Host "백업 화면 실행 도구 자동 설치가 완료되지 않았습니다. 4_실행도구_설치.url을 더블클릭하세요." -ForegroundColor Yellow
      return $false
    }
    Update-ProcessPath
    if (Get-WindowsNodeCommand) {
      Write-Host "백업 화면 실행 도구 설치가 확인됐습니다. 준비 확인을 계속합니다." -ForegroundColor Green
      return $true
    }
    Write-Host "설치 후 현재 창에서 아직 감지되지 않습니다. 이 창을 닫고 압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 압축을 푼 폴더의 시작하기.bat를 실행하세요." -ForegroundColor Yellow
    return $false
  } catch {
    Write-Host "백업 화면 실행 도구 자동 설치가 완료되지 않았습니다. 4_실행도구_설치.url을 더블클릭하세요." -ForegroundColor Yellow
    return $false
  }
}

function Show-NodeInstallHelp {
  Write-NodeInstallShortcut
  Write-Host ""
  Write-Host "백업 화면 실행 도구가 필요합니다." -ForegroundColor Yellow
  Write-Host "먼저 압축을 푼 폴더의 4_실행도구_설치.url을 더블클릭하세요." -ForegroundColor Yellow
  Write-Host "설치 페이지가 열리지 않을 때만 쓰는 명령:" -ForegroundColor Yellow
  Write-Host "  winget install OpenJS.NodeJS.LTS" -ForegroundColor Cyan
  Write-Host "winget을 사용할 수 없으면 https://nodejs.org/ 에서 LTS 버전을 설치하세요." -ForegroundColor Yellow
  Write-Host "설치가 끝나면 이 창을 닫고 압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 압축을 푼 폴더의 시작하기.bat를 실행하세요." -ForegroundColor Yellow
  Write-Host ""
}

function ConvertTo-WslPathSafe {
  param([string]$Path)
  return ConvertTo-WslPath $Path
}

$repoRootWsl = ConvertTo-WslPathSafe $repoRootWin
$stateDirWsl = ConvertTo-WslPathSafe $stateDir
$shotsDirWsl = ConvertTo-WslPathSafe $shotsDir
$runsDirWsl = ConvertTo-WslPathSafe $runsDir
$wechatDbWsl = ($shotsDirWsl.TrimEnd('/') + '/wechat_local.sqlite3')

$localConfig = [ordered]@{
  repoRootWsl = $repoRootWsl
  repoRootWin = $repoRootWin
  mirrorRootWsl = $repoRootWsl
  mirrorRootWin = $repoRootWin
  shotsDir = $shotsDirWsl
  shotsDirWin = $shotsDir
  stateDir = $stateDirWsl
  stateDirWin = $stateDir
  runsDir = $runsDirWsl
  runsDirWin = $runsDir
  wechatDb = $wechatDbWsl
  defaultConsolePort = $Port
  chromeCdpPort = 9222
  agentProvider = 'auto'
  allowCloudOcr = $false
  allowCloudTranslation = $false
}
$configFile = Join-Path $stateDir 'config.json'
$localConfig | ConvertTo-Json -Depth 5 | Set-Content -Path $configFile -Encoding UTF8

Write-Host "백업 화면 설정을 준비했습니다."
Write-Host "같은 컴퓨터에서는 따로 입력할 내용이 없습니다."

Try-InstallWindowsNode | Out-Null

$checks = @()
$checks += Test-WindowsCommand '백업 화면 실행 도구' 'node.exe'
$checks += Test-WindowsCommand 'Windows 기본 실행' 'powershell.exe' @('-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()')

$optionalChecks = @(
  [pscustomobject]@{ name = '고급 기능 실행 환경'; status = 'REVIEW'; detail = '기본 백업에는 없어도 됩니다' },
  [pscustomobject]@{ name = '고급 기능 실행 도구'; status = 'REVIEW'; detail = '기본 백업에는 없어도 됩니다' },
  [pscustomobject]@{ name = '고급 기능 자료 처리 도구'; status = 'REVIEW'; detail = '기본 백업에는 없어도 됩니다' },
  [pscustomobject]@{ name = '예전 파일 확인 도구'; status = 'REVIEW'; detail = '기본 백업에는 없어도 됩니다' },
  [pscustomobject]@{ name = '고급 자동 실행 선택 기능'; status = 'REVIEW'; detail = '기본 백업에는 없어도 됩니다' },
  [pscustomobject]@{ name = '고급 자동 실행 선택 기능'; status = 'REVIEW'; detail = '기본 백업에는 없어도 됩니다' }
)
if ($env:CU_SHOW_ADVANCED_CHECKS -eq '1') {
  $optionalChecks = @()
  $optionalChecks += Test-WslCommand '고급 기능 실행 환경' 'uname -a'
  $optionalChecks += Test-WslCommand '고급 기능 실행 도구' 'node --version'
  $optionalChecks += Test-WslCommand '고급 기능 자료 처리 도구' 'jq --version'
  $optionalChecks += Test-WslCommand '예전 파일 확인 도구' 'sqlite3 --version'
  $optionalChecks += Test-WslCommand '고급 자동 실행 선택 기능' 'codex --version'
  $optionalChecks += Test-WslCommand '고급 자동 실행 선택 기능' 'claude --version'
}

Write-Host "기본 준비 상태"
foreach ($check in $checks) {
  $label = Format-CheckStatus $check.status
  $color = Get-CheckStatusColor $check.status
  $detail = Format-CheckDetail $check
  if ([string]::IsNullOrWhiteSpace($detail)) {
    Write-Host ("{0,-10} {1}" -f $label, $check.name) -ForegroundColor $color
  } else {
    Write-Host ("{0,-10} {1}: {2}" -f $label, $check.name, $detail) -ForegroundColor $color
  }
}
$optionalReady = @($optionalChecks | Where-Object { $_.status -eq 'PASS' }).Count
$optionalReview = @($optionalChecks | Where-Object { $_.status -ne 'PASS' }).Count
Write-Host ("선택 기능   준비 {0}개, 필요할 때 확인 {1}개" -f $optionalReady, $optionalReview) -ForegroundColor DarkYellow
Write-Host "예전 백업 파일 검사나 추가 검수 같은 특별한 작업을 쓸 때만 선택 기능을 준비하면 됩니다." -ForegroundColor DarkYellow
if ($env:CU_SHOW_ADVANCED_CHECKS -eq '1') {
  foreach ($check in $optionalChecks) {
    $label = Format-CheckStatus $check.status
    $color = Get-CheckStatusColor $check.status
    $detail = Format-CheckDetail $check
    if ([string]::IsNullOrWhiteSpace($detail)) {
      Write-Host ("{0,-10} {1}" -f $label, $check.name) -ForegroundColor $color
    } else {
      Write-Host ("{0,-10} {1}: {2}" -f $label, $check.name, $detail) -ForegroundColor $color
    }
  }
}

if (-not $NoDesktopShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not [string]::IsNullOrWhiteSpace($desktop)) {
    $primaryBat = Join-Path $desktop '1_백업_시작.bat'
    $bat = Join-Path $desktop '시작하기.bat'
    $bootstrap = Join-Path $repoRootWin '1_백업_시작.bat'
    if (-not (Test-Path -LiteralPath $bootstrap)) {
      $bootstrap = Join-Path $repoRootWin '시작하기.bat'
    }
    if (-not (Test-Path -LiteralPath $bootstrap)) {
      $bootstrap = Join-Path $PSScriptRoot '백업_화면_실행.bat'
    }
    $batText = @"
@echo off
setlocal
chcp 65001 >nul
set "CU_LAUNCHER_PARENT=1"
call "$bootstrap" %*
set "CU_LAUNCHER_EXIT=%ERRORLEVEL%"
set "CU_LAUNCHER_PARENT="
if not "%CU_LAUNCHER_EXIT%"=="0" (
  echo.
  echo 백업 화면을 열지 못했습니다.
  echo 브라우저와 이 검은 창을 닫고 1_백업_시작.bat를 다시 실행하세요.
  echo 보이지 않으면 시작하기.bat를 실행하세요.
  echo 브라우저가 안 열리면 새로 만들어진 2_백업_화면.url을 더블클릭하세요.
  echo 계속 막히면 3_문제_확인.txt 맨 위의 빠른 해결 3단계를 먼저 보세요.
  echo 4_실행도구_설치.url이 있으면 설치한 뒤 다시 실행하세요.
  echo 아무 값도 입력하지 않습니다.
  pause
  exit /b %CU_LAUNCHER_EXIT%
)
exit /b 0
"@ -replace "`r?`n", "`r`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($primaryBat, $batText, $utf8NoBom)
    [System.IO.File]::WriteAllText($bat, $batText, $utf8NoBom)
    Write-Host "바탕화면 실행 파일을 만들었습니다: $primaryBat"
  }
}

if (-not $ConfigOnly) {
  Write-Host "준비 상태를 확인합니다..."
  $node = Get-WindowsNodeCommand
  if ($null -ne $node) {
    & $node (Join-Path $repoRootWin 'scripts\doctor.mjs')
  } else {
    Show-NodeInstallHelp
    $wslDoctor = Invoke-WslText -Args @('-e','bash','-lc',"cd '$repoRootWsl' && node scripts/doctor.mjs")
    if ($wslDoctor.ok) {
      Write-Host $wslDoctor.text
    } else {
      Write-Host "준비 확인을 건너뛰었습니다. 백업 화면 실행 도구를 설치한 뒤 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 시작하기.bat를 실행하세요." -ForegroundColor Yellow
      Write-Host "자세한 문제 확인은 백업 화면 실행 도구 설치 후 준비 확인에서 다시 볼 수 있습니다." -ForegroundColor DarkYellow
    }
  }
}

if (-not $NoStart -and -not $ConfigOnly) {
  $startScript = Join-Path $PSScriptRoot 'start_console.ps1'
  if ($PSBoundParameters.ContainsKey('Port')) {
    & $startScript -Port $Port
  } else {
    & $startScript
  }
}
