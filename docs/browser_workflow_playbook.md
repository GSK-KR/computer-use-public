# Windows Chrome 웹 자동화 운영 안내

이 문서는 `computer-use`가 웹 작업을 수행할 때 사용하는 Windows Chrome/CDP 구조와 검증 절차를 설명합니다. 대상 사용 환경은 Windows이며 WSL은 선택 사항입니다. 화면을 사람이 확인해야 하는 로그인, 폼, 파일 업로드, reCAPTCHA 단계에서는 WSL/WSLg Chrome이나 headless 브라우저를 사용하지 않습니다.

이 프로젝트 밖의 별도 Chrome 자동화 가이드는 필요하지 않습니다. 공개 저장소와 공개 ZIP에도 이 문서, `scripts/cu_web.ps1`, `scripts/ensure_windows_chrome_cdp.ps1`, `scripts/chrome_cdp_runner.mjs`, `scripts/browser_workflow.mjs`가 함께 들어갑니다. 폴더 전체를 전달하면 설치, 실행, 문제 해결, JSON 워크플로, 연동 방향까지 이 문서만으로 이어서 사용할 수 있습니다.

## 핵심 동작

- 웹 작업을 시작하면 Windows Chrome이 자동으로 열립니다. Chrome을 먼저 켜는 BAT나 별도 시작 명령은 필요하지 않습니다.
- 일반 Chrome과 분리된 `state\chrome-cdp-profile` 전용 프로필을 사용합니다.
- 기본 연결 번호는 `9224`입니다. 사용 중이면 다음 번호를 자동으로 찾아 `state\chrome_cdp.json`에 기록합니다.
- 연결 대상은 `Chrome/...`, `Windows NT`, 비-headless UA를 모두 만족해야 합니다.
- 전용 프로필의 루트 Chrome 프로세스와 Windows 데스크톱 창 핸들을 확인합니다.
- 브라우저 조작은 Windows Node.js와 Playwright CDP 연결로 실행합니다. 파일 업로드에도 Windows 경로를 그대로 사용합니다.
- 주소 일부를 지정한 경우 일치하는 탭만 조작합니다. 선택한 탭의 CDP 고유 ID는 `state\chrome_cdp_target.json`에 저장해 다음 명령이 정확히 같은 탭을 재사용합니다. Chrome PID가 바뀌면 오래된 ID는 사용하지 않습니다.
- `goto`에서 대상 탭이 없을 때만 새 탭을 만듭니다.
- 상태를 바꾸는 작업 뒤에는 대상 탭을 앞으로 가져오고 `shots\web_last.png`를 저장합니다.
- 작업 명령이 끝나도 실제 Chrome은 닫히지 않습니다. 다음 명령이 같은 창과 연결 번호를 재사용합니다.

## 실행 구조

웹 명령 한 번의 내부 흐름은 다음과 같습니다.

1. `scripts/cu_web.ps1`이 경로 설정을 읽습니다.
2. `scripts/ensure_windows_chrome_cdp.ps1`이 기존 전용 Chrome과 사용 가능한 연결 번호를 찾습니다.
3. 재사용할 창이 없으면 Windows 대화형 세션에 Google Chrome을 새 창으로 엽니다.
4. CDP 응답, Windows UA, 전용 프로필 프로세스, 보이는 창을 검증합니다.
5. `scripts/chrome_cdp_runner.mjs`를 Windows Node.js로 실행합니다.
6. 러너가 대상 탭을 명시적으로 선택해 작업하고 화면 증거를 저장합니다.
7. CDP 연결만 끊고 Chrome 창은 유지합니다.

Chrome 실행 파일은 환경 변수 `CU_CHROME_PATH`, Windows App Paths 레지스트리, Program Files, 사용자 LocalAppData 순서로 찾습니다. 일반 Chrome 프로필의 프로세스는 종료하지 않습니다. 새 연결을 막는 오래된 프로세스가 있더라도 전용 `chrome-cdp-profile`을 사용하는 프로세스만 정리합니다.

## 준비 사항

필수 항목:

- Windows 10 또는 Windows 11
- Google Chrome
- Windows Node.js LTS
- Windows PowerShell 5.1 이상

