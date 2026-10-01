# Windows Chrome 웹 자동화 운영 안내

이 문서는 `computer-use`가 웹 작업을 수행할 때 사용하는 Windows Chrome/CDP 구조, 명령, 안전장치, 검증 절차를 설명합니다. AI 작업 도구는 사람이 보는 Windows Chrome을 직접 보고 조작해 웹 작업을 끝까지 처리하고, 사람이 판단해야 하는 지점에서만 멈춥니다. 대상 사용 환경은 Windows이며 WSL은 선택 사항입니다. 화면을 사람이 확인해야 하는 로그인, 폼, 파일 업로드, reCAPTCHA 단계에서는 WSL/WSLg Chrome이나 headless 브라우저를 사용하지 않습니다.

이 프로젝트 밖의 별도 Chrome 자동화 가이드는 필요하지 않습니다. 공개 저장소와 공개 ZIP에도 이 문서, `scripts/cu.mjs`, `scripts/cu_web.ps1`, `scripts/ensure_windows_chrome_cdp.ps1`, `scripts/chrome_profiles.ps1`, `scripts/chrome_cdp_runner.mjs`, `scripts/browser_workflow.mjs`, `scripts/lib/web_helpers.mjs`, `scripts/lib/web_client.mjs`, `scripts/lib/chrome_profiles.ps1`가 함께 들어갑니다. 폴더 전체를 전달하면 설치, 실행, 문제 해결, JSON 워크플로, 연동 방향까지 이 문서만으로 이어서 사용할 수 있습니다.

## 핵심 동작

- 웹 작업을 시작하면 Windows Chrome이 자동으로 열립니다. Chrome을 먼저 켜는 BAT나 별도 시작 명령은 필요하지 않습니다.
- 모든 웹 작업은 `node scripts/cu.mjs web <명령>` 하나로 실행합니다. 결과는 JSON 한 줄이고, 실패하면 0이 아닌 종료 코드로 끝납니다.
- 일반 Chrome과 분리된 `state\chrome-cdp-profile` 전용 프로필을 사용합니다. 계정을 나눠야 하면 `--profile 이름`으로 계정별 전용 프로필(`state\chrome-cdp-profiles\이름`)을 씁니다.
- 기본 연결 번호는 `9224`입니다. 사용 중이면 다음 번호를 자동으로 찾아 `state\chrome_cdp.json`에 기록합니다. 이름 있는 프로필은 `9240`부터 빈 번호를 찾아 `state\chrome_cdp_이름.json`에 기록합니다.
- 연결 대상은 `Chrome/...`, `Windows NT`, 비-headless UA를 모두 만족해야 합니다.
- 전용 프로필의 루트 Chrome 프로세스와 Windows 데스크톱 창 핸들을 확인합니다.
- 브라우저 조작은 Windows Node.js와 Playwright CDP 연결로 실행합니다. 파일 업로드에도 Windows 경로를 그대로 사용합니다.
- 주소 일부를 지정한 경우 일치하는 탭만 조작합니다. 탭 주소는 쿼리(`?` 뒤)를 빼고 비교합니다. 선택한 탭의 CDP 고유 ID는 `state\chrome_cdp_target.json`(이름 있는 프로필은 `state\chrome_cdp_target_이름.json`)에 저장해 다음 명령이 정확히 같은 탭을 재사용합니다. Chrome PID가 바뀌면 오래된 ID는 사용하지 않습니다.
- `goto`에서 대상 탭이 없을 때만 새 탭을 만듭니다. `--new-tab`을 붙이면 항상 새 탭을 엽니다.
- 상태를 바꾸는 작업은 미리보기(`--dry-run`), 확인창 정책, 결과 판정(`outcome`), 쓰기 잠금, 중지 파일 같은 안전장치를 거칩니다.
- 상태를 바꾸는 작업 뒤에는 대상 탭을 앞으로 가져오고 `shots\web_last.png`와 작업마다 고유한 증거 파일(`shots\web\evidence\...png`)을 저장합니다.
- 작업 명령이 끝나도 실제 Chrome은 닫히지 않습니다. 다음 명령이 같은 창과 연결 번호를 재사용합니다.

## 실행 구조

웹 명령 한 번의 내부 흐름은 다음과 같습니다.

1. `scripts/cu.mjs`가 글자·선택자·옵션을 UTF-8 요청 파일(`state\tmp`)에 씁니다. 한글과 따옴표가 명령줄에서 깨지지 않습니다.
2. `scripts/cu_web.ps1`이 경로 설정과 프로필(`scripts/lib/chrome_profiles.ps1`)을 해석합니다.
3. `scripts/ensure_windows_chrome_cdp.ps1`이 기존 전용 Chrome과 사용 가능한 연결 번호를 찾습니다.
4. 재사용할 창이 없으면 Windows 대화형 세션에 Google Chrome을 새 창으로 엽니다.
5. CDP 응답, Windows UA, 전용 프로필 프로세스, 보이는 창을 검증합니다.
6. `scripts/chrome_cdp_runner.mjs`를 Windows Node.js로 실행합니다. 페이지 조작은 `scripts/lib/web_helpers.mjs`의 공용 구현을 사용합니다.
7. 러너가 대상 탭을 명시적으로 선택해 작업하고 결과 JSON과 화면 증거를 남깁니다.
8. CDP 연결만 끊고 Chrome 창은 유지합니다.

JSON 워크플로(`scripts/browser_workflow.mjs`)도 `scripts/lib/web_client.mjs`를 통해 같은 요청 파일 방식으로 `cu_web.ps1`을 호출합니다.

Chrome 실행 파일은 환경 변수 `CU_CHROME_PATH`, Windows App Paths 레지스트리, Program Files, 사용자 LocalAppData 순서로 찾습니다. 사용자의 일반 Chrome·Edge 프로필(`User Data`)은 자동화 프로필로 쓰지 않고, 그 프로세스도 종료하지 않습니다. 새 연결을 막는 오래된 프로세스가 있으면 프로젝트 `state` 폴더 안의 전용 프로필을 사용하는 프로세스만 정리합니다. 프로젝트 밖에서 연결한 프로필의 Chrome은 사람이 쓰던 창일 수 있으므로 종료하지 않고, 사람이 그 창을 닫도록 안내한 뒤 멈춥니다.

## 준비 사항

필수 항목:

- Windows 10 또는 Windows 11
- Google Chrome
- Windows Node.js LTS (`ping`, `health`는 내장 WebSocket이 있는 Node.js 22 이상 필요)
- Windows PowerShell 5.1 이상

WSL은 필수가 아닙니다. `node scripts/cu.mjs`는 Windows PowerShell, cmd, Git Bash, WSL 어디서나 같은 명령으로 동작하며, WSL에서는 Windows 쪽 `powershell.exe`를 호출합니다. 업로드 파일, `--out`, `--value-file`, 스크립트 경로처럼 Windows 쪽이 읽는 경로는 WSL 경로나 상대 경로로 줘도 Windows 경로로 바꿔 전달합니다.

Playwright 실행 모듈은 다음 순서로 찾습니다.

1. 프로젝트에서 이미 사용할 수 있는 `playwright-core`
2. `CU_PLAYWRIGHT_CORE_PATH`
3. `state\browser-runtime`
4. 이전 설치 호환 경로

어디에도 없으면 첫 웹 작업 때 `state\browser-runtime`에 `playwright-core`를 자동 준비합니다. 이때만 인터넷 연결과 npm 사용이 필요할 수 있습니다. Chrome 브라우저 바이너리를 별도로 내려받지는 않습니다.

## 통합 명령(`node scripts/cu.mjs web`)

```text
node scripts/cu.mjs web <명령> [인자] [--옵션]
node scripts/cu.mjs help        전체 명령 목록
```

결과 계약:

- 표준 출력의 마지막 줄이 결과 JSON입니다. `ok`가 `false`이면 `error`와 `code`가 함께 나옵니다.
- 실패는 종료 코드 1, 명령 형식 오류는 종료 코드 2입니다.
- 글자·라벨·프레임·탭이 여러 개 일치하면 임의로 고르지 않고 `code: "ambiguous"`와 후보 목록(`candidates`)을 돌려줍니다. `--nth N`, `--within 선택자`, `--exact`, 더 구체적인 `--url`로 하나를 지정합니다.
- 쓰기 명령은 `outcome`(`done`, `not_done`, `unknown`)을 함께 돌려줍니다. `ok`만 보고 완료라고 판단하지 않습니다.
- 처음 Chrome을 열었을 때만 표준 오류에 프로필과 연결 번호 안내가 한 줄 나옵니다.

명령 목록:

