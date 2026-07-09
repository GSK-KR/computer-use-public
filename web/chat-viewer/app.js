const state = {
  rooms: [],
  selectedRoomId: '',
  selectedRoom: null,
  messages: [],
  platform: 'all',
  status: '',
  roomQuery: '',
  messageQuery: '',
  exportingAll: false,
  capabilities: {
    discord: true,
  },
};

const apiBase = window.CHAT_VIEW_API_BASE
  || (location.pathname.startsWith('/chat-viewer') ? '/chat-viewer/api' : '/api');
const viewParams = new URLSearchParams(location.search);
const chatScope = viewParams.get('scope') === 'chat' || viewParams.get('platforms') === 'kakao,wechat';
const defaultApiPlatform = chatScope ? 'chat' : 'all';

const els = {
  summary: document.getElementById('summary'),
  refreshButton: document.getElementById('refreshButton'),
  roomSearch: document.getElementById('roomSearch'),
  messageSearch: document.getElementById('messageSearch'),
  roomList: document.getElementById('roomList'),
  roomTitle: document.getElementById('roomTitle'),
  roomMeta: document.getElementById('roomMeta'),
  resultGuide: document.getElementById('resultGuide'),
  auditStrip: document.getElementById('auditStrip'),
  messageList: document.getElementById('messageList'),
  exportAllCsvButton: document.getElementById('exportAllCsvButton'),
  exportAllTextButton: document.getElementById('exportAllTextButton'),
  exportCsvButton: document.getElementById('exportCsvButton'),
  exportTextButton: document.getElementById('exportTextButton'),
  sourceImageLink: document.getElementById('sourceImageLink'),
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function apiUrl(path) {
  const value = String(path || '');
  if (value.startsWith('/api/')) return `${apiBase}${value.slice('/api'.length)}`;
  return value;
}

function platformButtonVisible(platform) {
  if (chatScope && !['all', 'kakao', 'wechat'].includes(platform)) return false;
  if (platform === 'discord' && state.capabilities.discord === false) return false;
  return true;
}

function activateDefaultPlatformButton() {
  document.querySelectorAll('[data-platform], [data-status]').forEach((el) => el.classList.remove('active'));
  document.querySelector('[data-platform="all"]')?.classList.add('active');
}

async function activateFilter({ platform = 'all', status = '' } = {}) {
  document.querySelectorAll('[data-platform], [data-status]').forEach((el) => el.classList.remove('active'));
  const activeSelector = status ? `[data-status="${status}"]` : `[data-platform="${platform}"]`;
  document.querySelector(activeSelector)?.classList.add('active');
  state.platform = platform;
  state.status = status;
  await loadRooms();
}

function applyPlatformVisibility() {
  document.querySelectorAll('[data-platform]').forEach((button) => {
    const platform = button.dataset.platform || 'all';
    button.hidden = !platformButtonVisible(platform);
  });
  if (!platformButtonVisible(state.platform)) {
    state.platform = 'all';
    state.status = '';
    activateDefaultPlatformButton();
  }
}

function setupScopedUi() {
  applyPlatformVisibility();
}

function resourceUrl(path) {
  const value = String(path || '');
  if (value.startsWith('/api/')) return apiUrl(value);
  return value;
}

function consoleUrl(path) {
  const value = String(path || '/');
  const normalized = value.startsWith('/') ? value : `/${value}`;
  return normalized;
}

function n(value) {
  return new Intl.NumberFormat('ko-KR').format(Number(value || 0));
}

function safeFileName(value) {
  return String(value || 'backup-result')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/gu, '_')
    .replace(/\s+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 120) || 'backup-result';
}

