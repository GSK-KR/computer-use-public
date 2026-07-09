#!/usr/bin/env bash
# Batch WeChat local backup for visible chat-list rows.
#
# This is still a local, user-authorized backup workflow. It clicks visible rows
# in the WeChat chat list, exports each selected room with wechat_scrape.sh, and
# writes a metrics-only batch manifest. It does not read private databases or
# bypass login.
set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_WSL="$(cd "$SELF_DIR/.." && pwd -P)"
. "$SELF_DIR/lib/path_config.sh"
load_computer_use_path_config "$SELF_DIR"

PROC="Weixin"
HWND=""
CONFIRM="0"
PAGES="1"
ROOM_LIMIT="0"
MAX_VISIBLE_ROOMS="20"
MAX_FRAMES="120"
LIST_CROP="auto"
OUT_DIR_WSL=""
ROOM_WAIT_MS="900"
PAGE_WAIT_MS="700"
DIRECT_CHAT_AUTO="0"
TRANSLATE_KO="0"
ALLOW_CLOUD_TRANSLATION="0"
TRANSLATION_TIMEOUT_S="180"
TRANSLATION_PROVIDER="codex"
TRANSLATION_MODEL=""
TRANSLATION_CHUNK_SIZE=""
TRANSLATION_CODEX_CONFIGS=()
DRY_RUN="0"
EXCLUDE_TITLE_FILE=""
DB_WSL=""
DB_SKIP_KNOWN="0"

