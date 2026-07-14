#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

function usage() {
  console.log(`usage:
  node scripts/ai_project_check.mjs [--json|--text] [--require-windows] [--out FILE]

Checks whether this folder is a complete AI-transferable Computer-Use package.
It does not read or print chat contents.`);
}

const options = { json: true, requireWindows: false, out: '' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') options.json = true;
  else if (arg === '--text') options.json = false;
  else if (arg === '--require-windows') options.requireWindows = true;
  else if (arg === '--out') options.out = args[++i] || '';
  else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
  else if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  } else {
    console.error(`unknown option: ${arg}`);
    usage();
    process.exit(2);
  }
}
if (args.some((arg) => arg === '--out' || arg.startsWith('--out=')) && !options.out) {
  console.error('missing value for --out');
  process.exit(2);
}

function isFile(relativePath) {
  try {
    return statSync(join(rootDir, relativePath)).isFile();
  } catch {
    return false;
  }
}

function detectWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/iu.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function detectWindowsPowerShell() {
  if (process.platform === 'win32') return true;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  return result.status === 0;
}

const requiredFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.agents/skills/run-computer-use/SKILL.md',
  '.agents/skills/run-computer-use/agents/openai.yaml',
  '.claude/skills/run-computer-use/SKILL.md',
  'README.md',
  'docs/ai_agent_guide.md',
  'docs/browser_workflow_playbook.md',
  '1_백업_시작.bat',
  'scripts/ai_project_check.mjs',
  'scripts/doctor.mjs',
  'scripts/start_console.ps1',
  'scripts/computer_use_console_server.mjs',
  'scripts/chat_artifact_viewer_server.mjs',
  'scripts/browser_workflow.mjs',
  'scripts/chrome_cdp_runner.mjs',
  'scripts/cu_web.ps1',
  'scripts/ensure_windows_chrome_cdp.ps1',
  'scripts/wechat_windows_backup.mjs',
  'scripts/wechat_windows_batch.mjs',
  'scripts/kakao_regular_chat.mjs',
  'scripts/kakao_windows_batch.mjs',
  'scripts/kakao_openchat_windows_backup.mjs',
];

const missingFiles = requiredFiles.filter((file) => !isFile(file));
const isWsl = detectWsl();
const windowsPowerShell = detectWindowsPowerShell();
const windowsReachable = process.platform === 'win32' || (isWsl && windowsPowerShell);
const packageType = isFile('HANDOFF.md') || isFile('scripts/agent_runner.mjs') ? 'internal' : 'public';

function capability({ id, label, files, command, foreground = true, writes = true }) {
  const missing = files.filter((file) => !isFile(file));
  return {
    id,
    label,
    available: missing.length === 0,
    runtimeReady: missing.length === 0 && (!foreground || windowsReachable),
    foreground,
    writesLocalData: writes,
    command,
    missingFiles: missing,
  };
}

