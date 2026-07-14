@echo off
setlocal
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%..\state\config.json"
del /q "%SCRIPT_DIR%..\Computer-Use-Web.url" >nul 2>nul

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Windows 기본 실행 도구를 찾지 못했습니다.
  echo 이 PC의 Windows 기본 실행 상태를 확인한 뒤 1_백업_시작.bat를 다시 실행하세요.
  echo 계속 막히면 3_문제_확인.txt 맨 위의 빠른 해결 3단계를 먼저 보세요.
  echo 아무 값도 입력하지 않습니다.
  if not "%CU_LAUNCHER_PARENT%"=="1" pause
  exit /b 1
)

if not exist "%SCRIPT_DIR%install_windows.ps1" goto missing_required
if not exist "%SCRIPT_DIR%start_console.ps1" goto missing_required
if not exist "%SCRIPT_DIR%computer_use_console_server.mjs" goto missing_required
if not exist "%SCRIPT_DIR%chat_artifact_viewer_server.mjs" goto missing_required
if not exist "%SCRIPT_DIR%lib\path_config.ps1" goto missing_required
if not exist "%SCRIPT_DIR%lib\path_config.mjs" goto missing_required
if not exist "%SCRIPT_DIR%lib\job_runner.mjs" goto missing_required
if not exist "%SCRIPT_DIR%lib\doctor.mjs" goto missing_required
if not exist "%SCRIPT_DIR%..\web\console\index.html" goto missing_required
if not exist "%SCRIPT_DIR%..\web\console\app.js" goto missing_required
if not exist "%SCRIPT_DIR%..\web\console\styles.css" goto missing_required
if not exist "%SCRIPT_DIR%..\web\chat-viewer\index.html" goto missing_required
if not exist "%SCRIPT_DIR%..\web\chat-viewer\app.js" goto missing_required
if not exist "%SCRIPT_DIR%..\web\chat-viewer\styles.css" goto missing_required

if not exist "%CONFIG_FILE%" (
  echo 첫 실행입니다. 카카오톡/위챗 백업 화면에 필요한 폴더와 설정을 준비합니다.
  echo 설치 창이 뜨면 허용하고 기다리세요.
  echo 브라우저가 열릴 때까지 잠시 기다리세요.
  echo 브라우저가 열리면 위챗 백업 또는 카카오톡 백업을 누르면 됩니다.
  echo 여러 방을 한 번에 저장하려면 첫 화면의 위챗 통째 백업 또는 카카오톡 통째 백업을 누르세요.
  echo 브라우저가 안 열리면 새로 만들어지는 2_백업_화면.url을 더블클릭하고, 계속 막히면 3_문제_확인.txt 맨 위의 빠른 해결 3단계를 먼저 보세요.
  echo 위챗 바로가기는 2_1_위챗_백업.url, 카카오톡 바로가기는 2_2_카카오톡_백업.url입니다.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install_windows.ps1" -NoDesktopShortcut
) else (
  set "CU_START_CONSOLE_ARGS="
  if "%CU_NO_BROWSER%"=="1" set "CU_START_CONSOLE_ARGS=-NoBrowser"
  echo 카카오톡/위챗 백업 화면을 여는 중입니다. 브라우저가 열릴 때까지 잠시 기다리세요.
  echo 여러 방을 한 번에 저장하려면 첫 화면의 위챗 통째 백업 또는 카카오톡 통째 백업을 누르세요.
  echo 브라우저가 안 열리면 새로 만들어지는 2_백업_화면.url을 더블클릭하고, 계속 막히면 3_문제_확인.txt 맨 위의 빠른 해결 3단계를 먼저 보세요.
  echo 위챗 바로가기는 2_1_위챗_백업.url, 카카오톡 바로가기는 2_2_카카오톡_백업.url입니다.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_console.ps1" %CU_START_CONSOLE_ARGS%
)
if errorlevel 1 (
  echo.
  echo 백업 화면 준비가 끝나지 않았습니다.
  echo 브라우저와 이 검은 창을 닫고 1_백업_시작.bat를 다시 실행하세요.
  echo 보이지 않으면 시작하기.bat를 실행하세요.
  echo 브라우저가 안 열리면 새로 만들어진 2_백업_화면.url을 더블클릭하세요.
  echo 계속 막히면 3_문제_확인.txt 맨 위의 빠른 해결 3단계를 먼저 보세요.
  echo 4_실행도구_설치.url이 있으면 설치한 뒤 다시 실행하세요.
  echo 아무 값도 입력하지 않습니다.
  if not "%CU_LAUNCHER_PARENT%"=="1" pause
  exit /b 1
)
exit /b 0

:missing_required
echo 필수 실행 파일이 빠졌습니다.
echo 압축이 제대로 풀리지 않았거나 일부 파일만 옮긴 상태입니다.
echo ZIP 파일 안에서 바로 실행하지 말고 먼저 압축을 푼 뒤 다시 실행하세요.
echo 00_처음_여기부터.txt, 1_백업_시작.bat, scripts, web 폴더가 같은 폴더에 보여야 합니다.
echo 폴더 전체를 다시 압축 해제한 뒤 1_백업_시작.bat를 다시 실행하세요.
echo 아무 값도 입력하지 않습니다.
if not "%CU_LAUNCHER_PARENT%"=="1" pause
exit /b 1