usage() {
  cat <<'EOF'
wechat_batch.sh --confirm-local-backup [options]

Local backup batch runner for user-authorized WeChat chats. It OCRs the visible
left chat list, clicks room rows, runs wechat_scrape.sh for each room, and writes
a batch manifest. Use small --room-limit values first.

Options:
  --confirm-local-backup       required; acknowledges local private-data export
  --proc NAME                  WeChat process name (default: Weixin)
  --hwnd N                     exact WeChat main window handle; recommended
  --pages N                    chat-list pages to process (default: 1)
  --room-limit N               max rooms across all pages; 0 = no extra limit
  --max-visible-rooms N        max OCR room candidates per page (default: 20)
  --max-frames N               max history frames per room (default: 120)
  --list-crop auto|WxH+X+Y     left chat-list crop (default: auto)
  --out-dir DIR                batch output dir
  --room-wait-ms N             wait after selecting a room (default: 900)
  --page-wait-ms N             wait after scrolling chat list (default: 700)
  --direct-chat-auto           use room label as left-side speaker hint for 1:1-style rooms
  --translate-ko               pass through to per-room scrape
  --allow-cloud-translation    required with --translate-ko
  --translation-provider NAME   codex|claude (default: codex)
  --translation-timeout-s N     pass through to per-room scrape (default: 180)
  --translation-model NAME      pass Codex model to per-room scrape
  --translation-chunk-size N    pass Codex chunk size to per-room scrape
  --translation-codex-config K=V
                               repeatable Codex CLI -c config for per-room scrape
  --dry-run                    list room candidates without clicking/scraping
  --exclude-title-file FILE    one room title per line to skip if selected again
  --db FILE                    import completed batch into this local SQLite DB
  --db-skip-known              with --db, skip room titles already present in DB
  -h, --help                   show help
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARN: $*" >&2
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

to_win_path() {
  wslpath -w "$1"
}

to_wsl_path() {
  wslpath -u "$1"
}

resolve_windows_root() {
  if [[ -n "${COMPUTER_USE_WIN_ROOT:-}" ]]; then
    WIN_ROOT_WSL="$(to_wsl_path "$COMPUTER_USE_WIN_ROOT")"
  elif [[ -f "$CU_WINDOWS_SCRIPTS_DIR_WSL/scrape_capture.ps1" ]]; then
    WIN_ROOT_WSL="$(cd "$CU_WINDOWS_SCRIPTS_DIR_WSL/.." && pwd -P)"
  elif [[ "$ROOT_WSL" =~ ^/mnt/[A-Za-z]/ ]]; then
    WIN_ROOT_WSL="$ROOT_WSL"
  else
    die "repo is not under /mnt/<drive> and no Windows-visible fallback was found; set COMPUTER_USE_WIN_ROOT"
  fi

  [[ -f "$WIN_ROOT_WSL/scripts/scrape_capture.ps1" ]] || die "missing $WIN_ROOT_WSL/scripts/scrape_capture.ps1"
  [[ -f "$WIN_ROOT_WSL/scripts/wechat_window.ps1" ]] || die "missing $WIN_ROOT_WSL/scripts/wechat_window.ps1; sync scripts to the Windows-visible root"
  WIN_ROOT_WIN="$(to_win_path "$WIN_ROOT_WSL")"
  SCRIPTS_WIN="$WIN_ROOT_WIN\\scripts"
}

safe_slug() {
  local label="$1" hash slug
  hash=$(printf '%s' "$label" | sha1sum | awk '{print substr($1,1,8)}')
  slug=$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]_.-' '_' | sed 's/^_//; s/_$//; s/__*/_/g' | cut -c1-40)
  [[ -n "$slug" ]] || slug="room"
  printf '%s_%s' "$slug" "$hash"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-local-backup) CONFIRM="1"; shift ;;
    --proc) PROC="${2:?missing --proc value}"; shift 2 ;;
    --proc=*) PROC="${1#--proc=}"; shift ;;
    --hwnd) HWND="${2:?missing --hwnd value}"; shift 2 ;;
    --hwnd=*) HWND="${1#--hwnd=}"; shift ;;
    --pages) PAGES="${2:?missing --pages value}"; shift 2 ;;
    --pages=*) PAGES="${1#--pages=}"; shift ;;
    --room-limit) ROOM_LIMIT="${2:?missing --room-limit value}"; shift 2 ;;
    --room-limit=*) ROOM_LIMIT="${1#--room-limit=}"; shift ;;
    --max-visible-rooms) MAX_VISIBLE_ROOMS="${2:?missing --max-visible-rooms value}"; shift 2 ;;
    --max-visible-rooms=*) MAX_VISIBLE_ROOMS="${1#--max-visible-rooms=}"; shift ;;
    --max-frames) MAX_FRAMES="${2:?missing --max-frames value}"; shift 2 ;;
    --max-frames=*) MAX_FRAMES="${1#--max-frames=}"; shift ;;
    --list-crop) LIST_CROP="${2:?missing --list-crop value}"; shift 2 ;;
    --list-crop=*) LIST_CROP="${1#--list-crop=}"; shift ;;
    --out-dir) OUT_DIR_WSL="${2:?missing --out-dir value}"; shift 2 ;;
    --out-dir=*) OUT_DIR_WSL="${1#--out-dir=}"; shift ;;
    --room-wait-ms) ROOM_WAIT_MS="${2:?missing --room-wait-ms value}"; shift 2 ;;
    --room-wait-ms=*) ROOM_WAIT_MS="${1#--room-wait-ms=}"; shift ;;
    --page-wait-ms) PAGE_WAIT_MS="${2:?missing --page-wait-ms value}"; shift 2 ;;
    --page-wait-ms=*) PAGE_WAIT_MS="${1#--page-wait-ms=}"; shift ;;
    --direct-chat-auto) DIRECT_CHAT_AUTO="1"; shift ;;
    --translate-ko) TRANSLATE_KO="1"; shift ;;
    --allow-cloud-translation) ALLOW_CLOUD_TRANSLATION="1"; shift ;;
    --translation-provider) TRANSLATION_PROVIDER="${2:?missing --translation-provider value}"; shift 2 ;;
    --translation-provider=*) TRANSLATION_PROVIDER="${1#--translation-provider=}"; shift ;;
    --translation-timeout-s) TRANSLATION_TIMEOUT_S="${2:?missing --translation-timeout-s value}"; shift 2 ;;
    --translation-timeout-s=*) TRANSLATION_TIMEOUT_S="${1#--translation-timeout-s=}"; shift ;;
    --translation-model) TRANSLATION_MODEL="${2:?missing --translation-model value}"; shift 2 ;;
    --translation-model=*) TRANSLATION_MODEL="${1#--translation-model=}"; shift ;;
    --translation-chunk-size) TRANSLATION_CHUNK_SIZE="${2:?missing --translation-chunk-size value}"; shift 2 ;;
    --translation-chunk-size=*) TRANSLATION_CHUNK_SIZE="${1#--translation-chunk-size=}"; shift ;;
    --translation-codex-config) TRANSLATION_CODEX_CONFIGS+=("${2:?missing --translation-codex-config value}"); shift 2 ;;
    --translation-codex-config=*) TRANSLATION_CODEX_CONFIGS+=("${1#--translation-codex-config=}"); shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --exclude-title-file) EXCLUDE_TITLE_FILE="${2:?missing --exclude-title-file value}"; shift 2 ;;
    --exclude-title-file=*) EXCLUDE_TITLE_FILE="${1#--exclude-title-file=}"; shift ;;
    --db) DB_WSL="${2:?missing --db value}"; shift 2 ;;
    --db=*) DB_WSL="${1#--db=}"; shift ;;
    --db-skip-known) DB_SKIP_KNOWN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$CONFIRM" == "1" ]] || die "batch requires --confirm-local-backup"
