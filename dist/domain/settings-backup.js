import {SETTINGS_DOMAINS,emptySettings,assertSettings,settingsDomainValue,presetCapability} from '../shared/settings/model.js';
import {emptyWorkshop,assertWorkshop,validateModule,allocateCaptureTag} from './workshop/model.js';
import {emptyNarrative,assertNarrative} from './narrative/data.js';
import {emptySummary,assertSummaryPreferences} from './summary/data.js';
import {emptyCumulative,assertCumulativePreferences} from './cumulative/data.js';
import {emptyLatest,assertLatestPreferences} from './latest/data.js';
import {emptyTracking,assertTrackingPreferences} from './tracking/data.js';
import {emptyTime} from './time/data.js';
import {emptyWorldDynamics,assertWorldConfig} from './world-dynamics/data.js';
import {assertWorldPreferences} from './world-dynamics/preferences.js';
import {assertChatControls} from './controls/model.js';
import {recognitionSettings} from './time/source.js';
const copy=structuredClone;
const fail=()=>{throw new Error('设置备份格式无效，请选择兰台导出的设置文件。');};
const object=v=>!!v&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,required,optional=[])=>{if(!object(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail();};
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value??{},k)).map(k=>[k,copy(value[k])]));
const modulesKeys=['id','name','content','lifecycle','scope','role','enabled','depth','captureTag','characterKey','generationMaterials','generationSource','syncContentVersion'];
function moduleList(rows,scopes){
 if(!Array.isArray(rows))fail();const ids=new Set();
 return rows.map(row=>{exact(row,['id','name','content','lifecycle','scope','role','enabled','depth','captureTag'],modulesKeys);const module=validateModule(row);if(!scopes.includes(module.scope)||ids.has(module.id))fail();ids.add(module.id);return module;});
}
export function portableModules(rows){return rows.map(row=>pick(row,modulesKeys));}
function workshopTemplate(rows){let value=emptyWorkshop();value.modules=copy(rows);for(const scope of ['global','character','chat']){const max=rows.reduce((n,row)=>Math.max(n,Number(new RegExp(`^${{global:'g',character:'c',chat:'h'}[scope]}([1-9]\\d*)$`).exec(row.captureTag??'')?.[1]??0)),0);value.captureCounters[scope]=max;}return assertWorkshop(value);}
export function globalSettingsBackup(root){
 const data={};for(const key of Object.keys(SETTINGS_DOMAINS)){const value=settingsDomainValue(root,key);if(value!==undefined)data[key]=key==='workshop'?{modules:portableModules(value.modules)}:copy(value);}
 return data;
}
export function appearanceSettingsBackup(root){return pick(root,['theme','roundRecordMode','workshopModes']);}
const summaryManual=['includeUser','reviewBeforeCommit','hideOriginal'],summaryAuto=['batchSize','recentFloors',...summaryManual];
const cumulativeManual=['includeUser','checkBeforeSave','hideSource'],cumulativeAuto=['batchSize',...cumulativeManual];
export function chatSettingsBackup(root){
 const data={};
 for(const key of ['latest','narrative','tracking'])if(root[key])data[key]=copy(root[key].preferences);
 if(root.controls)data.controls=copy(root.controls);
 if(root.summary)data.summary={manual:pick(root.summary.preferences.manual,summaryManual),auto:pick(root.summary.preferences.auto,summaryAuto)};
 if(root.cumulative)data.cumulative={manual:pick(root.cumulative.preferences.manual,cumulativeManual),auto:pick(root.cumulative.preferences.auto,cumulativeAuto)};
 if(root.worldDynamics)data.worldDynamics={config:copy(root.worldDynamics.config),...(root.worldDynamics.preferences?{preferences:copy(root.worldDynamics.preferences)}:{})};
 if(root.workshop)data.workshop={modules:portableModules(root.workshop.modules.filter(row=>row.scope==='chat'))};
 if(root.time)data.recognition=copy(root.time.recognition);
 return data;
}
function validateGlobal(data){
 exact(data,['ai','eventGeneration'],Object.keys(SETTINGS_DOMAINS));const root=emptySettings();root.domainRevisions={};
 for(const key of Object.keys(SETTINGS_DOMAINS))if(Object.hasOwn(data,key)){const value=key==='workshop'?workshopTemplate(moduleList(data.workshop?.modules,['global','character'])):data[key];if(key==='workshop')exact(data.workshop,['modules']);root[key]=copy(value);root.domainRevisions[key]=0;}
 assertSettings(root);for(const key of ['taskRoutes','taskRouting'])for(const route of Object.values(data.ai[key]??{}))if(route.presetId!==null&&!data.ai.presets.some(row=>row.id===route.presetId))fail();return data;
}
function validateChat(data){
 exact(data,[],['latest','narrative','tracking','controls','summary','cumulative','worldDynamics','workshop','recognition']);
 for(const[key,validate]of [['latest',assertLatestPreferences],['tracking',assertTrackingPreferences],['controls',assertChatControls]])if(Object.hasOwn(data,key))validate(data[key]);
 if(Object.hasOwn(data,'narrative')){if(!object(data.narrative))fail();assertNarrative({...emptyNarrative(),preferences:copy(data.narrative)});}
 for(const [key,base,manual,auto,validate]of [['summary',emptySummary,summaryManual,summaryAuto,assertSummaryPreferences],['cumulative',emptyCumulative,cumulativeManual,cumulativeAuto,assertCumulativePreferences]])if(Object.hasOwn(data,key)){
  exact(data[key],['manual','auto']);exact(data[key].manual,manual);exact(data[key].auto,auto);const prefs=base().preferences;validate({manual:{...prefs.manual,...data[key].manual},auto:{...prefs.auto,...data[key].auto}});
 }
 if(Object.hasOwn(data,'worldDynamics')){exact(data.worldDynamics,['config'],['preferences']);if(data.worldDynamics.config!==null)assertWorldConfig(data.worldDynamics.config);if(Object.hasOwn(data.worldDynamics,'preferences'))assertWorldPreferences(data.worldDynamics.preferences);}
 if(Object.hasOwn(data,'workshop')){exact(data.workshop,['modules']);workshopTemplate(moduleList(data.workshop.modules,['chat']));}
 if(Object.hasOwn(data,'recognition')){exact(data.recognition,['lookback','scope','groups','users','assistant']);if(!Array.isArray(data.recognition.groups)||['users','assistant'].some(key=>typeof data.recognition[key]!=='boolean'))fail();for(const group of data.recognition.groups)exact(group,['start','end']);recognitionSettings(data.recognition);}
 return data;
}
export function validateSettingsBackup(value){
 try{
  exact(value,['type','formatVersion','exportedAt','pluginVersion','globalSettings','appearance'],['chatSettings','credentials']);
  if(value.type!=='lantai-settings'||value.formatVersion!==1||typeof value.exportedAt!=='string'||!Number.isFinite(Date.parse(value.exportedAt))||typeof value.pluginVersion!=='string'||!value.pluginVersion.trim())fail();
  validateGlobal(value.globalSettings);exact(value.appearance,['theme'],['roundRecordMode','workshopModes']);
  if(typeof value.appearance.theme!=='string'||!value.appearance.theme.trim()||Object.hasOwn(value.appearance,'roundRecordMode')&&!['builtin','regex'].includes(value.appearance.roundRecordMode)||Object.hasOwn(value.appearance,'workshopModes')&&(!object(value.appearance.workshopModes)||Object.entries(value.appearance.workshopModes).some(([id,mode])=>!id||!['builtin','regex'].includes(mode))))fail();
  if(Object.hasOwn(value,'chatSettings'))validateChat(value.chatSettings);
  if(Object.hasOwn(value,'credentials')){
   if(!Array.isArray(value.credentials))fail();const root=emptySettings();root.ai=copy(value.globalSettings.ai);root.credentials=copy(value.credentials);assertSettings(root);
  }
  return copy(value);
 }catch{fail();}
}
export function makeSettingsBackup({settings,appearance,chatRoot,includeCredentials=false,pluginVersion,exportedAt=new Date().toISOString()}){
 return validateSettingsBackup({type:'lantai-settings',formatVersion:1,exportedAt,pluginVersion,globalSettings:globalSettingsBackup(settings),appearance:appearanceSettingsBackup(appearance),...(chatRoot?{chatSettings:chatSettingsBackup(chatRoot)}:{}),...(includeCredentials?{credentials:copy(settings.credentials??[])}:{})});
}
const connection=plan=>JSON.stringify([String(plan.endpoint).replace(/\/$/,''),presetCapability(plan),plan.protocol??'openai']);
const mergeById=(old,rows)=>[...old.map(row=>rows.find(next=>next.id===row.id)??row),...rows.filter(row=>!old.some(previous=>previous.id===row.id))];
function mapStableIds(incoming,current){
 const reserved=new Set(incoming.filter(row=>current.some(old=>old.id===row.id)).map(row=>row.id)),used=new Set();
 return incoming.map(original=>{const row=copy(original),old=current.find(item=>item.id===row.id)??current.find(item=>item.name===row.name&&!reserved.has(item.id)&&!used.has(item.id));if(old)row.id=old.id;if(used.has(row.id))throw new Error('备份中的设置身份关联存在冲突。');used.add(row.id);return row;});
}
function mergeModules(current,incoming,idMap,uuid){
 const value=copy(current);const rows=[];
 for(const original of incoming){
  const row=copy(original);let old=value.modules.find(item=>item.id===row.id);
  if(old&&(old.scope!==row.scope||(old.characterKey??null)!==(row.characterKey??null)||old.lifecycle!==row.lifecycle)){row.id=`restore:${original.id}:${row.scope}:${encodeURIComponent(row.characterKey??'')}:${row.lifecycle}`;idMap[original.id]=row.id;old=value.modules.find(item=>item.id===row.id);if(old&&(old.scope!==row.scope||(old.characterKey??null)!==(row.characterKey??null)||old.lifecycle!==row.lifecycle))throw new Error('工坊栏目身份冲突，请先处理同名栏目后重新导入。');}
  else idMap[original.id]=row.id;
  if(old&&row.id===old.id&&old.captureTag!==null&&row.captureTag!==null){row.captureTag=old.captureTag;for(const key of ['captureAliases','moveVersion'])if(Object.hasOwn(old,key))row[key]=copy(old[key]);}
  else if(row.lifecycle!=='prompt'){
   const duplicate=[...value.modules,...rows].some(item=>item.scope===row.scope&&(item.characterKey??null)===(row.characterKey??null)&&item.captureTag===row.captureTag);
   if(duplicate){const allocated=allocateCaptureTag({...value,modules:[...value.modules,...rows]},row.scope);value.captureCounters=allocated.workshop.captureCounters;row.captureTag=allocated.tag;}
  }
  if(rows.some(item=>item.id===row.id))throw new Error('备份中的设置身份关联存在冲突。');
  rows.push(row);
 }
 value.modules=mergeById(value.modules,rows);
 for(const scope of ['global','character','chat']){const allocated=workshopTemplate(value.modules);value.captureCounters[scope]=Math.max(value.captureCounters[scope],allocated.captureCounters[scope]);}
 return assertWorkshop(value);
}
export function planSettingsRestore(pack,{settings,appearance,chatRoot=null,uuid=()=>crypto.randomUUID()}={}){
 const backup=validateSettingsBackup(pack),global=copy(backup.globalSettings),idMap={},apiMap={},credentials=[];
 const oldAi=settings.ai,incomingAi=global.ai;
 const incoming=mapStableIds(incomingAi.presets,oldAi.presets).map((row,index)=>{
  const original=incomingAi.presets[index];apiMap[original.id]=row.id;
  const saved=backup.credentials?.find(item=>item.presetId===original.id),retained=oldAi.presets.find(item=>item.id===row.id&&connection(item)===connection(row));
  const existing=retained&&settings.credentials?.find(item=>item.presetId===retained.id);
  if(saved||existing)credentials.push({presetId:row.id,value:(saved??existing).value});return row;
 });
 global.ai={...incomingAi,presets:mergeById(oldAi.presets,incoming),activePresetId:incomingAi.activePresetId===null?null:apiMap[incomingAi.activePresetId]};
 if(new Set(global.ai.presets.map(row=>row.name)).size!==global.ai.presets.length)throw new Error('存在同名但不同连接的 API 方案，请先调整方案名称后重新导入。');
 for(const key of ['taskRoutes','taskRouting'])if(global.ai[key])for(const route of Object.values(global.ai[key]))if(route.presetId!==null)route.presetId=apiMap[route.presetId]??route.presetId;
 for(const row of settings.credentials??[])if(!incoming.some(item=>item.id===row.presetId))credentials.push(copy(row));
 if(global.workshop)global.workshop=mergeModules(settings.workshop??emptyWorkshop(),global.workshop.modules,idMap,uuid);
 let chat=null;
 if(backup.chatSettings){
  if(!chatRoot)throw new Error('请先打开要恢复设置的聊天。');
  chat=copy(backup.chatSettings);
  if(chat.workshop)chat.workshop=mergeModules(chatRoot.workshop??emptyWorkshop(),chat.workshop.modules,idMap,uuid);
  if(chat.narrative){
   const previous=chatRoot.narrative?.preferences.self.characters??[],chosen=mapStableIds(chat.narrative.self.characters,previous);
   chat.narrative.self.characters=mergeById(previous,chosen);
   try{assertNarrative({...emptyNarrative(),preferences:chat.narrative});}catch{throw new Error('角色设置与当前角色名称存在冲突，请先调整角色配置后重新导入。');}
  }
 }
 const modes={...(appearance.workshopModes??{})};for(const[id,mode]of Object.entries(backup.appearance.workshopModes??{}))if(idMap[id])modes[idMap[id]]=mode;
 const appearanceDraft={...appearanceSettingsBackup(appearance),...backup.appearance,workshopModes:modes};
 const validated=emptySettings();validated.domainRevisions={};for(const key of Object.keys(SETTINGS_DOMAINS))if(Object.hasOwn(global,key)){validated[key]=global[key];validated.domainRevisions[key]=0;}validated.credentials=credentials;assertSettings(validated);
 return {globalSettings:global,credentials,appearance:appearanceDraft,chatSettings:chat,missingCredentials:incoming.filter(row=>!credentials.some(key=>key.presetId===row.id)).map(row=>row.name)};
}
export function applyChatSettingsRestore(root,data){
 const next=copy(root),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const set=(key,value,empty,change)=>{if(value===undefined)return;const current=copy(root[key]??empty()),draft=change(current,value);if(!same(draft,current))draft.revision=current.revision+1;next[key]=draft;};
 for(const[key,empty]of [['summary',emptySummary],['cumulative',emptyCumulative]])set(key,data[key],empty,(current,value)=>({...current,preferences:{manual:{...current.preferences.manual,...value.manual},auto:{...current.preferences.auto,...value.auto}}}));
 for(const[key,empty]of [['latest',emptyLatest],['narrative',emptyNarrative],['tracking',emptyTracking]])set(key,data[key],empty,(current,value)=>({...current,preferences:copy(value)}));
 set('worldDynamics',data.worldDynamics,emptyWorldDynamics,(current,value)=>({...current,config:copy(value.config),...(value.preferences?{preferences:copy(value.preferences)}:{})}));
 set('workshop',data.workshop,emptyWorkshop,(current,value)=>({...current,modules:copy(value.modules),captureCounters:copy(value.captureCounters)}));
 set('time',data.recognition,emptyTime,(current,value)=>({...current,recognition:copy(value)}));
 if(data.controls)next.controls=copy(data.controls);
 return next;
}

