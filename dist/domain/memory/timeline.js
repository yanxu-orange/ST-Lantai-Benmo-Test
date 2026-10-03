// Calendar-only projection. Never infer missing dates from the host clock.
export function parseStoryDate(value) {
  const text = String(value ?? '').trim().replace(/^(?:大约|约)\s*/u, '');
  const full = /^(\d{4})(?:年(?:(\d{1,2})月(?:(\d{1,2})日)?)?|[-/](\d{1,2})(?:[-/](\d{1,2}))?)?(.*)$/u.exec(text);
  const partial = !full && /^(?:(\d{1,2})月(?:(\d{1,2})日)?|(\d{1,2})[-/](\d{1,2}))(.*)$/u.exec(text);
  if (!full && !partial) return null;
  const year = full ? Number(full[1]) : null;
  const monthText = full ? full[2] ?? full[4] : partial[1] ?? partial[3];
  const dayText = full ? full[3] ?? full[5] : partial[2] ?? partial[4];
  const month = monthText === undefined ? null : Number(monthText), day = dayText === undefined ? null : Number(dayText);
  // Keep a reliable calendar prefix through clock notation; never parse its minutes
  // or timezone. The suffix whitelist excludes alternative dates and date ranges.
  let suffix = (full ? full[6] : partial[5]).trim();
  if (/^[（(]/u.test(suffix)) {
    const closing = suffix[0] === '（' ? '）' : ')';
    if (!suffix.endsWith(closing)) return null;
    suffix = suffix.slice(1, -1).trim();
  }
  if (!/^(?:T\s*)?(?:大约|约)?\s*(?:凌晨|清晨|早晨|上午|中午|午后|下午|傍晚|晚上|夜间|深夜)?\s*(?:\d{1,2}(?:[:：]\d{2}(?:[:：]\d{2}(?:\.\d+)?)?|[时点](?:半|一刻|三刻|\d{1,2}分(?:\d{1,2}秒)?)?)(?:Z|[+-]\d{2}:?\d{2})?)?\s*(?:左右)?$/u.test(suffix)) return null;
  if (year !== null && year < 1 || monthText !== undefined && (!month || month > 12)) return null;
  const leap = year === null || year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const limit = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (dayText !== undefined && (!day || day > limit)) return null;
  return { year, month, day, precision: day ? 'day' : month ? 'month' : 'year' };
}

export function buildTimeline(events) {
  const entries = events.map((event, index) => ({ event, index, date: parseStoryDate(event.endTime) ?? parseStoryDate(event.startTime) }));
  // Unknown month/day groups follow known dates in that year/month, without fabricating a date.
  entries.sort((a, b) => {
    if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : a.index - b.index;
    if (a.date.year === null || b.date.year === null) {
      if (a.date.year !== b.date.year) return a.date.year === null ? -1 : 1;
    }
    return b.date.year - a.date.year || (b.date.month ?? 0) - (a.date.month ?? 0) || (b.date.day ?? 0) - (a.date.day ?? 0) || a.index - b.index;
  });
  const years = [];
  for (const { event, date } of entries) {
    const year = date ? date.year : null, kind = date ? 'dated' : 'unlocated';
    let group = years.at(-1);
    if (!group || group.year !== year || group.kind !== kind) { group = { year, kind, dates: [] }; years.push(group); }
    const key = date ? `${date.month ?? ''}-${date.day ?? ''}` : 'unknown';
    let bucket = group.dates.at(-1);
    if (!bucket || bucket.key !== key) {
      bucket = { key, label: !date ? '' : date.day ? `${date.month}月${date.day}日` : date.month ? `${date.month}月 · 日期未知` : '月日未知', events: [] };
      group.dates.push(bucket);
    }
    bucket.events.push(event);
  }
  return years;
}