[[ "$PAGES" =~ ^[0-9]+$ ]] && (( PAGES >= 1 )) || die "--pages must be >= 1"
[[ "$ROOM_LIMIT" =~ ^[0-9]+$ ]] || die "--room-limit must be >= 0"
[[ "$MAX_VISIBLE_ROOMS" =~ ^[0-9]+$ ]] && (( MAX_VISIBLE_ROOMS >= 1 )) || die "--max-visible-rooms must be >= 1"
[[ "$MAX_FRAMES" =~ ^[0-9]+$ ]] && (( MAX_FRAMES >= 1 )) || die "--max-frames must be >= 1"
if [[ "$TRANSLATE_KO" == "1" && "$ALLOW_CLOUD_TRANSLATION" != "1" ]]; then
  die "--translate-ko requires --allow-cloud-translation"
fi
if [[ "$TRANSLATION_PROVIDER" != "codex" && "$TRANSLATION_PROVIDER" != "claude" ]]; then
  die "--translation-provider must be codex or claude"
fi

need_cmd powershell.exe
need_cmd tesseract
need_cmd convert
need_cmd identify
need_cmd node
need_cmd jq
need_cmd wslpath
need_cmd sha1sum
if [[ "$TRANSLATE_KO" == "1" ]]; then
  need_cmd timeout
  if [[ "$TRANSLATION_PROVIDER" == "codex" ]]; then
    need_cmd codex
  else
    need_cmd claude
  fi
fi
if [[ -n "$DB_WSL" ]]; then
  need_cmd sqlite3
fi
resolve_windows_root

export TESSDATA_PREFIX="${TESSDATA_PREFIX:-$HOME/.cache/computer-use/tessdata}"

if [[ -z "$OUT_DIR_WSL" ]]; then
  OUT_DIR_WSL="$WIN_ROOT_WSL/shots/wechat_batch_$(date +%Y%m%d_%H%M%S)"
fi
OUT_DIR_WIN="$(to_win_path "$OUT_DIR_WSL")"
mkdir -p "$OUT_DIR_WSL/pages" "$OUT_DIR_WSL/rooms"

batch_manifest="$OUT_DIR_WSL/wechat_batch_manifest.json"
rooms_ndjson="$OUT_DIR_WSL/rooms.ndjson"
: > "$rooms_ndjson"

