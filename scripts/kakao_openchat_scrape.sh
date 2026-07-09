#!/usr/bin/env bash
# ============================================================================
# kakao_openchat_scrape.sh — scrape a KakaoTalk open-chat room and message
# comment threads.
#
# Main loop:
#   capture current chat view -> OCR -> detect "댓글/답글" entry points ->
#   click visible thread button immediately -> capture/OCR that thread panel ->
#   close panel -> scroll main chat upward.
#
# This is read-only. It never types or sends messages.
# ============================================================================
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$SELF_DIR/lib/path_config.sh"
load_computer_use_path_config "$SELF_DIR"
WIN_ROOT_WSL="$(cd "$CU_WINDOWS_SCRIPTS_DIR_WSL/.." && pwd -P)"
SCRIPTS_WIN="$CU_SCRIPTS_DIR_WIN"
SHOTS_WSL="$WIN_ROOT_WSL/shots"

PROC="KakaoTalk"
TITLE=""
HWND=""
ROOM_LABEL=""
OUT_DIR=""
MAX_FRAMES=80
MAX_THREAD_FRAMES=30
NOTCHES=7
LOAD_WAIT_MS=650
THREAD_WAIT_MS=900
TO_BOTTOM=0
OPEN_THREADS=1
MAIN_FX="0.50"
MAIN_FY="0.45"
THREAD_FX="0.72"
THREAD_FY="0.55"

usage() {
  cat <<'EOF'
usage: kakao_openchat_scrape.sh [options]

Target:
  --hwnd N                   exact Kakao chat window handle
  --title TEXT               Kakao window title substring, e.g. 엘디유오_브릴CS
  --proc NAME                process name, default KakaoTalk
  --room-label TEXT          label stored in manifest

Capture:
  --out-dir DIR              output dir; default shots/kakao_openchat_YYYYMMDD_HHMMSS
  --max-frames N             main-chat frames, default 80
  --thread-max-frames N      per-comment thread frames, default 30
  --notches N                wheel notches per scroll, default 7
  --to-bottom                first scroll to newest/bottom, then scrape upward
  --no-comments              only scrape main chat, do not click comment buttons

Advanced:
  --main-fx N --main-fy N    main chat scroll fraction, default 0.50/0.45
  --thread-fx N --thread-fy N thread panel scroll fraction, default 0.72/0.55

Examples:
  bash scripts/kakao_openchat_scrape.sh --title '엘디유오_브릴CS' --to-bottom --max-frames 120
  bash scripts/kakao_openchat_scrape.sh --hwnd 123456 --thread-max-frames 20
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hwnd) HWND="${2:-}"; shift 2 ;;
    --hwnd=*) HWND="${1#--hwnd=}"; shift ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --title=*) TITLE="${1#--title=}"; shift ;;
    --proc) PROC="${2:-KakaoTalk}"; shift 2 ;;
    --proc=*) PROC="${1#--proc=}"; shift ;;
    --room-label) ROOM_LABEL="${2:-}"; shift 2 ;;
    --room-label=*) ROOM_LABEL="${1#--room-label=}"; shift ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --out-dir=*) OUT_DIR="${1#--out-dir=}"; shift ;;
    --max-frames) MAX_FRAMES="${2:-80}"; shift 2 ;;
    --max-frames=*) MAX_FRAMES="${1#--max-frames=}"; shift ;;
    --thread-max-frames) MAX_THREAD_FRAMES="${2:-30}"; shift 2 ;;
    --thread-max-frames=*) MAX_THREAD_FRAMES="${1#--thread-max-frames=}"; shift ;;
    --notches) NOTCHES="${2:-7}"; shift 2 ;;
    --notches=*) NOTCHES="${1#--notches=}"; shift ;;
    --to-bottom) TO_BOTTOM=1; shift ;;
    --no-comments) OPEN_THREADS=0; shift ;;
    --main-fx) MAIN_FX="${2:-0.50}"; shift 2 ;;
    --main-fx=*) MAIN_FX="${1#--main-fx=}"; shift ;;
    --main-fy) MAIN_FY="${2:-0.45}"; shift 2 ;;
    --main-fy=*) MAIN_FY="${1#--main-fy=}"; shift ;;
    --thread-fx) THREAD_FX="${2:-0.72}"; shift 2 ;;
    --thread-fx=*) THREAD_FX="${1#--thread-fx=}"; shift ;;
    --thread-fy) THREAD_FY="${2:-0.55}"; shift 2 ;;
    --thread-fy=*) THREAD_FY="${1#--thread-fy=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$SHOTS_WSL/kakao_openchat_$(date +%Y%m%d_%H%M%S)"