WSL은 필수가 아닙니다. WSL이나 bash가 있으면 기존 `cu web` 명령을 사용할 수 있고, 없으면 Windows PowerShell 진입점을 직접 사용할 수 있습니다. 둘 다 같은 자동 실행기와 러너를 사용합니다.

Playwright 실행 모듈은 다음 순서로 찾습니다.

1. 프로젝트에서 이미 사용할 수 있는 `playwright-core`
2. `CU_PLAYWRIGHT_CORE_PATH`
3. `state\browser-runtime`
4. 이전 설치 호환 경로

어디에도 없으면 첫 웹 작업 때 `state\browser-runtime`에 `playwright-core`를 자동 준비합니다. 이때만 인터넷 연결과 npm 사용이 필요할 수 있습니다. Chrome 브라우저 바이너리를 별도로 내려받지는 않습니다.

## 기본 명령

WSL 또는 bash 환경:

```bash
./scripts/cu web pages
./scripts/cu web goto https://example.com
./scripts/cu web read --url example.com
./scripts/cu web find "찾을 글자" --url example.com
./scripts/cu web click '#save' --url example.com
./scripts/cu web clicktext '저장' --url example.com
./scripts/cu web type '#name' '홍길동' --url example.com
./scripts/cu web select '#kind' '정확한 항목' --url example.com
./scripts/cu web check '#agree' --url example.com
./scripts/cu web upload '#file' 'C:\Users\ME\Documents\sample.pdf' --url example.com
./scripts/cu web validate '#submit' --url example.com
./scripts/cu web identify 'Computer-Use 작업 창' --url example.com
./scripts/cu web shot 'C:\Temp\final.png' --url example.com
```