function downloadTextFile(name, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function badge(text, tone = '') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

function statusLabel(status) {
  const labels = {
    pass: '정상',
    review: '확인 필요',
    fail: '실패',
    unknown: '확인 필요',
  };
  return labels[String(status || '').toLowerCase()] || '확인 필요';
}

function hasRoomReviewSignals(room) {
  if (!room) return false;
  const status = String(room.status || '').toLowerCase();
  return status !== 'pass'
    || Number(room.unknown_count || 0) > 0
    || Number(room.wechat?.missing_translation_count || 0) > 0
    || Array.isArray(room.quality_warnings) && room.quality_warnings.length > 0;
}

function renderResultGuide(room = null) {
  if (!els.resultGuide) return;
  const review = hasRoomReviewSignals(room);
  const title = !room ? '결과 해석' : (review ? '확인 필요 항목' : '정상 결과');
  const text = !room
    ? '정상은 읽을 수 있는 백업입니다. 확인 필요는 실패가 아니라 발신자, 글자, 원본만 대조하면 된다는 뜻입니다.'
    : (review
        ? '확인 필요는 실패가 아닙니다. 노란 배지가 붙은 메시지만 원본 화면과 대조하세요. 발신자 확인은 누가 보냈는지, 글자 확인은 흐릿한 글자, 원본 확인은 캡처와 맞는지를 보는 항목입니다.'
        : '이 방은 정상으로 읽혔습니다. 필요한 대화만 확인하고, 의심되는 줄이 있으면 원본 캡처로 대조하면 됩니다.');
  els.resultGuide.classList.toggle('review', review);
  els.resultGuide.classList.toggle('pass', !!room && !review);
  els.resultGuide.innerHTML = `<strong>${esc(title)}</strong><span>${esc(text)}</span>`;
}

function speakerLabel(speaker) {
  const value = String(speaker || '').trim();
  if (!value || value === 'Unknown') return '발신자 확인';
  if (value === 'Me') return '나';
  return value;
}

function warningBadge(warning) {
  const tone = warning?.severity === 'danger' ? 'danger' : (warning?.severity || 'warn');
  const label = warningLabel(warning?.label || warning?.code || '');
  const title = warning?.detail ? ` title="${esc(warningDetail(warning.detail))}"` : '';
  return `<span class="badge ${esc(tone)}"${title}>${esc(label)}</span>`;
}

function kindLabel(kind) {
  const labels = {
    attachment_or_media_card: '첨부/미디어',
    attachment_or_media: '첨부/미디어',
    image: '이미지',
    file: '파일',
  };
  return labels[String(kind || '')] || '첨부/미디어';
}

function warningLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '확인 필요';
  const withCount = raw.match(/^(.*?)(\s+\d+)$/u);
  const label = withCount ? withCount[1] : raw;
  const count = withCount ? withCount[2] : '';
  const normalized = label.toLowerCase().replace(/[ _-]+/gu, '');
  const labels = {
    '발신자검토': '발신자 확인',
    '발신자표시': '발신자 확인',
    'speakerunknown': '발신자 확인',
    'speakerreview': '발신자 확인',
    'speakervisualreview': '발신자 확인',
    '텍스트검토': '글자 확인',
    '문자검토': '글자 확인',
    '저신뢰': '글자 확인',
    '저신뢰ocr': '글자 확인',
    'lowconfidence': '글자 확인',
    'textreview': '글자 확인',
    'ocrnotereview': '글자 확인',
    '원본검토': '원본 확인',
    'sourcereview': '원본 확인',
    'screenshotreview': '원본 확인',
    '미디어검토': '첨부/미디어 확인',
    '첨부/미디어': '첨부/미디어 확인',
    'nontextreview': '첨부/미디어 확인',
    'attachmentreview': '첨부/미디어 확인',
    '번역누락': '번역 확인',
    '번역주의': '번역 확인',
    '번역검토': '번역 확인',
    'missingtranslation': '번역 확인',
    'translationrisk': '번역 확인',
    '이모지검토': '이모지 확인',
    'emojireview': '이모지 확인',
    '답장/인용': '답장/인용 확인',
    'quotereview': '답장/인용 확인',
    '이력불완전': '이력 확인',
    'historyincomplete': '이력 확인',
    '중복제거': '중복 정리',
  };
  if (labels[normalized]) return `${labels[normalized]}${count}`;
  if (/^[a-z0-9_:-]+$/iu.test(label)) return `확인 필요${count}`;
  return `${label}${count}`;
}

function warningDetail(value) {
  const text = String(value || '').trim();
  if (!text) return '확인이 필요한 항목입니다.';
  if (/codex|vision|ocr|low[-\s]?confidence|text confidence/iu.test(text)) return '화면 글자를 다시 확인하면 좋습니다.';
  if (/unknown|speaker|sender|profile|발신자|보낸 사람/iu.test(text)) return '발신자를 원본 화면에서 확인하면 좋습니다.';
  if (/translation|번역/iu.test(text)) return '원문과 번역을 함께 확인하면 좋습니다.';
  if (/attachment|media|file|image|첨부|미디어|파일|이미지/iu.test(text)) return '첨부나 미디어는 원본 앱에서 확인하면 좋습니다.';
  if (/max-frames|short scrape|history|이력/iu.test(text)) return '더 오래된 대화가 남아 있을 수 있습니다.';
  return '확인이 필요한 항목입니다.';
}

function flagLabel(flag) {
  const raw = String(flag || '');
  if (!raw || raw.startsWith('speaker:')) return null;
  if (isInternalFlag(raw)) return null;
  const labels = {
    source_review: '원본 확인',
    screenshot_review: '원본 확인',
    emoji_review: '이모지 확인',
    quote_review: '답장/인용 확인',
    speaker_visual_review: '발신자 확인',
    ocr_note_review: '글자 확인',
    speaker_unknown: '발신자 확인',
    attachment_or_media_card: '첨부/미디어',
    attachment_review: '첨부/미디어 확인',
    text_review: '글자 확인',
    low_confidence: '글자 확인',
    low_text_confidence: '글자 확인',
    translation_risk: '번역 확인',
    speaker_room_label_fallback: '발신자 확인',
  };
  return labels[raw] || warningLabel(raw);
}

