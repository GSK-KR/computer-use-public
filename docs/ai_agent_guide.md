# AI 세션용 Computer-Use 운영 안내

이 폴더는 AI가 사용자의 Windows PC를 직접 보고 조작해 일을 끝까지 처리하는 자율 에이전트 도구다. Claude Code, Codex CLI, Gemini CLI를 이 폴더에서 열면 AI가 이 폴더의 도구로 웹사이트와 Windows 앱을 조작하고, 결과를 증거로 확인한 뒤 보고한다. 대상 환경은 Windows 10/11이다.

이 문서는 사용자의 자연어 목표를 실제 Windows 작업으로 연결할 때 쓰는 기준 문서다. 루트 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`가 이 문서를 가리킨다. 전체를 읽지 말고 요청과 관련된 절만 읽는다.

기본 제공 기능은 다음 네 가지다.

- 웹 자동화: 보이는 Windows Chrome에서 웹사이트 읽기·입력·선택·업로드·다운로드·제출
- Windows 앱 조작: 모든 Windows 앱의 창 찾기·캡처·UIA 조작·글자 인식 클릭·키 입력
- 메신저 백업 팩: 카카오톡·위챗 대화의 보이는 화면 백업
- 결과 조회·검수: 백업 결과 화면, 준비·검증 보고서, 환경 진단

## 목차

- [기본 작업 루프](#기본-작업-루프)
- [처음 1분 점검](#처음-1분-점검)
- [요청 분류](#요청-분류)
- [통합 명령](#통합-명령)
- [Windows Chrome 웹 자동화](#windows-chrome-웹-자동화)
- [Windows 앱 조작](#windows-앱-조작)
- [메신저 백업 팩](#메신저-백업-팩)
- [결과 확인과 진단](#결과-확인과-진단)
- [Windows와 WSL 분기](#windows와-wsl-분기)
- [안전과 사용자 확인](#안전과-사용자-확인)
- [완료 판정](#완료-판정)
- [지원 범위 밖의 요청](#지원-범위-밖의-요청)
- [사용자 요청 예시](#사용자-요청-예시)

## 기본 작업 루프

모든 작업은 관찰 → 조작 → 검증을 목표에 도달할 때까지 반복한다.

1. 관찰: 지금 화면 상태와 대상을 먼저 읽는다. 웹은 `web pages`, `web read`, `web inspect`, Windows 앱은 `windows`, `see`, `tree`를 쓴다.
2. 조작: 대상을 하나로 특정한 뒤 한 번에 한 동작만 실행한다. 되돌리기 어려운 쓰기는 `--dry-run`으로 대상을 먼저 확인한다.
3. 검증: 동작 직후 결과를 다시 읽는다. 웹은 결과의 `outcome`과 `--expect` 또는 다시 읽기로, Windows 앱은 `assert`, `vassert`, `gettext`, 캡처로 확인한다.
4. 다음 동작 결정: 기대와 다르면 같은 동작을 되풀이하지 말고 다시 관찰해 원인을 찾는다.

명령이 시작됐거나 창이 열렸거나 버튼을 눌렀다는 사실만으로 완료라고 하지 않는다. 사용자가 요청한 범위 안에서는 끝까지 진행하고, [안전과 사용자 확인](#안전과-사용자-확인)에 적힌 지점에서만 멈춘다.

웹 Chrome 작업, Windows 앱 작업, 메신저 백업은 모두 전경 창을 쓰므로 두 GUI 작업을 동시에 실행하지 않는다. 사용자가 여러 작업 B/C/D를 한 번에 요청하면 읽기·준비 확인부터 시작하고, GUI 작업은 하나씩 순서대로 실행한다. 각 단계의 산출물을 확인한 후 다음 단계로 넘어간다.

## 처음 1분 점검

AI 세션은 반드시 압축을 푼 프로젝트 루트에서 시작한다. ZIP 내부에서 직접 실행하거나 `scripts` 폴더만 따로 복사하면 안 된다.

```powershell
node .\scripts\ai_project_check.mjs --json
node .\scripts\doctor.mjs --json
node .\scripts\cu.mjs help
```

첫 명령은 AI 지침 파일, 필수 스크립트, 실행 플랫폼과 기능 목록을 확인한다. `package.status`가 `pass`여야 한다. `runtime.windowsReachable`이 `false`면 현재 세션이 Windows 앱에 닿지 않는 Linux 환경일 수 있으므로 실제 GUI 작업을 시작하지 않는다.

두 번째 명령은 Windows 문자 인식, 카카오톡·위챗 실행 상태, 저장 폴더를 확인한다. 요청 기능과 관계없는 앱의 미설치·미로그인 경고는 전체 실패가 아니다. 웹 작업만 요청했다면 메신저 미로그인은 작업을 막지 않고, 한 메신저만 요청했다면 다른 메신저의 상태는 무시한다.

세 번째 명령은 웹과 Windows 앱 명령 전체 목록을 보여 준다. `node .\scripts\cu.mjs check`와 `node .\scripts\cu.mjs doctor`는 앞의 두 점검을 같은 진입점에서 실행한다.

Node.js가 없으면 Windows에서 다음 파일을 실행한다. 기본 실행 도구 설치, 폴더 준비, 로컬 백업 화면 시작을 함께 처리한다.

```powershell
.\1_백업_시작.bat
```

## 요청 분류

| 분류 | 사용자 목표 | 기본 진입점 | 검증 |
|---|---|---|---|
| 웹 | 웹사이트 읽기·검색·표 수집 | `cu.mjs web read`, `web table`, `web collect` | 다시 읽은 글자, 저장한 CSV |
| 웹 | 입력·선택·업로드·다운로드·제출 | `cu.mjs web type`, `select`, `upload`, `download`, `click`, 여러 단계는 `web script` | `outcome: done`, `--expect`, 증거 PNG |
| 웹 | 로그인·MFA·CAPTCHA가 필요한 사이트 | `cu.mjs web session`, `web handoff` | `LOGGED_IN` 상태 |
| 웹 | 반복하는 웹 업무 | `browser_workflow.mjs` 레시피 | workflow audit와 최종 PNG |
| Windows 앱 | 앱 화면 읽기 | `cu.mjs windows`, `see`, `tree`, `read`, `ocr` | 캡처 PNG, UIA 트리 |
| Windows 앱 | 클릭·입력·키·스크롤 | `cu.mjs front`, `click`, `clicktext`, `settext`, `type`, `key`, `scroll` | `assert`, `vassert`, `gettext` |
| Windows 앱 | 앱 창 정기 캡처 | `cu.mjs snapshot` | 날짜 폴더의 PNG와 `MISSING_` 파일 |
| 메신저 백업 팩 | 현재 열린 위챗 방 백업 | `wechat_windows_backup.mjs` | `wechat_scrape_manifest.json`, `wechat_audit.json` |
| 메신저 백업 팩 | 위챗 왼쪽 목록 전체 백업 | `wechat_windows_batch.mjs` | 배치 manifest의 목록 완료·실패 방 |
| 메신저 백업 팩 | 현재 열린 카카오톡 방 백업 | `kakao_regular_chat.mjs chat-batch` | 방 manifest와 audit |
| 메신저 백업 팩 | 카카오톡 왼쪽 목록 전체 백업 | `kakao_windows_batch.mjs` | 일반 목록·보관함 완료와 실패 방 |
| 메신저 백업 팩 | 카카오톡 오픈채팅과 댓글 백업 | `kakao_openchat_windows_backup.mjs` | `kakao_openchat_manifest.json`, `audit.json` |
| 결과 조회·검수 | 백업 결과 확인 | `1_백업_시작.bat`의 `결과 보기` | 방 수, 상태, 확인 필요 항목 |
| 결과 조회·검수 | 준비·검증 보고서 | `4_준비_보고서.bat`, `4_검증_보고서.bat` | 생성된 보고서 파일 |
| 진단 | 설치·환경 문제 확인 | `cu.mjs check`, `doctor.mjs --json` | 요청 기능의 필수 항목 |
| 새 기능 요청 | 패키지에 없는 B/C/D 작업 | [지원 범위 밖의 요청](#지원-범위-밖의-요청) | 기존 명령으로 가능한 부분과 새 구현 분리 |

Chrome 안의 화면은 `cu.mjs web`으로, Chrome 밖의 Windows 앱은 데스크톱 명령으로 다룬다. 카카오톡·위챗 백업은 범용 데스크톱 명령으로 새로 만들지 말고 메신저 백업 팩 스크립트를 쓴다.

## 통합 명령

웹과 Windows 앱 조작의 진입점은 `node scripts/cu.mjs <명령>` 하나다.

- Windows PowerShell, cmd, Git Bash, WSL에서 같은 명령을 쓴다. PowerShell 예시는 `node .\scripts\cu.mjs`로 적는다.
- 결과는 JSON 한 줄이다. `ok`가 `false`이거나 종료 코드가 0이 아니면 실패로 다룬다.
- 대상 창·탭·글자가 여러 개 일치하면 임의로 고르지 않고 실패하며, 가능한 경우 `candidates`에 후보를 담는다. 후보를 보고 대상을 좁히거나 `--index N`, `--nth N`으로 고른다.
- `node .\scripts\cu.mjs stop`은 `state\STOP` 파일을 만들어 이후 조작 명령을 거부하게 한다. `resume`으로 해제하고 `status`로 중지 여부와 마지막 상태를 본다. 사용자가 멈추라고 하면 먼저 `stop`을 실행한다.

## Windows Chrome 웹 자동화

웹 작업은 사용자가 볼 수 있는 Windows Chrome에서 실행한다. 프로젝트 전용 Chrome 프로필과 자동 선택된 로컬 CDP 포트를 쓰며, 사용자의 일반 Chrome을 종료하거나 일반 프로필을 디버그 모드로 다시 열지 않는다. 선택자 작성, 폼별 입력, 파일 업로드, 제출 전 검사, 레시피 스키마, reCAPTCHA 처리 방법은 `docs/browser_workflow_playbook.md`를 따른다.

### 프로필과 탭 고르기

```powershell
node .\scripts\cu.mjs web profiles
node .\scripts\cu.mjs web pages --profile 이름
node .\scripts\cu.mjs web read --profile 이름 --url 주소일부
```

- 계정마다 전용 프로필을 쓴다. 새 프로필은 `web profile add 이름`으로 만들고, 그 계정의 모든 웹 명령에 `--profile 이름`을 붙인다.
- 탭은 `--url 주소일부`로 지정한다. 여러 탭이 일치하면 도구가 고르지 않으므로 더 구체적인 주소 일부로 좁힌다.
- 새 주소는 `web goto URL`로 열고, 새 탭이 필요하면 `--new-tab`을 붙인다.

### 관찰

- `web read`: 화면 글자를 읽는다. `--selector`로 영역을, `--frame`으로 iframe을 고른다.
- `web inspect`: 입력 칸·버튼·링크처럼 조작할 수 있는 요소를 나열한다. `--aria`를 붙이면 접근성 이름 기준으로 본다.
- `web find 글자`: 글자가 있는 요소를 찾되 클릭하지 않는다.
- `web frames`, `web modals`: iframe과 열린 모달을 확인한다.
- `web table`, `web collect`: 표와 반복 항목을 구조화해 모은다. `web table --out 파일.csv`로 CSV를 저장한다.
- `web net 주소일부`: 화면 동작 중 오가는 네트워크 응답을 본다.
- `web shot [파일]`, `web capture URL --widths 390,1280`: 화면 증거를 남긴다.

### 조작

- 이동: `web goto URL`, `web reload`, `web scroll down|up|bottom|top`
- 클릭: `web click 선택자`, `web clicktext 글자`. 같은 글자가 여러 곳이면 `--nth N`이나 `--within 선택자`로 좁힌다.
- 입력: `web type 선택자 값`, `web setvalue`, `web keys`. 선택자 대신 화면 라벨로 칸을 지정하려면 `web type 값 --label 화면라벨`을 쓴다. 이미 내용이 있는 칸을 덮어쓰지 않으려면 `--require-empty`, 화면의 글자 수 표시로 반영을 확인하려면 `--counter 선택자`, 금액·수량처럼 쉼표나 단위가 붙는 칸은 `--numeric`을 붙인다.
- 선택: `web select 선택자 값`, `web pick 선택자 항목`, `web check`, `web uncheck`
- 파일: `web upload 선택자 파일`, 파일 선택 버튼만 있으면 `web upload --chooser-text 글자 파일`, 다운로드는 `web download --click 선택자 --out 파일`
- 키와 마우스: `web press 키`, `web hover 선택자`
- 기다림: `web waittext 글자 [--gone]`, `web waitsel 선택자`, `web waiturl 주소일부`
- 확인: `web assert 글자`, 제출 전 폼 입력 검사는 `web validate 제출선택자`
- 여러 단계: `web script 파일.mjs`. 스니펫은 `export default async ({ page, helpers, args }) => 결과` 형태다. 읽기만 하는 스니펫은 `export const mode = 'read'`를 선언하고, 화면이나 데이터를 바꾸는 스니펫은 사용자가 요청한 변경일 때만 `--write`를 붙인다.

### 쓰기 안전장치

클릭, 입력, 선택, 체크, 업로드, 다운로드, 키 입력, 스크립트 같은 모든 웹 쓰기 명령에 다음이 적용된다.

- `--dry-run`: 대상을 찾고 다른 요소에 가려졌는지, 여러 개와 일치하는지 확인하되 실제로 누르거나 입력하지 않는다. 처음 다루는 화면의 제출 버튼은 먼저 dry-run으로 확인한다.
- 브라우저 확인창(alert·confirm)은 기본으로 취소하고 결과에 기록한다. 의도한 확인창만 `--confirm-dialog "문구"`로 문구가 일치할 때 수락한다.
- 페이지 안의 모달은 `--modal-confirm "문구"`로 문구가 일치하는 모달만 확인하고, 버튼 이름이 다르면 `--modal-button 확인`처럼 지정한다.
- 결과 JSON의 `outcome`은 `done`, `not_done`, `unknown` 중 하나다. `observed`에는 주소 변경, 새 모달, 토스트, 경고, 오류가, `writeRequests`에는 동작 중 발생한 쓰기 요청이 기록된다.
- `--expect 글자`, `--expect-gone 글자`, `--expect-url 주소`로 동작 직후의 기대 상태를 함께 검사한다. 기대가 맞지 않으면 `outcome`은 `done`이 되지 않는다.
- 같은 제출이 두 번 실행되지 않도록 `--idem-key 키`를 붙인다. 같은 키의 이전 실행이 `done`이나 `unknown`이면 거부되며, 결과를 확인한 뒤 정말 다시 해야 할 때만 `--repeat`를 붙인다.
- 같은 Chrome 포트에는 쓰기 작업이 한 번에 하나만 실행된다. `state\STOP` 파일이 있으면 조작 명령을 거부한다.
- 비밀번호 칸 입력은 기본으로 거부된다. 로그인은 `web handoff`로 사람이 직접 하게 하고, 사용자가 명시적으로 지시하지 않는 한 `--allow-secret`을 쓰지 않는다.
- 쓰기와 이동 동작마다 `shots` 폴더의 `web\evidence` 아래 고유 증거 PNG와 `web_last.png`를 남기고, 실행 기록은 `state` 폴더의 `web_audit.jsonl`에 쌓인다. 정확한 경로는 결과 JSON에 나온다.

### 로그인과 사람에게 넘기기

```powershell
node .\scripts\cu.mjs web session "계정 표시 글자" --profile 이름 --url 주소일부
node .\scripts\cu.mjs web handoff "로그인과 인증을 완료해 주세요" --identity "계정 표시 글자" --profile 이름 --url 주소일부
```

- `web session`은 `LOGGED_IN`, `LOGIN_WALL`, `WRONG_ACCOUNT`, `NO_LOGIN_WALL` 중 하나를 돌려준다. 계정 표시 글자를 주지 않으면 로그인됐다고 단정하지 않고, 로그인 화면이 보이지 않는다는 사실만 `NO_LOGIN_WALL`로 알린다.
- `LOGIN_WALL`이나 `WRONG_ACCOUNT`이면 `web handoff`로 사람에게 넘긴다. 사람이 보이는 Chrome 창에서 로그인·MFA·CAPTCHA를 직접 끝내는 동안 도구가 기다리고, 끝나면 같은 세션을 이어 쓴다. 완료 조건은 `--identity`, `--until-url`, `--timeout`으로 정한다.
- CAPTCHA나 MFA를 자동으로 풀거나 우회하지 않는다.

### 레시피 워크플로

반복하는 웹 업무나 단계가 많은 작업은 JSON recipe와 `browser_workflow.mjs`로 만든다. 이 방식은 로그인 확인, 읽기 전용 수집, 쓰기 작업, 사후 검증을 분리하고 실행 기록을 남긴다. `node .\scripts\cu.mjs browser ...`도 같은 도구를 실행한다.

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

## Windows 앱 조작

Chrome이 아닌 Windows 앱(메모장, 탐색기, 설정, 사내 업무 프로그램 등)은 `cu.mjs`의 데스크톱 명령으로 다룬다. UIA(접근성 정보)를 먼저 쓰고, UIA로 닿지 않을 때만 화면 글자 인식(OCR)을 쓴다.

### 대상 지정

모든 데스크톱 명령의 첫 인자는 대상 창이다.

| 형식 | 의미 |
|---|---|
| `title:제목` | 창 제목. 정확히 같은 제목을 먼저 찾고, 없으면 정규식으로 찾는다 |
| `proc:이름` | 프로세스 이름 정규식. 접두어 없이 쓰면 프로세스 이름으로 본다 |
| `pid:번호` | 프로세스 번호 |
| `hwnd:번호` | 창 핸들. 가장 정확하다 |

```powershell
node .\scripts\cu.mjs windows --title "제목 일부"
node .\scripts\cu.mjs see hwnd:번호
node .\scripts\cu.mjs tree hwnd:번호
```

먼저 `windows`로 후보를 본다. 여러 창이 일치하면 도구가 임의로 고르지 않고 `candidates`로 후보를 돌려준다. 그 경우 `hwnd:번호`로 지정하거나 `--index N`을 쓴다.

### 관찰

- `see 대상 [파일.png]`: 포커스를 옮기지 않고 창을 캡처한다(PrintWindow). 최소화된 창은 빈 조각만 나오므로 거부하며, 필요하면 `--restore`로 잠시 복원해 캡처한다. 창이 너무 작거나 거의 한 가지 색이면 경고와 함께 실패로 돌려준다.
- 하드웨어 가속(GPU) 창이 검게 나오면 `see 대상 --screen`으로 창을 앞으로 가져와 화면 영역을 캡처한다.
- `screen [파일.png]`은 전체 화면을, `ocr 이미지 [--match 글자]`는 이미지 속 글자를 읽는다.
- `tree 대상`, `read 대상`은 UIA 요소 트리와 글자를 읽는다. `find 대상 정규식 [--by name|autoid|type]`으로 요소를 찾는다.
- 이미지를 볼 수 있는 AI는 캡처 PNG를 직접 열어 화면을 확인한다.

### 앞으로 가져오기

- `front 대상`은 창을 앞으로 가져온 뒤 실제로 전경 창이 됐는지 확인한다. 실패하면 우회하지 않고 `FG_FAILED`를 돌려준다. 사람이 PC를 쓰는 중일 수 있으므로 이때 키 입력을 보내지 않는다.
- `FG_FAILED`가 반복되고 사람이 PC를 쓰지 않는 것이 확인된 경우에만 `--force`로 다시 시도한다. `--force`는 맨 위 고정 전환을 더해 앞으로 가져온다.
- `fg`는 현재 앞에 있는 창을 알려 주고, `show 대상 restore|minimize|maximize`는 창 상태를 바꾼다.

### 조작

1. `click 대상 정규식`: UIA 요소를 직접 실행하고, 실행할 수 없으면 UIA 좌표로 마우스를 클릭하고, UIA에 없으면 화면 글자 인식으로 찾아 클릭한다. 결과의 `method`(`uia`, `uia-rect-mouse`, `ocr`)로 어떤 방식이 쓰였는지 확인한다.
2. `invoke|toggle|focus 대상 정규식`, `settext 대상 정규식 글자`: UIA 패턴만 쓰는 조작이다. 마우스를 움직이지 않는다.
3. `clicktext 대상 글자 [--double]`, `clickrel 대상 글자 dx dy`: UIA 정보가 없는 앱에서 화면 글자를 인식해 클릭한다. 한글 띄어쓰기 차이는 허용한다. 같은 글자가 여러 곳이면 후보를 돌려주므로 `--index N`(위에서 아래, 왼쪽에서 오른쪽 순서)으로 고른다.
4. `type 대상 글자`, `key 대상 "{ENTER}"`, `scroll 대상 up|down [칸]`: 창을 앞으로 가져와 실제로 앞에 온 것을 확인한 뒤에만 보낸다.

### 포커스 없이 다루는 Win32 컨트롤

표준 Win32 컨트롤로 만든 창은 앞으로 가져오지 않고도 읽고 스크롤할 수 있다.

- `children 대상`: 자식 컨트롤의 hwnd, 클래스, 글자, 위치
- `gettext hwnd:번호`: 컨트롤 글자 읽기. 읽지 못하면 `null`
- `vscroll hwnd:번호 bottom|top|pageup|pagedown [--count N]`: 세로 스크롤

### 기다리기와 정기 캡처

- `wait 대상 [--text 글자] [--gone] [--timeout ms]`: 창이 나타나거나 글자가 나타나거나 사라질 때까지 기다린다. 기본 제한 시간은 30초다.
- `snapshot --title 제목 [--title 제목2] [--out 폴더] [--keep-days 14]`: 포커스를 옮기지 않고 창을 캡처하는 예약 실행용 명령이다. 창이 없거나 최소화되어 있으면 `MISSING_` 표시 파일을 남긴다. 보관 기간이 지난 날짜 폴더는 지우므로 `--out`에는 snapshot 전용 폴더를 지정한다.

### 정확도 한계와 검증

UIA 정보를 제공하지 않는 앱(게임, 캔버스로 그린 화면, 일부 사용자 정의 컨트롤)은 글자 인식과 화면 좌표에 의존하므로 글자를 잘못 읽거나 클릭 위치가 어긋날 수 있다. 이런 앱에서는 동작마다 결과를 다시 확인한다.

- `assert 대상 정규식 기대정규식`: UIA 요소의 글자가 기대와 맞는지 확인
- `vassert 대상 글자`: 화면 글자 인식으로 글자가 보이는지 확인
- `gettext hwnd:번호`: Win32 컨트롤 글자 확인
- `see` 캡처: 화면 증거

## 메신저 백업 팩

카카오톡·위챗 채팅 백업은 이 패키지가 기본 제공하는 기능 팩 중 하나다. 보이는 화면을 읽어 내 PC에 저장한다. 채팅 백업은 범용 데스크톱 명령보다 이 전용 스크립트를 우선한다.

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

웹과 Windows 앱 작업의 증거는 결과 JSON에 적힌 파일 경로와 `shots` 폴더에서, 웹 실행 기록은 `state` 폴더의 `web_audit.jsonl`에서 확인한다.

## Windows와 WSL 분기

### Windows PowerShell 또는 AI CLI의 Windows 셸

위 예시의 `node .\scripts\...`와 PowerShell 명령을 그대로 사용한다. WSL은 선택 사항이며 설치를 요구하지 않는다.

### WSL에서 시작한 AI 세션

프로젝트가 `/mnt/c/...` 아래에 있으면 Node 기반 워크플로와 `cu.mjs`는 현재 폴더에서 실행할 수 있다. `cu.mjs`는 내부에서 Windows PowerShell을 불러 Windows 앱과 Chrome을 조작한다. Windows GUI 진입 파일은 `powershell.exe`로 호출한다.

```bash
node scripts/ai_project_check.mjs --json
node scripts/cu.mjs windows
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "$(wslpath -w "$PWD/scripts/start_console.ps1")"
node scripts/browser_workflow.mjs doctor
```

WSL의 Linux 전용 브라우저나 headless Chromium으로 대체하지 않는다. 카카오톡·위챗·보이는 Chrome·Windows 앱은 Windows 데스크톱 세션에서 실행되어야 한다.

### Windows에 닿지 않는 Linux·macOS 세션

문서와 코드는 검토할 수 있지만 실제 Windows GUI 작업은 완료할 수 없다. `ai_project_check.mjs`의 `runtime.windowsReachable=false`를 보고하고 Windows PC의 프로젝트 루트에서 세션을 다시 시작하도록 안내한다.

## 안전과 사용자 확인

다음은 사용자에게 추가 확인하지 않고 진행할 수 있다.

- 파일 존재 확인, `doctor`, `pages`, 읽기 전용 audit
- 화면 관찰: `web read`, `web inspect`, `windows`, `see`, `tree`, `--dry-run`
- 사용자가 명확히 요청한 현재 방 백업
- 사용자가 명확히 요청했고 dry-run 후보가 일치하는 전체 백업
- 사용자가 명확히 요청한 웹 입력·제출과 Windows 앱 조작 중 되돌릴 수 있고 결제·삭제가 아닌 단계

다음 지점에서는 멈추고 짧고 구체적으로 사용자 입력을 요청한다.

- 앱 로그인, QR 로그인, MFA, CAPTCHA. 웹은 `web handoff`로 사람에게 넘긴다.
- 결제, 송금, 계정 삭제, 게시물 공개, 대량 발송처럼 영향이 큰 최종 제출
- 같은 이름의 창·탭·방이 여러 개라 대상을 하나로 고를 수 없음
- 전체 백업 dry-run 후보가 요청 범위와 다름
- `FG_FAILED`가 반복돼 사람이 PC를 쓰는 중일 수 있음
- 웹 쓰기 결과가 `unknown`이고 다시 읽어도 반영 여부를 판단할 수 없음
- 클라우드 OCR·번역처럼 채팅이나 화면을 외부 서비스로 보내야 함

사용자가 개인정보 외부 전송에 명시적으로 동의하기 전에는 `--allow-cloud-ocr`, `--allow-cloud-translation`을 사용하지 않고, 채팅 본문이나 화면 캡처를 외부 AI로 보내지 않는다.

CAPTCHA나 MFA를 우회하지 않으며 우회하는 코드를 추가하지 않는다. 비밀번호는 사용자가 명시적으로 지시하지 않는 한 AI가 입력하지 않고 `web handoff`로 사람에게 넘긴다. 로컬 서버의 host를 `0.0.0.0`으로 바꾸거나 인터넷에 직접 공개하지 않는다. 사용자가 요청하지 않은 파일 삭제, 기존 백업 덮어쓰기, 앱 설정 변경을 하지 않는다.

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

- `cu.mjs web` 쓰기 명령은 결과의 `outcome`이 `done`이어야 한다. 가능하면 `--expect`, `--expect-gone`, `--expect-url`을 함께 걸고, 걸지 않았다면 동작 후 `web read`나 `web assert`로 다시 읽어 반영을 확인한다.
- `outcome`이 `unknown`이면 이미 반영됐을 수 있다. 같은 동작을 다시 실행하기 전에 화면이나 목록을 다시 읽어 실제 상태를 확인한다. `not_done`이면 실행되지 않은 것이므로 원인을 확인한 뒤 다시 시도할 수 있다.
- 레시피 워크플로는 `audit --check`가 통과하고 최종 화면 PNG가 생성되어야 한다.
- 제출 결과 페이지의 식별 가능한 텍스트나 상태를 읽어 요청이 반영됐는지 확인한다. 버튼을 클릭했다는 사실만으로 성공 처리하지 않는다.

### Windows 앱 조작

- 조작 명령의 `ok`만으로 끝내지 않는다. `assert`, `vassert`, `gettext`, `see` 캡처 중 하나 이상으로 기대한 상태가 실제로 나타났는지 다시 확인한다.
- 글자 인식(`method: ocr`)이나 `clicktext`로 조작했다면 결과 화면을 반드시 다시 확인한다.
- `FG_FAILED`, `minimized`, 캡처 경고, `MISSING_` 표시 파일이 남았다면 그 대상은 완료가 아니다.

### 최종 보고 형식

1. 실제 수행한 작업
2. PASS, 확인 필요, 실패 중 하나인 검증 결과
3. 산출물 폴더, 증거 PNG, 보고서 파일
4. 사용자가 직접 해야 하는 단계가 남았다면 그 한 가지

## 지원 범위 밖의 요청

공개 ZIP은 다음 기능을 완성품으로 제공한다.

- 보이는 Windows Chrome을 통한 웹 읽기·입력·선택·업로드·다운로드·제출(계정별 전용 프로필)
- Windows 앱의 창 찾기·캡처·UIA 조작·글자 인식 클릭·키 입력·예약 캡처
- 메신저 백업 팩: Windows 카카오톡·위챗의 보이는 화면 백업
- 백업 결과 조회와 개인정보를 가린 진단

일반 Windows 앱 조작은 제공하지만, UIA 정보를 제공하지 않는 앱(게임, 캔버스로 그린 화면 등)은 글자 인식과 화면 좌표에 의존하므로 정확도에 한계가 있다. 이런 앱의 결과는 다시 읽어 확인하고, 확인되지 않은 동작을 성공으로 보고하지 않는다.

다음은 현재 완성품이 아니다.

- 메신저 내부 DB 복호화와 원본 첨부파일 전체 다운로드
- 인터넷 공개용 서비스나 완성된 MCP 서버
- 공개 ZIP에 없는 내부 개발 모듈

CAPTCHA·MFA 우회는 제공하지 않으며 구현하지도 않는다.

사용자가 새 B/C/D 작업을 요청하면 먼저 `cu.mjs`의 웹·Windows 앱 명령 조합으로 끝낼 수 있는지 판단한다. 한 번 하는 작업은 대부분 새 코드 없이 기본 작업 루프로 처리하고, 반복할 웹 단계는 `web script` 스니펫이나 `browser_workflow.mjs` 레시피로 묶는다. 패키지 기능을 새로 구현해야 한다면 기존 `scripts/lib/job_runner.mjs`의 allowlist, Windows-first 실행, preview 또는 dry-run, 명시적 위험 확인, manifest·audit 계약을 따른다. 공개 ZIP에 포함될 파일과 문서를 exporter 및 배포 검사에 추가하고, Windows에서 실제 실행하기 전에는 완성이라고 말하지 않는다.

## 사용자 요청 예시

AI CLI를 이 폴더에서 연 뒤 다음처럼 자연어로 말하면 된다.

```text
이 프로젝트로 로그인된 관리자 사이트에서 신규 문의 목록을 읽고 표로 정리해 줘. 제출이나 변경은 하지 마.
```

```text
이 프로젝트로 지금 열려 있는 업무 프로그램 창에서 조회 버튼을 누르고, 결과 화면이 맞는지 캡처로 확인해 줘.
```

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
