export function normalizedVisibleLabel(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

export function suffixPrefixOverlap(previousKeys, pageKeys) {
  const max = Math.min(previousKeys.length, pageKeys.length);
  for (let length = max; length > 0; length -= 1) {
    let matched = true;
    const previousStart = previousKeys.length - length;
    for (let index = 0; index < length; index += 1) {
      if (previousKeys[previousStart + index] !== pageKeys[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return length;
  }
  return 0;
}

function editDistance(left, right) {
  const a = [...String(left || '')];
  const b = [...String(right || '')];
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[b.length];
}

export function visibleLabelSimilarity(left, right) {
  const a = normalizedVisibleLabel(left);
  const b = normalizedVisibleLabel(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max([...a].length, [...b].length, 1);
}

export function fuzzySuffixPrefixOverlap(previousKeys, pageKeys) {
  const max = Math.min(previousKeys.length, pageKeys.length);
  for (let length = max; length > 0; length -= 1) {
    const previousStart = previousKeys.length - length;
    const similarities = Array.from({ length }, (_, index) => (
      visibleLabelSimilarity(previousKeys[previousStart + index], pageKeys[index])
    ));
    const strong = similarities.filter((score) => score >= 0.5).length;
    const average = similarities.reduce((sum, score) => sum + score, 0) / length;
    const valid = length === 1
      ? similarities[0] >= 0.85
      : strong >= length - 1 && average >= 0.58;
    if (valid) return length;
  }
  return 0;
}

export function orderedPageMatchIndexes(previousKeys, pageKeys) {
  const rows = previousKeys.length + 1;
  const columns = pageKeys.length + 1;
  const lengths = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let previous = previousKeys.length - 1; previous >= 0; previous -= 1) {
    for (let current = pageKeys.length - 1; current >= 0; current -= 1) {
      lengths[previous][current] = previousKeys[previous] === pageKeys[current]
        ? 1 + lengths[previous + 1][current + 1]
        : Math.max(lengths[previous + 1][current], lengths[previous][current + 1]);
    }
  }

  const matched = new Set();
  let previous = 0;
  let current = 0;
  while (previous < previousKeys.length && current < pageKeys.length) {
    if (previousKeys[previous] === pageKeys[current]
      && lengths[previous][current] === 1 + lengths[previous + 1][current + 1]) {
      matched.add(current);
      previous += 1;
      current += 1;
    } else if (lengths[previous + 1][current] >= lengths[previous][current + 1]) {
      previous += 1;
    } else {
      current += 1;
    }
  }
  return matched;
}

export class VisibleListTracker {
  constructor(key = (room) => normalizedVisibleLabel(room?.label)) {
    this.key = key;
    this.keys = [];
    this.previousPageKeys = [];
  }

  addPage(rooms) {
    const entries = (Array.isArray(rooms) ? rooms : [])
      .map((room) => ({ room, key: this.key(room) }))
      .filter((entry) => entry.key);
    const pageKeys = entries.map((entry) => entry.key);
    const overlap = fuzzySuffixPrefixOverlap(this.previousPageKeys, pageKeys);
    const matchedIndexes = new Set(Array.from({ length: overlap }, (_, index) => index));
    const added = entries.filter((entry, index) => !matchedIndexes.has(index));
    this.keys.push(...added.map((entry) => entry.key));
    this.previousPageKeys = pageKeys;
    return {
      rooms: entries.map((entry) => entry.room),
      newRooms: added.map((entry) => entry.room),
      overlap: matchedIndexes.size,
      total: this.keys.length,
    };
  }
}
