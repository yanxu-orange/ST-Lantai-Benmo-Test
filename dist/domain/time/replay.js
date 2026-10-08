import {storyDate,compareStoryDates,shiftStoryDate} from './point.js';
// Pure deterministic replay; source/target validity is checked by the caller.
// parse(message, incomingDate) returns one selected date or null. It must resolve
// every relative token in that message against the same incomingDate.
export function replayDateMessages(calendar, messages, {
  parse,
  baseDate = null,
  startIndex = 0,
  allowAssistantRollback = false,
} = {}) {
  if (!Array.isArray(messages) || typeof parse !== 'function') throw new TypeError('日期重建来源无效');
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > messages.length) throw new RangeError('日期重建起点无效');
  let date = baseDate === null ? null : storyDate(calendar,baseDate);
  let provenance = date ? {source:'manual',messageIndex:null} : null;
  let matchedCount = 0;
  const entries = [];
  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index], before = date ? structuredClone(date) : null;
    let selected = null;
    if (message && ['user','assistant'].includes(message.role)) {
      selected = parse(message, before === null ? null : structuredClone(before), index);
      if (selected !== null && selected !== undefined) {
        selected = storyDate(calendar,selected);
        if (!allowAssistantRollback && message.role === 'assistant' && date && compareStoryDates(calendar,selected,date) < 0) selected = null;
      }
    }
    if (selected) {
      date = structuredClone(selected);
      provenance = {source:message.role,messageIndex:index};
      matchedCount++;
    }
    entries.push({messageIndex:index,before,after:date === null ? null : structuredClone(date),matched:!!selected});
  }
  return {date:date === null ? null : structuredClone(date),provenance,matchedCount,entries};
}

// Candidates already carry original message offsets, including both ends.
// Duplicate exposure through overlapping tag groups is one textual operation.
export function selectMessageDate(calendar, candidates, incomingDate = null) {
  if (!Array.isArray(candidates)) throw new TypeError('日期候选无效');
  const base = incomingDate === null ? null : storyDate(calendar,incomingDate);
  const unique = new Map();
  for (const item of candidates) {
    if (!item || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.end <= item.start) throw new Error('日期候选位置无效');
    let date = null;
    if (item.kind === 'absolute') {
      try { date = storyDate(calendar,item.date); } catch { continue; }
    } else if (['shiftDays','shiftMonths','shiftYears'].includes(item.kind)) {
      const amount = item.amount ?? item.days;
      if (!Number.isSafeInteger(amount)) throw new Error('日期偏移量无效');
      if (base !== null) date = shiftStoryDate(calendar,base,item.kind,amount);
    } else throw new Error('日期候选类型无效');
    if (date) unique.set(`${item.start}:${item.end}:${date.year}:${date.month}:${date.day}`,{start:item.start,end:item.end,date});
  }
  const ordered=[...unique.values()].sort((a,b)=>a.start-b.start || a.end-b.end);
  return ordered.length ? structuredClone(ordered.at(-1).date) : null;
}
