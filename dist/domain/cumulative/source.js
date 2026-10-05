import {assertRawSummarySource, durableSourceMessages, sourceFingerprint} from '../summary/source.js';
import {cleanSummaryFloors} from '../summary/cleaning.js';
const copy = structuredClone;
const freeze = value => {if(value && typeof value === 'object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const cumulativeRange = value => exact(value, ['start','end']) && Number.isSafeInteger(value.start) && value.start >= 0 && Number.isSafeInteger(value.end) && value.end >= value.start;
export function prepareCumulativeSource(raw, {startFloor, endFloor, includeUser, excludedFloors = [], rules} = {}) {
  const source = assertRawSummarySource(raw), requestedRange = {start:startFloor,end:endFloor};
  if (!cumulativeRange(requestedRange) || typeof includeUser !== 'boolean') throw new Error('古法范围及来源策略须明确提供');
  const rawMessages = source.messages.filter(item => item.floor >= startFloor && item.floor <= endFloor).sort((a,b) => a.floor-b.floor);
  if (rawMessages.length !== endFloor-startFloor+1) throw new Error('所选原始楼层不可用');
  const excluded = new Set();
  for (const record of excludedFloors) {
    if (!exact(record,['floor','identity']) || !Number.isSafeInteger(record.floor) || record.floor < 0 || excluded.has(record.floor) || !(record.identity === null || typeof record.identity === 'string' && record.identity)) throw new Error('古法排除楼层无效');
    const message = rawMessages.find(item => item.floor === record.floor);
    if (message && record.identity !== null && message.identity !== record.identity) throw new Error('排除楼层身份已变化');
    excluded.add(record.floor);
  }
  const sentFloors = cleanSummaryFloors(rawMessages.filter(item => !item.system && item.role !== 'system' && !excluded.has(item.floor)),{includeUser,rules});
  if (!sentFloors.length) throw new Error('清洗后没有可发送的正文');
  return freeze({epoch:source.epoch,requestedRange,rawMessages:copy(rawMessages),fingerprint:sourceFingerprint(rawMessages),includeUser,excludedFloors:copy(excludedFloors),sentFloors});
}
export function storedCumulativeSource(snapshot) {
  return assertCumulativeSource({requestedRange:copy(snapshot.requestedRange),rawMessages:durableSourceMessages(snapshot.rawMessages),fingerprint:snapshot.fingerprint,includeUser:snapshot.includeUser,excludedFloors:copy(snapshot.excludedFloors),sentFloors:durableSourceMessages(snapshot.sentFloors)});
}
export function assertCumulativeSource(value) {
  if (!exact(value,['requestedRange','rawMessages','fingerprint','includeUser','excludedFloors','sentFloors']) || !cumulativeRange(value.requestedRange) || typeof value.includeUser !== 'boolean' || !Array.isArray(value.rawMessages) || value.rawMessages.length !== value.requestedRange.end-value.requestedRange.start+1) throw new Error('古法来源证据无效');
  assertRawSummarySource({epoch:0,messages:value.rawMessages});
  if (value.rawMessages.some((message,index) => !exact(message,['floor','identity','role','system','text','date','swipeId']) || message.floor !== value.requestedRange.start+index || !(message.swipeId === null || Number.isSafeInteger(message.swipeId) && message.swipeId >= 0)) || sourceFingerprint(value.rawMessages) !== value.fingerprint) throw new Error('古法来源指纹或楼层不符');
  const excluded = new Set();
  if (!Array.isArray(value.excludedFloors)) throw new Error('古法排除楼层无效');
  for (const record of value.excludedFloors) {
    if (!exact(record,['floor','identity']) || !Number.isSafeInteger(record.floor) || record.floor < 0 || excluded.has(record.floor) || !(record.identity === null || typeof record.identity === 'string' && record.identity)) throw new Error('古法排除楼层无效');
    const message = value.rawMessages.find(item => item.floor === record.floor);
    if (message && record.identity !== null && record.identity !== message.identity) throw new Error('古法排除身份不符');
    excluded.add(record.floor);
  }
  const sent = new Set();
  if (!Array.isArray(value.sentFloors) || !value.sentFloors.length) throw new Error('古法有效正文不能为空');
  for (const item of value.sentFloors) {
    const original = value.rawMessages.find(message => message.floor === item.floor);
    if (!exact(item,['floor','identity','role','system','text','date','swipeId']) || !original || item.identity !== original.identity || item.role !== original.role || item.system !== original.system || item.date !== original.date || item.swipeId !== original.swipeId || sent.has(item.floor) || excluded.has(item.floor) || original.system || original.role === 'system' || !value.includeUser && original.role === 'user' || typeof item.text !== 'string' || !item.text.trim()) throw new Error('古法发送来源无效');
    sent.add(item.floor);
  }
  return copy(value);
}
// Runtime epoch and full tickets reject edit-and-revert ABA. Durable evidence is
// for reloaded pending and branching, never an authority over saved memory.
export function matchesCumulativeSource(snapshot, raw) {
  try {
    const current = assertRawSummarySource(raw);
    if (!Number.isSafeInteger(snapshot.epoch) || current.epoch !== snapshot.epoch) return false;
    return JSON.stringify(current.messages.filter(item => item.floor >= snapshot.requestedRange.start && item.floor <= snapshot.requestedRange.end).sort((a,b)=>a.floor-b.floor)) === JSON.stringify(snapshot.rawMessages);
  } catch { return false; }
}
export function matchesStoredCumulativeSource(snapshot, raw) {
  try {
    assertCumulativeSource(snapshot);
    const current = assertRawSummarySource(raw), messages = current.messages.filter(item => item.floor >= snapshot.requestedRange.start && item.floor <= snapshot.requestedRange.end).sort((a,b)=>a.floor-b.floor);
    return JSON.stringify(durableSourceMessages(messages)) === JSON.stringify(snapshot.rawMessages);
  } catch { return false; }
}