function isInternalFlag(flag) {
  return [
    'codex_vision',
    'reply_context',
    'deduped_overlap',
    'merged_wrapped_bubble',
    'vision_uncertain',
    'comment_thread',
    'outgoing_layout_downgraded',
    'incoming_layout_upgraded',
    'quoted_prefix_moved',
  ].includes(String(flag || ''));
}

function isReviewFlag(flag) {
  return [
    'speaker_unknown',
    'speaker_room_label_fallback',
    'low_text_confidence',
    'source_review',
    'screenshot_review',
    'attachment_review',
    'text_review',
    'low_confidence',
    'translation_risk',
    'speaker_visual_review',
    'ocr_note_review',
  ].includes(String(flag || ''));
}

function flagTone(flag) {
  const raw = String(flag || '');
  if (raw.includes('unknown') || raw === 'speaker_room_label_fallback' || raw === 'text_review' || raw === 'low_confidence' || raw === 'low_text_confidence' || raw === 'translation_risk' || raw === 'emoji_review' || raw === 'speaker_visual_review' || raw === 'ocr_note_review') return 'warn';
  if (raw === 'source_review' || raw === 'screenshot_review' || raw === 'attachment_review' || raw === 'quote_review') return 'review';
  return '';
}

function visibleContext(msg) {
  const context = String(msg.context_text || '').trim();
  if (!context) return '';
  if ((msg.platform || state.selectedRoom?.platform) === 'kakao') return '';
  return context;
}

function shouldShowSourceLink(msg) {
  if (!msg.image_url) return false;
  return (msg.flags || []).some(isReviewFlag);
}

function isKakaoPlatform(platform) {
  return String(platform || '').startsWith('kakao');
}

function messagePlatform(msg) {
  return msg.platform || state.selectedRoom?.platform || '';
}

function isOutgoingMessage(msg) {
  return msg.side === 'right' || msg.direction === 'outgoing' || msg.speaker === 'Me';
}

function messageSpeaker(msg) {
  return msg.speaker || 'Unknown';
}

function displayRiskNote(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/발신자가\s*Unknown이고/giu, '발신자를 아직 확인하지 못했고')
    .replace(/발신자가\s*Unknown/giu, '발신자를 아직 확인하지 못함')
    .replace(/\bUnknown\b/giu, '발신자 미확인')
    .replace(/\bWeChat\b/gu, '위챗')
    .replace(/\bscreenshot\b/giu, '원본 캡처')
    .replace(/\bOCR\b/giu, '문자 인식');
}

function exportSpeaker(msg) {
  return speakerLabel(messageSpeaker(msg));
}

function exportStatusText(msg) {
  const flags = (msg.flags || [])
    .map(flagLabel)
    .filter(Boolean);
  if (msg.kind && msg.kind !== 'text') flags.unshift(kindLabel(msg.kind));
  if (msg.translation_risk_note_ko) flags.push('번역 확인');
  return [...new Set(flags)].join(', ');
}

function csvValue(value) {
  const text = String(value ?? '').replace(/\r?\n/gu, '\n');
  return `"${text.replace(/"/gu, '""')}"`;
}

function selectedRoomFileBase() {
  const room = state.selectedRoom;
  const platform = platformLabel(room?.platform || 'chat');
  const roomName = room?.label || '선택한_방';
  const suffix = state.messageQuery ? '_검색결과' : '';
  return safeFileName(`${platform}_${roomName}${suffix}`);
}

function allRoomsFileBase() {
  const platform = state.platform === 'all'
    ? (chatScope ? '카카오톡_위챗' : '전체')
    : platformLabel(state.platform);
  const filters = [
    platform,
    state.status ? statusLabel(state.status) : '',
    state.roomQuery ? `방검색_${state.roomQuery}` : '',
    state.messageQuery ? `메시지검색_${state.messageQuery}` : '',
    '전체결과',
  ].filter(Boolean);
  return safeFileName(filters.join('_'));
}

function roomExportRows(room = state.selectedRoom || {}, messages = state.messages || []) {
  return (messages || []).map((msg, index) => ({
    index: index + 1,
    platform: platformLabel(msg.platform || room.platform || ''),
    room: room.label || '',
    timestamp: msg.timestamp || '',
    speaker: exportSpeaker(msg),
    side: isOutgoingMessage(msg) ? '보낸쪽' : '받은쪽',
    text: msg.text || '',
    translation: msg.translation_ko || '',
    check: exportStatusText(msg),
  }));
}

