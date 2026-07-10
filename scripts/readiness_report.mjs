#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from './lib/doctor.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '..');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    root: defaultRoot,
    outMd: '',
    outJson: '',
    open: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === '--root') args.root = argv[++i];
    else if (cur.startsWith('--root=')) args.root = cur.slice('--root='.length);
    else if (cur === '--out-md') args.outMd = argv[++i];
    else if (cur.startsWith('--out-md=')) args.outMd = cur.slice('--out-md='.length);
    else if (cur === '--out-json') args.outJson = argv[++i];
    else if (cur.startsWith('--out-json=')) args.outJson = cur.slice('--out-json='.length);
    else if (cur === '--open') args.open = true;
    else if (cur === '-h' || cur === '--help') {
      console.log(`usage:
  node scripts/readiness_report.mjs [--out-md FILE] [--out-json FILE] [--open]

Creates a KakaoTalk/WeChat backup readiness report without chat contents, room names,
or original screenshot file paths.`);
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${cur}`);
    }
  }
  args.root = resolve(args.root || defaultRoot);
  args.outMd = resolve(args.outMd || join(args.root, '준비_확인_보고서.md'));
  args.outJson = resolve(args.outJson || join(args.root, 'state', '준비_확인_보고서.json'));
  return args;
}

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'pass') return '준비됨';
  if (key === 'fail') return '시작 불가';
  return '확인 필요';
}

function cell(value) {
  const text = String(value ?? '').replace(/\|/gu, '/').replace(/[\r\n]+/gu, ' ').trim();
  return text || '-';
}

function reportMarkdown(report) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const beginnerIds = [
    'node',
    'powershell',
    'windows_ocr_ko',
    'windows_ocr_zh',
    'shots_writable',
    'state_writable',
    'runs_writable',
    'app_kakaotalk',
    'app_wechat',
  ];
  const mainChecks = beginnerIds
    .map((id) => checks.find((item) => item?.id === id))
    .filter(Boolean);
  const needs = mainChecks.filter((item) => item.status !== 'pass');
  const optionalNeeds = checks.filter((item) => item?.optional === true && item.status !== 'pass');
  const lines = [];

  lines.push('# 카카오톡/위챗 백업 준비 보고서');
  lines.push('');
  lines.push(`생성 시각: ${report.generated_at || new Date().toISOString()}`);
  lines.push(`전체 상태: ${statusLabel(report.status)}`);
  lines.push(`카카오톡: ${statusLabel(report.kakaoStatus)}`);
  lines.push(`위챗: ${statusLabel(report.wechatStatus)}`);
  lines.push('');
  lines.push('이 보고서는 백업 전에도 만들 수 있습니다. 채팅 본문, 방 이름, 원본 스크린샷 파일 경로는 넣지 않습니다.');
  lines.push('지원 담당자가 요청했을 때만 JSON 보고서를 전달하세요.');
  lines.push('');
  lines.push('## 바로 필요한 조치');
  lines.push('');
  if (!needs.length) {
    lines.push('카카오톡/위챗 지금 열린 방 백업에 필요한 핵심 항목은 준비됐습니다.');
  } else {
    lines.push('| 상태 | 항목 | 결과 | 다음 조치 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of needs) {
      lines.push(`| ${cell(statusLabel(item.status))} | ${cell(item.label)} | ${cell(item.message)} | ${cell(item.action)} |`);
    }
  }
  lines.push('');
  lines.push('## 핵심 항목 전체');
  lines.push('');
  lines.push('| 상태 | 항목 | 결과 |');
  lines.push('| --- | --- | --- |');
  for (const item of mainChecks) {
    lines.push(`| ${cell(statusLabel(item.status))} | ${cell(item.label)} | ${cell(item.message)} |`);
  }
  lines.push('');
  lines.push('## 선택 기능');
  lines.push('');
  if (!optionalNeeds.length) {
    lines.push('선택 기능도 추가 확인 없이 사용할 수 있습니다.');
  } else {
    lines.push('예전 백업 파일 검사나 추가 검수 같은 특별한 작업을 쓸 때만 아래 항목을 준비하면 됩니다.');
    lines.push('');
    lines.push('| 상태 | 항목 | 다음 조치 |');
    lines.push('| --- | --- | --- |');
    for (const item of optionalNeeds) {
      lines.push(`| ${cell(statusLabel(item.status))} | ${cell(item.label)} | ${cell(item.action)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function openFile(file) {
  let command = '';
  let args = [];
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', file];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [file];
  } else {
    command = 'xdg-open';
    args = [file];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}

const args = parseArgs();
console.log('준비 보고서를 만듭니다. 채팅 본문, 방 이름, 원본 스크린샷 파일 경로는 보고서에 넣지 않습니다.');
const report = await runDoctor();
mkdirSync(dirname(args.outMd), { recursive: true });
mkdirSync(dirname(args.outJson), { recursive: true });
writeFileSync(args.outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
writeFileSync(args.outMd, `\uFEFF${reportMarkdown(report)}`, 'utf8');
console.log(`보고서 파일: ${args.outMd}`);
console.log('채팅 내용 없이 준비 상태만 저장했습니다.');
if (args.open && existsSync(args.outMd)) openFile(args.outMd);
