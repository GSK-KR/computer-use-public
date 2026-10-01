---
name: run-computer-use
description: 사용자가 Windows PC에서 하고 싶은 일(웹사이트 읽기·입력·업로드·다운로드·제출, 데스크톱 앱 조작, 카카오톡·위챗 백업, 결과 검수)을 이 프로젝트의 도구로 AI가 직접 관찰·조작·검증해 끝낼 때 사용한다. "이 프로젝트로 해 줘", "computer-use로 해 줘", "내 PC에서 이거 처리해 줘", 여러 작업 B/C/D를 맡기는 경우에도 사용한다. CAPTCHA·MFA 우회나 비밀번호 자동 입력에는 사용하지 않는다.
---

# Computer-Use 실행

## 절차

1. 프로젝트 루트의 `AGENTS.md`를 따른다.
2. `node scripts/ai_project_check.mjs --json`으로 패키지와 Windows 연결을 확인한다.
3. `docs/ai_agent_guide.md`에서 요청에 해당하는 절만 읽는다. 웹 작업은 `docs/browser_workflow_playbook.md`도 본다.
4. `node scripts/cu.mjs`로 관찰(`web read|inspect`, `windows`, `see`, `tree`) → 조작 → 검증(`--expect`, `assert`, `vassert`, 다시 읽기) 순서로 실행한다. GUI 작업은 병렬 실행하지 않는다.
5. 결과 JSON의 `ok`, `outcome`, 증거 파일과 manifest·audit로 확인한 뒤 보고한다.

## 선택 기준

- 웹: `node scripts/cu.mjs web ...` (계정별 `--profile`, 탭은 `--url`), 여러 단계는 `web script`, 반복 업무는 `browser_workflow.mjs` 레시피
- Windows 앱: `node scripts/cu.mjs windows|see|tree|find|click|type|key|clicktext|vassert ...`
- 카카오톡·위챗 백업과 결과 확인: `docs/ai_agent_guide.md`의 메신저 백업·완료 판정 절
- 패키지에 없는 새 기능: 지원되는 부분과 새 구현이 필요한 부분을 먼저 분리한다.

로그인·MFA·CAPTCHA(`web handoff`로 사람에게 넘김), 결제·삭제·공개 게시·발송, 모호한 대상, 외부 AI로 개인정보 전송이 필요한 지점에서만 사용자 확인을 요청한다. 작업이 시작됐다는 사실을 완료로 간주하지 않는다.
