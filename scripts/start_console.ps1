# ============================================================================
# start_console.ps1 -- Windows launcher for the local web console.
# Starts one Windows-visible local server if needed, then opens the browser.
# ============================================================================
param(
  [int]$Port = 0,
  [switch]$NoBrowser,
  [switch]$StrictToken
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig
$explicitPort = $Port -gt 0
if (-not $explicitPort) { $Port = [int]$cuConfig.defaultConsolePort }

if ($StrictToken) {
  $env:CU_CONSOLE_REQUIRE_TOKEN = '1'
} else {
  $env:CU_CONSOLE_REQUIRE_TOKEN = '0'
}

function Get-StringHashPrefix([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha.ComputeHash($bytes)
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
  } finally {
    $sha.Dispose()
  }
}

$consoleInstanceHashFiles = @(
  'scripts/agent_runner.mjs',
  'scripts/computer_use_console_server.mjs',
  'scripts/chat_artifact_viewer_server.mjs',
  'scripts/discord_capture.mjs',
  'scripts/lib/job_runner.mjs',
  'scripts/lib/doctor.mjs',
  'scripts/lib/path_config.mjs',
  'web/console/index.html',
  'web/console/app.js',
  'web/console/styles.css',
  'web/chat-viewer/index.html',
  'web/chat-viewer/app.js',
  'web/chat-viewer/styles.css'
)

function Get-ConsolePackageHashPrefix([string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) { return '' }
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $consoleInstanceHashFiles) {
    $path = Join-Path $Root ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $fileHash = 'missing'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      try {
        $fileHash = ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash).ToLowerInvariant()
      } catch {
        $fileHash = 'missing'
      }
    }
    [void]$lines.Add(("${rel}:${fileHash}"))
  }
  return Get-StringHashPrefix ($lines -join "`n")
}