function csvRows(rows, headers, valuesForRow) {
  return [
    headers.map(csvValue).join(','),
    ...rows.map((row) => valuesForRow(row).map(csvValue).join(',')),
  ].join('\r\n');
}

function exportSelectedRoomCsv() {
  if (!state.selectedRoomId || !state.messages.length) return;
  const headers = ['번호', '구분', '방', '시간', '사람', '방향', '내용', '번역', '확인 항목'];
  const body = csvRows(roomExportRows(), headers, (row) => [
    row.index,
    row.platform,
    row.room,
    row.timestamp,
    row.speaker,
    row.side,
    row.text,
    row.translation,
    row.check,
  ]);
  downloadTextFile(`${selectedRoomFileBase()}.csv`, `\uFEFF${body}\r\n`, 'text/csv;charset=utf-8');
}

function exportSelectedRoomText() {
  if (!state.selectedRoomId || !state.messages.length) return;
  const room = state.selectedRoom || {};
  const lines = [
    `방: ${room.label || '선택한 방'}`,
    `구분: ${platformLabel(room.platform || '')}`,
    `메시지: ${n(state.messages.length)}개${state.messageQuery ? `, 검색어: ${state.messageQuery}` : ''}`,
    '확인 필요 표시는 실패가 아니라 원본과 대조할 항목입니다.',
    '',
  ];
  for (const row of roomExportRows()) {
    const prefix = [
      row.timestamp ? `[${row.timestamp}]` : '',
      row.speaker ? `${row.speaker}:` : '',
    ].filter(Boolean).join(' ');
    lines.push(`${prefix} ${row.text}`.trim());
    if (row.translation) lines.push(`  번역: ${row.translation}`);
    if (row.check) lines.push(`  확인 항목: ${row.check}`);
  }
  downloadTextFile(`${selectedRoomFileBase()}.txt`, `${lines.join('\n')}\n`);
}

async function fetchRoomMessagesForExport(room) {
  const params = new URLSearchParams({ limit: '50000' });
  if (state.messageQuery) params.set('q', state.messageQuery);
  const data = await fetchJson(`/api/rooms/${encodeURIComponent(room.id)}/messages?${params.toString()}`);
  return data.messages || [];
}

async function allRoomExportData() {
  const out = [];
  for (const room of state.rooms || []) {
    const messages = await fetchRoomMessagesForExport(room);
    out.push({ room, messages });
  }
  return out;
}

function allExportRows(roomData) {
  return roomData.flatMap(({ room, messages }, roomIndex) => (
    roomExportRows(room, messages).map((row) => ({
      ...row,
      roomIndex: roomIndex + 1,
      roomStatus: statusLabel(room.status || 'review'),
    }))
  ));
}

async function withBulkExportBusy(work) {
  if (state.exportingAll) return;
  state.exportingAll = true;
  updateExportButtons();
  const previousSummary = els.summary.textContent;
  els.summary.textContent = '전체 저장 파일을 준비하는 중입니다...';
  try {
    await work();
    els.summary.textContent = previousSummary;
  } catch {
    els.summary.textContent = '전체 저장 파일을 만들지 못했습니다. 결과 새로고침 후 다시 시도하세요.';
  } finally {
    state.exportingAll = false;
    updateExportButtons();
  }
}

async function exportAllRoomsCsv() {
  if (!state.rooms.length) return;
  await withBulkExportBusy(async () => {
    const roomData = await allRoomExportData();
    const rows = allExportRows(roomData);
    const headers = ['방 번호', '메시지 번호', '구분', '방', '방 상태', '시간', '사람', '방향', '내용', '번역', '확인 항목'];
    const body = csvRows(rows, headers, (row) => [
      row.roomIndex,
      row.index,
      row.platform,
      row.room,
      row.roomStatus,
      row.timestamp,
      row.speaker,
      row.side,
      row.text,
      row.translation,
      row.check,
    ]);
    downloadTextFile(`${allRoomsFileBase()}.csv`, `\uFEFF${body}\r\n`, 'text/csv;charset=utf-8');
  });
}