| 분류 | 명령 |
|---|---|
| 상태·탭 | `pages`, `ping`, `health [--close-hung]`, `profiles`, `profile add 이름 [--dir 폴더] [--port N]`, `profile remove 이름`, `unpin` |
| 이동·읽기 | `goto URL [--new-tab]`, `reload`, `read [--selector S] [--frame F\|all]`, `frames`, `inspect [범위선택자] [--aria] [--frame all]`, `find 글자`, `table [선택자]`, `modals`, `session [계정글자]` |
| 클릭·입력 | `click 선택자`, `clicktext 글자`, `type`/`setvalue`/`keys 선택자 값`, `select 선택자 값`, `pick 선택자 항목`, `check`/`uncheck 선택자`, `press 키`, `hover 선택자`, `scroll down\|up\|bottom\|top` |
| 파일 | `upload 선택자 파일...`, `upload --chooser-text 글자 파일...`, `download [URL] --click S\|--clicktext T [--out F]` |
| 대기·검증 | `waittext 글자 [--gone]`, `waitsel 선택자 [--count N]`, `waiturl 주소일부`, `assert 글자`, `validate 제출선택자` |
| 수집·응답 | `collect 항목선택자 --field 이름=선택자[@속성] --key ...`, `net 주소일부`, `fetch /api/...` |
| 화면 검수 | `shot [파일] [--full]`, `capture URL --widths 390,1280`, `pageaudit [URL]`, `identify [글자]`, `window [maximize]` |
| 사람·확장 | `handoff "사람이 할 일"`, `dismiss`, `script 파일.mjs [인자...]`, `eval JS` |

공통 옵션:

| 옵션 | 의미 |
|---|---|
| `--url 주소일부` | 작업할 탭 지정 |
| `--profile 이름` | 계정별 전용 프로필 사용 |
| `--port N` | 선호 연결 번호(사용 중이면 다음 빈 번호) |
| `--timeout ms` | 요소·글자 대기 시간(기본 15000) |
| `--timeout-ms ms` | 명령 전체 시간 상한(기본 300000, `script`는 900000) |
| `--no-autostart` | Chrome이 꺼져 있어도 새로 열지 않음(`CU_CHROME_CDP_AUTOSTART=0`과 같음) |
| `--no-shot`, `--no-front` | 증거 화면을 남기지 않음 / 캡처 때 탭을 앞으로 가져오지 않음 |
| `--frame F` | iframe 안에서 실행(프레임 절 참고) |

## 기본 명령

어느 셸에서나 같은 형식입니다.

```bash
node scripts/cu.mjs web pages
node scripts/cu.mjs web goto https://example.com
node scripts/cu.mjs web read --url example.com
node scripts/cu.mjs web inspect --url example.com
node scripts/cu.mjs web find "찾을 글자" --url example.com
node scripts/cu.mjs web click "#save" --dry-run --url example.com
node scripts/cu.mjs web clicktext "저장" --expect "저장되었습니다" --url example.com
node scripts/cu.mjs web type "#name" "홍길동" --url example.com
node scripts/cu.mjs web type "홍길동" --label "이름" --url example.com
node scripts/cu.mjs web select "#kind" "정확한 항목" --url example.com
node scripts/cu.mjs web check "#agree" --url example.com
node scripts/cu.mjs web upload "#file" "C:\Users\ME\Documents\sample.pdf" --url example.com
node scripts/cu.mjs web validate "#submit" --url example.com
node scripts/cu.mjs web identify "Computer-Use 작업 창" --url example.com
node scripts/cu.mjs web shot "C:\Temp\final.png" --url example.com
```

기존 호환 경로도 남아 있습니다. WSL·bash의 `./scripts/cu web ...`은 공개 패키지에서 `node scripts/cu.mjs web`으로 그대로 넘기지만, 이전 버전의 보조 실행 파일은 인자 두 개와 `--url`, `--port`만 전달하므로 옵션이 필요하면 `node scripts/cu.mjs web`을 직접 사용합니다. Windows PowerShell에서 `cu_web.ps1`을 직접 부르는 방식은 같은 자동 실행기와 러너를 사용하지만 `-Arg1`, `-Arg2`, `-Url`, `-Port`, `-ChromeProfile` 정도만 받고 `--dry-run`, `--label` 같은 옵션은 전달하지 않습니다.

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action pages
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action goto -Arg1 https://example.com
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action read -Url example.com
```

위 명령은 작업 명령이면서 자동 시작 진입점입니다. `ensure_windows_chrome_cdp.ps1`을 사용자가 따로 실행할 필요가 없습니다.

## 계정별 프로필

한 브라우저 안에서 계정을 바꾸면 그 계정에 묶인 다른 자동화가 깨집니다. 계정마다 전용 프로필을 분리하고, 프로필마다 연결 번호와 고정 탭, 증거 파일을 따로 둡니다.

```bash
node scripts/cu.mjs web goto https://example.com --profile work-a
node scripts/cu.mjs web read --url example.com --profile work-a
node scripts/cu.mjs web profiles
node scripts/cu.mjs web profile add work-b --dir "D:\Automation\work-b"
node scripts/cu.mjs web profile remove work-b
```

- 프로필 이름은 영문 소문자·숫자·`-`·`_`로 된 32자 이하이며 `default`는 쓸 수 없습니다.
- `--profile 이름`만 주면 `state\chrome-cdp-profiles\이름` 폴더를 사용합니다. 처음 쓰는 프로필은 로그인되어 있지 않으므로 `handoff`로 사람이 한 번 로그인합니다.
- 상태 파일은 `state\chrome_cdp_이름.json`, 고정 탭은 `state\chrome_cdp_target_이름.json`, 최신 화면은 `shots\web_last_이름.png`입니다.
- `profile add 이름 --dir 폴더`는 이미 로그인해 둔 기존 전용 자동화 프로필 폴더를 이름에 연결합니다. `--port N`으로 연결 번호를 고정하고 `--note 메모`를 남길 수 있습니다. 등록하지 않고 한 번만 쓰려면 `--profile 이름 --profile-dir 폴더`를 함께 줍니다.
- 일반 Chrome·Edge의 `User Data` 폴더와 그 하위 폴더는 등록과 실행을 모두 거부합니다.
- 연결할 폴더가 없으면 빈 프로필을 새로 만들지 않고 실패합니다. 빈 프로필로 열면 모든 사이트가 로그아웃된 것처럼 보이기 때문입니다.
- 프로젝트 밖 폴더를 연결한 프로필은 해당 Chrome이 자동화 연결 없이 열려 있어도 강제로 종료하지 않습니다. 사람이 작업을 저장하고 그 창을 닫은 뒤 다시 실행합니다.
- `profile remove`는 목록에서만 빼고 프로필 폴더(로그인 세션)는 지우지 않습니다.
- `profiles`는 등록된 프로필, 마지막 연결 번호, 실행 중인 디버그 Chrome과 탭을 보여 줍니다. 탭 주소의 쿼리는 세션 토큰이 들어 있을 수 있어 기본으로 가리며, 꼭 필요할 때만 `--show-query`를 씁니다. 목록에 나온 다른 디버그 Chrome은 자동으로 사용하지 않습니다.

## 대상 탭 선택

`--url`에는 전체 주소 대신 구분 가능한 주소 일부를 지정할 수 있습니다.

```bash
node scripts/cu.mjs web read --url account.example.com
```

규칙:

- 일치하는 탭이 있으면 그 탭만 사용합니다.
- 이미 고정한 탭 ID가 있으면 같은 주소의 탭이 여러 개여도 그 탭만 사용합니다. 아직 고정한 탭이 없고 일치 항목이 여러 개면 임의로 고르지 않고 실패하므로 경로까지 포함한 더 구체적인 주소 일부를 지정합니다.
- 일치하는 탭이 없으면 `read`, `click`, `type`, `select`, `upload` 등은 실패합니다. 다른 탭으로 자동 대체하지 않습니다.
- `--url`도 고정 탭도 없으면 빈 탭을 제외한 작업 탭이 하나뿐일 때만 그 탭을 씁니다. 여러 개면 열린 탭 목록과 함께 `code: "no_target"`으로 멈춥니다.
- `goto`만 새 탭을 만들 수 있습니다.
- 작업 창이 여러 개라 사람이 보는 창과 자동화 창이 헷갈리면 `identify`로 눈에 띄는 배너를 표시합니다.
- 비가역 작업 전에는 `pages`, `read`, `identify`, `shot`으로 대상 창을 다시 확인합니다.

### 탭 선택 규칙 변경

- 주소 비교는 쿼리와 `#` 뒤를 뺀 `호스트+경로`로 합니다. 로그인 화면은 "돌아갈 주소"를 쿼리 파라미터에 담는 경우가 많아서, 단순 부분 일치로 고르면 대상 주소가 쿼리에 들어 있는 로그인 탭을 작업 탭으로 잘못 고르는 함정이 있었습니다. `--url`에 `?`나 `#`를 직접 넣었을 때만 쿼리까지 포함한 전체 주소와 비교합니다.
- `waiturl`, `--expect-url`, `handoff --until-url`도 같은 비교 규칙을 사용합니다.
- 고정 탭은 `pages` 결과에 `pinned: true`로 표시됩니다. 고정 탭의 주소가 `--url`과 다르면 실패하고, 고정 탭이 닫혔으면 `pages` 또는 `goto`로 다시 고르라는 오류가 납니다.
- `unpin`은 고정 탭 기록만 지웁니다. 탭과 Chrome은 그대로 두고, 다음 명령이 `--url`이나 새 탭으로 대상을 다시 고릅니다.
- `goto URL`은 같은 주소의 탭이 있으면 그 탭을 재사용합니다. 사람이 보고 있는 탭을 건드리지 않으려면 `goto URL --new-tab`으로 새 탭을 엽니다. `goto` 결과의 `loginWall`이 `true`이면 로그인 화면에 도착한 것입니다.

