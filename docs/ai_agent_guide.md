# AI 세션용 Computer-Use 운영 안내

이 문서는 공개 ZIP을 압축 해제한 폴더에서 Codex CLI, Claude Code, Gemini CLI가 사용자의 자연어 목표를 실제 Windows 작업으로 연결할 때 사용하는 기준 문서다. 루트 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`가 이 문서를 가리킨다.

## 목차

- [처음 1분 점검](#처음-1분-점검)
- [요청 분류](#요청-분류)
- [카카오톡과 위챗 백업](#카카오톡과-위챗-백업)
- [결과 확인과 진단](#결과-확인과-진단)
- [Windows Chrome 자동화](#windows-chrome-자동화)
- [Windows와 WSL 분기](#windows와-wsl-분기)
- [안전과 사용자 확인](#안전과-사용자-확인)
- [완료 판정](#완료-판정)
- [지원 범위 밖의 요청](#지원-범위-밖의-요청)

## 처음 1분 점검

AI 세션은 반드시 압축을 푼 프로젝트 루트에서 시작한다. ZIP 내부에서 직접 실행하거나 `scripts` 폴더만 따로 복사하면 안 된다.

```powershell
node .\scripts\ai_project_check.mjs --json
node .\scripts\doctor.mjs --json
```

첫 명령은 AI 지침 파일, 필수 스크립트, 실행 플랫폼과 기능 목록을 확인한다. `package.status`가 `pass`여야 한다. `runtime.windowsReachable`이 `false`면 현재 세션이 Windows 앱에 닿지 않는 Linux 환경일 수 있으므로 실제 GUI 작업을 시작하지 않는다.

두 번째 명령은 Windows 문자 인식, 카카오톡·위챗 실행 상태, 저장 폴더를 확인한다. 사용자가 한 앱만 요청했다면 다른 앱의 미설치·미로그인 상태는 전체 실패가 아니다.

Node.js가 없으면 Windows에서 다음 파일을 실행한다. 기본 실행 도구 설치, 폴더 준비, 로컬 백업 화면 시작을 함께 처리한다.

```powershell
.\1_백업_시작.bat
```

## 요청 분류

| 사용자 목표 | 기본 진입점 | 검증 |
|---|---|---|
| 현재 열린 위챗 방 백업 | `wechat_windows_backup.mjs` | `wechat_scrape_manifest.json`, `wechat_audit.json` |
| 위챗 왼쪽 목록 전체 백업 | `wechat_windows_batch.mjs` | 배치 manifest의 목록 완료·실패 방 |
| 현재 열린 카카오톡 방 백업 | `kakao_regular_chat.mjs chat-batch` | 방 manifest와 audit |
| 카카오톡 왼쪽 목록 전체 백업 | `kakao_windows_batch.mjs` | 일반 목록·보관함 완료와 실패 방 |
| 카카오톡 오픈채팅과 댓글 백업 | `kakao_openchat_windows_backup.mjs` | `kakao_openchat_manifest.json`, `audit.json` |
| 백업 결과 확인 | `1_백업_시작.bat`의 `결과 보기` | 방 수, 상태, 확인 필요 항목 |
| 웹사이트 읽기·입력·업로드 | `browser_workflow.mjs` | workflow audit와 최종 PNG |
| 설치·환경 문제 확인 | `doctor.mjs --json` | 요청 기능의 필수 항목 |

사용자가 여러 작업 B/C/D를 한 번에 요청하면 읽기·준비 확인부터 시작하고, GUI를 쓰는 작업은 한 번에 하나씩 순서대로 실행한다. 각 단계의 산출물을 확인한 후 다음 단계로 넘어간다.

## 카카오톡과 위챗 백업

### 실행 전 공통 조건

- Windows 앱이 설치되어 있고 로그인되어 있어야 한다.
- 앱 창이 최소화되지 않아야 한다.
- 현재 방 백업은 사용자가 원하는 방을 앞에 둔 상태여야 한다.
- 전체 백업은 왼쪽 채팅 목록이 보이는 메인 창에서 시작한다.
- 사용자가 백업을 명확히 요청한 경우에만 `--confirm-local-backup`을 사용한다.

### 현재 열린 위챗 방

```powershell
node .\scripts\wechat_windows_backup.mjs --confirm-local-backup --max-frames 120
```

방 이름이나 1:1 상대를 확실히 아는 경우에만 `--room-label "방 이름"`, `--incoming-speaker "상대 이름"`을 추가한다. 추정한 이름을 넣지 않는다.

### 위챗 전체 목록

먼저 방을 클릭하지 않는 목록 확인을 실행한다.

```powershell
node .\scripts\wechat_windows_batch.mjs --confirm-local-backup --all-visible --pages 500 --room-limit 2000 --max-frames 800 --room-retries 1 --direct-chat-auto --dry-run
```

후보가 사용자의 의도와 맞고 실제 전체 백업 요청이 확인된 경우 `--dry-run`만 빼고 실행한다.

```powershell
node .\scripts\wechat_windows_batch.mjs --confirm-local-backup --all-visible --pages 500 --room-limit 2000 --max-frames 800 --room-retries 1 --direct-chat-auto
```

### 현재 열린 카카오톡 방

```powershell
node .\scripts\kakao_regular_chat.mjs chat-batch --confirm-local-backup --active-only --max-frames 40 --to-bottom
```

목록에서 이름으로 방을 열어야 할 때만 `--open-visible "정확한 방 이름 또는 식별 가능한 정규식"`을 추가한다. 여러 방과 일치하면 실행하지 말고 대상을 좁힌다.

### 카카오톡 전체 목록

```powershell
node .\scripts\kakao_windows_batch.mjs --confirm-local-backup --all-visible --pages 500 --room-limit 2000 --max-frames 500 --room-retries 1 --to-bottom --dry-run
```

후보 확인 후 `--dry-run`을 빼고 실행한다. `조용한 채팅방` 보관함도 기본적으로 순회한다.

### 카카오톡 오픈채팅과 댓글

```powershell
node .\scripts\kakao_openchat_windows_backup.mjs --confirm-local-backup --title "정확한 방 제목" --to-bottom --max-frames 80 --thread-max-frames 20
```

제목이 모호하거나 같은 제목의 창이 여러 개면 창을 임의로 고르지 않는다.

## 결과 확인과 진단

가장 안정적인 통합 결과 화면은 다음 파일로 연다.

```powershell
.\1_백업_시작.bat
```

같은 웹 화면의 `결과 보기`에서 카카오톡과 위챗 결과를 확인한다. 서버만 시작해야 하는 AI 세션은 다음 명령을 사용할 수 있다.

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\start_console.ps1
```

