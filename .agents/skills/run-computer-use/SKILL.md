---
name: run-computer-use
description: Windows의 이 프로젝트로 카카오톡·위챗 화면 백업, 백업 결과 검수, 보이는 Chrome 웹 읽기·입력·업로드·제출을 수행할 때 사용한다. 사용자가 "이 프로젝트로 해 줘", "computer-use를 사용해 줘", 여러 작업 B/C/D를 처리해 달라고 말한 경우에도 사용한다. 임의의 모든 데스크톱 앱 제어나 CAPTCHA 우회에는 사용하지 않는다.
---

# Computer-Use 실행

## 절차

1. 프로젝트 루트의 `AGENTS.md`를 따른다.
2. `node scripts/ai_project_check.mjs --json`으로 ZIP과 Windows 실행 가능 여부를 확인한다.
3. `docs/ai_agent_guide.md`에서 요청에 해당하는 절만 읽는다.
4. 기존 Windows 스크립트 또는 JSON 브라우저 워크플로를 실행한다. GUI 작업은 병렬 실행하지 않는다.
5. manifest, audit, 종료 코드, 필요한 화면 증거로 결과를 검증한 뒤 보고한다.

## 선택 기준

- 카카오톡·위챗 백업과 결과 확인: `docs/ai_agent_guide.md`의 채팅 백업·완료 판정 절
- 웹사이트 읽기·변경: 같은 문서의 Chrome 자동화 절과 `docs/browser_workflow_playbook.md`
- 패키지에 없는 새 기능: 지원되는 부분과 새 구현이 필요한 부분을 먼저 분리한다.

로그인, MFA, CAPTCHA, 결제·삭제·공개 게시, 모호한 대상, 외부 AI로 개인정보 전송이 필요한 지점에서만 사용자 확인을 요청한다. 작업이 시작됐다는 사실을 완료로 간주하지 않는다.
