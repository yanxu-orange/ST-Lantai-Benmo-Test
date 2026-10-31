import {assertWorldPreferences} from './preferences.js';
import {createCalendar} from '../time/calendar.js';
import {WORLD_TASKS,worldSectionKinds} from './tasks.js';
import {validateWorldEntry,WORLD_DIAGNOSTIC_CODES,WORLD_DIAGNOSTIC_FIELDS} from './output.js';
import {WORLD_MATERIALS} from './materials.js';
const copy=structuredClone;
const exact=(value,keys)=>{if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('世界动态数据字段无效');};
const text=v=>typeof v==='string';
const integer=v=>Number.isSafeInteger(v)&&v>=0;
export const WORLD_KINDS=Object.freeze({world:'世界动向',region:'地区动态',weather:'天气环境',activity:'活动机遇',character:'角色动态',opinion:'舆论动态',aftermath:'完结区',plot:'长期剧情库',custom:'自定义区'});
export function assertWorldConfig(value){
 const modular=Object.hasOwn(value,'taskModules');
 if(Object.hasOwn(value,'custom')){exact(value.custom,['enabled','name','content']);if(typeof value.custom.enabled!=='boolean'||!text(value.custom.name)||!text(value.custom.content))throw new Error('自定义区设置无效');}
 exact(value,[...['supplementRefs','supplement'].filter(key=>Object.hasOwn(value,key)),...(Object.hasOwn(value,'custom')?['custom']:[]),...(modular?['taskModules','commonTasks','commonDesign']:[]),...(Object.hasOwn(value,'materialEnabled')?['materialEnabled']:[]),'sections','themes','ideas','worldRefs','characterRefs','extraPeople','extra','notes','readStory','initialScope','initialCount']);
 if(Object.hasOwn(value,'materialEnabled')){exact(value.materialEnabled,Object.keys(WORLD_MATERIALS).filter(key=>key!=='supplementInfo'||Object.hasOwn(value.materialEnabled,key)));if(Object.values(value.materialEnabled).some(v=>typeof v!=='boolean'))throw new Error('资料开关无效');}
 if(modular){exact(value.taskModules,Object.keys(WORLD_TASKS));for(const task of Object.values(value.taskModules)){exact(task,['enabled','content','design']);if(typeof task.enabled!=='boolean'||!text(task.content)||!text(task.design))throw new Error('任务分区无效');}if(!text(value.commonTasks))throw new Error('公共任务无效');exact(value.commonDesign,['before','after']);if(Object.values(value.commonDesign).some(v=>!text(v)))throw new Error('公共设计无效');}
 exact(value.sections,['identity','rules','materials','tasks','design']);if(Object.values(value.sections).some(v=>!text(v)))throw new Error('预设分区无效');
 for(const key of ['themes','ideas']){if(!Array.isArray(value[key]))throw new Error('预设条目无效');for(const row of value[key]){exact(row,['id','name','content','enabled']);if(!text(row.id)||!row.id||!text(row.name)||!text(row.content)||typeof row.enabled!=='boolean')throw new Error('预设条目无效');}if(new Set(value[key].map(r=>r.id)).size!==value[key].length)throw new Error('预设条目身份重复');}
 for(const key of ['worldRefs','characterRefs',...(Object.hasOwn(value,'supplementRefs')?['supplementRefs']:[])]){if(!Array.isArray(value[key]))throw new Error('世界书引用无效');const seen=new Set();for(const ref of value[key]){exact(ref,['book','uid']);if(!text(ref.book)||!ref.book||!text(ref.uid)||!ref.uid||seen.has(JSON.stringify(ref)))throw new Error('世界书引用无效');seen.add(JSON.stringify(ref));}}
 if(Object.hasOwn(value,'supplement')&&!text(value.supplement))throw new Error('补充资料设置无效');
 if(['extraPeople','extra','notes'].some(k=>!text(value[k]))||typeof value.readStory!=='boolean'||!['all','recent'].includes(value.initialScope)||!Number.isSafeInteger(value.initialCount)||value.initialCount<1)throw new Error('世界动态资料设置无效');return copy(value);
}
export function emptyWorldDynamics(){return {schema:1,revision:0,config:null,current:null,versions:[],deleted:[],retained:{}};}
export function worldCalendar(definition){const value={id:definition.id,type:definition.type,name:definition.name};if(definition.type==='custom')value.months=definition.months.map(m=>({name:m.name,days:m.days}));if(definition.type==='dynasty')value.importedYears=definition.importedYears.map(y=>({sourceYear:y.sourceYear,months:y.months.map(m=>({name:m.name,days:m.days}))}));return value;}
function assertSectionDiagnostic(d){
 const optional=['field','expectedDate','actualDate','expectedCount','actualCount'];exact(d,['code',...optional.filter(k=>Object.hasOwn(d,k))]);
 if(!WORLD_DIAGNOSTIC_CODES.includes(d.code)||Object.hasOwn(d,'field')&&!WORLD_DIAGNOSTIC_FIELDS.includes(d.field))throw new Error('世界分区诊断无效');
 for(const key of ['expectedDate','actualDate'])if(Object.hasOwn(d,key)&&(!text(d[key])||!/^\d{1,4}年\d{1,2}月\d{1,2}日$/.test(d[key])))throw new Error('世界分区诊断日期无效');
 for(const key of ['expectedCount','actualCount'])if(Object.hasOwn(d,key)&&!integer(d[key]))throw new Error('世界分区诊断数量无效');
}
export function assertWorldVersion(v){
 exact(v,['id','date','calendar','entries','endFloor','anchor','generatedAt',...(Object.hasOwn(v,'design')?['design']:[]),...(Object.hasOwn(v,'sections')?['sections']:[])]);if(!text(v.id)||!v.id||!text(v.generatedAt)||Object.hasOwn(v,'design')&&!text(v.design)||!Number.isSafeInteger(v.endFloor)||v.endFloor< -1||!Array.isArray(v.entries)||!v.date||!v.calendar)throw new Error('世界成果归属无效');
 if(v.anchor!==null){exact(v.anchor,['floor','identity','role','swipeId']);if(!integer(v.anchor.floor)||!text(v.anchor.identity)||!['user','assistant','system'].includes(v.anchor.role)||!(v.anchor.swipeId===null||integer(v.anchor.swipeId)))throw new Error('世界成果回复归属无效');}
 exact(v.date,['calendarId','year','month','day']);
 const canonical=worldCalendar(v.calendar),shape=(original,clean)=>{if(Array.isArray(clean)){if(!Array.isArray(original)||original.length!==clean.length)throw new Error('历法字段无效');clean.forEach((item,i)=>shape(original[i],item));}else if(clean&&typeof clean==='object'){exact(original,Object.keys(clean));for(const key of Object.keys(clean))shape(original[key],clean[key]);}};shape(v.calendar,canonical);if(!v.generatedAt.trim())throw new Error('世界成果历法或日期无效');createCalendar(canonical).validate(v.date);
 const ids=new Set();for(const entry of v.entries){exact(entry,['id','kind','text',...(entry.kind==='custom'&&Object.hasOwn(entry,'name')?['name']:[])]);if(entry.kind==='custom'&&Object.hasOwn(entry,'name')&&(!text(entry.name)||!entry.name.trim()))throw new Error('自定义区名称无效');if(!text(entry.id)||ids.has(entry.id)||!Object.hasOwn(WORLD_KINDS,entry.kind)||!text(entry.text)||!entry.text.trim())throw new Error('世界成果条目无效');validateWorldEntry(entry,canonical,v.date);ids.add(entry.id);}
 if(Object.hasOwn(v,'sections')){
  exact(v.sections,worldSectionKinds());
  for(const [kind,section]of Object.entries(v.sections)){
   exact(section,['accepted',...['previous','diagnostic'].filter(k=>Object.hasOwn(section,k))]);
   if(typeof section.accepted!=='boolean'||section.accepted&&(Object.hasOwn(section,'previous')||Object.hasOwn(section,'diagnostic'))||!section.accepted&&v.entries.some(entry=>entry.kind===kind))throw new Error('世界分区状态无效');
   if(Object.hasOwn(section,'diagnostic'))assertSectionDiagnostic(section.diagnostic);
   if(Object.hasOwn(section,'previous')){const previous=section.previous;if(Object.hasOwn(previous,'sections')||Object.hasOwn(previous,'design'))throw new Error('世界分区快照必须独立');assertWorldVersion(previous);if(previous.endFloor>v.endFloor||previous.entries.some(entry=>entry.kind!==kind))throw new Error('世界分区快照归属无效');}
  }
 }
 return copy(v);
}
export function assertWorldDynamics(v){
 const retained=Object.hasOwn(v,'retained');exact(v,[...(Object.hasOwn(v,'preferences')?['preferences']:[]),...(retained?['retained']:[]),'schema','revision','config','current','versions','deleted']);
 if(retained){if(!v.retained||Object.getPrototypeOf(v.retained)!==Object.prototype)throw new Error('保留成果无效');for(const [kind,version]of Object.entries(v.retained)){if(!Object.hasOwn(WORLD_TASKS,kind)&&kind!=='custom')throw new Error('保留栏目无效');assertWorldVersion(version);if(version.entries.some(e=>e.kind!==kind))throw new Error('保留成果归属无效');}}if(v.schema!==1||!integer(v.revision)||!Array.isArray(v.versions)||!Array.isArray(v.deleted))throw new Error('世界动态数据无效');
 if(Object.hasOwn(v,'preferences'))assertWorldPreferences(v.preferences);if(v.config!==null)assertWorldConfig(v.config);if(v.current!==null)assertWorldVersion(v.current);for(const version of v.versions)assertWorldVersion(version);
 for(const entry of v.deleted){exact(entry,['kind','text']);if(!Object.hasOwn(WORLD_KINDS,entry.kind)||!text(entry.text))throw new Error('放弃记录无效');}return {...copy(v),retained:copy(v.retained??{})};
}
export const worldDynamicsOf=root=>Object.hasOwn(root,'worldDynamics')?assertWorldDynamics(root.worldDynamics):emptyWorldDynamics();
export function retainWorldVersions(versions,endFloor){const lower=Math.max(0,endFloor-99),inside=versions.filter(v=>v.endFloor>=lower&&v.endFloor<=endFloor);return copy(inside.length?inside:versions.filter(v=>v.endFloor<=endFloor).slice(-1));}
export function inheritWorldDynamics(value,floor){const domain=assertWorldDynamics(value),versions=retainWorldVersions(domain.versions.filter(v=>v.endFloor<floor),floor-1),current=domain.current?.endFloor<floor?domain.current:versions.at(-1)??null;return {...domain,revision:0,current:copy(current),versions,deleted:[],retained:current?Object.fromEntries(Object.entries(domain.retained).filter(([,v])=>v.endFloor<floor&&v.endFloor<=current.endFloor)):{}};}
