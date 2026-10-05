import {assertCumulativeSource,cumulativeRange} from './source.js';
import {assertCumulativeGeneration} from '../../shared/settings/model.js';
import {normalizeCleaningRule} from '../summary/cleaning.js';
const copy = structuredClone;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && !!value.trim();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new Error('古法数据结构无效'); }
export function defaultCumulativePreferences() {return {manual:{startFloor:0,endFloor:null,includeUser:true,checkBeforeSave:true,hideSource:true},auto:{startFloor:0,batchSize:50,includeUser:true,checkBeforeSave:false,hideSource:true}};}
export function emptyCumulative() { return {schema:1,revision:0,preferences:defaultCumulativePreferences(),excludedFloors:[],versions:[],currentVersionId:null,progress:{lastProcessedFloor:null}}; }
export function assertCumulativePreferences(value) {
  exact(value,['manual','auto']);
  for(const [mode,item] of Object.entries(value)) {
    const allowed=['startFloor','includeUser','checkBeforeSave','hideSource',...(mode==='manual'?['endFloor']:['batchSize'])];
    if(!item||Object.getPrototypeOf(item)!==Object.prototype||Object.keys(item).some(key=>!allowed.includes(key)))throw new Error('古法参数无效');
    if(Object.hasOwn(item,'startFloor')&&!integer(item.startFloor)||['includeUser','checkBeforeSave','hideSource'].some(key=>Object.hasOwn(item,key)&&typeof item[key]!=='boolean'))throw new Error('古法参数须明确提供');
    if(mode==='auto'&&(!Number.isSafeInteger(item.batchSize)||item.batchSize<1)||mode==='manual'&&Object.hasOwn(item,'endFloor')&&!(item.endFloor===null||integer(item.endFloor)&&(item.startFloor===undefined||item.endFloor>=item.startFloor)))throw new Error('古法范围参数无效');
  }
  return copy(value);
}
export function assertCumulativeHiddenSegments(value) {
  if(!Array.isArray(value))throw new Error('古法隐藏账本无效');
  const ids=new Set();
  for(const segment of value){
    exact(segment,['id','messages']);if(!text(segment.id)||ids.has(segment.id)||!Array.isArray(segment.messages)||!segment.messages.length)throw new Error('古法隐藏段身份无效');ids.add(segment.id);
    let previous=-1;const identities=new Set();
    for(const item of segment.messages){exact(item,['floor','identity','role','date']);if(!integer(item.floor)||item.floor<=previous||!text(item.identity)||identities.has(item.identity)||!['user','assistant'].includes(item.role)||!(item.date===null||typeof item.date==='string'))throw new Error('古法隐藏定位证据无效');previous=item.floor;identities.add(item.identity);}
  }
  return copy(value);
}
export function assertCumulativeExclusions(value) {
  if (!Array.isArray(value)) throw new Error('古法排除楼层无效');
  const floors = new Set();
  for (const item of value) { exact(item,['floor','identity']); if (!integer(item.floor) || floors.has(item.floor) || !(item.identity === null || text(item.identity))) throw new Error('古法排除楼层无效'); floors.add(item.floor); }
  return copy(value).sort((a,b)=>a.floor-b.floor);
}
export function cumulativeCoverage(ranges) {
  if (!Array.isArray(ranges) || !ranges.every(cumulativeRange)) throw new Error('古法累计来源无效');
  const result = [];
  for (const range of copy(ranges).sort((a,b)=>a.start-b.start || a.end-b.end)) { const last=result.at(-1); if (last && range.start <= last.end+1) last.end=Math.max(last.end,range.end); else result.push(range); }
  return result;
}
export function baseSnapshotOf(version) { return version ? {versionId:version.id,body:version.body,startTime:version.startTime,endTime:version.endTime} : null; }
function assertBase(value) {
  if (value === null) return;
  exact(value,['versionId','body','startTime','endTime']);
  if (!text(value.versionId) || !text(value.body) || typeof value.startTime !== 'string' || typeof value.endTime !== 'string') throw new Error('古法完整基版无效');
}
export function publicCumulativeEvidence(value) {
  const allowed = ['promptOverrides','injectionPosition','summaryCleaning','includeUser','checkBeforeSave','hideSource'];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key=>!allowed.includes(key))) throw new Error('古法公开配置证据无效');
  assertCumulativeGeneration(Object.fromEntries(['promptOverrides','injectionPosition'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])));
  if(['includeUser','checkBeforeSave','hideSource'].some(key=>Object.hasOwn(value,key)&&typeof value[key]!=='boolean'))throw new Error('古法配置策略无效');
  if(Object.hasOwn(value,'summaryCleaning')) {
    exact(value.summaryCleaning,['rules']);if(!Array.isArray(value.summaryCleaning.rules))throw new Error('古法清洗证据无效');
    const ids=new Set();for(const rule of value.summaryCleaning.rules){exact(rule,['id','name','enabled','action','pattern','captureGroup','replacement']);normalizeCleaningRule(rule);if(!text(rule.id)||!text(rule.name)||ids.has(rule.id))throw new Error('古法清洗证据无效');ids.add(rule.id);}
  }
  const visit = item => { if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return; if (Array.isArray(item)) {item.forEach(visit);return;} if (!item || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('古法配置证据无效'); for (const [key,child] of Object.entries(item)) {if (/^(ai|api|apiKey|password|credentials|credentialEpoch|authorization|secret|secretId|secretValue|endpoint|model|presets|activePresetId|epoch)$/i.test(key)) throw new Error('古法证据不得包含私有配置');visit(child);} };
  visit(value); return copy(value);
}
export function assertCumulativeVersion(value) {
  exact(value,['id','taskId','body','startTime','endTime','baseSnapshot','sourceSnapshot','coverageRanges','settingsEvidence','createdAt','updatedAt']);
  if (![value.id,value.taskId,value.body,value.createdAt,value.updatedAt].every(text) || typeof value.startTime !== 'string' || typeof value.endTime !== 'string') throw new Error('古法版本字段无效');
  assertBase(value.baseSnapshot); assertCumulativeSource(value.sourceSnapshot); publicCumulativeEvidence(value.settingsEvidence);
  if(Object.hasOwn(value.settingsEvidence,'includeUser')&&value.settingsEvidence.includeUser!==value.sourceSnapshot.includeUser)throw new Error('古法来源和配置策略不符');
  if (!Array.isArray(value.coverageRanges) || !value.coverageRanges.length || !same(value.coverageRanges,cumulativeCoverage(value.coverageRanges)) || !value.coverageRanges.some(range=>range.start <= value.sourceSnapshot.requestedRange.start && range.end >= value.sourceSnapshot.requestedRange.end) || value.baseSnapshot?.versionId === value.id) throw new Error('古法累计来源不完整');
  return copy(value);
}
export function assertCumulativePending(value) {
  exact(value,['schema','id','operation','version','createdAt','updatedAt']);
  if (value.schema !== 1 || ![value.id,value.createdAt,value.updatedAt].every(text) || !['append','replace'].includes(value.operation)) throw new Error('古法待审核身份无效');
  assertCumulativeVersion(value.version);
  if (value.version.taskId !== value.id) throw new Error('古法待审核任务不符');
  return copy(value);
}
export function assertCumulative(value) {
  exact(value,['schema','revision','preferences','excludedFloors','versions','currentVersionId','progress',...(Object.hasOwn(value,'pending')?['pending']:[]),...(Object.hasOwn(value,'hiddenSegments')?['hiddenSegments']:[])]);
  if (value.schema !== 1 || !integer(value.revision) || !Array.isArray(value.versions)) throw new Error('古法数据版本无效');
  assertCumulativePreferences(value.preferences); assertCumulativeExclusions(value.excludedFloors); exact(value.progress,['lastProcessedFloor']);
  if(Object.hasOwn(value,'hiddenSegments'))assertCumulativeHiddenSegments(value.hiddenSegments);
  const ids = new Set(), tasks = new Set(); let previous = null;
  for (const version of value.versions) {
    assertCumulativeVersion(version);
    if (ids.has(version.id) || tasks.has(version.taskId) || !same(version.baseSnapshot,baseSnapshotOf(previous)) || !same(version.coverageRanges,cumulativeCoverage([...(previous?.coverageRanges ?? []),version.sourceSnapshot.requestedRange]))) throw new Error('古法祖先链或完整累计来源无效');
    ids.add(version.id); tasks.add(version.taskId); previous=version;
  }
  const floor = previous ? Math.max(...previous.coverageRanges.map(range=>range.end)) : null;
  if (value.currentVersionId !== (previous?.id ?? null) || value.progress.lastProcessedFloor !== floor) throw new Error('古法当前指针或进度不符');
  if (Object.hasOwn(value,'pending')) {
    const pending = assertCumulativePending(value.pending), version=pending.version;
    if (pending.operation === 'append' ? ids.has(version.id) || tasks.has(version.taskId) || !same(version.baseSnapshot,baseSnapshotOf(previous)) || !same(version.coverageRanges,cumulativeCoverage([...(previous?.coverageRanges ?? []),version.sourceSnapshot.requestedRange])) : !previous || version.id !== previous.id || !same(version.baseSnapshot,previous.baseSnapshot) || !same(version.sourceSnapshot,previous.sourceSnapshot) || !same(version.coverageRanges,previous.coverageRanges)) throw new Error('古法待审核与正式版本冲突');
  }
  return copy(value);
}
export function cumulativeOf(root) {
  if(root.cumulative===undefined)return emptyCumulative();
  const domain=assertCumulative(root.cumulative),defaults=defaultCumulativePreferences();
  return {...domain,preferences:{manual:{...defaults.manual,...domain.preferences.manual},auto:{...defaults.auto,...domain.preferences.auto}}};
}
export function inheritCumulative(value, floor) {
  const domain=assertCumulative(value); if (!integer(floor)) throw new Error('分支楼层无效');
  // Only the complete ancestor prefix survives. A crossing version is never cut.
  const versions=[]; for (const version of domain.versions) {if (!version.coverageRanges.every(range=>range.end < floor)) break;versions.push(version);}
  const current=versions.at(-1);
  const result={...domain,revision:0,excludedFloors:domain.excludedFloors.filter(item=>item.floor < floor),versions,currentVersionId:current?.id ?? null,progress:{lastProcessedFloor:current ? Math.max(...current.coverageRanges.map(range=>range.end)) : null}};
  if(Object.hasOwn(domain,'hiddenSegments'))result.hiddenSegments=domain.hiddenSegments.filter(segment=>segment.messages.every(item=>item.floor<floor));
  delete result.pending; return assertCumulative(result);
}
