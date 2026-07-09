// Shared conservative rules for WeChat OCR speaker and attachment heuristics.
// Keep these in one place so live structuring and post-scrape sanitizers agree.

export function charLen(text) {
  return [...String(text || '').replace(/\s+/g, '')].length;
}

export function cleanOcrText(text) {
  return String(text || '')
    .replace(/(?:从\s*)?\d+\s+new message(?:\(s\))?/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:：|·,，.。]+|[\s:：|·,，.。]+$/gu, '')
    .trim();
}

export function stripWechatChromeText(text) {
  return cleanOcrText(text)
    .replace(/\s*(?:微信电脑版|WeChat\s*(?:Desktop|for Windows|PC))\s*$/iu, '')
    .replace(/\s*(?:메시지 입력|发送|按住说话|Enter|Shift\+Enter)\s*$/iu, '')
    .trim();
}

export function looksWechatChromeOrSystemArtifact(text) {
  const clean = cleanOcrText(text);
  if (!clean) return true;
  if (/^(?:微信电脑版|WeChat\s*(?:Desktop|for Windows|PC))$/iu.test(clean)) return true;
  if (/^(?:메시지 입력|发送|按住说话|表情|Enter|Shift\+Enter)$/iu.test(clean)) return true;
  if (/^(?:You recalled a message|.*撤回了一条消息|.*撤回了一則訊息)$/iu.test(clean)) return true;
  if (/^Other user is not your friend$/iu.test(clean)) return true;
  return false;
}

export function cleanSpeakerName(text) {
  return cleanOcrText(text)
    .replace(/([\p{Script=Han}\p{Script=Hangul}])\s+(?=[\p{Script=Han}\p{Script=Hangul}])/gu, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function looksGroupRoomLabel(label) {
  const s = cleanSpeakerName(label);
  if (!s) return false;
  if (/群/u.test(s)) return true;
  if (/[（(]\s*\d{1,3}\s*[)）]/u.test(s)) return true;
  if (/[,，、]\s*[^,，、]+/u.test(s) && /[（(]\s*\d{1,3}\s*[)）]/u.test(s)) return true;
  return false;
}

export function looksAttachmentOrMediaCard(text) {
  const clean = cleanOcrText(text);
  if (!clean) return false;
  const fileExtRe = /\.(?:wav|mp3|m4a|aac|flac|mp4|mov|avi|mkv|jpg|jpeg|png|gif|webp|pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv)\b/i;
  const fileSizeRe = /\b\d+(?:\.\d+)?\s?(?:B|K|KB|M|MB|G|GB)\b/i;
  if (fileExtRe.test(clean) || fileSizeRe.test(clean)) return true;
  if (/^(?:\[?(?:图片|照片|视频|语音|文件|Image|Video|File|Voice|사진|동영상|파일|음성)\]?)$/iu.test(clean)) return true;
  return false;
}

export function looksSentenceLikeSpeaker(text) {
  const s = cleanSpeakerName(text);
  if (!s) return true;
  if (charLen(s) > 24) return true;
  if (/[?？!！。。，,、;；()（）[\]【】]/u.test(s)) return true;
  if (/\.(?:pdf|xlsx?|docx?|ai|wav|png|jpg|jpeg|zip|rar)\b/i.test(s)) return true;
  if (/\b\d+(?:\.\d+)?\s?(?:B|K|KB|M|MB|G|GB)\b/i.test(s)) return true;
  if (/\b(?:the|is|are|okay|good|touch|plot|animations?|point|time|yes|no|need|designed|korea)\b/i.test(s) && /[a-z]/.test(s) && charLen(s) > 4) return true;
  if (/\b(?:I|you|we|they|this|that|the|and|or|to|for|with|not|then|okay|thanks?)\b/i.test(s) && charLen(s) > 10) return true;
  if (/(습니다|합니다|드립니다|됩니다|입니다|합니다|했어요|할게요|주세요|확인|공유|금액|공장|세금|환불|기존|현재|나머지|저희|누구|내용|요청|전달|언급|감사|좋은|있는|없는|했다|한다|된다|이다)$/u.test(s)) return true;
  if (/(这个|那个|我们|你们|他们|需要|可以|确认|麻烦|采购|销售|发票|合同|付款|报关|货物|金额|名称|出口|物流|开票|收到|好的|明天|今天|昨天|这个项目|方便的话|我|您|你|请|尺寸|规格|型号|LOGO|进行|按照|整体|问题|资料|地址|参考|要求|继续|计划|所有|以后)/u.test(s) && charLen(s) > 4) return true;
  if (/(합니다|습니다|주세요|확인|감사|여기로|보내|완료|영문주소|이것|참고|운동기구|주소)/u.test(s)) return true;
  if (/\d/.test(s) && /(?:元|위안|金额|货款|运费|合同|发票|报关|付款|销售|采购)/u.test(s)) return true;
  if (/^(?:收到|好的|Okay|Yes|No|Not hurry|This one not|If we start this item)$/iu.test(s)) return true;
  return false;
}

export function isPlausibleSpeakerName(text) {
  const s = cleanSpeakerName(text);
  const n = charLen(s);
  if (n < 1 || n > 24) return false;
  if (/^\d+(?:\.\d+)?[KMG]$/i.test(s)) return false;
  if (/^[\p{P}\p{S}\p{Number}\s]+$/u.test(s)) return false;
  if (looksAttachmentOrMediaCard(s)) return false;
  if (looksSentenceLikeSpeaker(s)) return false;
  const chars = [...s.replace(/\s+/g, '')];
  const letters = chars.filter((ch) => /[\p{Script=Han}\p{Script=Hangul}A-Za-z]/u.test(ch)).length;
  if (letters === 0) return false;
  return true;
}