## 폼 입력 원칙

### 입력 방식 선택

| 명령 | 방식 | 언제 쓰는지 |
|---|---|---|
| `type` | Playwright `fill`, `input` 이벤트 발생 | 일반 입력 칸 기본값 |
| `setvalue` | 값 setter 호출 후 `input`·`change` 이벤트, 편집 가능 영역은 글자 삽입 | 값은 들어갔는데 화면 상태(React·Vue 같은 제어 입력)가 갱신되지 않을 때 |
| `keys` | 칸을 누르고 전체 선택·삭제 후 한 글자씩 키 입력 | 마스킹 입력, 키 입력에만 반응하는 칸 |

입력 뒤에는 칸의 값을 다시 읽어 `verified`로 알려 줍니다. 값이 다르면 `outcome`이 `unknown`이 됩니다.

- `--label 화면라벨`: 선택자 대신 화면에 보이는 라벨 글자로 칸을 찾습니다. `aria-label`, `aria-labelledby`, 연결된 `label`, `placeholder`, 표나 div 배치에서 라벨 옆 칸 순서로 찾습니다. 이때 값은 첫 번째 인자로 줍니다(`type "값" --label "라벨"`). 여러 칸이 일치하면 `--nth N`, 정확히 같은 라벨만 보려면 `--exact`를 씁니다. `select`, `check`, `uncheck`, `upload`, `click`, `hover`, `press`도 `--label`을 받습니다.
- `--numeric`: 금액·수량처럼 화면이 쉼표나 단위를 붙이는 칸은 숫자만 비교해 검증합니다.
- `--counter 선택자`: 화면의 글자 수 표시(`12/1000` 같은)를 읽어 앱이 입력을 실제로 반영했는지 확인합니다. 바이트로 세는 화면을 고려해 입력 길이의 3배까지 허용합니다.
- `--require-empty`: 칸에 이미 내용이 있으면 덮어쓰지 않고 `code: "not_empty"`로 멈춥니다. 다른 사람이 쓰던 초안을 지우지 않기 위한 옵션입니다.
- `--value-file 파일`: 긴 글이나 줄바꿈이 있는 값은 UTF-8 파일로 넘깁니다.
- 비밀번호 칸(`type=password`)에는 입력하지 않고 `code: "secret_field"`로 멈춥니다. 로그인은 `handoff`로 사람이 보이는 창에서 직접 합니다. `--allow-secret`은 사용자가 명시적으로 요청한 경우에만 씁니다. 이름이나 자동완성 속성이 비밀번호·OTP·인증번호로 보이는 칸은 결과에 값을 싣지 않습니다.

### 텍스트와 숫자

기본 입력은 Playwright `fill`을 사용하므로 `input` 이벤트가 발생합니다. 숫자 필드는 화면의 단위와 HTML `step`을 함께 확인합니다. `type=number`에서 `step` 기본값이 1이면 소수가 유효하지 않을 수 있습니다. 입력값이 `maxlength`보다 길면 결과에 `truncatedByMaxLength`가 표시됩니다.

### 선택 목록

`select`는 옵션의 실제 값 또는 화면 글자가 완전히 일치할 때만 선택합니다. `과세`와 `과세 대상`처럼 부분 일치가 가능한 항목은 자동으로 고르지 않습니다. 연계 선택 목록은 상위 항목을 먼저 바꾼 뒤 하위 옵션을 다시 확인합니다.

HTML `select`가 아닌 사용자 정의 드롭다운은 `pick`을 사용합니다. 목록을 여는 요소를 누른 뒤 새로 보이는 목록 안에서 항목 글자를 정확히 일치로 고르고, 여는 요소에 고른 글자가 보이는지 확인합니다.

```bash
node scripts/cu.mjs web pick "#category" "정확한 항목" --url example.com
node scripts/cu.mjs web pick "정확한 항목" --trigger-text "분류 선택" --url example.com
node scripts/cu.mjs web pick "#category" "정확한 항목" --via keyboard --url example.com
```

`--via keyboard`는 클릭에는 반응하지 않고 방향키·Enter에만 반응하는 ARIA 콤보박스용입니다.

### 체크박스와 커스텀 컨트롤

일반 체크박스는 `check`, `uncheck`를 사용하고 결과의 `state`, `verified`로 최종 상태를 확인합니다. 사이트가 자체 UI만 보이고 실제 input을 숨긴 경우에는 먼저 `inspect`로 DOM 구조와 라벨 연결을 확인합니다. 무조건 좌표 클릭으로 우회하지 않습니다.

### 읽기 전용 필드

주소 검색처럼 사이트가 의도적으로 `readonly`로 둔 필드는 해당 사이트의 정상 입력 흐름을 우선 사용합니다. 기술적으로 속성을 제거할 수 있더라도 서버 검증이나 연계 필드가 깨질 수 있으므로, 사이트별로 검토한 경우에만 제한적으로 처리합니다.

### 파일 업로드

파일 업로드는 아래 "업로드·다운로드" 절을 따릅니다. Windows Node.js가 실행하므로 `setInputFiles`에는 Windows 경로를 전달합니다.

### 제출 전 검증

제출 버튼을 누르기 전에 반드시 `validate`를 실행합니다.

```bash
node scripts/cu.mjs web validate "#submit" --url example.com
```

검사는 제출 버튼이 속한 form의 활성 `input`, `select`, `textarea`를 대상으로 다음을 확인합니다.

- `checkValidity()` 실패 필드와 브라우저의 `validationMessage`
- 현재 값 길이가 `maxlength`를 넘은 필드

JSON recipe의 `clickSubmit`도 이 검사를 먼저 실행하며 실패하면 클릭을 차단합니다. `select` 변경 핸들러가 다른 입력값을 지우는 사이트에서는 select를 먼저 선택하고 텍스트를 나중에 입력한 뒤 다시 검증합니다.

## 쓰기 안전장치

쓰기 명령은 `click`, `clicktext`, `type`, `setvalue`, `keys`, `select`, `pick`, `check`, `uncheck`, `upload`, `download`, `press`, `dismiss`, `script`, 그리고 `--click`/`--clicktext`를 붙인 `net`, GET·HEAD가 아닌 `fetch`입니다.

### 미리보기(`--dry-run`)

```bash
node scripts/cu.mjs web clicktext "삭제" --dry-run --url example.com
```

대상을 찾고 개수, 보이는지, 비활성인지, 다른 요소에 덮였는지, 후보가 여러 개인지만 확인하고 실제로 누르거나 입력하지 않습니다. 업로드는 로컬 파일 크기, `fetch`는 보낼 요청, `dismiss`는 열린 모달을 미리 보여 줍니다. 결과의 `outcome`은 항상 `not_done`입니다.

### 확인창(alert·confirm·prompt)

| 상황 | 처리 |
|---|---|
| alert | 항상 닫고 `dialogs`에 기록합니다. 알림창을 닫은 것은 작업 거절로 세지 않습니다. |
| confirm·prompt·이동 전 확인(기본) | 취소하고 기록합니다. 쓰기·이동 명령은 `code: "dialog_dismissed"`로 실패합니다. |
| `--confirm-dialog "문구"` | 문구(정규식)와 일치하는 confirm·prompt만 수락하고, 다른 확인창은 취소한 뒤 `expectMismatch`로 기록합니다. |
| `--dialog accept` | 모든 확인창을 수락합니다. 대상과 문구를 이미 확인한 경우에만 씁니다. `accept:값`은 prompt에 값을 넣습니다. |

확인창 정책은 작업 탭과 그 탭이 연 팝업에만 적용합니다. 사람이 보던 다른 탭의 확인창은 건드리지 않습니다.

### 화면 안 확인 모달

```bash
node scripts/cu.mjs web clicktext "삭제" --modal-confirm "삭제하시겠습니까" --modal-button "확인" --url example.com
```

