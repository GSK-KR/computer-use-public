function ConvertTo-WslPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  if ($Path -match '^([A-Za-z]):[\\/](.*)$') {
    $drive = $Matches[1].ToLowerInvariant()
    $rest = $Matches[2] -replace '\\','/'
    return "/mnt/$drive/$rest"
  }
  if ($Path -match '^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\(.+)$') {
    return '/' + ($Matches[1] -replace '\\','/')
  }
  return ($Path -replace '\\','/')
}

function Get-ComputerUseConfig {
  param([string]$RepoRoot = '')

  if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  }

  $configPath = if (-not [string]::IsNullOrWhiteSpace($env:CU_CONFIG)) {
    $env:CU_CONFIG
  } else {
    Join-Path $RepoRoot 'state\config.json'
  }

  $json = $null
  if (Test-Path $configPath) {
    try { $json = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json } catch { $json = $null }
  }

  function FirstValue([object[]]$Values) {
    foreach ($value in $Values) {
      if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) { return [string]$value }
    }
    return ''
  }

  $shotsDir = FirstValue @($env:CU_SHOTS_DIR_WIN, $json.shotsDirWin, $json.shotsDir, (Join-Path $RepoRoot 'shots'))
  $stateDir = FirstValue @($env:CU_STATE_DIR_WIN, $json.stateDirWin, $json.stateDir, (Join-Path $RepoRoot 'state'))
  $runsDir = FirstValue @($env:CU_RUNS_DIR_WIN, $json.runsDirWin, $json.runsDir, (Join-Path $RepoRoot 'runs'))
  $scriptsDir = FirstValue @($env:CU_SCRIPTS_DIR_WIN, $json.scriptsDirWin, (Join-Path $RepoRoot 'scripts'))
  $docsDir = FirstValue @($env:CU_DOCS_DIR_WIN, $json.docsDirWin, $json.docsDir, (Join-Path $RepoRoot 'docs'))
  $wechatDb = FirstValue @($env:CU_WECHAT_DB_WIN, $json.wechatDbWin, $json.wechatDb, (Join-Path $shotsDir 'wechat_local.sqlite3'))

  [pscustomobject]@{
    schema = 'computer-use.path-config.v1'
    configFile = $configPath
    configLoaded = [bool](Test-Path $configPath)
    repoRootWin = FirstValue @($env:CU_REPO_ROOT_WIN, $json.repoRootWin, $RepoRoot)
    repoRootWsl = FirstValue @($env:CU_REPO_ROOT_WSL, $json.repoRootWsl, (ConvertTo-WslPath $RepoRoot))
    scriptsDirWin = $scriptsDir
    scriptsDirWsl = ConvertTo-WslPath $scriptsDir
    shotsDirWin = $shotsDir
    shotsDirWsl = ConvertTo-WslPath $shotsDir
    stateDirWin = $stateDir
    stateDirWsl = ConvertTo-WslPath $stateDir
    runsDirWin = $runsDir
    runsDirWsl = ConvertTo-WslPath $runsDir
    docsDirWin = $docsDir
    docsDirWsl = ConvertTo-WslPath $docsDir
    wechatDbWin = $wechatDb
    wechatDbWsl = ConvertTo-WslPath $wechatDb
    defaultConsolePort = [int](FirstValue @($env:CU_DEFAULT_CONSOLE_PORT, $json.defaultConsolePort, 8766))
    chromeCdpPort = [int](FirstValue @($env:CU_CHROME_CDP_PORT, $json.chromeCdpPort, 9224))
    agentProvider = FirstValue @($env:CU_AGENT_PROVIDER, $json.agentProvider, 'claude')
    webCdpScript = FirstValue @($env:CU_WEB_CDP_SCRIPT, $json.webCdpScript, (Join-Path $scriptsDir 'chrome_cdp_runner.mjs'))
  }
}