const capabilities = [
  capability({
    id: 'project-diagnostics',
    label: '패키지와 준비 상태 확인',
    files: ['scripts/ai_project_check.mjs', 'scripts/doctor.mjs'],
    command: 'node .\\scripts\\doctor.mjs --json',
    foreground: false,
    writes: false,
  }),
  capability({
    id: 'backup-console',
    label: '통합 백업과 결과 화면',
    files: ['1_백업_시작.bat', 'scripts/start_console.ps1', 'scripts/computer_use_console_server.mjs'],
    command: '.\\1_백업_시작.bat',
  }),
  capability({
    id: 'wechat-current-room',
    label: '현재 열린 위챗 방 백업',
    files: ['scripts/wechat_windows_backup.mjs'],
    command: 'node .\\scripts\\wechat_windows_backup.mjs --confirm-local-backup --max-frames 120',
  }),
  capability({
    id: 'wechat-all-visible',
    label: '위챗 왼쪽 목록 전체 백업',
    files: ['scripts/wechat_windows_batch.mjs'],
    command: 'node .\\scripts\\wechat_windows_batch.mjs --confirm-local-backup --all-visible --dry-run',
  }),
  capability({
    id: 'kakao-current-room',
    label: '현재 열린 카카오톡 방 백업',
    files: ['scripts/kakao_regular_chat.mjs'],
    command: 'node .\\scripts\\kakao_regular_chat.mjs chat-batch --confirm-local-backup --active-only --max-frames 40 --to-bottom',
  }),
  capability({
    id: 'kakao-all-visible',
    label: '카카오톡 왼쪽 목록 전체 백업',
    files: ['scripts/kakao_windows_batch.mjs'],
    command: 'node .\\scripts\\kakao_windows_batch.mjs --confirm-local-backup --all-visible --dry-run',
  }),
  capability({
    id: 'kakao-openchat',
    label: '카카오톡 오픈채팅과 댓글 백업',
    files: ['scripts/kakao_openchat_windows_backup.mjs'],
    command: 'node .\\scripts\\kakao_openchat_windows_backup.mjs --confirm-local-backup --title "방 제목" --to-bottom',
  }),
  capability({
    id: 'chat-results',
    label: '백업 결과 조회와 품질 확인',
    files: ['scripts/chat_artifact_viewer_server.mjs', 'scripts/chat_artifact_quality_audit.mjs'],
    command: '.\\1_백업_시작.bat',
    writes: false,
  }),
  capability({
    id: 'windows-chrome-workflow',
    label: '보이는 Windows Chrome 웹 자동화',
    files: ['scripts/browser_workflow.mjs', 'scripts/chrome_cdp_runner.mjs', 'scripts/cu_web.ps1', 'scripts/ensure_windows_chrome_cdp.ps1'],
    command: 'node .\\scripts\\browser_workflow.mjs doctor',
  }),
];

const warnings = [];
if (!windowsReachable) warnings.push('현재 세션에서 Windows 데스크톱에 연결할 수 없습니다. 실제 GUI 작업은 Windows PC의 프로젝트 루트에서 실행하세요.');
if (missingFiles.length) warnings.push('공개 ZIP 또는 프로젝트 파일이 일부 빠졌습니다. 폴더 전체를 다시 압축 해제하세요.');

const report = {
  schema: 'computer-use.ai-project-check.v1',
  status: missingFiles.length === 0 ? 'pass' : 'fail',
  package: {
    status: missingFiles.length === 0 ? 'pass' : 'fail',
    type: packageType,
    root: rootDir,
    externalGuideRequired: false,
    instructionFiles: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'],
    guide: 'docs/ai_agent_guide.md',
    missingFiles,
  },
  runtime: {
    platform: process.platform,
    session: process.platform === 'win32' ? 'windows-native' : (isWsl ? 'wsl' : 'non-windows'),
    node: process.version,
    windowsPowerShell,
    windowsReachable,
    wslRequired: false,
  },
  capabilities,
  safety: {
    localOnlyServer: true,
    cloudChatProcessingDefault: false,
    guiJobsMustBeSequential: true,
    captchaBypass: false,
  },
  warnings,
};

const output = options.json
  ? `${JSON.stringify(report, null, 2)}\n`
  : [
      `AI 전달 패키지: ${report.package.status === 'pass' ? '정상' : '파일 누락'}`,
      `실행 환경: ${report.runtime.session}, Windows 연결 ${windowsReachable ? '가능' : '불가'}`,
      `사용 가능 기능: ${capabilities.filter((item) => item.available).length}/${capabilities.length}`,
      ...warnings.map((warning) => `확인: ${warning}`),
    ].join('\n') + '\n';

if (options.out) writeFileSync(resolve(options.out), output, 'utf8');
else process.stdout.write(output);

if (missingFiles.length) process.exitCode = 1;
else if (options.requireWindows && !windowsReachable) process.exitCode = 2;