async function exportAllRoomsText() {
  if (!state.rooms.length) return;
  await withBulkExportBusy(async () => {
    const roomData = await allRoomExportData();
    const totalMessages = roomData.reduce((sum, item) => sum + item.messages.length, 0);
    const lines = [
      '전체 결과',
      `방: ${n(roomData.length)}개`,
      `메시지: ${n(totalMessages)}개${state.messageQuery ? `, 메시지 검색어: ${state.messageQuery}` : ''}${state.roomQuery ? `, 방 검색어: ${state.roomQuery}` : ''}`,
      '확인 필요 표시는 실패가 아니라 원본과 대조할 항목입니다.',
      '',
    ];
    for (const { room, messages } of roomData) {
      lines.push(`## ${room.label || '이름 없는 방'} (${platformLabel(room.platform || '')}, ${statusLabel(room.status || 'review')}, ${n(messages.length)}개)`);
      for (const row of roomExportRows(room, messages)) {
        const prefix = [
          row.timestamp ? `[${row.timestamp}]` : '',
          row.speaker ? `${row.speaker}:` : '',
        ].filter(Boolean).join(' ');
        lines.push(`${prefix} ${row.text}`.trim());
        if (row.translation) lines.push(`  번역: ${row.translation}`);
        if (row.check) lines.push(`  확인 항목: ${row.check}`);
      }
      lines.push('');
    }
    downloadTextFile(`${allRoomsFileBase()}.txt`, `${lines.join('\n')}\n`);
  });
}

function updateExportButtons() {
  const enabled = Boolean(state.selectedRoomId && state.messages.length);
  const allEnabled = Boolean(state.rooms.length) && !state.exportingAll;
  if (els.exportAllCsvButton) els.exportAllCsvButton.disabled = !allEnabled;
  if (els.exportAllTextButton) els.exportAllTextButton.disabled = !allEnabled;
  if (els.exportCsvButton) els.exportCsvButton.disabled = !enabled;
  if (els.exportTextButton) els.exportTextButton.disabled = !enabled;
}

function sourceClusterKey(msg) {
  return [
    msg.source_type || '',
    msg.thread_index == null ? '' : String(msg.thread_index),
  ].join(':');
}

function messageMeta(msg) {
  const confidence = Number(msg.confidence);
  const showConfidence = Number.isFinite(confidence) && confidence > 0 && confidence < 0.8;
  const flags = [
    msg.kind && msg.kind !== 'text' ? badge(kindLabel(msg.kind)) : '',
    msg.comment_count != null ? badge(`댓글 ${n(msg.comment_count)}`) : '',
    msg.thread_index != null ? badge(`댓글창 ${n(msg.thread_index)}`) : '',
    showConfidence ? badge(`글자 확인 ${Math.round(confidence * 100)}`, 'warn') : '',
    msg.translation_ko ? badge('번역') : '',
    ...(msg.flags || [])
      .map((flag) => {
        const label = flagLabel(flag);
        return label ? badge(label, flagTone(flag)) : '';
      }),
    shouldShowSourceLink(msg) ? `<a class="mini-link" href="${esc(resourceUrl(msg.image_url))}" target="_blank" rel="noreferrer">원본</a>` : '',
  ].filter(Boolean).join('');
  return [
    msg.timestamp ? `<span>${esc(msg.timestamp)}</span>` : '',
    flags,
  ].filter(Boolean).join('');
}

function renderBubble(msg) {
  const context = visibleContext(msg);
  const meta = messageMeta(msg);
  const riskNote = displayRiskNote(msg.translation_risk_note_ko);
  return `
    <div class="bubble-item">
      <div class="bubble">
        ${context ? `<div class="reply-context">${esc(context)}</div>` : ''}
        <div class="text">${esc(msg.text || '')}</div>
        ${msg.translation_ko ? `<div class="translation">${esc(msg.translation_ko)}</div>` : ''}
        ${riskNote ? `<div class="risk-note">${esc(riskNote)}</div>` : ''}
      </div>
      ${meta ? `<div class="message-meta">${meta}</div>` : ''}
    </div>`;
}

function groupMessages(messages) {
  const groups = [];
  for (const msg of messages) {
    const platform = messagePlatform(msg);
    const outgoing = isOutgoingMessage(msg);
    const speaker = messageSpeaker(msg);
    const clusterable = isKakaoPlatform(platform);
    const key = [
      platform,
      outgoing ? 'out' : 'in',
      speaker,
      sourceClusterKey(msg),
    ].join('|');
    const prev = groups[groups.length - 1];
    if (clusterable && prev?.key === key) {
      prev.messages.push(msg);
    } else {
      groups.push({ key, platform, outgoing, speaker, messages: [msg] });
    }
  }
  return groups;
}

function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'pass') return 'good';
  if (s === 'review') return 'review';
  if (s === 'fail') return 'danger';
  return '';
}

function platformTone(platform) {
  const p = String(platform || '');
  if (p.startsWith('kakao')) return 'kakao';
  if (p === 'wechat') return 'wechat';
  return 'discord';
}

function platformLabel(platform) {
  const p = String(platform || '');
  if (p === 'kakao_openchat') return '카카오톡 오픈채팅';
  if (p.startsWith('kakao')) return '카카오톡';
  if (p === 'wechat') return '위챗';
  if (p === 'discord') return '디스코드';
  return p || '기타';
}

