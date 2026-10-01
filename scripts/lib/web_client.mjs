// 웹 명령 공용 클라이언트. Windows 네이티브와 WSL 모두 cu_web.ps1을 같은 방식으로 부른다.
// 글자·선택자·옵션은 명령줄 대신 UTF-8 요청 파일로 넘겨 한글과 따옴표가 깨지지 않게 한다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPathConfig, wslPathToWindows } from './path_config.mjs';

const libDir = fileURLToPath(new URL('.', import.meta.url));
const scriptsDir = resolve(libDir, '..');

export function toWindowsPath(file) {
  const value = String(file || '').trim();
  if (!value) return '';
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) return value;
  const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value);
  return process.platform === 'win32' ? absolute : wslPathToWindows(absolute);
}

function lastJson(text) {
  const lines = String(text || '').trim().split(/\r?\n/u).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

// request: { action, arg1, arg2, url, profile, profileDir, options }
export function runWebAction(request, { port, noAutostart = false, timeoutMs = 300000, config = loadPathConfig() } = {}) {
  const isWin = process.platform === 'win32';
  const stateLocal = isWin ? config.stateDirWin : config.stateDirWsl;
  const tmpDir = join(stateLocal, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const name = `web_req_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.json`;
  const local = join(tmpDir, name);
  writeFileSync(local, JSON.stringify(request), 'utf8');
  const requestWin = isWin ? local : `${config.stateDirWin}\\tmp\\${name}`;
  const script = isWin ? join(scriptsDir, 'cu_web.ps1') : `${config.scriptsDirWin}\\cu_web.ps1`;
  try {
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', request.action, '-RequestFile', requestWin, '-Port', String(port || config.chromeCdpPort)];
    if (noAutostart || process.env.CU_CHROME_CDP_AUTOSTART === '0') args.push('-NoAutoStart');
    const result = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
    const stdout = String(result.stdout || '').replace(/\r/gu, '');
    const stderr = String(result.stderr || '').replace(/\r/gu, '');
    const parsed = lastJson(stdout);
    return { ok: result.status === 0 && parsed?.ok !== false, status: result.status ?? 1, stdout, stderr, parsed };
  } finally {
    rmSync(local, { force: true });
  }
}
