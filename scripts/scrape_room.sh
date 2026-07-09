#!/usr/bin/env bash
# ============================================================================
# scrape_room.sh — ONE COMMAND: scrape a chat window's history -> transcript.
#   1) scrape_capture.ps1  : scroll + capture frames (auto-stop at top)
#   2) ocr_lines.ps1 (-STA): OCR each frame -> frame_NNN.json
#   3) stitch.mjs (node)   : fuzzy-dedup + chronological transcript -> transcript.txt
#
# Usage: scrape_room.sh [ProcName] [extra scrape_capture args...]
#   e.g. scrape_room.sh KakaoTalk -ToBottom -MaxFrames 40
# ============================================================================
set -uo pipefail
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SELF_DIR/lib/path_config.sh"
load_computer_use_path_config "$SELF_DIR"
BASE="$CU_SCRIPTS_DIR_WIN"
PROC="${1:-KakaoTalk}"; [ $# -gt 0 ] && shift
EXTRA="$*"

echo ">> capturing frames ($PROC $EXTRA)..." >&2
OUT=$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$BASE\\scrape_capture.ps1" "$PROC" $EXTRA 2>&1)
echo "$OUT" >&2
DIRWIN=$(printf '%s' "$OUT" | grep -oP 'DIR=\K.*' | tr -d '\r')
if [ -z "$DIRWIN" ]; then echo "ERROR: no scrape dir (no window?)" >&2; exit 1; fi
DIRWSL=$(printf '%s' "$DIRWIN" | sed 's#^C:#/mnt/c#; s#\\#/#g')

echo ">> OCR per frame..." >&2
shopt -s nullglob
for f in "$DIRWSL"/frame_*.png; do
  win=$(printf '%s' "$f" | sed 's#^/mnt/c#C:#; s#/#\\#g')
  base=$(basename "$f" .png)
  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "$BASE\\ocr_lines.ps1" "$win" 2>/dev/null > "$DIRWSL/$base.json"
done

echo ">> stitching..." >&2
TRANS="$DIRWSL/transcript.txt"
node "$SELF_DIR/stitch.mjs" "$DIRWSL" > "$TRANS"

LINES=$(wc -l < "$TRANS" | tr -d ' ')
echo "TRANSCRIPT=$DIRWIN\\transcript.txt  ($LINES lines)"
