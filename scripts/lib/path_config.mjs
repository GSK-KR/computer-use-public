#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const libDir = fileURLToPath(new URL('.', import.meta.url));
const defaultRepoRoot = resolve(libDir, '..', '..');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function env(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : '';
}

function isDir(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function windowsPathToWsl(path) {
  const value = String(path || '').trim();
  const drive = value.match(/^([A-Za-z]):[\\/](.*)$/u);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  const unc = value.match(/^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\(.+)$/iu);
  if (unc) return `/${unc[1].replace(/\\/g, '/')}`;
  return value.replace(/\\/g, '/');
}

export function wslPathToWindows(path) {
  const raw = String(path || '').trim();
  const value = raw.replace(/\\/g, '/');
  const mount = value.match(/^\/mnt\/([A-Za-z])\/(.*)$/u);
  if (mount) return `${mount[1].toUpperCase()}:\\${mount[2].replace(/\//g, '\\')}`;
  if (process.platform === 'win32') return raw;
  if (value.startsWith('/')) {
    const distro = env('WSL_DISTRO_NAME') || 'Ubuntu';
    return `\\\\wsl.localhost\\${distro}${value.replace(/\//g, '\\')}`;
  }
  return raw;
}

function wslJoin(...parts) {
  return posix.join(...parts.filter(Boolean).map((part) => String(part).replace(/\\/g, '/')));
}

function maybeToWsl(path) {
  const value = String(path || '').trim();
  if (!value) return '';
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) return windowsPathToWsl(value);
  return value;
}

function resolveWslPath(path) {
  const value = maybeToWsl(path);
  if (!value) return '';
  if (process.platform === 'win32') return posix.normalize(value.replace(/\\/g, '/'));
  return resolve(value);
}

function resolveLocalPath(path) {
  const value = String(path || '').trim();
  if (!value) return '';
  if (process.platform === 'win32' && /^\/mnt\/[A-Za-z]\//u.test(value.replace(/\\/g, '/'))) return wslPathToWindows(value);
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) return value;
  return resolve(value);
}

function windowsUserProfileWsl() {
  if (env('USERPROFILE')) return windowsPathToWsl(env('USERPROFILE'));
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "[Environment]::GetFolderPath('UserProfile')"],
    { encoding: 'utf8', timeout: 3000, windowsHide: true },
  );
  if (ps.status !== 0) return '';
  return windowsPathToWsl(String(ps.stdout || '').trim());
}