진단과 보고서:

```powershell
node .\scripts\doctor.mjs --json
.\4_준비_보고서.bat
.\4_검증_보고서.bat
```

보고서에는 채팅 본문을 넣지 않는다. 원본 산출물을 사용자에게 보여줄 때도 방 이름과 메시지 내용을 터미널에 대량 출력하지 않는다.

## Windows Chrome 자동화

단발 명령보다 JSON recipe와 `browser_workflow.mjs`를 우선한다. 이 방식은 로그인 확인, 읽기 전용 수집, 쓰기 작업, 사후 검증을 분리하고 실행 기록을 남긴다.

```powershell
node .\scripts\browser_workflow.mjs doctor
node .\scripts\browser_workflow.mjs pages
node .\scripts\browser_workflow.mjs login-check --recipe .\recipe.json --out .\runs\web-task
node .\scripts\browser_workflow.mjs scrape --recipe .\recipe.json --out .\runs\web-task
node .\scripts\browser_workflow.mjs run --recipe .\recipe.json --out .\runs\web-task --confirm-browser-write
node .\scripts\browser_workflow.mjs audit .\runs\web-task --check
```

- 읽기 요청은 `login-check` 또는 `scrape`까지만 사용한다.
- 입력, 체크, 업로드, 제출은 사용자가 그 변경을 요청한 경우에만 `run --confirm-browser-write`를 사용한다.
- `pages` 결과에서 URL과 제목이 정확히 하나로 식별되는 탭을 선택한다.
- 로그인·MFA·CAPTCHA가 나오면 사용자가 전용 Chrome 창에서 직접 완료할 때까지 기다린 뒤 같은 세션을 이어 쓴다.
- 일반 Chrome을 종료하거나 사용자 프로필을 자동화용으로 재실행하지 않는다.

recipe 스키마, 정확한 탭 선택, 폼별 입력, 파일 업로드, 제출 전 검사, reCAPTCHA 처리 방법은 `docs/browser_workflow_playbook.md`를 따른다.

## Windows와 WSL 분기

### Windows PowerShell 또는 AI CLI의 Windows 셸

위 예시의 `node .\scripts\...`와 PowerShell 명령을 그대로 사용한다. WSL 설치를 요구하지 않는다.

### WSL에서 시작한 AI 세션

프로젝트가 `/mnt/c/...` 아래에 있으면 Node 기반 워크플로는 현재 폴더에서 실행할 수 있다. Windows GUI 진입 파일은 `powershell.exe`로 호출한다.

```bash
node scripts/ai_project_check.mjs --json
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "$(wslpath -w "$PWD/scripts/start_console.ps1")"
node scripts/browser_workflow.mjs doctor
```

WSL의 Linux 전용 브라우저나 headless Chromium으로 대체하지 않는다. 카카오톡·위챗·보이는 Chrome은 Windows 데스크톱 세션에서 실행되어야 한다.

### Windows에 닿지 않는 Linux·macOS 세션