fi
mkdir -p "$OUT_DIR"/frames "$OUT_DIR"/ocr "$OUT_DIR"/thread_candidates "$OUT_DIR"/threads

to_win_path() {
  printf '%s' "$1" | sed 's#^/mnt/c#C:#; s#/#\\#g'
}

ps_win() {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPTS_WIN\\kakao_window.ps1" "$@"
}

ps_ocr() {
  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "$SCRIPTS_WIN\\ocr_lines.ps1" "$@"
}

sleep_ms() {
  local ms="$1"
  sleep "$(awk -v ms="$ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
}

target_args=()
if [[ -n "$HWND" ]]; then
  target_args=(-Hwnd "$HWND")
else
  target_args=(-ProcName "$PROC")
  [[ -n "$TITLE" ]] && target_args+=(-Title "$TITLE")
fi

if ! rect_out=$(ps_win rect "${target_args[@]}" 2>&1); then
  echo "failed to resolve KakaoTalk window: $rect_out" >&2
  exit 1
fi
HWND=$(printf '%s\n' "$rect_out" | grep -oP 'hwnd=\K[0-9]+' | head -1 || true)
rect=$(printf '%s\n' "$rect_out" | grep -oP 'rect=\K[-0-9,]+' | head -1 || true)
if [[ -z "$HWND" || -z "$rect" ]]; then
  echo "failed to resolve KakaoTalk window: $rect_out" >&2
  exit 1
fi

if [[ -z "$ROOM_LABEL" ]]; then
  ROOM_LABEL="${TITLE:-KakaoTalk open chat}"
fi

parse_rect() {
  local r="$1"
  IFS=',' read -r WIN_L WIN_T WIN_R WIN_B <<< "$r"
  WIN_W=$((WIN_R - WIN_L))
  WIN_H=$((WIN_B - WIN_T))
}
parse_rect "$rect"

echo "TARGET hwnd=$HWND rect=$rect label=$ROOM_LABEL" >&2
START_EPOCH=$(date +%s)

if [[ "$TO_BOTTOM" -eq 1 ]]; then
  echo ">> scrolling to bottom/newest..." >&2
  prev=""
  for _ in $(seq 1 50); do
    ps_win scroll -Hwnd "$HWND" -Notches "-$NOTCHES" -Fx "$MAIN_FX" -Fy "$MAIN_FY" >/dev/null
    sleep_ms "$LOAD_WAIT_MS"
    probe="$OUT_DIR/_bottom_probe.png"
    ps_win capture -Hwnd "$HWND" -OutPath "$(to_win_path "$probe")" >/dev/null
    cur=$(md5sum "$probe" | awk '{print $1}')
    [[ "$cur" == "$prev" ]] && break
    prev="$cur"
  done
  rm -f "$OUT_DIR/_bottom_probe.png"
fi

seen_keys="$OUT_DIR/threads/.seen_comment_keys"
: > "$seen_keys"
thread_index_jsonl="$OUT_DIR/threads/thread_index.jsonl"
: > "$thread_index_jsonl"

thread_count=0
main_prev_hash=""
main_frames=0

capture_ocr_frame() {
  local hwnd="$1"
  local png="$2"
  local json="$3"
  local update_main_rect="${4:-0}"
  local cap
  if ! cap=$(ps_win capture -Hwnd "$hwnd" -OutPath "$(to_win_path "$png")" 2>&1); then
    echo "WARN: capture failed for $png: $cap" >&2
    return 1
  fi
  local cap_rect
  cap_rect=$(printf '%s\n' "$cap" | grep -oP 'rect=\K[-0-9,]+' | head -1 || true)
  if [[ "$update_main_rect" -eq 1 && -n "$cap_rect" ]]; then
    parse_rect "$cap_rect"
  fi
  if ! ps_ocr "$(to_win_path "$png")" 2>/dev/null > "$json"; then
    echo "WARN: OCR failed for $png" >&2
    echo '[]' > "$json"
    return 1
  fi
}

