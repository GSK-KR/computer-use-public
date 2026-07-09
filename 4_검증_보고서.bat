@echo off
setlocal
chcp 65001 >nul
echo.
echo 카카오톡/위챗 백업 검증 보고서를 만듭니다.
echo 백업을 한 뒤 실행하면 결과 개수와 준비 상태만 확인합니다.
echo 채팅 본문, 방 이름, 스크린샷 경로는 보고서에 넣지 않습니다.
echo 아무 값도 입력하지 않습니다.
echo.
if not exist "%~dp0scripts\live_acceptance_check.mjs" (
  echo 검증 도구를 찾지 못했습니다.
  echo ZIP 파일 안에서 바로 실행했거나 일부 파일만 옮긴 상태일 수 있습니다.
  echo 먼저 압축을 풀고 00_처음_여기부터.txt, 1_백업_시작.bat, scripts, web 폴더가 같은 폴더에 보이는지 확인하세요.
  echo.
  pause
  exit /b 1
)
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 백업 화면 실행 도구가 필요합니다.
  echo 먼저 1_백업_시작.bat를 더블클릭해 백업 화면을 열어 주세요.
  echo 설치 안내가 나오면 허용하고, 설치가 끝난 뒤 이 검증 보고서를 다시 실행하세요.
  echo.
  pause
  exit /b 1
)
set "CU_REPORT_URL=http://127.0.0.1:8766"
set "CU_FOUND_URL="
if exist "%~dp0state\console_url.txt" (
  for /f "usebackq delims=" %%U in (`findstr /B /C:"http://127.0.0.1:" "%~dp0state\console_url.txt" 2^>nul`) do if not defined CU_FOUND_URL set "CU_FOUND_URL=%%U"
)
if defined CU_FOUND_URL set "CU_REPORT_URL=%CU_FOUND_URL%"
if not exist "%~dp0state" mkdir "%~dp0state" >nul 2>nul
set "CU_REPORT_MD=%~dp0실사용_검증_보고서.md"
set "CU_REPORT_JSON=%~dp0state\실사용_검증_보고서.json"
echo 확인 주소: %CU_REPORT_URL%
echo.
node "%~dp0scripts\live_acceptance_check.mjs" --url "%CU_REPORT_URL%" --package-dir "%~dp0." --require-live-chats --check --out-md "%CU_REPORT_MD%" --out-json "%CU_REPORT_JSON%"
set "CU_REPORT_EXIT=%ERRORLEVEL%"
echo.
echo 보고서 파일: %CU_REPORT_MD%
echo 지원 담당자가 요청했을 때만 state\실사용_검증_보고서.json도 전달하세요.
if "%CU_REPORT_EXIT%"=="0" (
  echo 검증 기준을 통과했습니다.
) else (
  echo 확인이 필요한 항목이 있습니다. 보고서의 다음 행동을 먼저 보세요.
  echo 백업 화면이 열려 있지 않으면 1_백업_시작.bat를 실행한 뒤 다시 검증하세요.
)
start "" "%CU_REPORT_MD%" >nul 2>nul
pause
exit /b %CU_REPORT_EXIT%