$repoRootWinResolved = try { (Resolve-Path -LiteralPath $cuConfig.repoRootWin).ProviderPath } catch { $cuConfig.repoRootWin }
$expectedConsoleRootHashes = @(
  (Get-ConsolePackageHashPrefix $repoRootWinResolved),
  (Get-ConsolePackageHashPrefix $cuConfig.repoRootWin),
  (Get-ConsolePackageHashPrefix $cuConfig.repoRootWsl)
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

function Set-ConsoleUrls {
  $script:baseUrl = "http://127.0.0.1:$script:Port"
  $script:healthUrl = "$script:baseUrl/api/health"
}

Set-ConsoleUrls

function Write-NodeInstallShortcut {
  $shortcut = "[InternetShortcut]`r`nURL=https://nodejs.org/`r`n"
  $paths = @(
    (Join-Path $cuConfig.repoRootWin '4_실행도구_설치.url'),
    (Join-Path $cuConfig.stateDirWin '4_실행도구_설치.url'),
    (Join-Path $cuConfig.repoRootWin '백업 화면 실행 도구 설치.url'),
    (Join-Path $cuConfig.stateDirWin '백업 화면 실행 도구 설치.url')
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

function Test-ConsoleHealth {
  param([switch]$AllowWslServer)
  try {
    $r = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    $strictRequested = [bool]$StrictToken
    $strictServer = ($null -ne $r.tokenRequired -and [bool]$r.tokenRequired)
    $samePackageServer = ($null -ne $r.instance -and $expectedConsoleRootHashes -contains [string]$r.instance.rootHash)
    $serverPlatform = if ($null -ne $r.runtime -and $null -ne $r.runtime.platform) { [string]$r.runtime.platform } else { '' }
    $preferredRuntime = (-not $preferWindowsServer) -or $AllowWslServer -or $serverPlatform -eq 'win32'
    if (-not ($null -ne $r -and $r.schema -eq 'computer-use.console-health.v1' -and $r.ok -and $samePackageServer -and $preferredRuntime -and ($strictRequested -or -not $strictServer))) {
      return $false
    }
    $page = Invoke-WebRequest -Uri "$baseUrl/backup" -UseBasicParsing -TimeoutSec 2
    return ($page.StatusCode -eq 200 -and [string]$page.Content -like '*위챗/카카오톡 백업*')
  } catch {
    return $false
  }
}

function Test-HttpOccupied {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $client) { $client.Close() }
  }
}

function Quote-Bash([string]$Value) {
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Quote-PowerShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Write-ConsoleAddressFiles {
  $url = "$baseUrl/"
  $wechatUrl = "$baseUrl/backup#wechat"
  $kakaoUrl = "$baseUrl/backup#kakao"
  $wechatFullUrl = "$baseUrl/backup#wechat-full"
  $kakaoFullUrl = "$baseUrl/backup#kakao-full"
  $textPath = Join-Path $cuConfig.stateDirWin 'console_url.txt'
  $koreanShortcutStatePath = Join-Path $cuConfig.stateDirWin '백업 화면.url'
  $koreanShortcutRootPath = Join-Path $cuConfig.repoRootWin '백업 화면.url'
  $sortedShortcutStatePath = Join-Path $cuConfig.stateDirWin '2_백업_화면.url'
  $sortedShortcutRootPath = Join-Path $cuConfig.repoRootWin '2_백업_화면.url'
  $text = @"
카카오톡/위챗 백업 화면 주소
$url

브라우저가 자동으로 열리지 않으면 위 주소를 열거나 이번 실행에서 새로 만들어진 2_백업_화면.url 파일을 더블클릭하세요.
보이지 않으면 백업 화면.url 파일을 더블클릭하세요.
위챗을 바로 열려면 2_1_위챗_백업.url, 카카오톡을 바로 열려면 2_2_카카오톡_백업.url을 더블클릭하세요.
여러 방을 한 번에 저장하려면 2_3_위챗_통째백업.url 또는 2_4_카카오톡_통째백업.url을 더블클릭하세요.
Windows가 파일 확장자를 숨기면 1_백업_시작.bat가 1_백업_시작으로 보일 수 있습니다.
아무 값도 찾거나 입력하지 않습니다. 따로 입력할 내용이 없습니다.
첫 화면의 "1번 위챗 백업부터 시작하세요" 아래에서 1번 위챗 백업, 카카오톡 백업, 결과 보기를 먼저 봅니다.
여러 방을 한 번에 저장하려면 같은 첫 화면의 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인을 누릅니다.
여러 방을 한 번에 저장하려면 백업 화면의 "여러 방 저장" 영역에서 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인을 누릅니다.
같은 첫 화면에 "무엇을 백업할까요?" 안내도 함께 보입니다.
위챗은 사라진 것이 아닙니다. 첫 번째 초록색 1번 위챗 백업, 상단 바로가기, 왼쪽 메뉴, 결과 화면의 위챗 백업 버튼에서 다시 들어갑니다.
기본 더블클릭 사용에서는 값을 붙여 넣는 절차가 없습니다.
앱 상태나 문자 인식 확인은 막힐 때만 자세히 보기 안에 있습니다.
웹 화면은 하나입니다. 결과 보기 화면에서도 위챗 백업과 카카오톡 백업으로 돌아갈 수 있습니다.
준비가 끝난 상태면 첫 화면의 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인이 백업 화면의 준비 체크 위치로 이동합니다. 앱 창과 왼쪽 목록 준비를 체크한 뒤 전체 목록 확인을 누릅니다. 앱이나 문자 인식이 막혀 있으면 화면에 보이는 앱 열기 또는 문자 인식 설정을 먼저 누릅니다.
바로 클릭하지 않고 전체 목록 확인으로 후보 방 이름을 먼저 보여 준 뒤, 후보가 맞을 때 목록 백업 실행으로 이어집니다.
방 개수 상한 또는 페이지 상한에 도달했다는 안내가 보이면 전체 목록이 끝났다고 보장하기 어렵습니다.
전체 목록 확인 단계라면 완료 카드의 상한 늘려 전체 목록 다시 확인을 먼저 누릅니다.
가능한 상한을 이미 최대로 올린 상태에서 현재 후보만 저장해도 되면 현재 후보로 목록 백업 실행을 누릅니다.
목록 백업 실행 뒤라면 저장된 결과 보기와 확인 필요 방 보기로 빠진 방을 본 뒤 다시 백업합니다.
위챗이나 카카오톡이 설치되어 있지 않으면 시작 화면, 백업 화면, 준비 확인 화면의 공식 설치 페이지 버튼을 누르고 설치와 로그인을 마친 뒤 상태 새로고침을 누르세요.
저장할 수 없다는 안내가 나오면 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요.
OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.
오래된 화면이나 접속 오류가 보이면 압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하세요. Windows가 파일 확장자를 숨기면 1_백업_시작으로 보일 수 있습니다.
계속 막히면 3_문제_확인.txt 맨 위의 빠른 해결 3단계를 먼저 따라 하세요.
"@
  $shortcut = "[InternetShortcut]`r`nURL=$url`r`n"
  $wechatShortcut = "[InternetShortcut]`r`nURL=$wechatUrl`r`n"
  $kakaoShortcut = "[InternetShortcut]`r`nURL=$kakaoUrl`r`n"
  $wechatFullShortcut = "[InternetShortcut]`r`nURL=$wechatFullUrl`r`n"
  $kakaoFullShortcut = "[InternetShortcut]`r`nURL=$kakaoFullUrl`r`n"
  try {
    New-Item -ItemType Directory -Force -Path $cuConfig.stateDirWin | Out-Null
    [System.IO.File]::WriteAllText($textPath, $text, (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($koreanShortcutStatePath, $shortcut, [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($koreanShortcutRootPath, $shortcut, [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($sortedShortcutStatePath, $shortcut, [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($sortedShortcutRootPath, $shortcut, [System.Text.Encoding]::ASCII)
    foreach ($item in @(
      @{ Name = '2_1_위챗_백업.url'; Body = $wechatShortcut },
      @{ Name = '2_2_카카오톡_백업.url'; Body = $kakaoShortcut },
      @{ Name = '2_3_위챗_통째백업.url'; Body = $wechatFullShortcut },
      @{ Name = '2_4_카카오톡_통째백업.url'; Body = $kakaoFullShortcut }
    )) {
      [System.IO.File]::WriteAllText((Join-Path $cuConfig.stateDirWin $item.Name), $item.Body, [System.Text.Encoding]::ASCII)
      [System.IO.File]::WriteAllText((Join-Path $cuConfig.repoRootWin $item.Name), $item.Body, [System.Text.Encoding]::ASCII)
    }
  } catch {
    Write-Host "웹 주소 파일을 쓰지 못했습니다. 브라우저가 열리면 그대로 사용하고, 주소를 놓치면 1_백업_시작.bat를 다시 실행하세요." -ForegroundColor Yellow
  }
}

function Write-ConsoleTroubleshootingFile {
  param([string]$Url = '')
  Write-NodeInstallShortcut
  $rootPath = Join-Path $cuConfig.repoRootWin '3_문제_확인.txt'
  $statePath = Join-Path $cuConfig.stateDirWin '3_문제_확인.txt'
  $urlLine = if ($Url) { "백업 화면 주소: $Url" } else { "백업 화면 주소는 성공하면 2_백업_화면.url에 저장됩니다." }
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
3. 위챗은 시작 화면 "1번 위챗 백업부터 시작하세요" 아래의 첫 번째 초록색 1번 위챗 백업과 왼쪽 메뉴의 위챗 백업에 있습니다.
   같은 첫 화면에 "무엇을 백업할까요?" 안내도 함께 보입니다.
4. 여러 방을 한 번에 저장하려면 같은 첫 화면의 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인을 누릅니다.
   여러 방을 한 번에 저장하려면 백업 화면의 "여러 방 저장" 영역에서 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인을 누릅니다.
   누른 뒤에는 앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 둡니다.
5. 위챗은 사라진 것이 아닙니다. 새 화면에서도 첫 번째 초록색 1번 위챗 백업을 누르면 됩니다.
6. 무언가를 입력하라는 화면이 보여도 아무 값도 찾거나 입력하지 않습니다.
7. 따로 입력할 내용이 없습니다. 값을 붙여 넣는 절차가 없습니다. 오래된 화면이면 이 BAT를 다시 실행합니다.
8. Windows가 실행 확인 창을 띄우면 GitHub Releases에서 받은 공개 ZIP인지 확인한 뒤 실행 또는 허용을 누릅니다. 모르는 출처에서 받은 파일이면 실행하지 않습니다.
9. 기본 카카오톡/위챗 백업에는 WSL이 필요하지 않습니다.
10. 웹 화면은 하나입니다. 결과 보기 화면에서도 위챗 백업과 카카오톡 백업으로 돌아갈 수 있습니다.
   앱 상태나 문자 인식 확인은 막힐 때만 자세히 보기 안에 있습니다.
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

$urlLine

설치 페이지 바로가기:
- $($cuConfig.repoRootWin)\4_실행도구_설치.url

설치 페이지가 열리지 않을 때만 쓰는 명령:
winget install OpenJS.NodeJS.LTS

원본 문제 확인 기록(요청받았을 때만):
- $($cuConfig.stateDirWin)\console_server_*.log
- $($cuConfig.stateDirWin)\console_server_*.err.log
- $($cuConfig.stateDirWin)\console_server.log
- $($cuConfig.stateDirWin)\console_server.err.log

주의:
- 원본 문제 확인 기록에는 내 컴퓨터의 폴더 경로와 오류 원문이 들어갈 수 있습니다.
- 백업 화면이 열리는 경우에는 진행 기록 화면의 보기용 기록 저장을 먼저 사용하세요.
- 카카오톡/위챗 대화 내용이나 스크린샷은 직접 확인한 뒤 필요한 경우에만 공유하세요.
"@
  try {
    New-Item -ItemType Directory -Force -Path $cuConfig.stateDirWin | Out-Null
    if (-not (Test-Path -LiteralPath $rootPath -PathType Leaf)) {
      [System.IO.File]::WriteAllText($rootPath, $text, (New-Object System.Text.UTF8Encoding $false))
    }
    [System.IO.File]::WriteAllText($statePath, $text, (New-Object System.Text.UTF8Encoding $false))
  } catch {
    Write-Host "문제 확인 파일을 쓰지 못했습니다. 1_백업_시작.bat를 다시 실행해 주세요." -ForegroundColor Yellow
  }
}

function Open-Console {
  Write-ConsoleAddressFiles
  Write-ConsoleTroubleshootingFile "$baseUrl/"
  if ($NoBrowser) { return }
  Start-Process "$baseUrl/" | Out-Null
}

function Get-WindowsNodeCommand {
  $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  if ($null -ne $node) { return $node.Source }
  $common = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $common) { return $common }
  return $null
}

$preferWindowsServer = $null -ne (Get-WindowsNodeCommand)

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
      Write-Host "백업 화면 실행 도구 설치가 확인됐습니다. 백업 화면 시작을 계속합니다." -ForegroundColor Green
      return $true
    }
    Write-Host "설치 후 현재 창에서 아직 감지되지 않습니다. 이 창을 닫고 압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 압축을 푼 폴더의 시작하기.bat를 실행하세요." -ForegroundColor Yellow
    return $false
  } catch {
    Write-Host "백업 화면 실행 도구 자동 설치가 완료되지 않았습니다. 4_실행도구_설치.url을 더블클릭하세요." -ForegroundColor Yellow
    return $false
  }
}

function Start-WindowsNodeConsole {
  $node = Get-WindowsNodeCommand
  if ($null -eq $node) { return $false }
  if (-not (Test-Path (Join-Path $cuConfig.repoRootWin 'scripts\computer_use_console_server.mjs'))) { return $false }

  $log = Join-Path $cuConfig.stateDirWin ("console_server_$Port.log")
  $err = Join-Path $cuConfig.stateDirWin ("console_server_$Port.err.log")
  $runner = Join-Path $cuConfig.stateDirWin 'start_console_server.ps1'
  $requireToken = if ($StrictToken) { '1' } else { '0' }
  $nodeLiteral = Quote-PowerShellLiteral $node
  $repoLiteral = Quote-PowerShellLiteral $cuConfig.repoRootWin
  $logLiteral = Quote-PowerShellLiteral $log
  $errLiteral = Quote-PowerShellLiteral $err
  $serverScript = @"
`$ErrorActionPreference = 'Stop'
`$env:CU_CONSOLE_REQUIRE_TOKEN = '$requireToken'
Set-Location -LiteralPath $repoLiteral
& $nodeLiteral 'scripts\computer_use_console_server.mjs' '--host' '127.0.0.1' '--port' '$Port' > $logLiteral 2> $errLiteral
"@
  try {
    [System.IO.File]::WriteAllText($runner, $serverScript, (New-Object System.Text.UTF8Encoding $false))
    Start-Process `
      -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$runner) `
      -WindowStyle Hidden | Out-Null
    return $true
  } catch {
    Write-Host "백업 화면을 바로 열지 못했습니다. 다른 방법으로 다시 시도합니다." -ForegroundColor Yellow
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

function Assert-ConsoleStorageReady {
  try {
    foreach ($dir in @($cuConfig.stateDirWin, $cuConfig.shotsDirWin, $cuConfig.runsDirWin)) {
      Assert-StorageDirectoryWritable $dir
    }
  } catch {
    Show-StorageSetupHelp
    exit 1
  }
}

function Test-WslAvailable {
  try {
    $out = & wsl.exe -e sh -lc 'printf ok' 2>&1
    return ($LASTEXITCODE -eq 0 -and (($out -join "`n").Trim()) -eq 'ok')
  } catch {
    return $false
  }
}

Assert-ConsoleStorageReady
Write-ConsoleTroubleshootingFile "$baseUrl/"

while (-not $explicitPort -and (Test-HttpOccupied) -and -not (Test-ConsoleHealth)) {
  Write-Host "기본 백업 화면 주소가 이미 사용 중입니다. 다른 주소로 다시 시도합니다." -ForegroundColor Yellow
  $Port++
  Set-ConsoleUrls
}
Write-ConsoleTroubleshootingFile "$baseUrl/"

if (Test-ConsoleHealth) {
  Open-Console
  Write-Host "카카오톡/위챗 백업 화면이 이미 실행 중입니다: $baseUrl"
  exit 0
}

$startedWindows = Start-WindowsNodeConsole
if (-not $startedWindows -and (Try-InstallWindowsNode)) {
  $preferWindowsServer = $null -ne (Get-WindowsNodeCommand)
  $startedWindows = Start-WindowsNodeConsole
}
if ($startedWindows) {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ConsoleHealth) {
      Open-Console
      Write-Host "카카오톡/위챗 백업 화면을 시작했습니다: $baseUrl"
      exit 0
    }
  }
  Write-Host "백업 화면이 아직 준비되지 않아 다른 방법으로 다시 시도합니다." -ForegroundColor Yellow
}

if (-not (Test-WslAvailable)) {
  Write-Host "카카오톡/위챗 백업 화면을 시작하지 못했습니다." -ForegroundColor Red
  Show-NodeInstallHelp
  Write-Host "기본 사용에는 WSL이 필요하지 않습니다. 백업 화면 실행 도구를 설치한 뒤 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 시작하기.bat를 실행하세요." -ForegroundColor Yellow
  Write-Host "원본 문제 확인 기록(요청받았을 때만): $($cuConfig.stateDirWin)\console_server_*.log" -ForegroundColor Yellow
  exit 1
}

$repo = Quote-Bash $cuConfig.repoRootWsl
$state = Quote-Bash $cuConfig.stateDirWsl
$launchWin = Join-Path $cuConfig.stateDirWin 'start_console_server.sh'
$launchWsl = ($cuConfig.stateDirWsl.TrimEnd('/') + '/start_console_server.sh')
$script = @"
#!/usr/bin/env bash
set -euo pipefail
cd $repo
mkdir -p $state
exec node scripts/computer_use_console_server.mjs --host 127.0.0.1 --port $Port > $state/console_server_$Port.log 2> $state/console_server_$Port.err.log
"@
[System.IO.File]::WriteAllText($launchWin, $script, (New-Object System.Text.UTF8Encoding $false))

try {
  Start-Process -FilePath 'wsl.exe' -ArgumentList @('-e','bash',$launchWsl) -WindowStyle Hidden | Out-Null
} catch {
  Write-Host "다른 방법으로도 백업 화면을 시작하지 못했습니다." -ForegroundColor Red
  Write-Host "압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하거나 백업 화면 실행 도구 설치 상태를 확인하세요. 보이지 않으면 압축을 푼 폴더의 시작하기.bat를 실행하세요." -ForegroundColor Yellow
  exit 1
}

for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ConsoleHealth -AllowWslServer) {
      Open-Console
      Write-Host "카카오톡/위챗 백업 화면을 시작했습니다: $baseUrl"
      exit 0
    }
}

Write-Host "카카오톡/위챗 백업 화면이 정상 상태가 되지 않았습니다." -ForegroundColor Red
Write-Host "원본 문제 확인 기록(요청받았을 때만): $($cuConfig.stateDirWin)\console_server_*.log" -ForegroundColor Yellow
Write-Host "기록 파일은 요청받았을 때만 전달하고, 먼저 백업 화면 실행 도구 설치 후 다시 실행하세요." -ForegroundColor Yellow
exit 1
