import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { loadPathConfig } from './path_config.mjs';

const validName = /^[a-z][a-z0-9_-]*$/u;
const terminalStatuses = new Set(['pass', 'fail', 'stopped']);
const risky = new Set(['write', 'destructive', 'cloud']);
let wslAvailableCache = false;
const wslToolCache = new Map();

function timestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isoNow() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.includes(`..${sep}`));
}

function normalizeRisk(risk) {
  const values = Array.isArray(risk) ? risk : [risk || 'read'];
  return [...new Set(values.map((it) => String(it).trim()).filter(Boolean))];
}

function hasConfirmationRisk(risk) {
  return risk.some((it) => risky.has(it));
}

function makeError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, details);
  return err;
}

function windowsWslAvailable() {
  if (process.platform !== 'win32') return true;
  if (wslAvailableCache) return true;
  const result = spawnSync('wsl.exe', ['-e', 'sh', '-lc', 'printf ok'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  const ok = result.status === 0 && String(result.stdout || '').trim() === 'ok';
  if (ok) wslAvailableCache = true;
  return ok;
}

const wslToolProbes = {
  node: { label: '고급 기능 실행 도구', command: 'node --version' },
  jq: { label: '고급 기능 자료 처리 도구', command: 'jq --version' },
  sqlite: { label: '예전 파일 확인 도구', command: 'sqlite3 --version' },
  tesseract: { label: '고급 문자 인식 도구', command: 'tesseract --version' },
  imagemagick: { label: '고급 이미지 처리 도구', command: 'command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1' },
};

function windowsWslToolAvailable(name) {
  if (process.platform !== 'win32') return true;
  if (wslToolCache.get(name)) return true;
  const probe = wslToolProbes[name];
  if (!probe) return true;
  const result = spawnSync('wsl.exe', ['-e', 'bash', '-lc', probe.command], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const ok = result.status === 0;
  if (ok) wslToolCache.set(name, true);
  return ok;
}

export function expectedConfirmation(module, action, risk) {
  return `confirm:${module}:${action}:${normalizeRisk(risk).join('+')}`;
}

export function defaultJobCatalog(pathConfig = loadPathConfig()) {
  const repo = process.platform === 'win32' ? pathConfig.repoRootWin : pathConfig.repoRootWsl;
  const cuScriptWsl = `${pathConfig.windowsScriptsDirWsl || pathConfig.scriptsDirWsl}/cu`;
  const cu = process.platform === 'win32'
    ? ['wsl.exe', '-e', 'bash', cuScriptWsl]
    : ['bash', join(repo, 'scripts', 'cu')];
  const kakaoWindowsRequirements = ['windows', 'windows_ocr_ko', 'kakaotalk'];
  const wechatWindowsRequirements = ['windows', 'windows_ocr_zh', 'wechat'];
  const kakaoRequirements = process.platform === 'win32' ? kakaoWindowsRequirements : ['wsl', 'ocr', 'kakaotalk'];
  const wechatRequirements = process.platform === 'win32' ? wechatWindowsRequirements : ['wsl', 'ocr', 'wechat'];
  const intParam = (value, label, fallback, min, max) => {
    const raw = value === undefined || value === null || value === '' ? fallback : value;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw makeError('BAD_PARAMS', `${label} 항목은 ${min}~${max} 사이의 정수로 입력하세요.`);
    }
    return n;
  };
  const textParam = (value, name, { required = false, max = 120 } = {}) => {
    const text = String(value || '').trim();
    if (required && !text) throw makeError('BAD_PARAMS', `${name} 항목을 입력하세요.`);
    if (text.length > max) throw makeError('BAD_PARAMS', `${name} 항목은 ${max}자 이하로 입력하세요.`);
    return text;
  };
  const psSingle = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`;
  const psArray = (values) => `@(${values.map(psSingle).join(', ')})`;
  const assertCuRuntime = (requirements = []) => {
    if (process.platform === 'win32' && !windowsWslAvailable()) {
      throw makeError(
        'MISSING_WSL',
        '이 선택 기능은 고급 실행 환경이 필요합니다. 기본 카카오톡/위챗 화면 백업은 백업 화면의 기본 버튼을 사용하세요.',
        { requirement: 'wsl' },
      );
    }
    for (const requirement of requirements) {
      if (process.platform === 'win32' && !windowsWslToolAvailable(requirement)) {
        const label = wslToolProbes[requirement]?.label || requirement;
        throw makeError(
          'MISSING_WSL_TOOL',
          `이 선택 기능은 ${label}가 필요합니다. 기본 카카오톡/위챗 화면 백업은 백업 화면의 기본 버튼을 사용하세요.`,
          { requirement },
        );
      }
    }
  };
  const cuJob = (args, requirements = ['node', 'jq']) => {
    assertCuRuntime(requirements);
    return { command: [...cu, ...args], cwd: repo };
  };
  const kakaoOpenWindowsJob = ({ maxFrames, toBottom } = {}) => {
    const frames = intParam(maxFrames, '캡처 수', 40, 1, 500);
    if (process.platform !== 'win32') {
      const args = ['kakao', 'chat-batch', '--confirm-local-backup', '--max-frames', String(frames)];
      if (toBottom !== false) args.push('--to-bottom');
      return cuJob(args, ['node', 'jq']);
    }
    const command = [
      process.execPath,
      join(repo, 'scripts', 'kakao_regular_chat.mjs'),
      'chat-batch',
      '--confirm-local-backup',
      '--max-frames',
      String(frames),
    ];
    if (toBottom !== false) command.push('--to-bottom');
    return { command, cwd: repo };
  };
  const kakaoVisibleRoomJob = ({ pattern, maxFrames, toBottom } = {}) => {
    const query = textParam(pattern, '카카오톡 방 이름', { required: true, max: 80 });
    const frames = intParam(maxFrames, '캡처 수', 40, 1, 500);
    if (process.platform !== 'win32') {
      const args = ['kakao', 'chat-batch', '--confirm-local-backup', '--open-visible', query, '--max-frames', String(frames)];
      if (toBottom !== false) args.push('--to-bottom');
      return cuJob(args, ['node', 'jq']);
    }
    const command = [
      process.execPath,
      join(repo, 'scripts', 'kakao_regular_chat.mjs'),
      'chat-batch',
      '--confirm-local-backup',
      '--open-visible',
      query,
      '--max-frames',
      String(frames),
    ];
    if (toBottom !== false) command.push('--to-bottom');
    return { command, cwd: repo };
  };
  const kakaoVisibleBatchJob = ({ pages, roomLimit, maxFrames, roomRetries, dryRun, allVisible, toBottom } = {}) => {
    const fullList = allVisible !== false;
    const pageCount = intParam(pages, '페이지 수', fullList ? 80 : 1, 1, 200);
    const rooms = intParam(roomLimit, '방 개수', fullList ? 200 : 5, 1, 500);
    const frames = intParam(maxFrames, '캡처 수', fullList ? 120 : 40, 1, 500);
    const retries = intParam(roomRetries, '방 재시도 횟수', 1, 0, 5);
    if (process.platform !== 'win32') {
      const args = ['kakao', 'chat-batch', '--confirm-local-backup', '--max-frames', String(frames)];
      if (toBottom !== false) args.push('--to-bottom');
      return cuJob(args, ['node', 'jq']);
    }
    const command = [
      process.execPath,
      join(repo, 'scripts', 'kakao_windows_batch.mjs'),
      '--confirm-local-backup',
      '--pages',
      String(pageCount),
      '--room-limit',
      String(rooms),
      '--max-frames',
      String(frames),
      '--room-retries',
      String(retries),
    ];
    if (fullList) command.push('--all-visible');
    if (dryRun) command.push('--dry-run');
    if (toBottom !== false) command.push('--to-bottom');
    return { command, cwd: repo };
  };
  const kakaoOpenchatJob = ({ title, maxFrames, threadMaxFrames, toBottom } = {}) => {
    const room = textParam(title, '오픈채팅 제목', { required: true, max: 120 });
    const frames = intParam(maxFrames, '본문 캡처 수', 80, 1, 500);
    const threadFrames = intParam(threadMaxFrames, '댓글 캡처 수', 20, 1, 200);
    if (process.platform !== 'win32') {
      const args = [
        'kakao',
        'openchat',
        '--title',
        room,
        '--max-frames',
        String(frames),
        '--thread-max-frames',
        String(threadFrames),
      ];
      if (toBottom !== false) args.push('--to-bottom');
      return cuJob(args, ['node', 'jq']);
    }
    const command = [
      process.execPath,
      join(repo, 'scripts', 'kakao_openchat_windows_backup.mjs'),
      '--confirm-local-backup',
      '--title',
      room,
      '--max-frames',
      String(frames),
      '--thread-max-frames',
      String(threadFrames),
    ];
    if (toBottom !== false) command.push('--to-bottom');
    return { command, cwd: repo };
  };
  const wechatCurrentRoomJob = ({ roomLabel, maxFrames, incomingSpeaker } = {}) => {
    const frames = intParam(maxFrames, '캡처 수', 120, 1, 800);
    const label = textParam(roomLabel, '위챗 방 이름', { max: 120 });
    const speaker = textParam(incomingSpeaker, '상대 이름', { max: 120 });
    if (process.platform === 'win32') {
      const command = [
        process.execPath,
        join(repo, 'scripts', 'wechat_windows_backup.mjs'),
        '--confirm-local-backup',
        '--max-frames',
        String(frames),
      ];
      if (label) command.push('--room-label', label);
      if (speaker) command.push('--incoming-speaker', speaker);
      return { command, cwd: repo };
    }
    const script = [
      'set -euo pipefail',
      'cu="$1"',
      'frames="$2"',
      'label="$3"',
      'speaker="$4"',
      'shots_dir="$5"',
      'db="$6"',
      'out="${shots_dir}/wechat_web_$(date +%Y%m%d_%H%M%S)"',
      'args=(wechat run --confirm-local-backup --out-dir "$out" --max-frames "$frames")',
      'if [ -n "$label" ]; then args+=(--room-label "$label"); fi',
      'if [ -n "$speaker" ]; then args+=(--incoming-speaker "$speaker"); else args+=(--incoming-speaker auto); fi',
      '"$cu" "${args[@]}"',
      '"$cu" wechat db --db "$db" --dir "$out"',
      '"$cu" wechat validate-db --db "$db"',
    ].join('\n');
    return bashJob(script, [cuScriptWsl, String(frames), label, speaker, pathConfig.shotsDirWsl, pathConfig.wechatDbWsl], ['node', 'jq', 'sqlite', 'tesseract', 'imagemagick']);
  };
  const wechatVisibleBatchJob = ({ pages, roomLimit, maxFrames, roomRetries, directChatAuto, dryRun, allVisible } = {}) => {
    const fullList = allVisible !== false;
    const pageCount = intParam(pages, '페이지 수', fullList ? 80 : 1, 1, 200);
    const rooms = intParam(roomLimit, '방 개수', fullList ? 200 : 5, 1, 500);
    const frames = intParam(maxFrames, '캡처 수', 120, 1, 800);
    const retries = intParam(roomRetries, '방 재시도 횟수', 1, 0, 5);
    if (process.platform === 'win32') {
      const command = [
        process.execPath,
        join(repo, 'scripts', 'wechat_windows_batch.mjs'),
        '--confirm-local-backup',
        '--pages',
        String(pageCount),
        '--room-limit',
        String(rooms),
        '--max-frames',
        String(frames),
        '--room-retries',
        String(retries),
      ];
      if (directChatAuto !== false) command.push('--direct-chat-auto');
      if (fullList) command.push('--all-visible');
      if (dryRun) command.push('--dry-run');
      return { command, cwd: repo };
    }
    const args = [
      'wechat',
      'batch',
      '--confirm-local-backup',
      '--pages',
      String(pageCount),
      '--room-limit',
      String(rooms),
      '--max-frames',
      String(frames),
      '--db',
      pathConfig.wechatDbWsl,
      '--db-skip-known',
    ];
    if (directChatAuto !== false) args.push('--direct-chat-auto');
    if (dryRun) args.push('--dry-run');
    return cuJob(args, ['node', 'jq', 'sqlite', 'tesseract', 'imagemagick']);
  };
  const installWslToolsJob = () => {
    if (process.platform === 'win32' && !windowsWslAvailable()) {
      throw makeError(
        'MISSING_WSL',
        '고급 실행 환경을 먼저 준비해야 합니다. 기본 카카오톡/위챗 백업은 그대로 사용할 수 있습니다.',
        { requirement: 'wsl' },
      );
    }
    const script = [
      'set -euo pipefail',
      'export DEBIAN_FRONTEND=noninteractive',
      'packages=(nodejs npm jq sqlite3 tesseract-ocr tesseract-ocr-kor tesseract-ocr-chi-sim imagemagick)',
      'if ! command -v apt-get >/dev/null 2>&1; then',
      '  echo "이 자동 설치는 Ubuntu/Debian 계열 WSL에서만 지원됩니다." >&2',
      '  exit 2',
      'fi',
      'echo "고급 기능 도구를 설치합니다..."',
      'if [ "$(id -u)" = "0" ]; then',
      '  apt-get update',
      '  apt-get install -y "${packages[@]}"',
      'elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then',
      '  sudo DEBIAN_FRONTEND=noninteractive apt-get update',
      '  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"',
      'else',
      '  echo "관리자 권한이 필요합니다. Ubuntu 터미널에서 아래 명령을 직접 실행하세요:" >&2',
      '  echo "sudo apt update && sudo apt install -y ${packages[*]}" >&2',
      '  exit 2',
      'fi',
      'echo ""',
      'echo "설치 확인:"',
      'node --version || true',
      'jq --version || true',
      'sqlite3 --version || true',
      'tesseract --version | head -1 || true',
      '(magick -version || convert -version) 2>/dev/null | head -1 || true',
    ].join('\n');
    return {
      command: process.platform === 'win32'
        ? ['wsl.exe', '-u', 'root', '-e', 'bash', '-lc', script]
        : ['bash', '-lc', script],
      cwd: repo,
    };
  };
  const launchWindowsAppJob = ({ label, processNames, executablePaths, linkPatterns, appNamePatterns = [], uri = '' }) => {
    const script = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}
$label = ${psSingle(label)}
$names = ${psArray(processNames)}
$paths = ${psArray(executablePaths)}
$linkPatterns = ${psArray(linkPatterns)}
$appNamePatterns = ${psArray(appNamePatterns)}
$uri = ${psSingle(uri)}
$signature = @'
using System;
using System.Runtime.InteropServices;
public static class CuWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
try { Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue } catch {}
function Focus-Process($proc) {
  if ($null -eq $proc -or $proc.MainWindowHandle -eq 0) { return }
  [CuWin]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null
  [CuWin]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
}
$existing = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName } | Sort-Object StartTime -Descending | Select-Object -First 1
if ($existing) {
  Focus-Process $existing
  Write-Output ($label + '이 이미 실행 중입니다. 창을 앞으로 가져왔습니다.')
  exit 0
}
foreach ($path in $paths) {
  $expanded = [Environment]::ExpandEnvironmentVariables($path)
  if ($expanded -and (Test-Path -LiteralPath $expanded)) {
    Start-Process -FilePath $expanded
    Write-Output ($label + '을 열었습니다.')
    exit 0
  }
}
$startDirs = @()
foreach ($dir in @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  $(if ($env:APPDATA) { Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu' }),
  $(if ($env:ProgramData) { Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu' })
)) {
  if ($dir) { $startDirs += $dir }
}
foreach ($dir in ($startDirs | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  foreach ($pattern in $linkPatterns) {
    $link = Get-ChildItem -LiteralPath $dir -Filter $pattern -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($link) {
      Start-Process -FilePath $link.FullName
      Write-Output ($label + '을 열었습니다.')
      exit 0
    }
  }
}
if ($appNamePatterns.Count -gt 0) {
  try {
    $appsFolder = (New-Object -ComObject Shell.Application).Namespace('shell:AppsFolder')
    if ($appsFolder) {
      foreach ($item in $appsFolder.Items()) {
        $appName = [string]$item.Name
        foreach ($pattern in $appNamePatterns) {
          if ($appName -match $pattern) {
            $item.InvokeVerb('open')
            Write-Output ($label + '을 열었습니다.')
            exit 0
          }
        }
      }
    }
  } catch {}
}
if ($uri) {
  try {
    Start-Process $uri
    Write-Output ($label + '을 열었습니다.')
    exit 0
  } catch {}
}
Write-Error ($label + '을 찾지 못했습니다. 앱을 설치한 뒤 다시 시도하세요.')
exit 2
`.trim();
    return {
      command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repo,
    };
  };
  const openWindowsSettingsJob = ({ uri = 'ms-settings:regionlanguage', label = 'Windows 언어 설정' } = {}) => {
    const safeUri = textParam(uri, 'Windows 설정 주소', { required: true, max: 120 });
    const safeLabel = textParam(label, 'Windows 설정 이름', { required: true, max: 80 });
    const script = `
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
  Write-Error '이 설정 화면은 Windows에서만 열 수 있습니다.'
  exit 2
}
Start-Process ${psSingle(safeUri)}
Write-Output (${psSingle(safeLabel)} + '을 열었습니다.')
`.trim();
    return {
      command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repo,
    };
  };
  const installWindowsOcrLanguageJob = ({ label, capabilities, prefixes, installMode = 'all' } = {}) => {
    const safeLabel = textParam(label, '문자 인식 언어 이름', { required: true, max: 40 });
    const safeCapabilities = (Array.isArray(capabilities) ? capabilities : [])
      .map((it) => textParam(it, 'Windows 문자 인식 기능 이름', { required: true, max: 80 }));
    const safePrefixes = (Array.isArray(prefixes) ? prefixes : [])
      .map((it) => textParam(it, 'Windows 문자 인식 언어 코드', { required: true, max: 12 }));
    const safeInstallMode = installMode === 'any' ? 'any' : 'all';
    if (!safeCapabilities.length || !safePrefixes.length) throw makeError('BAD_PARAMS', '설치할 문자 인식 언어를 확인하지 못했습니다.');
    const innerScript = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}
$label = ${psSingle(safeLabel)}
$capabilities = ${psArray(safeCapabilities)}
$prefixes = ${psArray(safePrefixes)}
$installMode = ${psSingle(safeInstallMode)}
$installedCount = 0
$errors = @()
function Test-OcrLanguage {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag.ToLowerInvariant() })
    foreach ($tag in $langs) {
      foreach ($prefix in $prefixes) {
        $needle = $prefix.ToLowerInvariant()
        if ($tag -eq $needle -or $tag.StartsWith($needle + '-')) { return $true }
      }
    }
  } catch {}
  return $false
}
foreach ($name in $capabilities) {
  $capability = Get-WindowsCapability -Online -Name $name -ErrorAction SilentlyContinue
  if ($capability -and $capability.State -eq 'Installed') {
    Write-Output ($label + ' 문자 인식은 이미 설치돼 있습니다.')
    $installedCount += 1
    if ($installMode -eq 'any' -and (Test-OcrLanguage)) { break }
    continue
  }
  Write-Output ($label + ' 문자 인식을 설치합니다. 시간이 조금 걸릴 수 있습니다.')
  try {
    Add-WindowsCapability -Online -Name $name -ErrorAction Stop | Out-Null
    $installedCount += 1
    if ($installMode -eq 'any' -and (Test-OcrLanguage)) { break }
  } catch {
    $errors += ($name + ': ' + $_.Exception.Message)
  }
}
if ($installedCount -eq 0 -and $errors.Count -gt 0) {
  Write-Output '자동 설치가 끝나지 않았습니다. Windows 언어 설정을 열겠습니다.'
  Write-Output ($errors -join ' / ')
  exit 2
}
Write-Output ($label + ' 문자 인식 설치 명령이 끝났습니다.')
exit 0
`.trim();
    const script = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
  Write-Error 'Windows 문자 인식 설치는 Windows에서만 실행할 수 있습니다.'
  exit 2
}
$label = ${psSingle(safeLabel)}
$prefixes = ${psArray(safePrefixes)}
$installScript = @'
${innerScript}
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($installScript))
function Test-OcrLanguage {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag.ToLowerInvariant() })
    foreach ($tag in $langs) {
      foreach ($prefix in $prefixes) {
        $needle = $prefix.ToLowerInvariant()
        if ($tag -eq $needle -or $tag.StartsWith($needle + '-')) { return $true }
      }
    }
  } catch {}
  return $false
}
function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (Test-OcrLanguage) {
  Write-Output ($label + ' 문자 인식이 이미 준비돼 있습니다. 상태 새로고침을 누르세요.')
  exit 0
}
if (-not (Test-Admin)) {
  Write-Output ($label + ' 문자 인식 자동 설치에는 관리자 권한이 필요합니다. Windows 권한 확인 창이 뜨면 예를 누르세요. 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요.')
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) | Out-Null
  } catch {
    Write-Output '권한 확인이 취소됐거나 열리지 않았습니다. Windows 언어 설정을 열겠습니다.'
    Start-Process ms-settings:regionlanguage
    exit 2
  }
  Write-Output '권한 확인 창에서 예를 누르면 설치가 백그라운드로 진행됩니다. 1~2분 뒤 이 화면의 상태 새로고침을 누르세요. 자동 설치가 막히면 Windows 언어 설정 열기로 직접 설치하세요.'
  exit 0
} else {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded
  if ($LASTEXITCODE -ne 0) {
    Write-Output '자동 설치가 끝나지 않았습니다. Windows 언어 설정을 열겠습니다.'
    Start-Process ms-settings:regionlanguage
    exit 2
  }
}
Start-Sleep -Milliseconds 700
if (Test-OcrLanguage) {
  Write-Output ($label + ' 문자 인식이 준비됐습니다. 이 화면의 상태 새로고침을 누르세요.')
  exit 0
}
Write-Output '설치 명령은 끝났지만 Windows가 아직 문자 인식을 반영하지 않았습니다. 잠시 뒤 상태 새로고침을 누르세요.'
Start-Process ms-settings:regionlanguage
exit 0
`.trim();
    return {
      command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repo,
    };
  };
  const openExternalPageJob = ({ url, label } = {}) => {
    const safeUrl = textParam(url, '페이지 주소', { required: true, max: 240 });
    const safeLabel = textParam(label, '페이지 이름', { required: true, max: 80 });
    if (!/^https:\/\/[A-Za-z0-9.-]+(?:\/|$)/u.test(safeUrl)) throw makeError('BAD_PARAMS', 'https 주소만 열 수 있습니다.');
    const script = `
$ErrorActionPreference = 'Stop'
Start-Process ${psSingle(safeUrl)}
Write-Output (${psSingle(safeLabel)} + '을 열었습니다.')
`.trim();
    return {
      command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repo,
    };
  };
  const openFolderJob = ({ folder, label } = {}) => {
    const safeFolder = textParam(folder, '폴더 경로', { required: true, max: 260 });
    const safeLabel = textParam(label, '폴더 이름', { required: true, max: 80 });
    const script = `
$ErrorActionPreference = 'Stop'
$folder = ${psSingle(safeFolder)}
New-Item -ItemType Directory -Force -Path $folder | Out-Null
Start-Process explorer.exe -ArgumentList $folder
Write-Output (${psSingle(safeLabel)} + '을 열었습니다.')
`.trim();
    return {
      command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repo,
    };
  };
  const liveValidationReportJob = ({ url } = {}) => {
    const fallbackUrl = `http://127.0.0.1:${pathConfig.defaultConsolePort || 8766}`;
    const rawUrl = String(url || fallbackUrl).trim().replace(/\/+$/u, '');
    let safeUrl = fallbackUrl;
    try {
      const parsed = new URL(rawUrl);
      const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && localHosts.has(parsed.hostname)) {
        safeUrl = parsed.origin;
      }
    } catch {}
    const script = `
$ErrorActionPreference = 'Continue'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}
$root = ${psSingle(pathConfig.repoRootWin || repo)}
$url = ${psSingle(safeUrl)}
$state = Join-Path $root 'state'
$reportMd = Join-Path $root '실사용_검증_보고서.md'
$reportJson = Join-Path $state '실사용_검증_보고서.json'
$checker = Join-Path $root 'scripts\\live_acceptance_check.mjs'
if (-not (Test-Path -LiteralPath $checker)) {
  Write-Error '검증 도구를 찾지 못했습니다. 압축을 푼 폴더에서 1_백업_시작.bat를 다시 실행하세요.'
  exit 2
}
New-Item -ItemType Directory -Force -Path $state | Out-Null
Write-Output '검증 보고서를 만듭니다. 채팅 본문, 방 이름, 스크린샷 경로는 보고서에 넣지 않습니다.'
Write-Output ('확인 주소: ' + $url)
& ${psSingle(process.execPath)} $checker --url $url --package-dir $root --require-live-chats --check --out-md $reportMd --out-json $reportJson
$exitCode = $LASTEXITCODE
Write-Output ('보고서 파일: ' + $reportMd)
Write-Output '지원 담당자가 요청했을 때만 JSON 보고서를 전달하세요.'
if (Test-Path -LiteralPath $reportMd) {
  try { Start-Process -FilePath $reportMd | Out-Null } catch {}
}
if ($exitCode -ne 0) { exit $exitCode }
exit 0
`.trim();
    return {
      command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repo,
    };
  };
  const readinessReportJob = () => {
    const stateDir = process.platform === 'win32' ? pathConfig.stateDirWin : pathConfig.stateDirWsl;
    return {
      command: [
        process.execPath,
        join(repo, 'scripts', 'readiness_report.mjs'),
        '--out-md',
        join(repo, '준비_확인_보고서.md'),
        '--out-json',
        join(stateDir, '준비_확인_보고서.json'),
        '--open',
      ],
      cwd: repo,
    };
  };
  const bashJob = (script, args = [], requirements = ['node', 'jq']) => {
    assertCuRuntime(requirements);
    return {
      command: process.platform === 'win32'
        ? ['wsl.exe', '-e', 'bash', '-lc', script, 'web-backup', ...args]
        : ['bash', '-lc', script, 'web-backup', ...args],
      cwd: repo,
    };
  };
  const catalog = {
    setup: {
      wsl_tools: {
        risk: ['write'],
        requires: ['wsl'],
        description: '카카오톡/위챗 백업에 필요한 WSL 도구를 설치합니다',
        build: () => installWslToolsJob(),
      },
      open_kakaotalk: {
        risk: ['foreground'],
        foreground: true,
        description: '카카오톡 앱을 열거나 앞으로 가져옵니다',
        build: () => launchWindowsAppJob({
          label: '카카오톡',
          processNames: ['KakaoTalk'],
          executablePaths: [
            '%LOCALAPPDATA%\\Kakao\\KakaoTalk\\KakaoTalk.exe',
            '%LOCALAPPDATA%\\Programs\\Kakao\\KakaoTalk\\KakaoTalk.exe',
            '%ProgramFiles%\\Kakao\\KakaoTalk\\KakaoTalk.exe',
            '%ProgramFiles(x86)%\\Kakao\\KakaoTalk\\KakaoTalk.exe',
          ],
          linkPatterns: ['KakaoTalk*.lnk', '카카오톡*.lnk'],
          appNamePatterns: ['KakaoTalk', '카카오톡'],
          uri: 'kakaotalk://',
        }),
      },
      open_kakaotalk_download: {
        risk: ['foreground'],
        foreground: true,
        description: '카카오톡 공식 PC 다운로드 페이지를 엽니다',
        build: () => openExternalPageJob({
          label: '카카오톡 공식 PC 다운로드 페이지',
          url: 'https://www.kakaocorp.com/page/service/all',
        }),
      },
      open_wechat: {
        risk: ['foreground'],
        foreground: true,
        description: '위챗 앱을 열거나 앞으로 가져옵니다',
        build: () => launchWindowsAppJob({
          label: '위챗',
          processNames: ['Weixin', 'WeChat'],
          executablePaths: [
            '%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe',
            '%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe',
            '%LOCALAPPDATA%\\Tencent\\WeChat\\WeChat.exe',
            '%LOCALAPPDATA%\\Programs\\Tencent\\WeChat\\WeChat.exe',
            '%ProgramFiles%\\Tencent\\WeChat\\Weixin.exe',
            '%ProgramFiles(x86)%\\Tencent\\WeChat\\Weixin.exe',
          ],
          linkPatterns: ['WeChat*.lnk', 'Weixin*.lnk', '微信*.lnk'],
          appNamePatterns: ['WeChat', 'Weixin', '위챗', '微信'],
          uri: 'weixin://',
        }),
      },
      open_wechat_download: {
        risk: ['foreground'],
        foreground: true,
        description: '위챗 Windows 공식 설치 페이지를 엽니다',
        build: () => openExternalPageJob({
          label: '위챗 Windows 공식 설치 페이지',
          url: 'https://apps.microsoft.com/detail/xpfckbrnfzq62g?gl=US&hl=ko-KR',
        }),
      },
      open_backup_tool_download: {
        risk: ['foreground'],
        foreground: true,
        description: '백업 화면 실행 도구 설치 페이지를 엽니다',
        build: () => openExternalPageJob({
          label: '백업 화면 실행 도구 설치 페이지',
          url: 'https://nodejs.org/',
        }),
      },
      open_backup_folder: {
        risk: ['foreground'],
        foreground: true,
        description: '백업 결과가 저장되는 폴더를 엽니다',
        build: () => openFolderJob({ folder: pathConfig.shotsDirWin, label: '백업 폴더' }),
      },
      open_language_settings: {
        risk: ['foreground'],
        foreground: true,
        description: 'Windows OCR 언어 설정 화면을 엽니다',
        build: () => openWindowsSettingsJob({ uri: 'ms-settings:regionlanguage', label: 'Windows 언어 설정' }),
      },
      create_live_validation_report: {
        risk: ['read', 'write', 'foreground'],
        foreground: true,
        description: '백업 결과 개수와 준비 상태만 담은 검증 보고서를 만들고 엽니다',
        build: (params = {}) => liveValidationReportJob(params),
      },
      create_readiness_report: {
        risk: ['read', 'write', 'foreground'],
        foreground: true,
        description: '채팅 내용 없이 앱, 문자 인식, 저장 폴더 준비 상태만 담은 보고서를 만들고 엽니다',
        build: () => readinessReportJob(),
      },
      install_ocr_ko: {
        risk: ['foreground', 'write'],
        foreground: true,
        description: '카카오톡용 한국어 Windows 문자 인식 설치를 시도합니다',
        build: () => installWindowsOcrLanguageJob({
          label: '한국어',
          capabilities: [
            'Language.Basic~~~ko-KR~0.0.1.0',
            'Language.OCR~~~ko-KR~0.0.1.0',
          ],
          prefixes: ['ko'],
        }),
      },
      install_ocr_zh: {
        risk: ['foreground', 'write'],
        foreground: true,
        description: '위챗용 중국어 Windows 문자 인식 설치를 시도합니다',
        build: () => installWindowsOcrLanguageJob({
          label: '중국어',
          capabilities: [
            'Language.Basic~~~zh-CN~0.0.1.0',
            'Language.OCR~~~zh-CN~0.0.1.0',
            'Language.Basic~~~zh-TW~0.0.1.0',
            'Language.OCR~~~zh-TW~0.0.1.0',
            'Language.Basic~~~zh-HK~0.0.1.0',
            'Language.OCR~~~zh-HK~0.0.1.0',
          ],
          prefixes: ['zh'],
          installMode: 'any',
        }),
      },
    },
    doctor: {
      run: {
        risk: ['read'],
        description: '통합 진단을 실행합니다',
        build: () => ({
          command: [process.execPath, join(repo, 'scripts', 'doctor.mjs'), '--json'],
          cwd: repo,
        }),
      },
    },
    chat: {
      viewer: {
        risk: ['read'],
        description: '읽기 전용 통합 채팅 뷰어를 실행합니다',
        build: ({ port, allSources } = {}) => {
          const viewerPort = Number(port || pathConfig.defaultConsolePort || 8766);
          if (!Number.isInteger(viewerPort) || viewerPort <= 0 || viewerPort > 65535) {
            throw makeError('BAD_PARAMS', '결과 보기 포트는 1~65535 사이의 숫자로 입력하세요.');
          }
          const command = [
            process.execPath,
            join(repo, 'scripts', 'chat_artifact_viewer_server.mjs'),
            '--host',
            '127.0.0.1',
            '--port',
            String(viewerPort),
          ];
          if (allSources) command.push('--all-sources');
          return { command, cwd: repo };
        },
      },
      audit: {
        risk: ['read'],
        description: '통합 채팅 뷰어 API를 검수합니다',
        build: ({ url, check } = {}) => {
          const command = [process.execPath, join(repo, 'scripts', 'chat_artifact_quality_audit.mjs')];
          if (url) command.push('--url', String(url));
          if (check) command.push('--check');
          return { command, cwd: repo };
        },
      },
    },
    kakao: {
      open_windows: {
        risk: ['foreground', 'write'],
        requires: kakaoRequirements,
        foreground: true,
        description: '현재 열려 있는 카카오톡 채팅방을 백업합니다',
        build: (params = {}) => kakaoOpenWindowsJob(params),
      },
      visible_room: {
        risk: ['foreground', 'write'],
        requires: kakaoRequirements,
        foreground: true,
        description: '카카오톡 목록에서 보이는 방을 열어 백업합니다',
        build: (params = {}) => kakaoVisibleRoomJob(params),
      },
      visible_batch: {
        risk: ['foreground', 'write'],
        requires: kakaoRequirements,
        foreground: true,
        description: process.platform === 'win32'
          ? '카카오톡 왼쪽 목록을 끝까지 순회하며 Windows OCR로 백업합니다'
          : '카카오톡 목록의 열린 채팅창들을 백업합니다',
        build: (params = {}) => kakaoVisibleBatchJob(params),
      },
      openchat: {
        risk: ['foreground', 'write'],
        requires: kakaoRequirements,
        foreground: true,
        description: process.platform === 'win32'
          ? '카카오톡 오픈채팅과 댓글창을 Windows OCR로 백업합니다'
          : '카카오톡 오픈채팅과 보이는 댓글창을 백업합니다',
        build: (params = {}) => kakaoOpenchatJob(params),
      },
    },
    wechat: {
      current_room: {
        risk: ['foreground', 'write'],
        requires: wechatRequirements,
        foreground: true,
        description: process.platform === 'win32'
          ? '현재 선택된 위챗 방을 Windows OCR로 백업합니다'
          : '현재 선택된 위챗 방을 백업하고 고급 검수용 저장소에 넣습니다',
        build: (params = {}) => wechatCurrentRoomJob(params),
      },
      visible_batch: {
        risk: ['foreground', 'write'],
        requires: wechatRequirements,
        foreground: true,
        description: process.platform === 'win32'
          ? '위챗 왼쪽 목록을 끝까지 순회하며 Windows OCR로 백업합니다'
          : '위챗 목록에서 보이는 방들을 백업하고 고급 검수용 저장소에 넣습니다',
        build: (params = {}) => wechatVisibleBatchJob(params),
      },
      validate_db: {
        risk: ['read'],
        requires: ['wsl', 'sqlite'],
        description: '예전 위챗 백업 파일을 검사합니다',
        build: () => cuJob(['wechat', 'validate-db', '--db', pathConfig.wechatDbWsl], ['node', 'sqlite']),
      },
    },
  };
  if (existsSync(join(repo, 'scripts', 'agent_runner.mjs'))) {
    catalog.agent = {
      preview: {
        risk: ['read', 'cloud'],
        description: '에이전트 실행 계획을 미리 확인합니다',
        build: ({ goal, provider } = {}) => {
          const text = String(goal || '').trim();
          if (!text) throw makeError('BAD_PARAMS', '고급 자동 실행 목표를 입력하세요.');
          return {
            command: [
              process.execPath,
              join(repo, 'scripts', 'agent_runner.mjs'),
              '--provider',
              provider || pathConfig.agentProvider || 'auto',
              '--mode',
              'preview',
              '--goal',
              text,
            ],
            cwd: repo,
          };
        },
      },
      run: {
        risk: ['foreground', 'write', 'cloud'],
        foreground: true,
        description: '에이전트 작업을 실행합니다',
        build: ({ goal, provider } = {}) => {
          const text = String(goal || '').trim();
          if (!text) throw makeError('BAD_PARAMS', '고급 자동 실행 목표를 입력하세요.');
          return {
            command: [
              process.execPath,
              join(repo, 'scripts', 'agent_runner.mjs'),
              '--provider',
              provider || pathConfig.agentProvider || 'auto',
              '--mode',
              'run',
              '--goal',
              text,
            ],
            cwd: repo,
          };
        },
      },
    };
  }
  return catalog;
}