echo "WeChat batch export plan:"
echo "  proc=$PROC hwnd=${HWND:-auto-main-window}"
echo "  out_dir=$OUT_DIR_WSL"
echo "  pages=$PAGES room_limit=$ROOM_LIMIT max_visible_rooms=$MAX_VISIBLE_ROOMS max_frames=$MAX_FRAMES"
echo "  list_crop=$LIST_CROP direct_chat_auto=$DIRECT_CHAT_AUTO dry_run=$DRY_RUN"
echo "  translation=$TRANSLATE_KO provider=$TRANSLATION_PROVIDER"
echo "  db=${DB_WSL:-none} db_skip_known=$DB_SKIP_KNOWN"
echo "  scope=visible chat-list rooms from a user-opened WeChat window; output remains local"

processed=0
skipped_duplicates=0
skipped_duplicate_titles=0
declare -A seen_rooms=()
declare -A seen_titles=()

load_exclude_titles() {
  local file="$1" excluded_title excluded_key
  [[ -n "$file" && -f "$file" ]] || return 0
  while IFS= read -r excluded_title; do
    excluded_key=$(printf '%s' "$excluded_title" | tr -d '[:space:][:punct:]' | tr '[:upper:]' '[:lower:]')
    [[ -n "$excluded_key" ]] && seen_titles[$excluded_key]=1
  done < "$file"
}

if [[ -n "$DB_WSL" && "$DB_SKIP_KNOWN" == "1" ]]; then
  db_exclude_file="$OUT_DIR_WSL/db_known_titles.txt"
  node "$SELF_DIR/wechat_db_import.mjs" --db "$DB_WSL" --write-exclude "$db_exclude_file" >/dev/null
  load_exclude_titles "$db_exclude_file"
fi
load_exclude_titles "$EXCLUDE_TITLE_FILE"