`--modal-confirm "문구"`는 작업 뒤 떠오른 화면 안 모달의 글자가 문구(정규식)와 맞을 때만 그 모달 안의 버튼(`--modal-button`, 기본 `확인`)을 정확히 일치로 누릅니다. 기대한 모달이 없거나 다른 모달이 뜨면 누르지 않고 실패합니다. 이 옵션 없이 작업 뒤 새 모달이 나타나면 확인 단계가 남았을 수 있으므로 `outcome`을 `unknown`으로 두고 `hint`를 돌려줍니다. `modals`로 내용을 보고 `--modal-confirm`으로 다시 하거나 `dismiss`로 닫습니다. `dismiss`는 가장 위 모달을 `닫기`, `취소`, `나중에`, `Close`, `Cancel`, `×` 같은 거절 쪽 버튼이나 닫기 아이콘으로만 닫고, 승인·저장·전송 버튼은 누르지 않습니다.

### 결과 판정

| 필드 | 의미 |
|---|---|
| `outcome: "done"` | 실행했고 취소된 확인창, 실패한 기대 조건, 값 검증 실패, 새 모달이 없습니다. 서버 반영의 증명은 아니므로 결과를 다시 읽습니다. |
| `outcome: "not_done"` | 실제 조작 전에 멈췄습니다(대상 없음·모호함·덮임·비활성·`not_empty`·중복·잠금·중지·파일 없음·비밀번호 칸, `--dry-run`, 쓰기 요청 없이 확인창 취소). |
| `outcome: "unknown"` | 조작을 시작한 뒤 실패했거나, 확인창을 취소했는데 쓰기 요청이 보였거나, 기대 조건·값 검증·모달 확인이 실패했거나, 새 모달이 떴습니다. 같은 작업을 다시 하지 말고 결과부터 확인합니다. |
| `observed` | 작업 전후 비교: `urlChanged`, `newModals`, `toasts`(잠깐 떴다 사라진 알림 포함), `alerts`, `errors`(검증 오류 문구) |
| `writeRequests` | 작업 중 페이지가 보낸 POST·PUT·PATCH·DELETE 요청(분석·로그 요청 제외, 쿼리 제외 주소와 상태 코드). 화면 반응이 없어도 서버에 반영됐을 수 있다는 신호입니다. |
| `popups` | 작업 탭이 연 새 탭 |
| `expectations` | `--expect 글자`, `--expect-gone 글자`, `--expect-url 주소일부` 결과. 하나라도 실패하면 종료 코드 1이고 대기 시간은 `--expect-timeout ms`로 바꿉니다. |

### 중복 실행·잠금·중지

- `--idem-key 키`: 결과를 `state\web_idempotency.jsonl`에 기록합니다. 같은 키가 이미 `done`이거나 `unknown`이면 `code: "duplicate"`로 거부합니다. 결과를 확인한 뒤 정말 다시 해야 할 때만 `--repeat`를 붙입니다.
- 쓰기 잠금: 같은 Chrome 연결 번호에서 두 쓰기 작업이 동시에 실행되지 않도록 `state\locks\cdp-<번호>.lock`을 잡습니다. 다른 작업이 진행 중이면 `code: "busy"`로 멈춥니다.
- 중지 파일: `node scripts/cu.mjs stop`이 `state\STOP`을 만들면 이동·쓰기·스크립트 명령을 `code: "stopped"`로 거부합니다. `pages`, `read`, `inspect`, `shot` 같은 읽기 명령은 계속 동작합니다. `node scripts/cu.mjs resume`으로 재개하고 `node scripts/cu.mjs status`로 상태를 봅니다.
- 시간 상한(watchdog): 명령이 시간 안에 끝나지 않으면 연결을 끊고 `code: "watchdog"`을 돌려줍니다. 기본 300초, `script`는 스크립트 제한 시간+60초(최소 240초), `handoff`는 대기 시간+60초이며 `--watchdog-ms`로 바꿉니다.

### 증거와 기록

- 이동·쓰기·`identify`·`window`·`scroll`·`hover`·`dismiss`·`handoff` 뒤에는 `shots\web_last.png`(이름 있는 프로필은 `web_last_이름.png`)를 갱신하고, 같은 화면을 `shots\web\evidence\<시각>_<프로필>_<명령>.png`로 복사합니다. 결과의 `evidence`는 고유 파일, `evidenceLatest`는 최신 화면 파일입니다. 보고에는 `evidence`를 씁니다.
- 모든 명령은 `state\web_audit.jsonl`에 시각, 프로필, 연결 번호, 명령, `ok`, `outcome`, 쿼리를 뺀 대상 주소, 증거 파일, 오류 코드, 작업 키, 스크립트 해시, 확인창·쓰기 요청 수를 남깁니다. 5MB를 넘으면 `.1`로 넘깁니다.

## 업로드·다운로드

```bash
node scripts/cu.mjs web upload "input[type=file]" "C:\Users\ME\Documents\proposal.pdf" --url example.com
node scripts/cu.mjs web upload --chooser-text "파일 선택" "C:\Users\ME\a.pdf" "C:\Users\ME\b.pdf" --url example.com
node scripts/cu.mjs web upload --label "첨부파일" "C:\Users\ME\a.pdf" --url example.com
node scripts/cu.mjs web download --clicktext "엑셀 다운로드" --out "C:\Temp\report.xlsx" --url example.com
node scripts/cu.mjs web download "https://example.com/files/report.pdf" --url example.com
```

- 숨은 `input[type=file]`도 선택자로 바로 넣습니다. 클릭해야 파일 입력이 생기는 화면은 `--chooser-text 글자`(또는 `--chooser 선택자`)로 파일 선택 창 이벤트를 가로채 넣습니다. 이때 위치 인자는 모두 파일입니다.
- 실행 전에 파일이 있는지 확인하고 없으면 `code: "file_missing"`으로 멈춥니다. 결과의 `attached`에 화면이 받은 파일 이름·크기가 나오며, 개수가 맞아야 `verified: true`입니다.
- 원격 연결로 파일 내용을 보내는 방식은 50MB 근처에서 실패합니다. 45MB를 넘는 파일은 Chrome이 Windows 경로를 직접 읽도록 CDP `DOM.setFileInputFiles` 경로(`mode: "cdp-path"`)를 자동으로 사용합니다. 이 경로는 메인 문서의 입력 칸에만 적용되므로, iframe 안의 입력 칸에 큰 파일을 올릴 때는 결과의 `attached`를 반드시 확인합니다.
- 상대 경로는 명령을 실행한 폴더 기준으로 Windows 경로로 바뀝니다. 재현성을 높이려면 절대 Windows 경로를 사용합니다.
- `download`는 `--click`/`--clicktext`로 현재 탭에서 내려받거나, 주소를 주면 임시 탭에서 내려받습니다. `--out`이 없으면 `shots\downloads`에 사이트가 준 파일 이름으로 저장합니다. 결과에는 `file`, `size`, `sha256`, `suggestedFilename`, 파일 앞부분으로 판별한 `kind`(`pdf`, `png`, `zip-or-office`, `html` 등)가 나옵니다. `kind`가 `html`이면 파일 대신 화면이 내려온 것이므로 로그인 만료나 권한 문제를 의심하고 `outcome`은 `unknown`이 됩니다.

## 프레임

```bash
node scripts/cu.mjs web frames --url example.com
node scripts/cu.mjs web read --frame all --url example.com
node scripts/cu.mjs web clicktext "확인" --frame auto --url example.com
node scripts/cu.mjs web type "#memo" "내용" --frame "selector:iframe#editor" --url example.com
```

- `frames`는 프레임 번호, 이름, 주소, 상위 프레임을 보여 줍니다.
- `--frame`에는 프레임 번호(`2` 또는 `#2`), 이름, 주소 일부, `selector:CSS`(iframe 요소)를 줄 수 있습니다. 여러 프레임이 일치하면 고르지 않고 실패합니다.
- `--frame auto`는 글자나 선택자가 있는 프레임을 메인 문서부터 찾습니다. 여러 프레임에 있으면 `ambiguous`로 멈춥니다.
- `--frame all`은 `read`와 `inspect`에서 모든 프레임을 한 번에 읽습니다.

## 응답 캡처·fetch

화면에 그리기 전 사이트가 받는 JSON을 읽으면 표를 긁는 것보다 정확합니다.

```bash
node scripts/cu.mjs web net "/api/" --clicktext "조회" --until-first --url example.com
node scripts/cu.mjs web net "/api/list" --seconds 10 --bodies --url example.com
node scripts/cu.mjs web fetch "/api/items?page=1" --url example.com
node scripts/cu.mjs web fetch "/api/items" --method POST --body-file body.json --write --url example.com
```