window_hwnds_file() {
  local out="$1"
  ps_win list -ProcName "$PROC" > "$out" 2>/dev/null || : > "$out"
}

new_kakao_hwnd_after() {
  local before="$1"
  local after="$2"
  window_hwnds_file "$after"
  while IFS= read -r line; do
    local h
    h=$(printf '%s\n' "$line" | grep -oP 'hwnd=\K[0-9]+' | head -1 || true)
    [[ -z "$h" ]] && continue
    if ! grep -q "hwnd=$h\\b" "$before"; then
      printf '%s\n' "$h"
      return 0
    fi
  done < "$after"
  return 1
}

wait_for_main_window() {
  for _ in $(seq 1 20); do
    if ps_win rect -Hwnd "$HWND" >/dev/null 2>&1; then
      return 0
    fi
    sleep_ms 250
  done
  return 1
}

write_thread_failure() {
  local tdir="$1"
  local parent_frame="$2"
  local candidate_json="$3"
  local status="$4"
  local detail="${5:-}"
  mkdir -p "$tdir"/frames "$tdir"/ocr
  : > "$tdir/transcript.txt"
  node - <<'NODE' "$tdir" "$parent_frame" "$candidate_json" "$ROOM_LABEL" "$status" "$detail"
const fs = require('fs');
const [dir, parentFrame, candidatePath, roomLabel, status, detail] = process.argv.slice(2);
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
fs.writeFileSync(`${dir}/thread_manifest.json`, `${JSON.stringify({
  schema: 'kakao_openchat_thread.v1',
  generated_at: new Date().toISOString(),
  room_label: roomLabel,
  parent_frame: Number(parentFrame),
  captured_frames: 0,
  status,
  detail,
  candidate,
  files: {
    transcript: 'transcript.txt',
    manifest: 'thread_manifest.json',
    candidate: 'candidate.json',
  },
}, null, 2)}\n`);
NODE
}

capture_thread() {
  local tdir="$1"
  local thread_hwnd="$2"
  local parent_frame="$3"
  local candidate_json="$4"
  local thread_started_epoch
  thread_started_epoch=$(date +%s)
  mkdir -p "$tdir"/frames "$tdir"/ocr
  local prev="" count=0
  for j in $(seq 0 $((MAX_THREAD_FRAMES - 1))); do
    local frame
    frame=$(printf '%s/frames/frame_%03d.png' "$tdir" "$j")
    local ocr
    ocr=$(printf '%s/ocr/frame_%03d.json' "$tdir" "$j")
    if ! capture_ocr_frame "$thread_hwnd" "$frame" "$ocr" 0; then
      rm -f "$frame" "$ocr"
      break
    fi
    local hh
    hh=$(md5sum "$frame" | awk '{print $1}')
    if [[ "$j" -gt 0 && "$hh" == "$prev" ]]; then
      rm -f "$frame" "$ocr"
      break
    fi
    prev="$hh"
    count=$((count + 1))
    ps_win scroll -Hwnd "$thread_hwnd" -Notches "$NOTCHES" -Fx "$THREAD_FX" -Fy "$THREAD_FY" >/dev/null
    sleep_ms "$LOAD_WAIT_MS"
  done
  node "$SELF_DIR/stitch.mjs" "$tdir/ocr" > "$tdir/transcript.txt" || : > "$tdir/transcript.txt"
  node - <<'NODE' "$tdir" "$parent_frame" "$candidate_json" "$count" "$ROOM_LABEL" "$thread_hwnd" "$thread_started_epoch"
const fs = require('fs');
const [dir, parentFrame, candidatePath, count, roomLabel, threadHwnd, startedEpoch] = process.argv.slice(2);
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  fs.writeFileSync(`${dir}/thread_manifest.json`, `${JSON.stringify({
  schema: 'kakao_openchat_thread.v1',
  generated_at: new Date().toISOString(),
  room_label: roomLabel,
  thread_hwnd: Number(threadHwnd),
  parent_frame: Number(parentFrame),
  captured_frames: Number(count),
  status: Number(count) > 0 ? 'captured' : 'capture_failed',
  elapsed_seconds: Math.max(0, Math.round(Date.now() / 1000 - Number(startedEpoch))),
  candidate,
  files: {
    transcript: 'transcript.txt',
    manifest: 'thread_manifest.json',
    candidate: 'candidate.json',
  },
}, null, 2)}\n`);
NODE
}