for ((page=1; page<=PAGES; page++)); do
  page_png="$OUT_DIR_WSL/pages/page_$(printf '%03d' "$page").png"
  page_crop_png="$OUT_DIR_WSL/pages/page_$(printf '%03d' "$page")_list.png"
  page_json="$OUT_DIR_WSL/pages/page_$(printf '%03d' "$page")_list.json"
  candidates_json="$OUT_DIR_WSL/pages/page_$(printf '%03d' "$page")_rooms.json"

  capture_args=(-NoProfile -ExecutionPolicy Bypass -File "$SCRIPTS_WIN\\wechat_window.ps1" capture -ProcName "$PROC" -OutPath "$(to_win_path "$page_png")")
  [[ -n "$HWND" ]] && capture_args+=(-Hwnd "$HWND")
  powershell.exe "${capture_args[@]}" >/dev/null

  frame_size=$(identify -format '%wx%h' "$page_png" 2>/dev/null || echo "2048x1392")
  frame_w="${frame_size%x*}"
  frame_h="${frame_size#*x}"
  page_list_crop="$LIST_CROP"
  if [[ "$page_list_crop" == "auto" ]]; then
    list_w=$((frame_w * 29 / 100))
    (( list_w < 420 )) && list_w=420
    (( list_w > 620 )) && list_w=620
    list_y=$((frame_h * 7 / 100))
    list_h=$((frame_h - list_y - 40))
    page_list_crop="${list_w}x${list_h}+0+${list_y}"
  fi

  convert "$page_png" -crop "$page_list_crop" +repage "$page_crop_png"
  TESSDATA_PREFIX="$TESSDATA_PREFIX" \
    tesseract "$page_crop_png" stdout -l chi_sim+kor+eng --psm 6 -c tessedit_create_tsv=1 2>"$OUT_DIR_WSL/pages/page_$(printf '%03d' "$page")_list.err" \
    | node "$SELF_DIR/tess_tsv_lines.mjs" --min-conf 10 > "$page_json"
  node "$SELF_DIR/wechat_rooms_from_ocr.mjs" \
    --json "$page_json" \
    --crop "$page_list_crop" \
    --max-rooms "$MAX_VISIBLE_ROOMS" > "$candidates_json"

  room_count=$(jq '.rooms | length' "$candidates_json")
  echo ">> page $page candidates=$room_count crop=$page_list_crop"

  if [[ "$DRY_RUN" == "1" ]]; then
    jq -r '.rooms[] | "  y=\(.click_y) label=\(.label)"' "$candidates_json"
  else
    while IFS= read -r room; do
      if (( ROOM_LIMIT > 0 && processed >= ROOM_LIMIT )); then
        break
      fi
      label=$(jq -r '.label' <<< "$room")
      key=$(printf '%s' "$label" | tr -d '[:space:][:punct:]' | tr '[:upper:]' '[:lower:]')
      if [[ -n "${seen_rooms[$key]:-}" ]]; then
        skipped_duplicates=$((skipped_duplicates + 1))
        continue
      fi
      seen_rooms[$key]=1
      click_x=$(jq -r '.click_x' <<< "$room")
      click_y=$(jq -r '.click_y' <<< "$room")
      processed=$((processed + 1))

      echo ">> room $processed page=$page y=$click_y"
      click_args=(-NoProfile -ExecutionPolicy Bypass -File "$SCRIPTS_WIN\\wechat_window.ps1" click -ProcName "$PROC" -X "$click_x" -Y "$click_y")
      [[ -n "$HWND" ]] && click_args+=(-Hwnd "$HWND")
      powershell.exe "${click_args[@]}" >/dev/null < /dev/null
      sleep "$(awk "BEGIN { printf \"%.3f\", $ROOM_WAIT_MS / 1000 }")"

      selected_png="$OUT_DIR_WSL/pages/room_$(printf '%03d' "$processed")_selected.png"
      header_png="$OUT_DIR_WSL/pages/room_$(printf '%03d' "$processed")_header.png"
      header_json="$OUT_DIR_WSL/pages/room_$(printf '%03d' "$processed")_header.json"
      header_title_json="$OUT_DIR_WSL/pages/room_$(printf '%03d' "$processed")_title.json"
      select_capture_args=(-NoProfile -ExecutionPolicy Bypass -File "$SCRIPTS_WIN\\wechat_window.ps1" capture -ProcName "$PROC" -OutPath "$(to_win_path "$selected_png")")
      [[ -n "$HWND" ]] && select_capture_args+=(-Hwnd "$HWND")
      powershell.exe "${select_capture_args[@]}" >/dev/null < /dev/null || true
      title_label="$label"
      if [[ -f "$selected_png" ]]; then
        if [[ "$page_list_crop" =~ ^([0-9]+)x[0-9]+\+([0-9]+)\+ ]]; then
          header_x=$((BASH_REMATCH[1] + BASH_REMATCH[2]))
        else
          header_x=$((frame_w * 29 / 100))
        fi
        header_w=$((frame_w - header_x - 80))
        (( header_w < 400 )) && header_w=$((frame_w - header_x))
        header_crop="${header_w}x130+${header_x}+0"
        if convert "$selected_png" -crop "$header_crop" +repage "$header_png" 2>/dev/null; then
          TESSDATA_PREFIX="$TESSDATA_PREFIX" \
            tesseract "$header_png" stdout -l chi_sim+kor+eng --psm 6 -c tessedit_create_tsv=1 2>"$header_json.err" \
            | node "$SELF_DIR/tess_tsv_lines.mjs" --min-conf 10 > "$header_json"
          node "$SELF_DIR/wechat_title_from_ocr.mjs" --json "$header_json" > "$header_title_json" || true
          header_title=$(jq -r '.title // ""' "$header_title_json" 2>/dev/null || echo "")
          if [[ -n "$header_title" ]]; then
            title_label="$header_title"
          fi
        fi
      fi

      slug="$(safe_slug "$title_label")"
      room_dir="$OUT_DIR_WSL/rooms/$(printf '%03d' "$processed")_$slug"

      title_key=$(printf '%s' "$title_label" | tr -d '[:space:][:punct:]' | tr '[:upper:]' '[:lower:]')
      if [[ -n "${seen_titles[$title_key]:-}" ]]; then
        skipped_duplicate_titles=$((skipped_duplicate_titles + 1))
        jq -n \
          --argjson page "$page" \
          --argjson index "$processed" \
          --arg label "$title_label" \
          --arg list_label "$label" \
          --argjson click_x "$click_x" \
          --argjson click_y "$click_y" \
          --arg room_dir "$room_dir" \
          '{page:$page,index:$index,label:$label,list_label:$list_label,click:{x:$click_x,y:$click_y},scrape_status:"skipped",audit_status:"skipped_duplicate_title",skip_reason:"selected room title was already processed",room_dir:$room_dir}' \
          >> "$rooms_ndjson"
        continue
      fi
      seen_titles[$title_key]=1

      scrape_args=(run --confirm-local-backup --proc "$PROC" --max-frames "$MAX_FRAMES" --room-label "$title_label" --out-dir "$room_dir")
      [[ -n "$HWND" ]] && scrape_args+=(--hwnd "$HWND")
      if [[ "$DIRECT_CHAT_AUTO" == "1" ]]; then
        scrape_args+=(--incoming-speaker auto)
      fi
      if [[ "$TRANSLATE_KO" == "1" ]]; then
        scrape_args+=(--translate-ko --allow-cloud-translation --translation-provider "$TRANSLATION_PROVIDER" --translation-timeout-s "$TRANSLATION_TIMEOUT_S")
        [[ -n "$TRANSLATION_MODEL" ]] && scrape_args+=(--translation-model "$TRANSLATION_MODEL")
        [[ -n "$TRANSLATION_CHUNK_SIZE" ]] && scrape_args+=(--translation-chunk-size "$TRANSLATION_CHUNK_SIZE")
        for config in "${TRANSLATION_CODEX_CONFIGS[@]}"; do
          scrape_args+=(--translation-codex-config "$config")
        done
      fi

      scrape_status="ok"
      if ! bash "$SELF_DIR/wechat_scrape.sh" "${scrape_args[@]}" > "$room_dir.log" 2>&1 < /dev/null; then
        scrape_status="failed"
      fi

      audit_status="missing"
      skip_reason=""
      if [[ -f "$room_dir/wechat_messages.json" ]]; then
        audit_json="$room_dir/wechat_audit.json"
        node "$SELF_DIR/wechat_audit.mjs" --dir "$room_dir" --json > "$audit_json" || true
        audit_status=$(jq -r '.status // "missing"' "$audit_json" 2>/dev/null || echo "missing")
        audit_messages=$(jq '.metrics.messages.structured // 0' "$audit_json" 2>/dev/null || echo 0)
        audit_raw_lines=$(jq '.metrics.ocr.raw_lines // 0' "$audit_json" 2>/dev/null || echo 0)
        audit_frames=$(jq '.metrics.frames.captured // 0' "$audit_json" 2>/dev/null || echo 0)
        if [[ "$audit_status" == "fail" ]] && (( audit_frames <= 2 )) && \
          (( (audit_messages <= 1 && audit_raw_lines <= 1) || (audit_messages == 0 && audit_raw_lines <= 5) )); then
          scrape_status="skipped"
          audit_status="skipped_non_chat"
          skip_reason="no usable message pane; likely service panel, blank pane, or non-chat row"
        fi
      fi

      jq -n \
        --argjson page "$page" \
        --argjson index "$processed" \
        --arg label "$title_label" \
        --arg list_label "$label" \
        --argjson click_x "$click_x" \
        --argjson click_y "$click_y" \
        --arg scrape_status "$scrape_status" \
        --arg audit_status "$audit_status" \
        --arg skip_reason "$skip_reason" \
        --arg room_dir "$room_dir" \
        '{page:$page,index:$index,label:$label,list_label:$list_label,click:{x:$click_x,y:$click_y},scrape_status:$scrape_status,audit_status:$audit_status,skip_reason:(if $skip_reason == "" then null else $skip_reason end),room_dir:$room_dir}' \
        >> "$rooms_ndjson"
    done < <(jq -c '.rooms[]' "$candidates_json")
  fi

  if (( ROOM_LIMIT > 0 && processed >= ROOM_LIMIT )); then
    break
  fi
  if (( page < PAGES )); then
    scroll_x=$((frame_w * 13 / 100))
    scroll_y=$((frame_h / 2))
    scroll_args=(-NoProfile -ExecutionPolicy Bypass -File "$SCRIPTS_WIN\\wechat_window.ps1" scroll -ProcName "$PROC" -X "$scroll_x" -Y "$scroll_y" -Notches -6)
    [[ -n "$HWND" ]] && scroll_args+=(-Hwnd "$HWND")
    powershell.exe "${scroll_args[@]}" >/dev/null
    sleep "$(awk "BEGIN { printf \"%.3f\", $PAGE_WAIT_MS / 1000 }")"
  fi
