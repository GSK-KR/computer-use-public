#!/usr/bin/env bash

cu__shell_quote() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/"
}

cu__wsl_to_win() {
  if command -v wslpath >/dev/null 2>&1; then
    wslpath -w "$1" 2>/dev/null && return 0
  fi
  case "$1" in
    /mnt/[A-Za-z]/*)
      local drive rest
      drive="${1:5:1}"
      rest="${1:7}"
      printf '%s:\\%s\n' "${drive^^}" "${rest//\//\\}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

cu__win_to_wsl() {
  if command -v wslpath >/dev/null 2>&1; then
    wslpath -u "$1" 2>/dev/null && return 0
  fi
  case "$1" in
    [A-Za-z]:\\*)
      local drive rest
      drive="${1:0:1}"
      rest="${1:3}"
      printf '/mnt/%s/%s\n' "${drive,,}" "${rest//\\//}"
      ;;
    *)
      printf '%s\n' "${1//\\//}"
      ;;
  esac
}

load_computer_use_path_config() {
  local scripts_dir="$1"
  local repo_root
  repo_root="$(cd "$scripts_dir/.." && pwd -P)"

  if command -v node >/dev/null 2>&1 && [ -f "$scripts_dir/lib/path_config.mjs" ]; then
    local shell_vars
    if shell_vars="$(node "$scripts_dir/lib/path_config.mjs" --shell 2>/dev/null)"; then
      eval "$shell_vars"
      return 0
    fi
  fi

  CU_REPO_ROOT_WSL="${CU_REPO_ROOT_WSL:-$repo_root}"
  CU_MIRROR_ROOT_WSL="${CU_MIRROR_ROOT_WSL:-$CU_REPO_ROOT_WSL}"
  CU_SCRIPTS_DIR_WSL="${CU_SCRIPTS_DIR_WSL:-$scripts_dir}"
  CU_WINDOWS_SCRIPTS_DIR_WSL="${CU_WINDOWS_SCRIPTS_DIR_WSL:-$CU_SCRIPTS_DIR_WSL}"
  CU_SHOTS_DIR_WSL="${CU_SHOTS_DIR_WSL:-$CU_REPO_ROOT_WSL/shots}"
  CU_STATE_DIR_WSL="${CU_STATE_DIR_WSL:-$CU_REPO_ROOT_WSL/state}"
  CU_RUNS_DIR_WSL="${CU_RUNS_DIR_WSL:-$CU_REPO_ROOT_WSL/runs}"
  CU_DOCS_DIR_WSL="${CU_DOCS_DIR_WSL:-$CU_REPO_ROOT_WSL/docs}"
  CU_WECHAT_DB_WSL="${CU_WECHAT_DB_WSL:-${WECHAT_DB:-$CU_SHOTS_DIR_WSL/wechat_local.sqlite3}}"
  CU_REPO_ROOT_WIN="${CU_REPO_ROOT_WIN:-$(cu__wsl_to_win "$CU_REPO_ROOT_WSL")}"
  CU_MIRROR_ROOT_WIN="${CU_MIRROR_ROOT_WIN:-$(cu__wsl_to_win "$CU_MIRROR_ROOT_WSL")}"
  CU_SCRIPTS_DIR_WIN="${CU_SCRIPTS_DIR_WIN:-$(cu__wsl_to_win "$CU_WINDOWS_SCRIPTS_DIR_WSL")}"
  CU_SHOTS_DIR_WIN="${CU_SHOTS_DIR_WIN:-$(cu__wsl_to_win "$CU_SHOTS_DIR_WSL")}"
  CU_STATE_DIR_WIN="${CU_STATE_DIR_WIN:-$(cu__wsl_to_win "$CU_STATE_DIR_WSL")}"
  CU_RUNS_DIR_WIN="${CU_RUNS_DIR_WIN:-$(cu__wsl_to_win "$CU_RUNS_DIR_WSL")}"
  CU_DOCS_DIR_WIN="${CU_DOCS_DIR_WIN:-$(cu__wsl_to_win "$CU_DOCS_DIR_WSL")}"
  CU_WECHAT_DB_WIN="${CU_WECHAT_DB_WIN:-$(cu__wsl_to_win "$CU_WECHAT_DB_WSL")}"
  CU_DEFAULT_CONSOLE_PORT="${CU_DEFAULT_CONSOLE_PORT:-8766}"
  CU_CHROME_CDP_PORT="${CU_CHROME_CDP_PORT:-9222}"
  CU_AGENT_PROVIDER="${CU_AGENT_PROVIDER:-claude}"
  CU_SQLITE3="${CU_SQLITE3:-${SQLITE3:-sqlite3}}"
  CU_WEB_CDP_SCRIPT="${CU_WEB_CDP_SCRIPT:-}"
}
