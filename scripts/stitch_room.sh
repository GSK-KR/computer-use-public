#!/usr/bin/env bash
# ============================================================================
# stitch_room.sh <scrape_dir>  — OCR all frames oldest->newest, dedup overlapping
#   lines, print a chronological transcript to stdout.
#   <scrape_dir> = Windows path (C:\...\scrape_xxx) or WSL path (/mnt/c/...).
#   Cheap baseline (exact dedup on whitespace-stripped text); VLM can polish OCR noise.
# ============================================================================
set -uo pipefail
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SELF_DIR/lib/path_config.sh"
load_computer_use_path_config "$SELF_DIR"
IN="${1:?usage: stitch_room.sh <scrape_dir>}"
OCR="$CU_SCRIPTS_DIR_WIN\\ocr_lines.ps1"

# normalize to WSL dir for listing
DIR_WSL=$(printf '%s' "$IN" | sed 's#^C:#/mnt/c#; s#\\#/#g')

# chrome/noise to drop (room header, input bar, icons)
is_chrome() {
  local s="$1"
  case "$s" in
    *"환영합니다"*|*"메시지 입력"*|*"Q 9"*|"口"|"十 ㉭"|"C"|"0"|"1"|"O"|"€"|*"오픈재팅방"*|*"오픈채팅방"*) return 0;;
  esac
  return 1
}

declare -A seen
# frames in REVERSE numeric order: oldest (highest index = scrolled-up top) first
for f in $(ls "$DIR_WSL"/frame_*.png 2>/dev/null | sort -r); do
  win=$(printf '%s' "$f" | sed 's#^/mnt/c#C:#; s#/#\\#g')
  while IFS= read -r line; do
    key=$(printf '%s' "$line" | tr -d '[:space:]')
    [ ${#key} -lt 3 ] && continue
    is_chrome "$line" && continue
    if [ -z "${seen[$key]:-}" ]; then
      seen[$key]=1
      printf '%s\n' "$line"
    fi
  done < <(powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "$OCR" "$win" 2>/dev/null | jq -r 'sort_by(.y)[].text')
done