function chooseMirrorRoot(repoRootWsl, config) {
  const explicit = env('CU_MIRROR_ROOT_WSL') || env('COMPUTER_USE_WIN_ROOT') || config.mirrorRootWsl || config.repoRootWin;
  if (explicit) return resolveWslPath(explicit);
  if (/^\/mnt\/[A-Za-z]\//u.test(repoRootWsl)) return repoRootWsl;

  const profile = windowsUserProfileWsl();
  const candidates = [];
  if (profile) {
    candidates.push(wslJoin(profile, posix.basename(repoRootWsl)));
    candidates.push(wslJoin(profile, 'computer-use'));
  }
  for (const candidate of candidates) {
    if (isFile(wslJoin(candidate, 'scripts', 'cu'))) return resolve(candidate);
  }
  return repoRootWsl;
}

function chooseDir(config, field, envWsl, envWin, candidates) {
  const explicit = env(envWsl) || env(envWin) || config[field];
  if (explicit) return resolveWslPath(explicit);
  const existing = candidates.find((candidate) => isDir(candidate));
  return resolveWslPath(existing || candidates[0]);
}

function chooseFile(config, field, envWsl, envWin, fallback) {
  const explicit = env(envWsl) || env(envWin) || config[field];
  return explicit ? resolveWslPath(explicit) : resolveWslPath(fallback);
}

export function loadPathConfig(options = {}) {
  const defaultRepoRootLocal = resolveLocalPath(env('CU_REPO_ROOT_WIN') || options.repoRootWin || defaultRepoRoot);
  const repoRootWsl = resolveWslPath(env('CU_REPO_ROOT_WSL') || options.repoRootWsl || defaultRepoRoot);
  const defaultConfigFile = process.platform === 'win32'
    ? join(defaultRepoRootLocal, 'state', 'config.json')
    : join(repoRootWsl, 'state', 'config.json');
  const configFile = env('CU_CONFIG') || defaultConfigFile;
  const config = readJson(configFile);
  const repoRoot = resolveWslPath(env('CU_REPO_ROOT_WSL') || config.repoRootWsl || repoRootWsl);
  const mirrorRootWsl = chooseMirrorRoot(repoRoot, config);
  const repoRootWin = resolveLocalPath(env('CU_REPO_ROOT_WIN') || config.repoRootWin || wslPathToWindows(repoRoot));
  const mirrorRootWin = resolveLocalPath(env('CU_MIRROR_ROOT_WIN') || config.mirrorRootWin || wslPathToWindows(mirrorRootWsl));

  const scriptsDirWsl = wslJoin(repoRoot, 'scripts');
  const mirrorScriptsDirWsl = wslJoin(mirrorRootWsl, 'scripts');
  const windowsScriptsDirWsl = isDir(mirrorScriptsDirWsl) ? mirrorScriptsDirWsl : scriptsDirWsl;
  const scriptsDirWin = env('CU_SCRIPTS_DIR_WIN') || config.scriptsDirWin || wslPathToWindows(windowsScriptsDirWsl);

  const shotsDirWsl = chooseDir(config, 'shotsDir', 'CU_SHOTS_DIR_WSL', 'CU_SHOTS_DIR_WIN', [
    wslJoin(mirrorRootWsl, 'shots'),
    wslJoin(repoRoot, 'shots'),
  ]);
  const stateDirWsl = chooseDir(config, 'stateDir', 'CU_STATE_DIR_WSL', 'CU_STATE_DIR_WIN', [
    wslJoin(mirrorRootWsl, 'state'),
    wslJoin(repoRoot, 'state'),
  ]);
  const runsDirWsl = chooseDir(config, 'runsDir', 'CU_RUNS_DIR_WSL', 'CU_RUNS_DIR_WIN', [
    wslJoin(mirrorRootWsl, 'runs'),
    wslJoin(repoRoot, 'runs'),
  ]);
  const docsDirWsl = chooseDir(config, 'docsDir', 'CU_DOCS_DIR_WSL', 'CU_DOCS_DIR_WIN', [
    wslJoin(repoRoot, 'docs'),
    wslJoin(mirrorRootWsl, 'docs'),
  ]);
  const wechatDbWsl = chooseFile(config, 'wechatDb', 'CU_WECHAT_DB_WSL', 'WECHAT_DB', wslJoin(shotsDirWsl, 'wechat_local.sqlite3'));

  const profileWsl = windowsUserProfileWsl();
  const profileWin = profileWsl ? wslPathToWindows(profileWsl) : '';
  const localAppData = env('LOCALAPPDATA') || (profileWin ? `${profileWin}\\AppData\\Local` : '');
  const webCdpScript = env('CU_WEB_CDP_SCRIPT') || config.webCdpScript || (
    localAppData ? `${localAppData}\\claude-cdp\\cu_web.mjs` : ''
  );

  return {
    schema: 'computer-use.path-config.v1',
    configFile,
    configLoaded: isFile(configFile),
    repoRootWsl: repoRoot,
    repoRootWin,
    mirrorRootWsl,
    mirrorRootWin,
    scriptsDirWsl,
    scriptsDirWin,
    windowsScriptsDirWsl,
    shotsDirWsl,
    shotsDirWin: resolveLocalPath(env('CU_SHOTS_DIR_WIN') || config.shotsDirWin || wslPathToWindows(shotsDirWsl)),
    stateDirWsl,
    stateDirWin: resolveLocalPath(env('CU_STATE_DIR_WIN') || config.stateDirWin || wslPathToWindows(stateDirWsl)),
    runsDirWsl,
    runsDirWin: resolveLocalPath(env('CU_RUNS_DIR_WIN') || config.runsDirWin || wslPathToWindows(runsDirWsl)),
    docsDirWsl,
    docsDirWin: resolveLocalPath(env('CU_DOCS_DIR_WIN') || config.docsDirWin || wslPathToWindows(docsDirWsl)),
    wechatDbWsl,
    wechatDbWin: resolveLocalPath(env('CU_WECHAT_DB_WIN') || config.wechatDbWin || wslPathToWindows(wechatDbWsl)),
    defaultConsolePort: Number(env('CU_DEFAULT_CONSOLE_PORT') || config.defaultConsolePort || 8766),
    chromeCdpPort: Number(env('CU_CHROME_CDP_PORT') || config.chromeCdpPort || 9222),
    agentProvider: env('CU_AGENT_PROVIDER') || config.agentProvider || 'claude',
    allowCloudOcr: Boolean(config.allowCloudOcr ?? false),
    allowCloudTranslation: Boolean(config.allowCloudTranslation ?? false),
    sqlite3Path: env('CU_SQLITE3') || config.sqlite3Path || env('SQLITE3') || 'sqlite3',
    webCdpScript,
  };
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function printShell(config) {
  const keys = {
    CU_REPO_ROOT_WSL: 'repoRootWsl',
    CU_REPO_ROOT_WIN: 'repoRootWin',
    CU_MIRROR_ROOT_WSL: 'mirrorRootWsl',
    CU_MIRROR_ROOT_WIN: 'mirrorRootWin',
    CU_SCRIPTS_DIR_WSL: 'scriptsDirWsl',
    CU_SCRIPTS_DIR_WIN: 'scriptsDirWin',
    CU_WINDOWS_SCRIPTS_DIR_WSL: 'windowsScriptsDirWsl',
    CU_SHOTS_DIR_WSL: 'shotsDirWsl',
    CU_SHOTS_DIR_WIN: 'shotsDirWin',
    CU_STATE_DIR_WSL: 'stateDirWsl',
    CU_STATE_DIR_WIN: 'stateDirWin',
    CU_RUNS_DIR_WSL: 'runsDirWsl',
    CU_RUNS_DIR_WIN: 'runsDirWin',
    CU_DOCS_DIR_WSL: 'docsDirWsl',
    CU_DOCS_DIR_WIN: 'docsDirWin',
    CU_WECHAT_DB_WSL: 'wechatDbWsl',
    CU_WECHAT_DB_WIN: 'wechatDbWin',
    CU_DEFAULT_CONSOLE_PORT: 'defaultConsolePort',
    CU_CHROME_CDP_PORT: 'chromeCdpPort',
    CU_AGENT_PROVIDER: 'agentProvider',
    CU_SQLITE3: 'sqlite3Path',
    CU_WEB_CDP_SCRIPT: 'webCdpScript',
  };
  for (const [name, key] of Object.entries(keys)) {
    console.log(`${name}=${shellQuote(config[key])}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadPathConfig();
  if (process.argv.includes('--shell')) printShell(config);
  else console.log(JSON.stringify(config, null, 2));
}