for i in $(seq 0 $((MAX_FRAMES - 1))); do
  frame_png=$(printf '%s/frames/frame_%03d.png' "$OUT_DIR" "$i")
  frame_json=$(printf '%s/ocr/frame_%03d.json' "$OUT_DIR" "$i")
  echo ">> main frame $i/$MAX_FRAMES" >&2
  if ! capture_ocr_frame "$HWND" "$frame_png" "$frame_json" 1; then
    echo "WARN: stopping main loop after capture/OCR failure at frame $i" >&2
    break
  fi
  main_frames=$((main_frames + 1))

  current_hash=$(md5sum "$frame_png" | awk '{print $1}')
  if [[ -n "$main_prev_hash" && "$current_hash" == "$main_prev_hash" ]]; then
    sleep_ms "$LOAD_WAIT_MS"
    capture_ocr_frame "$HWND" "$frame_png" "$frame_json" 1
    current_hash=$(md5sum "$frame_png" | awk '{print $1}')
    if [[ "$current_hash" == "$main_prev_hash" ]]; then
      rm -f "$frame_png" "$frame_json"
      main_frames=$((main_frames - 1))
      echo ">> main top/stable reached" >&2
      break
    fi
  fi
  main_prev_hash="$current_hash"

  cand_json=$(printf '%s/thread_candidates/frame_%03d.json' "$OUT_DIR" "$i")
  node "$SELF_DIR/kakao_openchat_threads.mjs" \
    --ocr "$frame_json" \
    --frame-index "$i" \
    --window-width "$WIN_W" \
    --window-height "$WIN_H" > "$cand_json"

  if [[ "$OPEN_THREADS" -eq 1 ]]; then
    cand_count=$(jq '.candidates | length' "$cand_json")
    for idx in $(seq 0 $((cand_count - 1))); do
      key=$(jq -r ".candidates[$idx].dedupe_key" "$cand_json")
      [[ -z "$key" || "$key" == "null" ]] && continue
      if grep -Fxq "$key" "$seen_keys"; then
        continue
      fi
      echo "$key" >> "$seen_keys"
      rel_x=$(jq -r ".candidates[$idx].click_x" "$cand_json")
      rel_y=$(jq -r ".candidates[$idx].click_y" "$cand_json")
      sx=$((WIN_L + rel_x))
      sy=$((WIN_T + rel_y))
      thread_count=$((thread_count + 1))
      tdir=$(printf '%s/threads/thread_%03d' "$OUT_DIR" "$thread_count")
      mkdir -p "$tdir"
      jq ".candidates[$idx] + {screen_x:$sx, screen_y:$sy}" "$cand_json" > "$tdir/candidate.json"
      echo ">> open comment thread #$thread_count at frame=$i screen=$sx,$sy" >&2
      before_windows="$tdir/windows_before.txt"
      after_windows="$tdir/windows_after.txt"
      window_hwnds_file "$before_windows"
      if ! ps_win click -Hwnd "$HWND" -X "$sx" -Y "$sy" >/dev/null; then
        write_thread_failure "$tdir" "$i" "$tdir/candidate.json" "click_failed" "failed to click comment marker"
        echo "WARN: comment thread #$thread_count click failed" >&2
        continue
      fi
      sleep_ms "$THREAD_WAIT_MS"
      thread_hwnd=$(new_kakao_hwnd_after "$before_windows" "$after_windows" || true)
      if [[ -z "$thread_hwnd" ]]; then
        write_thread_failure "$tdir" "$i" "$tdir/candidate.json" "thread_window_not_found" "no new KakaoTalk thread window appeared"
        echo "WARN: comment thread #$thread_count window not found" >&2
      elif ! capture_thread "$tdir" "$thread_hwnd" "$i" "$tdir/candidate.json"; then
        echo "WARN: comment thread #$thread_count capture returned non-zero" >&2
      fi
      if [[ -n "${thread_hwnd:-}" && "$thread_hwnd" != "$HWND" ]]; then
        ps_win key -Hwnd "$thread_hwnd" -Keys "%{F4}" >/dev/null || true
      fi
      sleep_ms 500
      if ! wait_for_main_window; then
        echo "WARN: main chat window did not return after closing comment thread #$thread_count" >&2
        break
      fi
      jq -c --arg dir "$tdir" --argjson n "$thread_count" --argjson frame "$i" \
        '. + {thread_index:$n, thread_dir:$dir, parent_frame:$frame}' "$tdir/candidate.json" >> "$thread_index_jsonl"
    done
  fi

  ps_win scroll -Hwnd "$HWND" -Notches "$NOTCHES" -Fx "$MAIN_FX" -Fy "$MAIN_FY" >/dev/null
  sleep_ms "$LOAD_WAIT_MS"