WSL이 없는 Windows PowerShell:

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action pages
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action goto -Arg1 https://example.com
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action read -Url example.com
```

위 명령은 작업 명령이면서 자동 시작 진입점입니다. `ensure_windows_chrome_cdp.ps1`을 사용자가 따로 실행할 필요가 없습니다.

## 대상 탭 선택

`--url` 또는 PowerShell의 `-Url`에는 전체 주소 대신 구분 가능한 주소 일부를 지정할 수 있습니다.

```bash
./scripts/cu web read --url account.example.com
```

규칙:

- 일치하는 탭이 있으면 그 탭만 사용합니다.
- 이미 고정한 탭 ID가 있으면 같은 주소의 탭이 여러 개여도 그 탭만 사용합니다. 아직 고정한 탭이 없고 일치 항목이 여러 개면 임의로 고르지 않고 실패하므로 경로까지 포함한 더 구체적인 주소 일부를 지정합니다.
- 일치하는 탭이 없으면 `read`, `click`, `type`, `select`, `upload` 등은 실패합니다.
- `goto`만 새 탭을 만들 수 있습니다.
- 작업 창이 여러 개라 사람이 보는 창과 자동화 창이 헷갈리면 `identify`로 눈에 띄는 배너를 표시합니다.
- 비가역 작업 전에는 `pages`, `read`, `identify`, `shot`으로 대상 창을 다시 확인합니다.

## 폼 입력 원칙

### 텍스트와 숫자

기본 입력은 Playwright `fill`을 사용하므로 `input` 이벤트가 발생합니다. 숫자 필드는 화면의 단위와 HTML `step`을 함께 확인합니다. `type=number`에서 `step` 기본값이 1이면 소수가 유효하지 않을 수 있습니다.

### 선택 목록

`select`는 옵션의 실제 값 또는 화면 글자가 완전히 일치할 때만 선택합니다. `과세`와 `과세 대상`처럼 부분 일치가 가능한 항목은 자동으로 고르지 않습니다. 연계 선택 목록은 상위 항목을 먼저 바꾼 뒤 하위 옵션을 다시 확인합니다.

### 체크박스와 커스텀 컨트롤

일반 체크박스는 `check`를 사용합니다. 사이트가 자체 UI만 보이고 실제 input을 숨긴 경우에는 먼저 DOM 구조와 라벨 연결을 확인합니다. 무조건 좌표 클릭으로 우회하지 않습니다.

### 읽기 전용 필드

주소 검색처럼 사이트가 의도적으로 `readonly`로 둔 필드는 해당 사이트의 정상 입력 흐름을 우선 사용합니다. 기술적으로 속성을 제거할 수 있더라도 서버 검증이나 연계 필드가 깨질 수 있으므로, 사이트별로 검토한 경우에만 제한적으로 처리합니다.

### 파일 업로드

Windows Node.js가 실행하므로 `setInputFiles`에는 Windows 경로를 전달합니다.

```bash
./scripts/cu web upload 'input[type=file]' 'C:\Users\ME\Documents\proposal.pdf' --url example.com
```

상대 경로를 쓸 때는 Windows 프로젝트 폴더가 기준입니다. 재현성을 높이려면 절대 Windows 경로를 사용합니다.

### 제출 전 검증

제출 버튼을 누르기 전에 반드시 `validate`를 실행합니다.

```bash
./scripts/cu web validate '#submit' --url example.com
```

검사는 제출 버튼이 속한 form의 활성 `input`, `select`, `textarea`를 대상으로 다음을 확인합니다.

- `checkValidity()` 실패 필드와 브라우저의 `validationMessage`
- 현재 값 길이가 `maxlength`를 넘은 필드

JSON recipe의 `clickSubmit`도 이 검사를 먼저 실행하며 실패하면 클릭을 차단합니다. `select` 변경 핸들러가 다른 입력값을 지우는 사이트에서는 select를 먼저 선택하고 텍스트를 나중에 입력한 뒤 다시 검증합니다.

## 세션과 제출

- 폼을 오래 열어 둔 뒤 `잘못된 접근`, 무한 로딩, CSRF 오류가 나오면 `reload` 후 전체 값을 다시 입력합니다.
- 서버가 해시 형태의 필드명이나 세션별 토큰을 쓰는 경우 이전 DOM 값을 재사용하지 않습니다.
- 제출 직전 `validate`, `read`, `shot`으로 현재 상태를 확인합니다.
- 결제, 송금, 계약, 계정 삭제, 최종 접수처럼 비가역적인 작업은 별도 사람 확인을 유지합니다.

## reCAPTCHA

reCAPTCHA 체크와 이미지 문제는 사람이 보이는 Windows Chrome에서 직접 처리합니다. 자동화 도구는 이미지 문제를 풀거나 우회하지 않습니다.

권장 역할 분담:

1. 자동화가 일반 필드와 첨부 파일을 채웁니다.
2. `validate`와 스크린샷으로 누락을 확인합니다.
3. 사람이 같은 창에서 reCAPTCHA를 처리합니다.
4. 토큰 만료를 피하도록 사람이 최종 제출을 즉시 확인하거나 실행합니다.

사람이 보고 있는 창과 자동화 연결 창이 다를 수 있으면 `identify` 배너가 보이는지 먼저 확인합니다.

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
  "steps": [
    {"id": "logged_in", "action": "assertTextAny", "texts": ["로그아웃", "내 계정"]},
    {"id": "evidence", "action": "screenshot"}
  ],
  "extract": [
    {"id": "orders", "type": "table", "expect_nonzero": true}
  ]
}
```

```bash
./scripts/cu browser doctor
./scripts/cu browser login-check --recipe recipe.json --driver cdp --out shots/browser_check
./scripts/cu browser scrape --recipe recipe.json --driver cdp --out shots/browser_scrape
./scripts/cu browser run --recipe recipe.json --driver cdp --out shots/browser_run --confirm-browser-write
./scripts/cu browser audit shots/browser_run
```

WSL이 없는 Windows에서는 Windows Node.js로 같은 워크플로 파일을 직접 실행합니다.

```powershell
node .\scripts\browser_workflow.mjs login-check --recipe .\recipe.json --driver cdp --out .\shots\browser_check
node .\scripts\browser_workflow.mjs run --recipe .\recipe.json --driver cdp --out .\shots\browser_run --confirm-browser-write
node .\scripts\browser_workflow.mjs audit .\shots\browser_run
```

안전 규칙:

- 비어 있는 도메인, `*`, `com`, `*.com` 같은 넓은 허용 범위는 거부합니다.
- 쓰기 작업은 읽기 전용이 아닌 recipe와 `--confirm-browser-write`가 모두 있어야 합니다.
- 민감한 값은 recipe에 `sensitive: true`로 표시해 기록에서 가립니다.
- 실행 마지막에는 `screenshots/final.png`를 저장합니다.

산출물:

```text
shots/browser_YYYYMMDD_HHMMSS/
  manifest.json
  recipe.json
  pages.json
  steps.jsonl
  extracted/
  screenshots/final.png
  audit.json
```

## 문제 해결

| 증상 | 확인과 조치 |
|---|---|
| Chrome이 열리지 않음 | Google Chrome과 Windows Node.js 설치를 확인합니다. `cu web pages` 또는 `cu_web.ps1 -Action pages`를 다시 실행합니다. |
| Linux 또는 headless UA로 연결됨 | 이 구현은 해당 연결을 거부합니다. `state\chrome_cdp.json`의 UA가 `Windows NT`인지 확인합니다. |
| 기본 번호가 사용 중임 | 자동으로 다음 빈 번호를 찾습니다. 실제 번호는 `state\chrome_cdp.json`에서 확인합니다. 번호를 외워서 입력할 필요는 없습니다. |
| 대상 탭을 찾지 못함 | `pages`로 탭을 확인하고 더 구분 가능한 `--url` 값을 지정합니다. 읽기/클릭 명령은 다른 탭으로 자동 대체되지 않습니다. |
| Chrome 연결은 되지만 창이 안 보임 | 전용 프로필 Chrome을 닫고 웹 명령을 다시 실행합니다. 자동 실행기는 유효한 Windows 창 핸들이 없는 연결을 정상으로 처리하지 않습니다. |
| 파일 업로드 경로 오류 | `C:\...` 형식의 Windows 절대 경로를 사용하고 파일 존재 여부를 확인합니다. |
| 폼 제출이 막힘 | `validate` 결과, `maxlength`, 숫자 `step`, 연계 필드 순서, 세션 만료를 확인합니다. 필요하면 `reload` 후 다시 입력합니다. |
| reCAPTCHA가 만료됨 | 사람이 같은 식별 창에서 처리한 직후 최종 제출합니다. 자동으로 이미지 문제를 풀지 않습니다. |

문제 해결을 위해 일반 Chrome 전체를 강제 종료하지 않습니다. 전용 프로필 경로가 명확한 경우에만 해당 프로세스를 정리합니다.

## 검증

공개 ZIP 또는 공개 저장소만 받은 사용자는 다음 명령으로 자동 실행, Windows UA, 탭 목록, 화면 저장을 직접 확인할 수 있습니다.

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\cu_web.ps1 -Action pages
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
4. JSON 워크플로가 WSL 없는 Windows를 지원하는지
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
18. 파일 업로드가 Windows 경로를 전달하는지
19. 제출 전에 버튼, 폼, 필드 유효성, 최대 길이를 검사하는지
20. 실제 공개 패키지가 독립 실행 파일을 담고 개발·개인 산출물을 제외하는지

`--live`를 붙이면 이 20개 계약 검사 뒤에 실제 Windows Chrome 새 창, 한글 입력, 선택·체크·업로드, 폼 검증, 탭 고정, 화면 증거, 프로세스 재사용까지 추가로 실행합니다. `windows_public_release_smoke.ps1 -CheckChromeAutomation`은 별도로 공개 ZIP을 새 임시 폴더에 풀어 Windows 네이티브 직접 명령과 JSON 워크플로를 모두 확인합니다.

## MCP·Claude·Cowork 연동 방향

연동 시 브라우저 전체를 임의 코드 실행 도구로 공개하지 않습니다. 다음과 같은 제한된 도구 계약을 권장합니다.

- 읽기: `pages`, `read`, `find`, `shot`
- 이동: 허용 도메인 안의 `goto`, `reload`
- 쓰기: `click`, `type`, `select`, `check`, `upload`
- 검증: `validate`, `assert`, `identify`

MCP 서버는 `cu_web.ps1`을 호출하고 결과 JSON과 화면 증거 경로를 반환할 수 있습니다. 쓰기 도구는 허용 도메인, 사용자 확인, 민감 값 마스킹, 실행 감사 기록을 추가합니다. 로컬 개인용 모드는 `127.0.0.1` 안에서 별도 입력값 없이 유지하되, 외부 공개 모드는 로컬 화면을 그대로 노출하지 않고 계정, 권한, HTTPS, 감사 로그, 요청 제한을 가진 별도 서비스로 설계합니다.
