import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const TIMESTAMP_RE = /^(오전|오후)\s*\d{1,2}\s*[:•]?\s*\d{1,2}$/u;

function cleanText(value) {
  return String(value || '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(value) {
  return cleanText(value).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function compactTimestamp(value) {
  return cleanText(value).replace(/\s+/g, '').replace(/[•]/g, ':');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function frameFiles(ocrDir) {
  if (!existsSync(ocrDir)) return [];
  return readdirSync(ocrDir)
    .filter((name) => /^frame_\d+\.json$/u.test(name))
    .sort()
    .reverse();
}

function frameIndexFromName(file) {
  return Number(basename(file).match(/frame_(\d+)\.json$/u)?.[1] || 0);
}

function asLine(raw) {
  const text = cleanText(raw?.text);
  return {
    text,
    x: Number(raw?.x || 0),
    y: Number(raw?.y || 0),
    w: Number(raw?.w || 0),
    h: Number(raw?.h || 0),
  };
}

function isTimestamp(text) {
  return TIMESTAMP_RE.test(cleanText(text));
}

function isCommentControl(text) {
  const t = cleanText(text);
  return /^[“"']?\s*(나\s*)?댓글\s*\d+/u.test(t)
    || /^[\d\s]*댓글\s*\d+\s*개?$/u.test(t)
    || /^댓글\s*\d+\s*개$/u.test(t)
    || /^댓글\s*메시지\s*입력$/u.test(t);
}

function commentCount(text) {
  if (!isCommentControl(text)) return null;
  const n = cleanText(text).match(/\d{1,4}/u)?.[0];
  return n ? Number(n) : null;
}

function isReactionOrIcon(text) {
  const t = cleanText(text);
  return /^\d+$/u.test(t)
    || /^\d+\s*[€♡♥]+$/u.test(t)
    || /^[口十㉭OCO€Ⅲ:.,+\s]+$/u.test(t);
}

function isReplyContext(text) {
  const t = cleanText(text).replace(/^0\s+/, '');
  return /(에게|에계|께|한테)\s*(댓글|댓그|답글|대댓글)/u.test(t);
}

function isMediaContext(text) {
  return /^(사진|동영상|이미지|파일)$/u.test(cleanText(text));
}

function isUiChrome(text, line, frameMaxY, mode) {
  const t = cleanText(text);
  if (!t) return true;
  if (isReactionOrIcon(t)) return true;
  if (/^(메시지 입력|채팅방에 함께 보내기|재팅방에 함께 보내기|채팅방 서랍|검색|톡게시판|앨범)$/u.test(t)) return true;
  if (/^저장\s*[•·]\s*다른 이름으로 저장$/u.test(t)) return true;
  if (/^(유효기한|유효기전)\s*~/u.test(t)) return true;
  if (/^(용량|용盟)?\s*\d+(?:\.\d+)?\s*(KB|MB|GB)$/iu.test(t)) return true;
  if (/^(LDUO|Q\s*\d+|엘디유오[_\s]*브릴CS|엘디유오 브릴cs)$/iu.test(t)) return true;
  if (/환영합니다.*오픈/u.test(t) || /^입니다\.?$/u.test(t)) return true;
  if (mode === 'main' && line.y < 270) return true;
  if (mode === 'thread' && line.y < 320) return true;
  if (frameMaxY > 900 && line.y > frameMaxY - 170) return true;
  return false;
}

function isLikelySender(text) {
  const t = cleanText(text);
  if (t.length < 2 || t.length > 34) return false;
  if (isTimestamp(t) || isCommentControl(t) || isReplyContext(t)) return false;
  if (/[?？!！.。,:：]/u.test(t)) return false;
  if (/\d{2,}/u.test(t)) return false;
  if (/^(사진|파일|댓글|답글|대댓글)$/u.test(t)) return false;
  if (/^사원-[\p{L}\p{N}_ .-]{2,24}$/u.test(t)) return true;
  if (/(사원|팀장|매니저|대표|CS)$/iu.test(t)) return true;
  return false;
}

function bbox(lines) {
  const x1 = Math.min(...lines.map((line) => line.x));
  const y1 = Math.min(...lines.map((line) => line.y));
  const x2 = Math.max(...lines.map((line) => line.x + line.w));
  const y2 = Math.max(...lines.map((line) => line.y + line.h));
  return [x1, y1, x2 - x1, y2 - y1];
}

function nearestSender(senders, group) {
  const first = group.lines[0];
  const candidates = senders
    .filter((line) => line.y < first.y && first.y - line.y < 145)
    .sort((a, b) => Math.abs(first.y - a.y) - Math.abs(first.y - b.y));
  return candidates[0]?.text || 'Unknown';
}

function nearestTimestamp(timestamps, group) {
  const [x, y, w, h] = group.bbox;
  const y2 = y + h;
  const centerY = y + h / 2;
  const candidates = timestamps
    .filter((line) => line.y >= y - 20 && line.y <= y2 + 90)
    .map((line) => ({
      line,
      score: Math.abs((line.y + line.h / 2) - centerY) - (line.x > x + w * 0.65 ? 20 : 0),
    }))
    .sort((a, b) => a.score - b.score);
  return candidates[0]?.line?.text || null;
}

function nearestCommentCount(comments, group) {
  const [x, y, w, h] = group.bbox;
  const y2 = y + h;
  const candidates = comments
    .filter((line) => line.y > y2 - 4 && line.y < y2 + 95)
    .filter((line) => Math.abs(line.x - x) < Math.max(90, w * 0.4));
  return commentCount(candidates[0]?.text);
}

function groupContentLines(lines) {
  const groups = [];
  let cur = null;
  for (const line of lines) {
    if (!cur) {
      cur = { lines: [line] };
      continue;
    }
    const prev = cur.lines[cur.lines.length - 1];
    const gap = line.y - (prev.y + prev.h);
    const centerDelta = Math.abs((line.x + line.w / 2) - (prev.x + prev.w / 2));
    const hardBreak = gap > 105 || (gap > 42 && centerDelta > 280);
    if (hardBreak) {
      groups.push(cur);
      cur = { lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur) groups.push(cur);
  for (const group of groups) group.bbox = bbox(group.lines);
  return groups;
}

function splitContextAndBody(lines) {
  const context = [];
  const body = [];
  let inContext = false;
  let contextStarted = false;
  let mediaContextSeen = false;
  let prev = null;

  for (const line of lines) {
    const t = line.text;
    const gap = prev ? line.y - (prev.y + prev.h) : 0;
    if (!contextStarted && (isReplyContext(t) || isMediaContext(t))) {
      inContext = true;
      contextStarted = true;
      context.push(t);
      if (isMediaContext(t)) mediaContextSeen = true;
      prev = line;
      continue;
    }
    if (inContext) {
      if ((context.length === 1 || gap > 52 || mediaContextSeen) && !isMediaContext(t) && !isReplyContext(t)) {
        inContext = false;
        body.push(t);
      } else {
        context.push(t);
        if (isMediaContext(t)) mediaContextSeen = true;
      }
      prev = line;
      continue;
    }
    body.push(t);
    prev = line;
  }

  const bodyText = body.join('\n').trim();
  const contextText = context.join('\n').trim();
  return {
    text: bodyText || contextText,
    context_text: bodyText ? contextText : '',
  };
}

function textLines(value) {
  return String(value || '').split(/\n+/u).map((line) => cleanText(line)).filter(Boolean);
}

function qualityScore(msg) {
  const text = `${msg.context_text || ''}\n${msg.text || ''}`;
  const weird = (text.match(/[�毳㉭口十€]/gu) || []).length;
  const hangul = (text.match(/\p{Script=Hangul}/gu) || []).length;
  return text.length + hangul * 0.2 - weird * 8 + (msg.timestamp_text ? 4 : 0) + (msg.speaker !== 'Unknown' ? 3 : 0);
}

function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

function messageKey(msg) {
  return norm([
    msg.speaker === 'Unknown' ? '' : msg.speaker,
    msg.context_text || '',
    msg.text || '',
    compactTimestamp(msg.timestamp_text || ''),
  ].join('|'));
}

function isDuplicateMessage(a, b) {
  const ak = messageKey(a);
  const bk = messageKey(b);
  if (!ak || !bk) return false;
  if (ak === bk) return true;
  const aText = norm(`${a.context_text || ''} ${a.text || ''}`);
  const bText = norm(`${b.context_text || ''} ${b.text || ''}`);
  if (aText.length < 10 || bText.length < 10) {
    return aText === bText && compactTimestamp(a.timestamp_text || '') === compactTimestamp(b.timestamp_text || '');
  }
  if (compactTimestamp(a.timestamp_text || '') && compactTimestamp(b.timestamp_text || '')
      && compactTimestamp(a.timestamp_text || '') !== compactTimestamp(b.timestamp_text || '')) {
    return false;
  }
  return similarity(aText, bText) >= 0.84;
}

function dedupeMessages(messages) {
  const out = [];
  for (let msg of messages) {
    let duplicateIndex = -1;
    for (let i = out.length - 1; i >= 0 && i >= out.length - 160; i--) {
      if (isDuplicateMessage(out[i], msg)) {
        duplicateIndex = i;
        break;
      }
    }
    if (duplicateIndex < 0) {
      out.push(msg);
      continue;
    }
    const prev = out[duplicateIndex];
    const mergedFlags = [...new Set([...(prev.flags || []), ...(msg.flags || []), 'deduped_overlap'])];
    if (qualityScore(msg) > qualityScore(prev) + 1 && prev.source_type !== 'main') {
      out[duplicateIndex] = { ...msg, flags: mergedFlags };
    } else {
      out[duplicateIndex] = { ...prev, flags: mergedFlags };
    }
  }
  return out;
}

function removeQuotedPrefixes(messages) {
  const earlier = [];
  const out = [];
  for (let msg of messages) {
    const lines = textLines(msg.text);
    let moveCount = 0;
    for (let count = 1; count <= Math.min(4, lines.length - 1); count++) {
      const prefix = norm(lines.slice(0, count).join(' '));
      if (prefix.length < 10) continue;
      const matchesEarlier = earlier.some((prev) => (
        similarity(prefix, prev) >= 0.84
        || (prev.includes(prefix) && prefix.length >= Math.min(18, prev.length * 0.35))
        || (prefix.includes(prev) && prev.length >= Math.min(18, prefix.length * 0.35))
      ));
      if (matchesEarlier) moveCount = count;
    }
    if (moveCount > 0) {
      const moved = lines.slice(0, moveCount).join('\n');
      const kept = lines.slice(moveCount).join('\n');
      msg = {
        ...msg,
        text: kept,
        context_text: [msg.context_text, moved].filter(Boolean).join('\n'),
        flags: [...new Set([...(msg.flags || []), 'quoted_prefix_moved'])],
      };
    }
    out.push(msg);
    const body = norm(msg.text || '');
    if (body.length >= 10) earlier.push(body);
    const full = norm(`${msg.context_text || ''} ${msg.text || ''}`);
    if (full.length >= 10) earlier.push(full);
    if (earlier.length > 240) earlier.splice(0, earlier.length - 240);
  }
  return out.filter((msg) => norm(msg.text || '').length >= 2);
}

function parseFrame({ lines, file, frameIndex, mode, rootDir, ocrDir, threadIndex = null }) {
  const normalized = lines.map(asLine).filter((line) => line.text);
  const frameMaxY = Math.max(0, ...normalized.map((line) => line.y + line.h));
  const frameMaxX = Math.max(1, ...normalized.map((line) => line.x + line.w));
  const timestamps = [];
  const comments = [];
  const senders = [];
  const content = [];

  for (const line of normalized.sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
    if (isTimestamp(line.text)) {
      timestamps.push(line);
      continue;
    }
    if (isCommentControl(line.text)) {
      comments.push(line);
      continue;
    }
    if (isUiChrome(line.text, line, frameMaxY, mode)) continue;
    if (isLikelySender(line.text)) {
      senders.push(line);
      continue;
    }
    content.push(line);
  }

  const groups = groupContentLines(content);
  const messages = [];
  for (const group of groups) {
    const [x, y, w, h] = group.bbox;
    if (w < 24 || h < 12) continue;
    const { text, context_text } = splitContextAndBody(group.lines);
    if (!text || norm(text).length < 2) continue;
    if (isUiChrome(text, { x, y, w, h }, frameMaxY, mode)) continue;

    const centerX = x + w / 2;
    const direction = centerX > frameMaxX * 0.66 ? 'outgoing' : 'incoming';
    const speaker = direction === 'outgoing' ? 'Me' : nearestSender(senders, group);
    const timestamp = nearestTimestamp(timestamps, group);
    const sourceFile = relative(rootDir, join(ocrDir, file)).replace(/\\/g, '/');
    const framePng = sourceFile.replace(/\/ocr\/frame_(\d+)\.json$/u, '/frames/frame_$1.png');
    const flags = [
      mode === 'thread' ? 'comment_thread' : '',
      context_text ? 'reply_context' : '',
      speaker === 'Unknown' && direction === 'incoming' ? 'speaker_unknown' : '',
    ].filter(Boolean);
    messages.push({
      schema: 'chat.message.v1',
      source_type: mode,
      thread_index: threadIndex,
      speaker,
      speaker_confidence: speaker === 'Unknown' ? 0.1 : (direction === 'outgoing' ? 0.8 : 0.68),
      direction,
      text,
      context_text,
      kind: context_text && !text ? 'reply_context' : 'text',
      timestamp_text: timestamp,
      comment_count: nearestCommentCount(comments, group),
      source: {
        frame: sourceFile,
        frame_image: framePng,
        frame_index: frameIndex,
        bbox: [x, y, w, h],
      },
      flags,
    });
  }
  return messages;
}

function parseOcrDir({ ocrDir, rootDir, mode, threadIndex = null }) {
  const messages = [];
  for (const file of frameFiles(ocrDir)) {
    const lines = readJson(join(ocrDir, file), []);
    if (!Array.isArray(lines)) continue;
    messages.push(...parseFrame({
      lines,
      file,
      frameIndex: frameIndexFromName(file),
      mode,
      rootDir,
      ocrDir,
      threadIndex,
    }));
  }
  return messages;
}

function readThreadManifests(dir, manifest) {
  const threads = Array.isArray(manifest?.threads) ? manifest.threads : [];
  if (threads.length) return threads;
  const root = join(dir, 'threads');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^thread_\d+$/u.test(name))
    .sort()
    .map((name) => ({
      thread_index: Number(name.match(/thread_(\d+)/u)?.[1] || 0),
      thread_dir: join(root, name),
    }));
}

export function buildKakaoOpenchatMessages(dir, { write = false } = {}) {
  const manifest = readJson(join(dir, 'kakao_openchat_manifest.json'), {});
  const room = manifest.room_label || 'KakaoTalk open chat';
  const mainMessages = parseOcrDir({ ocrDir: join(dir, 'ocr'), rootDir: dir, mode: 'main' });
  const threadMessages = [];

  for (const thread of readThreadManifests(dir, manifest)) {
    const threadDir = thread.thread_dir || join(dir, 'threads', `thread_${String(thread.thread_index || 0).padStart(3, '0')}`);
    const parsed = parseOcrDir({
      ocrDir: join(threadDir, 'ocr'),
      rootDir: dir,
      mode: 'thread',
      threadIndex: Number(thread.thread_index || 0) || null,
    });
    for (const msg of parsed) {
      msg.thread_parent_anchor = thread.parent_anchor || thread.candidate?.parent_anchor || '';
      if (msg.thread_parent_anchor) msg.flags = [...new Set([...(msg.flags || []), 'thread_parent_linked'])];
      threadMessages.push(msg);
    }
  }

  const messages = dedupeMessages(removeQuotedPrefixes(dedupeMessages([...mainMessages, ...threadMessages]))).map((msg, index) => ({
    id: `kakao-openchat-${String(index + 1).padStart(5, '0')}`,
    room,
    ...msg,
  }));
  const stats = {
    main_candidates: mainMessages.length,
    thread_candidates: threadMessages.length,
    messages: messages.length,
    duplicates_removed: mainMessages.length + threadMessages.length - messages.length,
    unknown_speaker_messages: messages.filter((msg) => msg.speaker === 'Unknown').length,
    outgoing: messages.filter((msg) => msg.direction === 'outgoing').length,
    incoming: messages.filter((msg) => msg.direction !== 'outgoing').length,
    comment_thread_messages: messages.filter((msg) => msg.source_type === 'thread').length,
  };
  const doc = {
    schema: 'kakao_openchat_messages.v1',
    generated_at: new Date().toISOString(),
    room,
    provider: 'windows-ocr-layout-heuristic',
    note: 'OCR lines are grouped into bubble-like messages by geometry; this is not Codex vision output.',
    stats,
    messages,
  };
  if (write) writeJson(join(dir, 'kakao_openchat_messages.json'), doc);
  return doc;
}

export function loadKakaoOpenchatMessages(dir) {
  const existing = readJson(join(dir, 'kakao_openchat_messages.json'));
  if (existing?.schema === 'kakao_openchat_messages.v1' && Array.isArray(existing.messages)) return existing;
  return buildKakaoOpenchatMessages(dir, { write: false });
}