- `net 주소일부|/정규식/`는 지정한 시간(`--seconds`) 동안 xhr·fetch·document 응답을 모아 `shots\web\net_<시각>.json`에 저장하고 요약(주소, 메서드, 상태, 형식, JSON 키)만 돌려줍니다. `--click`/`--clicktext`/`--reload`로 응답을 일으키는 동작을 함께 실행하고, `--until-first`는 첫 응답에서 멈춥니다.
- 응답 본문은 개인정보일 수 있어 기본으로 저장하지 않습니다. 데이터가 필요할 때만 `--bodies`를 켭니다. 주소 쿼리의 토큰·세션·서명·비밀번호·코드류 값은 `[REDACTED]`로 가립니다.
- `fetch`는 로그인된 탭의 세션으로 같은 사이트의 http(s) 주소만 요청합니다. 다른 사이트 주소는 거부합니다. GET·HEAD가 아닌 요청은 데이터를 바꿀 수 있으므로 `--write`가 있어야 하고, 쓰기 안전장치가 그대로 적용됩니다. 머리글은 `--header "이름: 값"`, 본문은 `--body` 또는 `--body-file`로 줍니다.
- `fetch` 결과의 `httpOk`는 응답을 받았다는 뜻일 뿐입니다. 401·403, 로그인 주소로 돌아간 응답, 로그인 HTML은 `loginSuspected: true`와 종료 코드 1로 알려 줍니다. 로그아웃 상태를 "0건"으로 오해하지 않기 위한 표시입니다. 전체 응답은 `shots\web\fetch_<시각>.json`에 저장합니다.

## 수집(가상 목록)

가상 목록은 스크롤하면 앞 항목이 DOM에서 사라집니다. 맨 아래까지 내린 뒤 한 번 읽으면 마지막 몇 줄만 남으므로, 내리는 동안 매번 읽고 키로 중복을 지우는 `collect`를 사용합니다.

```bash
node scripts/cu.mjs web collect ".list-item" --field "제목=.title" --field "링크=a@href" --key "@data-id" --selector ".list-scroll" --out "C:\Temp\items.csv" --url example.com
node scripts/cu.mjs web scroll bottom --selector ".list-scroll" --until-text "마지막 항목" --url example.com
node scripts/cu.mjs web table ".orders" --out "C:\Temp\orders.csv" --url example.com
```

- `--field 이름=선택자[@속성]`는 항목 안에서 읽을 값입니다. 생략하면 항목 전체 글자를 읽습니다.
- `--key`는 중복 판정 기준입니다. `@속성`(항목 자신), `선택자@속성`, `선택자`(글자) 형식이며, 생략하면 행 전체 내용으로 비교합니다.
- `--selector`는 스크롤 영역입니다. 생략하면 문서 전체를 내립니다. 스크롤 이벤트에 반응하지 않는 목록은 `--wheel`로 실제 마우스 휠을 씁니다. `--max-steps`, `--px`, `--wait-ms`, `--max`로 단계를 조절합니다.
- 결과의 `reachedEnd`가 `false`이고 `truncated`도 아니면 끝에 닿기 전에 단계 상한에 걸린 것이므로 `--max-steps`를 늘려 다시 수집합니다. 파일 확장자가 `.csv`이면 BOM 포함 CSV, 아니면 JSON으로 저장합니다(기본 `shots\web\collect_<시각>.json`).
- `table`은 `table` 요소와 `role=grid`·`role=table` 표를 읽고, `--out`에 `.csv`나 `.json`으로 저장합니다.

## 화면 검수(capture, pageaudit)

```bash
node scripts/cu.mjs web capture "https://example.com/" --widths 390,1280 --dpr 2 --hide-fixed
node scripts/cu.mjs web pageaudit "https://example.com/" --isolated
node scripts/cu.mjs web pageaudit --checks images,overflow,tiny-text --url example.com
```

- `capture`는 사람이 보는 탭을 건드리지 않도록 새 탭에서 폭별로 화면 크기를 바꿔 전체 페이지를 찍습니다. 찍기 전에 지연 이미지를 불러오도록 끝까지 내렸다가 돌아옵니다. `--hide-fixed`는 고정 머리글·떠 있는 버튼을 가려 중복 노출을 없애고, `--viewport-only`는 보이는 영역만 찍습니다. 결과 폴더(기본 `shots\web\capture_<시각>`)의 `manifest.json`에 폭, DPR, 파일, CSS 기준 높이(`cssHeight`), 도착 주소, `sha256`, 깨진 이미지·가로 넘침 문제가 기록됩니다.
- `pageaudit`는 깨진 이미지, 가로 넘침, 너무 작은 글자(`--min-font`, 기본 11px), 콘솔 오류, 실패한 요청을 검사해 `PASS`/`FAIL`을 돌려주고 실패하면 종료 코드 1로 끝납니다. 콘솔 오류와 실패한 요청은 주소를 주거나 `--reload`·`--isolated`를 붙여 새 탭에서 다시 열 때만 모읍니다. `--isolated`는 로그인 정보가 없는 별도 창에서 열어 비로그인 방문자 화면을 확인합니다.

## 사람에게 넘기기(handoff, session)

```bash
node scripts/cu.mjs web session "홍길동" --url example.com
node scripts/cu.mjs web handoff "로그인과 추가 인증을 이 창에서 완료해 주세요" --identity "홍길동" --url example.com
```

`session [계정글자]`는 주소, 비밀번호 칸, 로그인 버튼, 계정 글자를 함께 보고 다음 중 하나를 돌려줍니다.

| 상태 | 의미 |
|---|---|
| `LOGGED_IN` | 계정 글자가 화면에 있고 로그인 주소가 아닙니다. |
| `LOGIN_WALL` | 로그인·인증 주소이거나 비밀번호 칸과 로그인 버튼이 함께 보입니다. |
| `WRONG_ACCOUNT` | 로그인 벽은 없지만 기대한 계정 글자가 없습니다. 다른 계정으로 로그인된 상태일 수 있습니다. |
| `NO_LOGIN_WALL` | 로그인 벽이 보이지 않을 뿐 계정은 확인하지 않았습니다. 계정까지 확인하려면 계정 글자를 줍니다. |

`--require LOGGED_IN`처럼 기대 상태를 주면 다를 때 종료 코드 1로 끝납니다.

`handoff "사람이 할 일"`은 로그인, MFA, CAPTCHA처럼 사람이 해야 하는 단계를 넘기는 명령입니다. 창을 정상 크기로 복구해 앞으로 가져오고 "사람 확인 필요" 배너를 띄운 뒤, 사람이 같은 창에서 완료할 때까지 3초마다 확인합니다. 기본 완료 조건은 로그인 벽이 사라지는 것이고, `--identity 계정글자`(그 계정으로 `LOGGED_IN`), `--until-url 주소일부`, `--until-text 글자`로 조건을 더할 수 있습니다. 기본 대기 시간은 600초(`--timeout ms`)이며 넘으면 `code: "handoff_timeout"`으로 끝납니다. 완료 후에는 `session`으로 상태를 다시 확인하고 작업을 이어갑니다.

## 세션과 제출

- 폼을 오래 열어 둔 뒤 `잘못된 접근`, 무한 로딩, CSRF 오류가 나오면 `reload` 후 전체 값을 다시 입력합니다.
- 서버가 해시 형태의 필드명이나 세션별 토큰을 쓰는 경우 이전 DOM 값을 재사용하지 않습니다.
- 제출 직전 `validate`, `read`, `shot`으로 현재 상태를 확인하고, 제출 명령은 `--dry-run`으로 대상을 먼저 확인합니다.
- 제출 결과는 `--expect`, `--expect-url`, 다시 읽기로 확인합니다. `outcome`이 `unknown`이면 다시 제출하지 않고 결과 화면이나 목록을 먼저 조회합니다.
- 결제, 송금, 계약, 계정 삭제, 최종 접수처럼 비가역적인 작업은 별도 사람 확인을 유지합니다.

## reCAPTCHA

reCAPTCHA 체크와 이미지 문제는 사람이 보이는 Windows Chrome에서 직접 처리합니다. 자동화 도구는 이미지 문제를 풀거나 우회하지 않습니다.

권장 역할 분담:

1. 자동화가 일반 필드와 첨부 파일을 채웁니다.
2. `validate`와 스크린샷으로 누락을 확인합니다.
3. `handoff`로 사람이 같은 창에서 reCAPTCHA를 처리하도록 넘깁니다.
4. 토큰 만료를 피하도록 사람이 최종 제출을 즉시 확인하거나 실행합니다.

사람이 보고 있는 창과 자동화 연결 창이 다를 수 있으면 `identify` 배너가 보이는지 먼저 확인합니다.

## 스니펫 실행(script)

고정 명령으로 부족한 여러 단계 작업은 스니펫 파일로 실행합니다. 스니펫은 고정 명령과 같은 `scripts/lib/web_helpers.mjs` 구현을 받아 씁니다.

```bash
node scripts/cu.mjs web script count_rows.mjs "table.list" --url example.com
node scripts/cu.mjs web script update_items.mjs --param limit=10 --write --url example.com
```

계약:

- 모듈은 `export default async function (ctx)`(또는 `export async function run(ctx)`)를 내보내고, 반환값이 결과 JSON의 `result`가 됩니다. 20만 자를 넘으면 `shots\web\script_<시각>.json`에 저장하고 앞부분만 보여 줍니다. `{ ok: false }`를 반환하면 종료 코드 1입니다.
- 읽기만 하는 스니펫은 `export const mode = 'read'`(또는 `meta.writes = false`)를 선언합니다. 선언이 없으면 쓰기로 보고 `--write`가 있어야 실행합니다.
- `export const meta = { allowedDomains: [...], timeoutMs: 60000, supportsDryRun: true }`로 허용 도메인, 제한 시간(기본 180000ms, `--script-timeout`), 미리보기 지원을 선언합니다. 허용 도메인 밖의 탭에서는 시작하지 않고, 끝난 탭이 밖이면 `domainViolation`과 함께 실패합니다. 명령줄의 `--allowed-domain`도 같은 역할을 합니다.
- `--dry-run`은 `supportsDryRun`을 선언한 스니펫만 받으며, 스니펫은 `ctx.dryRun`이 `true`일 때 아무것도 바꾸지 않아야 합니다.
- `ctx`에는 `page`, `frame`(`--frame`으로 고른 범위), `context`와 `ctx`(같은 브라우저 컨텍스트), `browser`, `pages`, `args`(위치 인자·`--arg`·`--args JSON`, 모두 문자열), `params`(`--param 이름=값`·`--params JSON`), `helpers`와 `h`(같은 도구 묶음), `log(...)`(결과의 `logs`에 최근 50줄), `evidence(page)`(마지막 증거 화면으로 찍을 탭 지정), `dryRun`이 들어 있습니다.
- `--new-tab`은 새 탭에서 실행하고 끝나면 닫습니다(`--keep-tab`으로 유지).
- 확인창 정책, 쓰기 요청 기록, 쓰기 잠금, `--idem-key`, 중지 파일은 스니펫에도 적용됩니다. 다만 `observed`와 `--modal-confirm` 후처리는 적용되지 않으므로 스니펫이 직접 결과를 다시 읽어 반환합니다.
- 결과에는 파일 이름, `sha256`, 쓰기 선언 여부, `logs`, 쿼리를 뺀 최종 주소가 남고 감사 기록에도 해시가 남습니다.
- 증거 화면은 `ctx.evidence(page)`로 지정하는 것이 기본입니다. 전역 변수 `globalThis.__shotPage`(찍을 탭), `__shotPath`(저장 경로), `__fullPage`(전체 페이지), `__noShot`(찍지 않음)으로 지정하는 예전 형식 스니펫도 그대로 동작합니다.

`helpers`(`h`) 목록: `version`, `sleep`, `waitFor`, `waitText`, `bodyText`, `listFrames`, `resolveFrame`, `parseDialogPolicy`, `dismissedDecisions`, `watchWriteRequests`, `watchPopups`, `sessionState`, `normalizeWindow`, `screenshot`, `findByText`, `pickTextCandidate`, `hitCovered`, `selectorCovered`, `clickText`, `clickSelector`, `hover`, `setValue`, `selectExact`, `pickOption`, `setChecked`, `fieldByLabel`, `pageSignals`, `startToastWatch`, `stopToastWatch`, `dismissTopModal`, `findFrameWith`, `collectWhileScrolling`, `auditPage`, `primeForCapture`, `redactUrl`, `uploadFiles`, `downloadVia`, `captureResponses`, `summarizeResponses`, `fetchInPage`, `readTable`, `readList`, `inspectPage`, `ariaSnapshot`, `visibleModals`, `scrollUntil`, `validateForm`, `sniffFileKind`, `urlMatcher`, `siteOf`.

예시 스니펫(`count_rows.mjs`, 읽기 전용):

```js
export const mode = 'read';
export const meta = { allowedDomains: ['example.com'], timeoutMs: 60000 };

export default async ({ page, helpers, args, log }) => {
  const selector = args[0] || 'table';
  await helpers.waitFor(async () => (await page.locator(selector).count()) > 0, {
    timeout: 15000,
    message: `표가 보이지 않습니다: ${selector}`,
  });
  const rows = await helpers.readTable(page, selector);
  log('rows', rows.length);
  return { ok: rows.length > 1, rows: rows.length, header: rows[0] || [] };
};
```

`eval JS`는 쓰기 판정과 결과 관찰을 거치지 않으므로 값 확인 같은 읽기 용도로만 씁니다. 화면을 바꾸는 일은 고정 명령이나 `script --write`로 합니다.

## 상태 점검(ping, health)

```bash
node scripts/cu.mjs web ping
node scripts/cu.mjs web health
node scripts/cu.mjs web health --close-hung
```

- 두 명령은 Playwright 없이 CDP에 직접 묻고, Chrome을 새로 열지 않습니다. 마지막으로 기록된 연결 번호를 사용하며 `--profile`도 받습니다.
- `ping`은 연결 번호가 열린 것과 브라우저가 실제로 응답하는 것을 구분해 `alive`, `latencyMs`, `browser`, `windowsChrome`을 돌려줍니다.
- `health`는 모든 탭에 짧은 명령을 보내 멈춘 탭(`hungTabs`)을 찾습니다. 탭별 대기 시간은 `--tab-timeout-ms`(기본 6000)입니다. 멈춘 탭 하나가 Chrome 연결 전체를 막을 수 있으므로, 연결 실패가 반복되면 `health --close-hung`으로 멈춘 탭만 닫습니다.

## 실전 교훈

사이트에 상관없이 반복해서 확인된 일반 교훈입니다.

1. 버튼이 안 눌리는 것처럼 보이면 대개 숨은 확인 모달이나 오버레이가 덮고 있습니다. `clicktext`가 `code: "covered"`를 돌려주면 `modals`로 열린 창을 확인합니다. 낮은 z-index의 확인 모달도 있으므로 화면에 안 보인다고 없다고 판단하지 않습니다.
2. alert은 거절이 아닙니다. 알림창이 닫혔다고 작업이 거절된 것은 아니므로 `dialogs`의 메시지를 읽고 화면이나 목록을 다시 읽어 결과를 확인합니다. 반대로 confirm이 취소됐다면 작업이 실행되지 않았을 가능성이 큽니다.
3. 고정 시간 대기 대신 조건 대기를 씁니다. `waittext`, `waittext --gone`, `waitsel`, `waitsel --count N`, `waiturl`, `--expect`로 화면이 실제로 바뀐 것을 기다립니다.
4. "0건"은 로그인 만료나 남아 있는 필터·기간 조건일 수 있습니다. `session`, `fetch`의 `loginSuspected`, 다운로드의 `kind: "html"`, 화면의 필터 상태를 확인한 뒤에만 "데이터 없음"이라고 보고합니다.
5. 클릭 성공은 반영이 아닙니다. `outcome: "done"`이어도 저장된 값, 목록, 상태 글자를 다시 읽어 확인합니다.
6. 쓰기 요청이 보였으면 재시도하지 않습니다. `writeRequests`가 있거나 `outcome`이 `unknown`이면 이미 반영됐을 수 있으므로 조회로 먼저 확인합니다. 제출·등록처럼 중복되면 안 되는 작업에는 `--idem-key`를 붙입니다.
7. 로그인 스크립트를 만들지 않습니다. 자동 로그인 반복은 계정 잠금으로 이어질 수 있으므로 비밀번호 칸은 거부하고 `handoff`로 사람이 직접 로그인합니다.
8. 최소화되거나 너무 작게 줄어든 창은 캡처가 비거나 사이트가 목록을 0개로 그립니다. 증거 저장 전에 창 상태를 자동으로 복구하지만, 결과가 이상하면 `window` 또는 `window maximize` 뒤 다시 읽습니다.
9. 가상 목록은 내리면서 읽습니다. `collect`의 `reachedEnd`로 끝까지 읽었는지 확인합니다.
10. 원격 연결로 파일 내용을 보내는 업로드는 50MB 근처에서 실패합니다. 45MB를 넘는 파일은 Windows 경로를 Chrome이 직접 읽는 경로로 자동 전환되며, 결과의 `mode`와 `attached`로 확인합니다.
11. 여러 세션이 `web_last.png` 같은 같은 증거 파일을 덮어씁니다. 보고에는 작업마다 고유한 `evidence` 파일을 쓰고, 계정별 작업은 프로필을 나눕니다.
12. Windows PowerShell 5.1은 BOM 없는 `.ps1`을 시스템 코드 페이지로 읽어 한글이 깨집니다. 한글이 들어간 PowerShell 스크립트는 UTF-8 BOM으로 저장합니다.
13. 화면 이미지 픽셀과 CSS 픽셀은 다릅니다. 배율(DPR)이 1이 아니면 스크린샷 좌표로 클릭 위치를 계산할 수 없으므로 선택자·글자·라벨로 대상을 지정합니다. `capture`의 이미지 크기와 `manifest.json`의 `cssHeight`도 배율만큼 다릅니다.
14. 읽기만 해도 읽음 처리되는 화면이 있습니다. 메시지·알림·문의 상세를 여는 것만으로 상대방에게 읽음이 표시될 수 있으므로, 목록에서 확인할 수 있으면 상세를 열지 않고 꼭 열어야 하면 사용자가 그 영향을 알고 있어야 합니다.
15. 한 브라우저 안에서 계정을 바꾸지 않습니다. 계정마다 `--profile`을 나누고 `session "계정글자"`로 계정을 확인한 뒤 작업합니다.

