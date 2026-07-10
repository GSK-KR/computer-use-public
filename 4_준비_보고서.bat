@echo off
setlocal
chcp 65001 >nul
echo.
echo 카카오톡/위챗 백업 준비 보고서를 만듭니다.
echo 백업 전에도 실행할 수 있고, 앱/문자 인식/저장 폴더 상태만 확인합니다.
echo 채팅 본문, 방 이름, 원본 스크린샷 파일 경로는 보고서에 넣지 않습니다.
echo 아무 값도 입력하지 않습니다.
echo.
if not exist "%~dp0scripts\readiness_report.mjs" (
  echo 준비 보고서 도구를 찾지 못했습니다.
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
  echo 설치 안내가 나오면 허용하고, 설치가 끝난 뒤 이 준비 보고서를 다시 실행하세요.
  echo.
  pause
  exit /b 1
)
if not exist "%~dp0state" mkdir "%~dp0state" >nul 2>nul
set "CU_REPORT_MD=%~dp0준비_확인_보고서.md"
set "CU_REPORT_JSON=%~dp0state\준비_확인_보고서.json"
node "%~dp0scripts\readiness_report.mjs" --out-md "%CU_REPORT_MD%" --out-json "%CU_REPORT_JSON%" --open
set "CU_REPORT_EXIT=%ERRORLEVEL%"
echo.
echo 보고서 파일: %CU_REPORT_MD%
echo 지원 담당자가 요청했을 때만 state\준비_확인_보고서.json도 전달하세요.
if "%CU_REPORT_EXIT%"=="0" (
  echo 준비 보고서를 만들었습니다.
) else (
  echo 준비 보고서를 만들지 못했습니다. 1_백업_시작.bat를 다시 실행한 뒤 준비 확인을 보세요.
)
if exist "%CU_REPORT_MD%" start "" "%CU_REPORT_MD%" >nul 2>nul
pause
exit /b %CU_REPORT_EXIT%
