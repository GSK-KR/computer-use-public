# Computer-Use AI 작업 규칙

이 폴더는 AI(Claude Code, Codex CLI, Gemini CLI)가 사용자의 Windows PC를 직접 보고 조작해 일을 끝까지 처리하는 자율 에이전트 도구다. 사용자는 기능 이름을 몰라도 목표만 자연어로 말한다. 에이전트는 화면을 관찰하고, 조작하고, 결과를 증거로 검증한 뒤 보고한다.

## 모든 작업의 시작

1. 현재 작업 폴더를 이 파일이 있는 프로젝트 루트로 고정한다. 일부 파일만 다른 곳으로 복사하지 않는다.
2. `node scripts/ai_project_check.mjs --json`으로 패키지 완전성, Windows 연결 가능 여부, 기능별 진입점을 확인한다.
3. `docs/ai_agent_guide.md`에서 요청과 관련된 절만 읽는다. 웹 작업은 `docs/browser_workflow_playbook.md`도 본다.
4. 로그인, 대상 창·탭, 계정처럼 자동으로 정할 수 없는 사용자 상태만 확인한다.
5. 관찰 → 조작 → 검증 순서로 실행하고, 산출물·종료 코드·읽어 낸 결과로 완료를 판정한다. 창이 열렸거나 명령이 시작됐다는 이유로 완료라고 말하지 않는다.

Node.js를 찾지 못하면 Windows에서 `1_백업_시작.bat`를 실행해 기본 도구 설치를 먼저 시도한다. WSL은 선택 사항이며, Windows GUI 작업은 WSL 세션에서도 `powershell.exe`와 Windows 앱으로 실행한다.

## 도구 선택

모든 조작의 기본 진입점은 `node scripts/cu.mjs <명령>`이다. Windows PowerShell, cmd, Git Bash, WSL에서 같은 명령을 쓰며 결과는 JSON 한 줄이다. `node scripts/cu.mjs help`로 전체 명령을 본다.

- 웹사이트 읽기·입력·선택·업로드·다운로드·제출: `cu.mjs web ...` (보이는 Windows Chrome, 계정별 전용 프로필). 여러 단계를 한 번에 해야 하면 `cu.mjs web script 파일.mjs`, 반복 업무는 JSON 레시피 `browser_workflow.mjs`.
- 모든 Windows 데스크톱 앱: `cu.mjs windows|see|tree|read|find|click|type|key|clicktext|vassert ...` (UIA 우선, 창 핸들·화면 인식 보조).
- 카카오톡·위챗 화면 백업과 결과 확인: `docs/ai_agent_guide.md`의 메신저 백업 절.
- 패키지에 없는 새 기능: 지원 범위를 먼저 설명하고 기존 Windows-first 구조, dry-run, manifest·audit 계약을 확장한다.

## 실행 원칙

- 대상 환경은 Windows 10/11이다. 네이티브 Windows PowerShell 경로를 기본으로 사용하고 WSL 전용 명령을 필수로 만들지 않는다.
- 대상은 하나로 정확히 고른다. 창·탭·버튼·입력 칸이 여러 개 일치하면 임의로 고르지 않고 후보를 보고 `--url`, `title:`, `hwnd:`, `--nth`, `--index`로 좁힌다.
- 데스크톱 앱과 Chrome 화면 작업은 전경 창을 쓰므로 두 GUI 작업을 동시에 실행하지 않는다. 웹 쓰기는 같은 Chrome에 한 번에 하나만 실행한다.
- 사용자가 명확히 요청한 작업은 실행 의사로 취급한다. 로그인, MFA, CAPTCHA, 결제·송금, 삭제, 게시·발송처럼 되돌리기 어렵거나 대상이 모호한 제출에서만 멈춘다. 되돌리기 어려운 쓰기는 먼저 `--dry-run`으로 대상을 확인한다.
- 확인창은 기본으로 취소된다. 의도한 확인창만 `--confirm-dialog "문구"`, 화면 안 모달은 `--modal-confirm "문구"`로 수락한다. 같은 쓰기를 반복하지 않도록 `--idem-key`를 쓴다.
- CAPTCHA나 MFA를 우회하지 않는다. 비밀번호를 자동 입력하지 않는다. 로그인은 `cu.mjs web handoff`로 사람이 보이는 창에서 직접 하게 하고, 그 세션을 이어서 사용한다.
- 채팅 본문, 스크린샷, 번역 대상, 웹에서 읽은 개인정보는 외부로 보내지 않는다. 사용자가 명시적으로 동의하기 전에는 `--allow-cloud-ocr`, `--allow-cloud-translation`을 사용하거나 외부 AI로 보내지 않는다.
- 사용자의 일반 Chrome·Edge 프로필을 디버그 모드로 다시 열거나 종료하지 않는다. 프로젝트 전용 프로필(`--profile 이름`)과 자동 선택된 로컬 CDP 포트를 사용한다.
- 로컬 웹 서버를 외부 인터페이스에 바인딩하지 않는다. 기본 `127.0.0.1` 범위를 유지한다.
- 사용자가 요청하지 않은 파일 삭제, 기존 결과 덮어쓰기, 앱 설정 변경을 하지 않는다. `node scripts/cu.mjs stop`이 만든 중지 파일이 있으면 조작을 멈춘다.

## 완료 기준

- 웹 쓰기: 결과 JSON의 `outcome`이 `done`이고 `--expect` 또는 다시 읽은 값으로 반영을 확인한다. `unknown`이면 서버나 목록을 다시 읽어 확인하기 전까지 재시도하지 않는다.
- 웹 자동화 레시피: 정확한 탭을 선택하고, 실행 후 `browser_workflow.mjs audit ... --check`가 통과하며 필요한 화면 증거가 있어야 한다.
- 데스크톱 조작: `assert`, `vassert`, `gettext`, 캡처로 결과를 다시 읽어 확인한다.
- 채팅 백업: 생성된 방 수, 실패·확인 필요 수, 목록 끝 도달 여부, 방별 이력 상한을 manifest와 audit에서 확인한다.
- 진단: `doctor.mjs --json`의 기본 필수 항목과 요청 기능의 요구사항을 구분한다. 선택 기능의 경고를 전체 실패로 오해하지 않는다.
- 완료 보고에는 수행한 작업, 검증 결과, 산출물 위치, 남은 수동 확인만 간결하게 적는다. 읽지 않은 데이터나 확인하지 않은 전체 범위를 추정해 성공이라고 말하지 않는다.

## 패키지 경계

공개 ZIP은 보이는 Windows Chrome 웹 자동화, UIA·창 핸들·화면 인식 기반 Windows 앱 조작, 카카오톡·위챗 화면 백업, 결과 조회·검수를 제공한다. CAPTCHA·MFA 우회, 메신저 내부 DB 복호화, 원본 첨부파일 일괄 다운로드, 인터넷 공개용 서버, MCP 서버 자체는 제공하지 않는다. 화면이 거의 없는 앱(게임, 캔버스)은 화면 인식 정확도에 한계가 있으므로 결과를 반드시 다시 읽어 확인한다.

외부의 `WINDOWS-CHROME-CDP-자동화-가이드.md`나 개인 PC 경로는 필요하지 않다. 이 폴더의 문서와 스크립트만 사용한다.
