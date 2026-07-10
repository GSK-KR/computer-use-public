@echo off
setlocal
chcp 65001 >nul
echo.
echo 카카오톡/위챗 백업 실행 파일과 로컬 실행 설정을 정리합니다.
echo 주소 바로가기, 실행 중 만든 문제 확인 기록, 준비/검증 보고서, 실행 로그도 같이 정리합니다.
echo 백업 결과와 진행 기록은 지우지 않습니다.
echo 완전히 지우는 방법은 README.md의 삭제 안내에 따로 있습니다.
echo.
if not exist "%~dp0scripts\uninstall_windows.ps1" (
  echo scripts 폴더를 찾지 못했습니다.
  echo ZIP 파일 안에서 바로 실행한 경우 먼저 압축을 푼 뒤 다시 실행하세요.
  echo 00_처음_여기부터.txt, 1_백업_시작.bat, 5_정리_삭제.bat, scripts, web 폴더가 같은 폴더에 보여야 합니다.
  echo.
  pause
  exit /b 1
)
set /p CONFIRM=정리하려면 Y를 입력하고 Enter를 누르세요. 취소하려면 그냥 닫으세요:
if /I not "%CONFIRM%"=="Y" (
  echo 취소했습니다.
  pause
  exit /b 0
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall_windows.ps1" -RemoveConfig
if errorlevel 1 (
  echo 정리 중 문제가 생겼습니다. README.md의 삭제 안내를 확인하세요.
  pause
  exit /b 1
)
echo.
echo 정리했습니다. 백업 결과와 진행 기록은 그대로 보존했습니다.
pause
