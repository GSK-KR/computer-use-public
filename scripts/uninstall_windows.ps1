# ============================================================================
# uninstall_windows.ps1 -- 카카오톡/위챗 백업 실행 설정 정리.
# 백업 결과와 진행 기록은 -RemoveArtifacts를 직접 지정한 경우에만 삭제합니다.
# ============================================================================
param(
  [switch]$RemoveConfig,
  [switch]$RemoveToken,
  [switch]$RemoveArtifacts,
  [switch]$WhatIfOnly
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$repoRootWin = Split-Path -Parent $PSScriptRoot
$config = Get-ComputerUseConfig -RepoRoot $repoRootWin
$generatedRootFiles = @(
  '2_백업_화면.url',
  '백업 화면.url',
  'Computer-Use-Web.url',
  '2_1_위챗_백업.url',
  '2_2_카카오톡_백업.url',
  '2_3_위챗_통째백업.url',
  '2_4_카카오톡_통째백업.url',
  '4_실행도구_설치.url',
  '백업 화면 실행 도구 설치.url',
  '준비_확인_보고서.md',
  '실사용_검증_보고서.md',
  'live_acceptance.md',
  'live_acceptance.json'
)
$generatedStateFiles = @(
  'console_url.txt',
  '2_백업_화면.url',
  '백업 화면.url',
  'Computer-Use-Web.url',
  '2_1_위챗_백업.url',
  '2_2_카카오톡_백업.url',
  '2_3_위챗_통째백업.url',
  '2_4_카카오톡_통째백업.url',
  '3_문제_확인.txt',
  '4_실행도구_설치.url',
  '백업 화면 실행 도구 설치.url',
  '준비_확인_보고서.json',
  '실사용_검증_보고서.json',
  'live_acceptance.json',
  'live_acceptance.md',
  'console_server.log',
  'console_server.err.log',
  'chat_viewer_proxy.log',
  'start_console_server.ps1',
  'start_console_server.sh'
)
$generatedStatePatterns = @(
  'console_server_*.log',
  'console_server_*.err.log'
)

function Remove-PathSafe {
  param([string]$Path, [switch]$Recurse)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  if (-not (Test-Path $Path)) { return }
  if ($WhatIfOnly) {
    Write-Host "정리 예정: $Path"
    return
  }
  if ($Recurse) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  } else {
    Remove-Item -LiteralPath $Path -Force
  }
  Write-Host "정리함: $Path"
}

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not [string]::IsNullOrWhiteSpace($desktop)) {
  Remove-PathSafe (Join-Path $desktop '1_백업_시작.bat')
  Remove-PathSafe (Join-Path $desktop '시작하기.bat')
  Remove-PathSafe (Join-Path $desktop 'Computer-Use-Web.bat')
  Remove-PathSafe (Join-Path $desktop 'Computer-Use.bat')
}

if ($RemoveToken) {
  Remove-PathSafe (Join-Path $config.stateDirWin 'console_token')
}

if ($RemoveConfig) {
  Remove-PathSafe (Join-Path $config.stateDirWin 'config.json')
  foreach ($name in $generatedRootFiles) {
    Remove-PathSafe (Join-Path $repoRootWin $name)
  }
  foreach ($name in $generatedStateFiles) {
    Remove-PathSafe (Join-Path $config.stateDirWin $name)
  }
  foreach ($pattern in $generatedStatePatterns) {
    foreach ($item in Get-ChildItem -LiteralPath $config.stateDirWin -Filter $pattern -File -ErrorAction SilentlyContinue) {
      Remove-PathSafe $item.FullName
    }
  }
  Write-Host "백업 화면 주소 바로가기, 문제 확인 파일, 준비/검증 보고서, 실행 로그를 정리했습니다."
}

if ($RemoveArtifacts) {
  Remove-PathSafe $config.shotsDirWin -Recurse
  Remove-PathSafe $config.runsDirWin -Recurse
  Remove-PathSafe $config.stateDirWin -Recurse
  Write-Host "백업 결과, 진행 기록, 실행 설정까지 정리했습니다."
} else {
  Write-Host "백업 결과와 진행 기록은 보존했습니다. 백업 산출물까지 지울 때만 -RemoveArtifacts를 직접 사용하세요."
}