## JSON 워크플로

브라우저 워크플로는 허용 도메인과 작업을 JSON recipe로 고정할 수 있습니다.

```json
{
  "schema": "browser.recipe.v1",
  "name": "account_check",
  "allowed_domains": ["example.com"],
  "start_url": "https://example.com/account",
  "driver": "cdp",
  "mode": "read_only",
  "profile": "work-a",
  "steps": [
    {"id": "login", "action": "session", "identity": "홍길동"},
    {"id": "logged_in", "action": "assertTextAny", "texts": ["로그아웃", "내 계정"]},
    {"id": "evidence", "action": "screenshot"}
  ],
  "extract": [
    {"id": "orders", "type": "table", "expect_nonzero": true},
    {"id": "items", "type": "collect", "item": ".list-item", "fields": {"title": ".title", "id": "@data-id"}, "key": "@data-id", "container": ".list-scroll", "max_steps": 60, "expect_nonzero": true},
    {"id": "summary", "type": "fetch", "url": "/api/summary"}
  ]
}
```

쓰기 recipe 예시:

```json
{
  "schema": "browser.recipe.v1",
  "name": "settings_update",
  "allowed_domains": ["example.com"],
  "start_url": "https://example.com/settings",
  "driver": "cdp",
  "mode": "write",
  "profile": "work-a",
  "steps": [
    {"id": "login", "action": "handoff", "reason": "로그인을 완료해 주세요", "identity": "홍길동", "timeout": 600000},
    {"id": "name", "action": "type", "label": "표시 이름", "value": "새 이름", "require_empty": false},
    {"id": "amount", "action": "setValue", "selector": "#amount", "value": "15000", "numeric": true},
    {"id": "kind", "action": "pick", "selector": "#kind", "value": "정확한 항목"},
    {"id": "notice", "action": "uncheck", "selector": "#notice"},
    {"id": "file", "action": "upload", "selector": "input[type=file]", "files": ["C:\\Users\\ME\\Documents\\sample.pdf"]},
    {"id": "save", "action": "clickSubmit", "selector": "#save", "modal_confirm": "저장하시겠습니까", "idem_key": "settings-save-001", "expect": {"text": "저장되었습니다"}}
  ]
}
```

```bash
node scripts/cu.mjs browser doctor
node scripts/cu.mjs browser login-check --recipe recipe.json --driver cdp --out shots/browser_check
node scripts/cu.mjs browser scrape --recipe recipe.json --driver cdp --out shots/browser_scrape
node scripts/cu.mjs browser run --recipe recipe.json --driver cdp --out shots/browser_run --confirm-browser-write
node scripts/cu.mjs browser audit shots/browser_run --check
```

`node scripts/cu.mjs browser ...`, `./scripts/cu browser ...`, `node scripts/browser_workflow.mjs ...`는 같은 워크플로를 실행합니다. `--profile 이름`을 주면 recipe의 `profile`보다 우선합니다.

```powershell
node .\scripts\browser_workflow.mjs login-check --recipe .\recipe.json --driver cdp --out .\shots\browser_check
node .\scripts\browser_workflow.mjs run --recipe .\recipe.json --driver cdp --out .\shots\browser_run --confirm-browser-write
node .\scripts\browser_workflow.mjs audit .\shots\browser_run --check
```

recipe 필드: `schema`(`browser.recipe.v1`), `name`, `allowed_domains`, `start_url`, `driver`(`cdp` 또는 `static`), `mode`, `profile`, `steps`, `extract`.

단계 동작:

| 구분 | 동작과 필드 |
|---|---|
| 읽기·이동 | `goto`(`url`), `reload`, `assertText`(`text`), `assertTextAny`(`texts`), `waitText`(`text`), `waitSelector`(`selector`, `count`, `state`), `hover`(`selector` 또는 `text`), `scroll`(`direction`, `selector`, `until_text`), `validate`(`selector`), `identify`(`text`), `screenshot`, `session`(`identity`), `handoff`(`reason`, `identity`, `until_url`, `timeout`) |
| 쓰기 | `type`·`setValue`(`selector` 또는 `label`, `value`), `select`·`pick`(`selector`, `value`), `check`·`uncheck`(`selector` 또는 `label`), `upload`(`selector`, `files` 또는 `value`), `click`(`selector` 또는 `text`), `clickSubmit`(`selector`, 검증 통과 후 클릭), `press`(`key`, `selector`), `dismiss`, `download`(`url` 또는 `selector`·`text`, `out`), `script`(`file`, `args`, `writes`) |

단계 옵션(snake_case로 쓰면 러너 옵션으로 옮겨집니다): `frame`, `label`, `nth`, `exact`, `within`, `dialog`, `confirm_dialog`, `modal_confirm`, `modal_button`, `expect_gone`, `expect_url`, `idem_key`, `mode`(`type`의 입력 방식 `fill`·`native`·`keys`), `require_empty`, `numeric`, `counter`, `via`(`pick`의 `keyboard`), `timeout`, `identity`, `until_url`, `count`, `state`, `force`. `expect: {"text": "..."}`는 러너의 `--expect`로 전달되고 단계가 끝난 뒤 한 번 더 확인합니다. `sensitive: true`인 단계는 `value`, `text`를 기록에서 가립니다.

추출 유형: `text`(`selector`), `table`(`selector`, `expect_nonzero`), `links`(`selector`), `fetch`(`url`, 허용 도메인 안에서만, `loginSuspected`이면 실패), `collect`(`item`, `fields`, `key`, `container`, `max_steps`, `expect_nonzero`; 목록 끝에 닿지 못하면 검토 항목으로 남김). `fetch`, `collect`는 `--driver cdp`가 필요합니다.

안전 규칙:

- 비어 있는 도메인, `*`, `com`, `*.com` 같은 넓은 허용 범위는 거부합니다. 시작 주소와 각 단계가 끝난 주소도 허용 도메인 안이어야 합니다.
- 쓰기 단계는 `"mode": "read_only"`가 아닌 recipe와 `--confirm-browser-write`, `--driver cdp`가 모두 있어야 합니다. 쓰기 recipe는 `"mode": "write"`처럼 모드를 명시합니다.
- `script` 단계는 쓰기 단계로 취급하며, `writes: false`일 때만 `--write` 없이 실행합니다. 파일 경로는 recipe 파일 위치 기준입니다.
- 쓰기 단계의 `outcome`이 `unknown`이면 검토 항목으로 남깁니다. 같은 recipe를 다시 실행하기 전에 결과를 확인하고, 중복되면 안 되는 단계에는 `idem_key`를 둡니다.
- 민감한 값은 recipe에 `sensitive: true`로 표시해 기록에서 가립니다.
- 실행 마지막에는 `screenshots/final.png`를 저장합니다.
- 완료 판단은 `audit ... --check`가 통과하고 필요한 화면 증거가 있을 때만 합니다.

산출물:

```text
shots/browser_YYYYMMDD_HHMMSS/
  manifest.json
  recipe.json
  pages.json
  steps.jsonl
  extracted/
  downloads/          (download 단계가 있을 때)
  screenshots/final.png
  audit.json
```

## 문제 해결