done

node "$SELF_DIR/stitch.mjs" "$OUT_DIR/ocr" > "$OUT_DIR/transcript.txt"

node - <<'NODE' "$OUT_DIR" "$ROOM_LABEL" "$HWND" "$main_frames" "$thread_count" "$MAX_FRAMES" "$MAX_THREAD_FRAMES" "$OPEN_THREADS" "$START_EPOCH"
const fs = require('fs');
const path = require('path');
const [dir, roomLabel, hwnd, mainFrames, threadCount, maxFrames, maxThreadFrames, openThreads, startedEpoch] = process.argv.slice(2);
const jsonlPath = `${dir}/threads/thread_index.jsonl`;
const threads = fs.existsSync(jsonlPath)
  ? fs.readFileSync(jsonlPath, 'utf8').split(/\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const threadRoot = `${dir}/threads`;
const threadManifests = fs.existsSync(threadRoot)
  ? fs.readdirSync(threadRoot)
      .filter((name) => /^thread_\d+$/.test(name))
      .map((name) => path.join(threadRoot, name, 'thread_manifest.json'))
      .filter((p) => fs.existsSync(p))
      .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')))
  : [];
const capturedThreads = threadManifests.filter((m) => m.status === 'captured').length;
const manifest = {
  schema: 'kakao_openchat_scrape.v1',
  generated_at: new Date().toISOString(),
  room_label: roomLabel,
  hwnd: Number(hwnd),
  main_frames: Number(mainFrames),
  comment_threads_attempted: Number(threadCount),
  comment_threads_captured: capturedThreads,
  elapsed_seconds: Math.max(0, Math.round(Date.now() / 1000 - Number(startedEpoch))),
  options: {
    max_frames: Number(maxFrames),
    max_thread_frames: Number(maxThreadFrames),
    open_threads: openThreads === '1',
  },
  files: {
    transcript: 'transcript.txt',
    frames_dir: 'frames',
    ocr_dir: 'ocr',
    thread_candidates_dir: 'thread_candidates',
    threads_dir: 'threads',
  },
  threads,
};
fs.writeFileSync(`${dir}/kakao_openchat_manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(`${dir}/threads/thread_index.json`, `${JSON.stringify({ schema: 'kakao_openchat_thread_index.v1', threads }, null, 2)}\n`);
NODE

if ! node "$SELF_DIR/kakao_openchat_structure.mjs" "$OUT_DIR" --write >/dev/null; then
  echo "WARN: kakao_openchat_structure failed; viewer will fall back to on-demand structure" >&2
fi

lines=$(wc -l < "$OUT_DIR/transcript.txt" | tr -d ' ')
captured_threads=$(jq -r '.comment_threads_captured // 0' "$OUT_DIR/kakao_openchat_manifest.json" 2>/dev/null || printf '0')
echo "KAKAO_OPENCHAT_DIR=$(to_win_path "$OUT_DIR")"
echo "MAIN_FRAMES=$main_frames"
echo "THREADS_ATTEMPTED=$thread_count"
echo "THREADS_CAPTURED=$captured_threads"
echo "TRANSCRIPT=$(to_win_path "$OUT_DIR/transcript.txt") ($lines lines)"