function debounce(fn, delay = 160) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function fetchJson(path) {
  const res = await fetch(apiUrl(path), { cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || '결과를 읽지 못했습니다');
  return body;
}

async function refreshSources() {
  await fetchJson('/api/refresh');
  await loadAll();
}

async function openConsoleBackupFolder(button) {
  const originalText = button?.textContent || '백업 폴더 열기';
  if (button) {
    button.disabled = true;
    button.textContent = '폴더 여는 중';
  }
  try {
    const res = await fetch(consoleUrl('/api/jobs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        module: 'setup',
        action: 'open_backup_folder',
        params: { confirmRisk: true },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || '백업 폴더를 열지 못했습니다');
    if (button) button.textContent = '폴더 열림';
    setTimeout(() => {
      if (!button) return;
      button.disabled = false;
      button.textContent = originalText;
    }, 1500);
  } catch {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    window.top.location.href = consoleUrl('/settings');
  }
}

function bindEmptyRecoveryActions(root) {
  root.querySelectorAll('[data-empty-refresh]').forEach((button) => button.addEventListener('click', refreshSources));
  root.querySelectorAll('[data-empty-folder]').forEach((button) => {
    button.addEventListener('click', () => openConsoleBackupFolder(button));
  });
}

async function loadHealth() {
  const health = await fetchJson(chatScope ? '/api/health?platform=chat' : '/api/health');
  state.capabilities = { ...state.capabilities, ...(health.capabilities || {}) };
  applyPlatformVisibility();
  const c = health.counts || {};
  const statusBits = [
    c.review_rooms ? `확인 필요 ${n(c.review_rooms)}` : '',
    c.fail_rooms ? `실패 ${n(c.fail_rooms)}` : '',
    c.unknown ? `발신자 확인 ${n(c.unknown)}` : '',
    c.quality_warnings ? `확인 항목 ${n(c.quality_warnings)}` : '',
    c.dedupe_removed ? `중복 정리 ${n(c.dedupe_removed)}` : '',
  ].filter(Boolean).join(' · ');
  els.summary.textContent = `${n(c.rooms)}개 방 · ${n(c.messages)}개 메시지${statusBits ? ` · ${statusBits}` : ' · 정상'}`;
}

async function loadRooms() {
  const apiPlatform = state.platform === 'all' ? defaultApiPlatform : state.platform;
  const params = new URLSearchParams({ platform: apiPlatform });
  if (state.status) params.set('status', state.status);
  if (state.roomQuery) params.set('q', state.roomQuery);
  const data = await fetchJson(`/api/rooms?${params.toString()}`);
  state.rooms = data.rooms || [];
  renderRooms();

  if (!state.rooms.length) {
    state.selectedRoomId = '';
    state.selectedRoom = null;
    state.messages = [];
    renderResultGuide(null);
    renderSelectedRoom();
    renderMessages();
    return;
  }

  if (!state.rooms.some((room) => room.id === state.selectedRoomId)) {
    state.selectedRoomId = state.rooms[0].id;
  }
  await selectRoom(state.selectedRoomId, false);
}

async function selectRoom(roomId, rerenderList = true) {
  state.selectedRoomId = roomId;
  const [roomData] = await Promise.all([
    fetchJson(`/api/rooms/${encodeURIComponent(roomId)}`),
    loadMessages(roomId),
  ]);
  state.selectedRoom = roomData.room;
  renderSelectedRoom();
  renderMessages();
  if (rerenderList) renderRooms();
}

async function loadMessages(roomId = state.selectedRoomId) {
  if (!roomId) {
    state.messages = [];
    return;
  }
  const params = new URLSearchParams({ limit: '50000' });
  if (state.messageQuery) params.set('q', state.messageQuery);
  const data = await fetchJson(`/api/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`);
  state.messages = data.messages || [];
}

function initials(label) {
  const clean = String(label || '?').trim();
  return Array.from(clean.replace(/\s+/g, '') || '?').slice(0, 2).join('').toUpperCase();
}

function renderRooms() {
  if (!state.rooms.length) {
    els.roomList.innerHTML = `
      <div class="empty-state rich">
        <strong>아직 백업 결과가 없습니다</strong>
        <span>실패가 아니라 아직 이 화면에서 읽을 백업 파일이 없다는 뜻입니다.</span>
        <ol class="empty-next-steps">
          <li>처음이면 위챗 백업 또는 카카오톡 백업을 실행합니다.</li>
          <li>앱에서 백업할 방을 먼저 열어 둡니다.</li>
          <li>이미 실행했다면 결과 새로고침, 백업 폴더 열기, 진행 기록 순서로 봅니다.</li>
        </ol>
        <div class="empty-actions">
          <a class="action-link primary" href="${esc(consoleUrl('/backup#wechat'))}" target="_top">위챗 백업</a>
          <a class="action-link" href="${esc(consoleUrl('/backup#kakao'))}" target="_top">카카오톡 백업</a>
          <button class="action-link" type="button" data-empty-refresh>결과 새로고침</button>
          <button class="action-link" type="button" data-empty-folder>백업 폴더 열기</button>
          <a class="action-link" href="${esc(consoleUrl('/jobs'))}" target="_top">진행 기록</a>
        </div>
      </div>`;
    bindEmptyRecoveryActions(els.roomList);
    return;
  }

  els.roomList.innerHTML = state.rooms.map((room) => {
    const active = room.id === state.selectedRoomId ? ' active' : '';
    const status = room.status || 'review';
    const badges = [
      badge(platformLabel(room.platform), platformTone(room.platform)),
      badge(statusLabel(status), statusTone(status)),
      ...(room.quality_warnings || []).slice(0, 2).map(warningBadge),
      room.frame_count ? badge(`캡처 ${n(room.frame_count)}`) : '',
    ].filter(Boolean).join('');

    return `
      <button class="room-item${active}" type="button" data-room-id="${esc(room.id)}">
        <div class="avatar ${esc(platformTone(room.platform))}">${esc(initials(room.label))}</div>
        <div class="room-main">
          <div class="room-line">
            <div class="room-name">${esc(room.label)}</div>
            <div class="room-count">${n(room.message_count)}</div>
          </div>
          <div class="room-badges">${badges}</div>
        </div>
      </button>`;
  }).join('');

  els.roomList.querySelectorAll('.room-item').forEach((button) => {
    button.addEventListener('click', () => selectRoom(button.dataset.roomId));
  });
}

function renderSelectedRoom() {
  const room = state.selectedRoom;
  if (!room) {
    els.roomTitle.textContent = state.rooms.length ? '백업 결과를 선택하세요' : '아직 백업 결과가 없습니다';
    els.roomMeta.textContent = state.rooms.length ? '' : '백업 후 결과 새로고침을 누르면 이 화면에 표시됩니다.';
    els.auditStrip.innerHTML = '';
    renderResultGuide(null);
    els.sourceImageLink.classList.add('hidden');
    updateExportButtons();
    return;
  }

  els.roomTitle.textContent = room.label || '(이름 없음)';
  els.roomMeta.textContent = `${platformLabel(room.platform)} · ${n(room.message_count)}개 메시지 · ${statusLabel(room.status || 'review')} · 읽기 전용`;

  const parts = [
    badge(platformLabel(room.platform), platformTone(room.platform)),
    badge(statusLabel(room.status || 'review'), statusTone(room.status)),
    badge(`메시지 ${n(room.message_count)}`),
    room.unknown_count ? badge(`발신자 확인 ${n(room.unknown_count)}`, 'warn') : '',
    room.outgoing_count ? badge(`보낸쪽 ${n(room.outgoing_count)}`) : '',
    room.incoming_count ? badge(`받은쪽 ${n(room.incoming_count)}`) : '',
    room.frame_count ? badge(`캡처 ${n(room.frame_count)}`) : '',
    room.dedupe_count ? badge(`중복 정리 ${n(room.dedupe_count)}`) : '',
    room.elapsed_s != null ? badge(`소요 ${Number(room.elapsed_s).toFixed(1)}초`) : '',
    room.wechat?.translated_count ? badge(`번역 ${n(room.wechat.translated_count)}`) : '',
    room.wechat?.missing_translation_count ? badge(`번역 확인 ${n(room.wechat.missing_translation_count)}`, 'warn') : '',
    room.wechat?.non_text_count ? badge(`첨부/미디어 ${n(room.wechat.non_text_count)}`) : '',
    ...(room.quality_warnings || []).map(warningBadge),
  ];
  els.auditStrip.innerHTML = parts.filter(Boolean).join('');
  renderResultGuide(room);

  if (room.screenshot_url) {
    els.sourceImageLink.href = resourceUrl(room.screenshot_url);
    els.sourceImageLink.classList.remove('hidden');
  } else {
    els.sourceImageLink.classList.add('hidden');
  }
  updateExportButtons();
}

function renderMessages() {
  if (!state.selectedRoomId) {
    els.messageList.innerHTML = state.rooms.length
      ? '<div class="empty-state">왼쪽에서 채팅방을 고르세요.</div>'
      : `<div class="empty-state rich">
          <strong>아직 백업 결과가 없습니다</strong>
          <span>먼저 위챗 또는 카카오톡에서 백업할 방을 열고 백업을 실행하세요.</span>
          <ol class="empty-next-steps">
            <li>위챗 또는 카카오톡에서 백업할 방을 열어 둡니다.</li>
            <li>백업 화면에서 방 선택 완료 표시를 하고 백업을 누릅니다.</li>
            <li>이미 백업했다면 결과 새로고침, 백업 폴더 열기, 진행 기록 순서로 봅니다.</li>
          </ol>
          <div class="empty-actions">
            <a class="action-link primary" href="${esc(consoleUrl('/backup#wechat'))}" target="_top">위챗 백업</a>
            <a class="action-link" href="${esc(consoleUrl('/backup#kakao'))}" target="_top">카카오톡 백업</a>
            <button class="action-link" type="button" data-empty-refresh>결과 새로고침</button>
            <button class="action-link" type="button" data-empty-folder>백업 폴더 열기</button>
            <a class="action-link" href="${esc(consoleUrl('/jobs'))}" target="_top">진행 기록</a>
          </div>
        </div>`;
    bindEmptyRecoveryActions(els.messageList);
    updateExportButtons();
    return;
  }
  if (!state.messages.length) {
    els.messageList.innerHTML = '<div class="empty-state">표시할 메시지가 없습니다.</div>';
    updateExportButtons();
    return;
  }

  const html = [];
  let lastSpeaker = '';
  for (const group of groupMessages(state.messages)) {
    const { outgoing, platform, speaker } = group;
    const kakaoGroup = isKakaoPlatform(platform);
    const repeated = !kakaoGroup && speaker === lastSpeaker && !outgoing && ['discord', 'wechat'].includes(platform);
    lastSpeaker = speaker;

    html.push(`
      <div class="message-row ${outgoing ? 'out' : 'in'} ${esc(platform)}${kakaoGroup ? ' message-group' : ''}${group.messages.length > 1 ? ' stacked' : ''}">
        <div class="bubble-wrap">
          ${repeated ? '' : `<div class="speaker">${esc(outgoing ? '나' : speakerLabel(speaker))}</div>`}
          <div class="bubble-stack">${group.messages.map(renderBubble).join('')}</div>
        </div>
      </div>`);
  }
  els.messageList.innerHTML = html.join('');
  updateExportButtons();
}

async function loadAll() {
  try {
    await loadHealth();
    await loadRooms();
  } catch (err) {
    els.summary.textContent = '확인 필요';
    els.messageList.innerHTML = `<div class="empty-state rich">
      <strong>결과를 읽지 못했습니다</strong>
      <span>값을 찾거나 입력하지 말고 아래 버튼으로 다시 확인하세요.</span>
      <ol class="empty-next-steps">
        <li>결과 새로고침을 누릅니다.</li>
        <li>계속 비어 있으면 위챗 백업 또는 카카오톡 백업을 다시 실행합니다.</li>
        <li>이미 실행했다면 백업 폴더 열기 또는 진행 기록에서 마지막 안내를 확인합니다.</li>
      </ol>
      <div class="empty-actions">
        <button class="action-link primary" type="button" data-empty-refresh>결과 새로고침</button>
        <a class="action-link" href="${esc(consoleUrl('/backup#wechat'))}" target="_top">위챗 백업</a>
        <a class="action-link" href="${esc(consoleUrl('/backup#kakao'))}" target="_top">카카오톡 백업</a>
        <button class="action-link" type="button" data-empty-folder>백업 폴더 열기</button>
        <a class="action-link" href="${esc(consoleUrl('/jobs'))}" target="_top">진행 기록</a>
      </div>
    </div>`;
    bindEmptyRecoveryActions(els.messageList);
  }
}

document.querySelectorAll('[data-platform], [data-status]').forEach((button) => {
  button.addEventListener('click', async () => {
    await activateFilter({
      platform: button.dataset.platform || 'all',
      status: button.dataset.status || '',
    });
  });
});

document.querySelectorAll('[data-quick-platform]').forEach((button) => {
  button.addEventListener('click', async () => {
    await activateFilter({ platform: button.dataset.quickPlatform || 'all' });
  });
});

els.roomSearch.addEventListener('input', debounce(async () => {
  state.roomQuery = els.roomSearch.value.trim();
  await loadRooms();
}));

els.messageSearch.addEventListener('input', debounce(async () => {
  state.messageQuery = els.messageSearch.value.trim();
  await loadMessages();
  renderMessages();
}));

els.refreshButton.addEventListener('click', refreshSources);
els.exportAllCsvButton?.addEventListener('click', exportAllRoomsCsv);
els.exportAllTextButton?.addEventListener('click', exportAllRoomsText);
els.exportCsvButton?.addEventListener('click', exportSelectedRoomCsv);
els.exportTextButton?.addEventListener('click', exportSelectedRoomText);

setupScopedUi();
loadAll();