문서와 코드는 검토할 수 있지만 실제 Windows GUI 작업은 완료할 수 없다. `ai_project_check.mjs`의 `runtime.windowsReachable=false`를 보고하고 Windows PC의 프로젝트 루트에서 세션을 다시 시작하도록 안내한다.

## 안전과 사용자 확인

다음은 사용자에게 추가 확인하지 않고 진행할 수 있다.

- 파일 존재 확인, `doctor`, `pages`, 읽기 전용 audit
- 사용자가 명확히 요청한 현재 방 백업
- 사용자가 명확히 요청했고 dry-run 후보가 일치하는 전체 백업
- 사용자가 명확히 요청한 웹 입력·제출 중 되돌릴 수 있고 결제·삭제가 아닌 단계

다음 지점에서는 멈추고 짧고 구체적으로 사용자 입력을 요청한다.

- 앱 로그인, QR 로그인, MFA, CAPTCHA
- 결제, 계정 삭제, 게시물 공개, 대량 발송처럼 영향이 큰 최종 제출
- 같은 이름의 창·탭·방이 여러 개라 대상을 하나로 고를 수 없음
- 전체 백업 dry-run 후보가 요청 범위와 다름
- 클라우드 OCR·번역처럼 채팅이나 화면을 외부 서비스로 보내야 함

사용자가 개인정보 외부 전송에 명시적으로 동의하기 전에는 클라우드 OCR·번역을 실행하지 않는다.

CAPTCHA나 접근 제어를 우회하는 코드를 추가하지 않는다. 로컬 서버의 host를 `0.0.0.0`으로 바꾸거나 인터넷에 직접 공개하지 않는다.

## 완료 판정

### 채팅 백업

명령 종료 코드뿐 아니라 생성 폴더의 manifest와 audit를 읽는다. 전체 백업은 다음을 구분해서 보고한다.

- 목록 끝 도달 여부
- 발견한 후보 수와 실제 저장한 방 수
- 실패 후 재시도해도 남은 방 수
- 페이지·방 개수 상한 도달 여부
- 방별 과거 이력 상한 또는 맨 위·맨 아래 확인 실패
- 글자·발신자·첨부파일 확인 필요 수

목록 상한에 걸렸거나 실패 방이 남으면 `전체 완료`라고 말하지 않는다. 저장된 범위와 남은 범위를 각각 적는다.

### 웹 자동화

`audit --check`가 통과하고 최종 화면 PNG가 생성되어야 한다. 제출 결과 페이지의 식별 가능한 텍스트나 상태를 읽어 요청이 반영됐는지 확인한다. 버튼을 클릭했다는 사실만으로 성공 처리하지 않는다.

### 최종 보고 형식

1. 실제 수행한 작업
2. PASS, 확인 필요, 실패 중 하나인 검증 결과
3. 산출물 폴더 또는 보고서 파일
4. 사용자가 직접 해야 하는 단계가 남았다면 그 한 가지

## 지원 범위 밖의 요청

공개 ZIP은 다음 기능을 완성품으로 제공한다.

- Windows 카카오톡·위챗의 보이는 화면 백업
- 백업 결과 조회와 개인정보를 가린 진단
- 전용 Windows Chrome을 통한 웹 읽기·입력·업로드·제출

다음은 현재 완성품이 아니다.

- 모든 종류의 Windows 데스크톱 앱을 자연어만으로 제어하는 범용 런타임
- 메신저 내부 DB 복호화와 원본 첨부파일 전체 다운로드
- CAPTCHA·MFA 우회
- 인터넷 공개용 서비스나 완성된 MCP 서버
- 공개 ZIP에 없는 내부 개발 모듈

사용자가 새 B/C/D 기능 구현까지 요청하면 기존 `scripts/lib/job_runner.mjs`의 allowlist, Windows-first 실행, preview 또는 dry-run, 명시적 위험 확인, manifest·audit 계약을 따른다. 공개 ZIP에 포함될 파일과 문서를 exporter 및 배포 검사에 추가하고, Windows에서 실제 실행하기 전에는 완성이라고 말하지 않는다.

## 사용자 요청 예시

AI CLI를 이 폴더에서 연 뒤 다음처럼 자연어로 말하면 된다.

```text
이 프로젝트를 사용해서 지금 열어 둔 위챗 방을 백업하고 결과가 정상인지 확인해 줘.
```

```text
이 프로젝트로 카카오톡 왼쪽 목록의 모든 방을 먼저 미리 확인하고, 누락 위험을 알려 준 뒤 전체 백업해 줘.
```

```text
이 프로젝트의 Windows Chrome 자동화로 로그인된 사이트에서 주문 목록을 읽어 CSV로 정리해 줘. 제출이나 변경은 하지 마.
```

```text
이 프로젝트로 B, C, D 작업을 순서대로 처리하고 각 단계의 산출물과 검증 결과를 알려 줘.
```