done

jq -n \
  --arg created_at "$(date -Iseconds)" \
  --arg proc "$PROC" \
  --arg hwnd "$HWND" \
  --arg out_dir "$OUT_DIR_WSL" \
  --argjson pages "$PAGES" \
  --argjson room_limit "$ROOM_LIMIT" \
  --argjson max_visible_rooms "$MAX_VISIBLE_ROOMS" \
  --argjson max_frames "$MAX_FRAMES" \
  --argjson processed "$processed" \
  --argjson skipped_duplicates "$skipped_duplicates" \
  --argjson skipped_duplicate_titles "$skipped_duplicate_titles" \
  --slurpfile rooms "$rooms_ndjson" \
  '{
    schema: "wechat_batch.v1",
    created_at: $created_at,
    target: {proc:$proc, hwnd:$hwnd},
    output_dir: $out_dir,
    options: {
      pages:$pages,
      room_limit:$room_limit,
      max_visible_rooms:$max_visible_rooms,
      max_frames:$max_frames
    },
    stats: {
      processed_rooms:$processed,
      skipped_duplicate_labels:$skipped_duplicates,
      skipped_duplicate_titles:$skipped_duplicate_titles,
      pass: ($rooms | map(select(.audit_status == "pass")) | length),
      review: ($rooms | map(select(.audit_status == "review")) | length),
      skipped_non_chat: ($rooms | map(select(.audit_status == "skipped_non_chat")) | length),
      skipped_duplicate_title: ($rooms | map(select(.audit_status == "skipped_duplicate_title")) | length),
      fail_or_missing: ($rooms | map(select(.audit_status != "pass" and .audit_status != "review" and .audit_status != "skipped_non_chat" and .audit_status != "skipped_duplicate_title")) | length)
    },
    privacy: {
      scope: "visible chat-list rooms from a user-opened WeChat window",
      storage: "local shots directory",
      network_upload: false
    },
    rooms: $rooms
  }' > "$batch_manifest"

echo "BATCH_MANIFEST=$(to_win_path "$batch_manifest")"
echo "BATCH_DIR=$(to_win_path "$OUT_DIR_WSL")"
jq -r '"SUMMARY processed=\(.stats.processed_rooms) pass=\(.stats.pass) review=\(.stats.review) skipped_non_chat=\(.stats.skipped_non_chat) skipped_duplicate_title=\(.stats.skipped_duplicate_title) fail_or_missing=\(.stats.fail_or_missing) skipped_duplicate_labels=\(.stats.skipped_duplicate_labels)"' "$batch_manifest"

if [[ -n "$DB_WSL" && "$DRY_RUN" != "1" ]]; then
  db_import_json="$OUT_DIR_WSL/wechat_db_import.json"
  node "$SELF_DIR/wechat_db_import.mjs" --db "$DB_WSL" --batch-dir "$OUT_DIR_WSL" --json > "$db_import_json"
  echo "DB_IMPORT=$db_import_json"
  jq -r '"DB_SUMMARY db=\(.db) batches=\(.stats.batches) rooms=\(.stats.rooms) messages=\(.stats.messages) message_sources=\(.stats.message_sources)"' "$db_import_json"
fi