| 증상 | 확인과 조치 |
|---|---|
| Chrome이 열리지 않음 | Google Chrome과 Windows Node.js 설치를 확인합니다. `node scripts/cu.mjs web pages`를 다시 실행합니다. |
| Linux 또는 headless UA로 연결됨 | 이 구현은 해당 연결을 거부합니다. `state\chrome_cdp.json`의 UA가 `Windows NT`인지 확인합니다. |
| 기본 번호가 사용 중임 | 자동으로 다음 빈 번호를 찾습니다. 실제 번호는 `state\chrome_cdp.json`(이름 있는 프로필은 `chrome_cdp_이름.json`)에서 확인합니다. 번호를 외워서 입력할 필요는 없습니다. |
| Chrome 연결 실패가 반복됨 | 멈춘 탭이 연결을 막을 수 있습니다. `web health`로 확인하고 `web health --close-hung`으로 멈춘 탭만 닫습니다. |
| 대상 탭을 찾지 못함, `no_target` | `pages`로 탭을 확인하고 더 구분 가능한 `--url` 값을 지정합니다. 읽기/클릭 명령은 다른 탭으로 자동 대체되지 않습니다. |
| 선택한 탭이 닫혔거나 주소가 다름 | `pages` 또는 `goto`로 다시 고르거나 `unpin`으로 고정 탭을 풉니다. |
| `ambiguous` | 결과의 `candidates`를 보고 `--nth N`, `--within 선택자`, `--exact`, `--frame`을 지정합니다. |
| `covered` | `modals`로 덮고 있는 창을 확인하고 `--modal-confirm` 또는 `dismiss`로 처리합니다. 의도한 경우에만 `--force`를 씁니다. |
| `dialog_dismissed` | `dialogs`의 메시지를 읽고, 의도한 변경이면 `--confirm-dialog "문구"`로 그 확인창만 수락해 다시 실행합니다. |
| `duplicate` | 같은 `--idem-key` 작업이 이미 실행됐거나 결과가 불명입니다. 결과를 먼저 확인하고 정말 필요할 때만 `--repeat`를 붙입니다. |
| `busy` | 같은 Chrome에서 다른 쓰기 작업이 진행 중입니다. 끝난 뒤 다시 실행합니다. |
| `stopped` | 중지 파일이 있습니다. 사용자가 재개를 원할 때 `node scripts/cu.mjs resume`을 실행합니다. |
| `secret_field`, `not_empty` | 비밀번호 칸은 `handoff`로 사람이 입력합니다. 이미 내용이 있는 칸은 덮어쓸지 사용자에게 확인합니다. |
| `handoff_timeout`, `watchdog` | 사람이 창에서 완료했는지 확인한 뒤 다시 실행하거나 `--timeout`, `--watchdog-ms`를 늘립니다. |
| Chrome 연결은 되지만 창이 안 보임 | 전용 프로필 Chrome을 닫고 웹 명령을 다시 실행합니다. 자동 실행기는 유효한 Windows 창 핸들이 없는 연결을 정상으로 처리하지 않습니다. |
| 연결한 프로필의 Chrome이 자동화 연결 없이 열려 있음 | 프로젝트 밖 프로필은 강제로 종료하지 않습니다. 사람이 작업을 저장하고 그 Chrome 창을 닫은 뒤 다시 실행합니다. |
| 연결할 프로필 폴더가 없음 | 빈 프로필을 만들지 않고 멈춘 것입니다. `profile add --dir` 경로를 확인합니다. |
| 파일 업로드 경로 오류 | `C:\...` 형식의 Windows 절대 경로를 사용하고 파일 존재 여부를 확인합니다. |
| 다운로드 결과가 `kind: "html"` | 파일 대신 화면이 내려왔습니다. `session`으로 로그인 상태와 권한을 확인합니다. |
| 폼 제출이 막힘 | `validate` 결과, `maxlength`, 숫자 `step`, 연계 필드 순서, 세션 만료를 확인합니다. 필요하면 `reload` 후 다시 입력합니다. |
| reCAPTCHA가 만료됨 | 사람이 같은 식별 창에서 처리한 직후 최종 제출합니다. 자동으로 이미지 문제를 풀지 않습니다. |

문제 해결을 위해 일반 Chrome 전체를 강제 종료하지 않습니다. 전용 프로필 경로가 명확한 경우에만 해당 프로세스를 정리합니다.

## 검증

공개 ZIP 또는 공개 저장소만 받은 사용자는 다음 명령으로 자동 실행, Windows UA, 탭 목록, 화면 저장을 직접 확인할 수 있습니다.

```powershell
node scripts/cu.mjs web pages
node scripts/cu.mjs web ping
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action identify -Arg1 "자동화 확인 창"
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action shot -Arg1 "$env:TEMP\computer-use-web-check.png"
```

아래 항목은 테스트 파일이 포함된 전체 개발 저장소에서 유지보수자가 실행하는 회귀 검사입니다. 일반 사용자용 공개 ZIP에는 `scripts/test_*` 파일을 넣지 않습니다.

정적 회귀 검사:

```bash
node scripts/test_windows_chrome_cdp.mjs
node scripts/test_windows_chrome_cdp_adversarial.mjs
node scripts/test_browser_workflow.mjs
bash scripts/test_path_config.sh
```

Windows/WSL 실환경 검사:

```bash
node scripts/test_windows_chrome_cdp.mjs --live
node scripts/test_windows_chrome_cdp_adversarial.mjs --live
```

실환경 검사는 전용 자동화 Chrome만 재시작하고 다음을 확인합니다.

- 사용자 시작 명령 없이 새 Windows Chrome 창 생성
- Windows UA, 비-headless, 데스크톱 세션과 창 핸들
- 전용 프로필과 충돌 없는 연결 번호
- 한글 입력, 정확한 select, 체크박스, Windows 파일 업로드
- 빈 폼 차단과 입력 후 유효성 통과
- 식별 배너와 PNG 화면 증거
- 없는 대상 탭 거부
- 두 번째 명령의 프로세스/번호 재사용
- 러너 종료 뒤 Chrome 유지
- WSL 없는 Windows PowerShell 진입점 연결

### 적대적 시나리오 20개

`test_windows_chrome_cdp_adversarial.mjs`는 서로 다른 실패 조건 20개를 이름과 함께 검사합니다.

1. 외부 가이드 파일 없이 운영 문서가 완결되는지
2. 공개 내보내기에 핵심 구현 파일이 모두 포함되는지
3. 공개 WSL 보조 명령이 Windows 진입점을 호출하는지
4. JSON 워크플로가 WSL 없는 Windows를 지원하는지(공용 웹 클라이언트가 요청 파일로 `cu_web.ps1`을 호출)
5. CDP가 `127.0.0.1`에만 열리는지
6. 전용 프로필만 정리하고 일반 Chrome을 건드리지 않는지
7. 기본 연결 번호 충돌 시 다음 빈 번호를 찾는지
8. 잘못된 시작 주소와 비 HTTP 스킴을 거부하는지
9. Chrome 설치 위치 탐색 경로가 충분한지
10. Linux와 headless 응답을 정상 Windows Chrome으로 인정하지 않는지
11. 보이는 Windows 데스크톱 창만 허용하는지
12. 오래된 탭 ID를 PID와 연결 번호가 같을 때만 재사용하는지
13. Windows Node.js와 Playwright CDP 연결을 사용하는지
14. 없는 주소의 탭을 다른 탭으로 대체하지 않는지
15. 같은 주소 탭이 여러 개면 임의 선택을 거부하는지
16. CDP 고유 탭 ID가 주소 추정보다 우선하는지
17. 선택 목록이 정확히 일치하는 값만 허용하는지
18. 파일 업로드가 Windows 경로를 전달하고, 큰 파일은 `DOM.setFileInputFiles` 경로를 쓰는지
19. 제출 전에 버튼, 폼, 필드 유효성, 최대 길이를 검사하는지
20. 실제 공개 패키지가 통합 명령, 프로필 관리, 공용 웹 모듈까지 독립 실행 파일을 담고 개발·개인 산출물을 제외하는지

`--live`를 붙이면 이 20개 계약 검사 뒤에 실제 Windows Chrome 새 창, 한글 입력, 선택·체크·업로드, 폼 검증, 탭 고정, 화면 증거, 프로세스 재사용까지 추가로 실행합니다. `windows_public_release_smoke.ps1 -CheckChromeAutomation`은 별도로 공개 ZIP을 새 임시 폴더에 풀어 Windows 네이티브 직접 명령과 JSON 워크플로를 모두 확인합니다.

## MCP·Claude·Cowork 연동 방향

연동 시 브라우저 전체를 임의 코드 실행 도구로 공개하지 않습니다. 다음과 같은 제한된 도구 계약을 권장합니다.

- 읽기: `pages`, `read`, `find`, `inspect`, `frames`, `modals`, `session`, `table`, `collect`, `shot`
- 이동: 허용 도메인 안의 `goto`, `reload`
- 쓰기: `click`, `clicktext`, `type`, `setvalue`, `keys`, `select`, `pick`, `check`, `uncheck`, `upload`, `download`, `press`, `dismiss` (먼저 `--dry-run`, 결과로 `outcome`·`observed`·`writeRequests`·`evidence` 반환)
- 검증: `validate`, `assert`, `waittext`, `waitsel`, `waiturl`, `identify`, `capture`, `pageaudit`
- 사람 확인: `handoff`

`eval`, `script`, `fetch --write`는 임의 코드나 임의 요청이 되므로 일반 도구로 공개하지 않고, 검토한 스니펫만 이름으로 실행하게 합니다. MCP 서버는 `node scripts/cu.mjs web`을 호출하고 결과 JSON과 화면 증거 경로를 반환할 수 있습니다. MCP 서버 자체는 현재 이 패키지에 포함된 완성 기능이 아닙니다. 쓰기 도구는 허용 도메인, 사용자 확인, 민감 값 마스킹, 실행 감사 기록을 추가합니다. 로컬 개인용 모드는 `127.0.0.1` 안에서 별도 입력값 없이 유지하되, 외부 공개 모드는 로컬 화면을 그대로 노출하지 않고 계정, 권한, HTTPS, 감사 로그, 요청 제한을 가진 별도 서비스로 설계합니다.