export class JobRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pathConfig = options.pathConfig || loadPathConfig();
    const defaultRepoRoot = process.platform === 'win32' ? this.pathConfig.repoRootWin : this.pathConfig.repoRootWsl;
    const defaultRunsDir = process.platform === 'win32' ? this.pathConfig.runsDirWin : this.pathConfig.runsDirWsl;
    this.repoRoot = resolve(options.repoRoot || defaultRepoRoot);
    this.runsDir = resolve(options.runsDir || join(defaultRunsDir, 'jobs'));
    this.catalog = options.catalog || defaultJobCatalog(this.pathConfig);
    this.jobs = new Map();
    this.counter = 0;
    ensureDir(this.runsDir);
    this.loadExistingJobs();
  }

  loadExistingJobs() {
    let entries = [];
    try { entries = readdirSync(this.runsDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(this.runsDir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = readJson(manifestPath);
        this.jobs.set(manifest.id, {
          id: manifest.id,
          manifest,
          dir: join(this.runsDir, entry.name),
          process: null,
          done: Promise.resolve(manifest),
        });
      } catch {}
    }
  }

  listJobs() {
    return [...this.jobs.values()]
      .map((job) => job.manifest)
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  }

  getJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw makeError('NOT_FOUND', `unknown job: ${id}`);
    return job.manifest;
  }

  getDefinition(module, action) {
    if (!validName.test(module) || !validName.test(action)) {
      throw makeError('BAD_JOB_NAME', 'module and action must be lowercase names');
    }
    const def = this.catalog[module]?.[action];
    if (!def) throw makeError('UNKNOWN_JOB', `unknown job action: ${module}.${action}`);
    return def;
  }

  assertRiskConfirmed(module, action, risk, params = {}) {
    if (!hasConfirmationRisk(risk)) return;
    const expected = expectedConfirmation(module, action, risk);
    if (params.confirmation === expected || params.confirmRisk === true) return;
    throw makeError('CONFIRMATION_REQUIRED', `confirmation required for ${module}.${action}`, { expectedConfirmation: expected, risk });
  }

  assertForegroundAvailable() {
    const active = [...this.jobs.values()].find((job) => job.manifest.foreground && job.manifest.status === 'running');
    if (active) throw makeError('FOREGROUND_BUSY', `foreground job already running: ${active.id}`, { activeJobId: active.id });
  }

  nextId(module, action) {
    this.counter += 1;
    return `job_${timestamp()}_${String(this.counter).padStart(4, '0')}_${module}_${action}`;
  }

  startJob({ module, action, params = {} }) {
    const def = this.getDefinition(module, action);
    const risk = normalizeRisk(def.risk);
    this.assertRiskConfirmed(module, action, risk, params);
    if (def.foreground || risk.includes('foreground')) this.assertForegroundAvailable();

    const built = def.build(params, { pathConfig: this.pathConfig, repoRoot: this.repoRoot });
    if (!Array.isArray(built.command) || built.command.length === 0) {
      throw makeError('BAD_COMMAND', `job ${module}.${action} did not return argv command`);
    }
    const command = built.command.map((part) => String(part));
    const id = this.nextId(module, action);
    const dir = ensureDir(join(this.runsDir, id));
    const stdoutPath = join(dir, 'stdout.log');
    const stderrPath = join(dir, 'stderr.log');
    const eventsPath = join(dir, 'events.jsonl');
    const manifestPath = join(dir, 'manifest.json');
    const manifest = {
      schema: 'computer-use.job.v1',
      id,
      module,
      action,
      description: def.description || '',
      status: 'running',
      risk,
      foreground: Boolean(def.foreground || risk.includes('foreground')),
      command,
      cwd: built.cwd || this.repoRoot,
      params,
      started_at: isoNow(),
      ended_at: null,
      exit_code: null,
      signal: null,
      pid: null,
      artifacts: {
        manifest: 'manifest.json',
        stdout: 'stdout.log',
        stderr: 'stderr.log',
        events: 'events.jsonl',
      },
    };
    writeFileSync(stdoutPath, '', 'utf8');
    writeFileSync(stderrPath, '', 'utf8');
    writeFileSync(eventsPath, '', 'utf8');
    writeJson(manifestPath, manifest);

    const child = spawn(command[0], command.slice(1), {
      cwd: manifest.cwd,
      env: { ...process.env, COMPUTER_USE_JOB_ID: id, COMPUTER_USE_RUN_DIR: dir },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    manifest.pid = child.pid || null;
    writeJson(manifestPath, manifest);

    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const job = { id, dir, manifest, process: child, done, resolveDone };
    this.jobs.set(id, job);
    this.writeEvent(job, { type: 'start', status: 'running', pid: manifest.pid });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      appendFileSync(stdoutPath, text);
      this.writeEvent(job, { type: 'stdout', text });
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      appendFileSync(stderrPath, text);
      this.writeEvent(job, { type: 'stderr', text });
    });
    child.on('error', (err) => {
      appendFileSync(stderrPath, `${err.message}\n`);
      this.finishJob(job, 'fail', null, null, err.message);
    });
    child.on('exit', (code, signal) => {
      if (job.manifest.status === 'stopping') {
        this.finishJob(job, 'stopped', code, signal);
      } else {
        this.finishJob(job, code === 0 ? 'pass' : 'fail', code, signal);
      }
    });
    return manifest;
  }

  writeEvent(job, event) {
    const enriched = { ts: isoNow(), job_id: job.id, ...event };
    appendFileSync(join(job.dir, 'events.jsonl'), `${JSON.stringify(enriched)}\n`, 'utf8');
    this.emit('event', enriched);
    this.emit(`event:${job.id}`, enriched);
  }

  finishJob(job, status, code = null, signal = null, error = '') {
    if (terminalStatuses.has(job.manifest.status)) return;
    job.manifest.status = status;
    job.manifest.ended_at = isoNow();
    job.manifest.exit_code = code;
    job.manifest.signal = signal;
    if (error) job.manifest.error = error;
    writeJson(join(job.dir, 'manifest.json'), job.manifest);
    this.writeEvent(job, { type: 'exit', status, exit_code: code, signal, error });
    job.process = null;
    job.resolveDone?.(job.manifest);
  }

  async waitForJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw makeError('NOT_FOUND', `unknown job: ${id}`);
    return job.done;
  }

  stopJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw makeError('NOT_FOUND', `unknown job: ${id}`);
    if (terminalStatuses.has(job.manifest.status)) return job.manifest;
    job.manifest.status = 'stopping';
    writeJson(join(job.dir, 'manifest.json'), job.manifest);
    this.writeEvent(job, { type: 'stopping', status: 'stopping' });
    if (job.process?.pid) {
      try {
        if (process.platform === 'win32') job.process.kill('SIGTERM');
        else process.kill(-job.process.pid, 'SIGTERM');
      } catch {
        try { job.process.kill('SIGTERM'); } catch {}
      }
      setTimeout(() => {
        if (job.process && !terminalStatuses.has(job.manifest.status)) {
          try {
            if (process.platform === 'win32') job.process.kill('SIGKILL');
            else process.kill(-job.process.pid, 'SIGKILL');
          } catch {
            try { job.process.kill('SIGKILL'); } catch {}
          }
        }
      }, 1500).unref?.();
    }
    return job.manifest;
  }

  rerunJob(id) {
    const old = this.getJob(id);
    return this.startJob({ module: old.module, action: old.action, params: old.params || {} });
  }

  resolveArtifactPath(id, relPath) {
    const job = this.jobs.get(id);
    if (!job) throw makeError('NOT_FOUND', `unknown job: ${id}`);
    const rel = String(relPath || '');
    if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.startsWith('\\')) {
      throw makeError('BAD_ARTIFACT_PATH', 'artifact path must be relative');
    }
    const full = resolve(job.dir, rel);
    if (!isInside(full, job.dir)) throw makeError('PATH_TRAVERSAL', 'artifact path escapes job directory');
    const st = statSync(full);
    if (!st.isFile()) throw makeError('BAD_ARTIFACT_PATH', 'artifact is not a file');
    return full;
  }

  readArtifact(id, relPath, encoding = 'utf8') {
    return readFileSync(this.resolveArtifactPath(id, relPath), encoding);
  }
}
