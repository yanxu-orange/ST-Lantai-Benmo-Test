import {emptyRoot,assertRoot} from '../../domain/memory/model.js';
import {emptySettings,assertSettings,SETTINGS_KEY} from '../../shared/settings/model.js';
import {defaultControls} from '../../domain/controls/model.js';
import {emptyWorkshop,assertWorkshop,validateModule,allocateCaptureTag} from '../../domain/workshop/model.js';
import {emptyLatest,assertLatest} from '../../domain/latest/data.js';
import {prepareLatestSource,storedLatestSource} from '../../domain/latest/source.js';
import {assertRawSummarySource} from '../../domain/summary/source.js';
import {emptyTracking,addTrackingRecord,setTrackingPreferences} from '../../domain/tracking/data.js';
import {prepareWorkshopIdentities,WORKSHOP_REPLY_KEY} from './workshop-identities.js';
import {APPEARANCE_KEY,assertAppearance} from './appearance-adapter.js';
import {isTheme,DEFAULT_THEME} from '../../app/styles/theme.js';
import * as styleEntries from '../../app/styles/style-entries.js';

export const TRANSITION_SAMPLE_ID='fixed-workshop-benmo-v1';
const NAME='transition-sample',AVATAR='transition-sample.png',DATE='2026-06-01T00:00:00.000Z';
const clone=value=>structuredClone(value);
const blocked=()=>{throw new Error('切区样本仅使用固定虚构数据，已阻止此操作');};
const reply=value=>({ok:true,json:async()=>clone(value)});

// This fixture never receives the real host context or storage. Production
// adapters/controllers still run against a separate in-memory host contract.
export function createTransitionSampleFixture({assetFetch,theme=DEFAULT_THEME}={}){
 const listeners=new Map(),calls=[],slots=new Map();let disposed=false;
 const eventNames=['APP_READY','CHAT_CHANGED','CHAT_RENAMED','SETTINGS_UPDATED','MAIN_API_CHANGED','CHATCOMPLETION_MODEL_CHANGED','CHATCOMPLETION_SOURCE_CHANGED','OAI_PRESET_CHANGED_AFTER','PRESET_CHANGED','MESSAGE_EDITED','WORLD_INFO_ACTIVATED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','MESSAGE_RECEIVED','MESSAGE_SENT','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED'];
 const eventTypes=Object.fromEntries(eventNames.map(name=>[name,name]));
 const emit=name=>{for(const fn of [...(listeners.get(name)??[])])fn();};
 let global=emptyWorkshop(),chatWorkshop=emptyWorkshop();
 for(const lifecycle of ['prompt','collect','sync'])for(let i=0;i<12;i++){
  const scope=['global','character','chat'][i%3];let store=scope==='chat'?chatWorkshop:global,captureTag=null;
  if(lifecycle!=='prompt'){const next=allocateCaptureTag(store,scope);store=next.workshop;captureTag=next.tag;}
  store.modules.push(validateModule({id:`sample-${lifecycle}-${i}`,name:`虚构${{prompt:'提示词',collect:'收集',sync:'追踪'}[lifecycle]} ${i+1}：港口与街区记录`,lifecycle,scope,role:i%2?'assistant':'system',depth:i%4,enabled:i%4!==3,content:'【固定虚构样本】港口的公告栏记录了天气、航班与街区活动。这段文字只用于页面切换样本。',generationSource:'story',captureTag,...(scope==='character'?{characterKey:AVATAR}:{})}));
  if(scope==='chat')chatWorkshop=store;else global=store;
 }
 global.imports=['examples-v1','examples-v3','workshop-hide-regex-v1','workshop-statusbar-regex-v1'];chatWorkshop.imports=['examples-v3'];
 const controls=defaultControls();for(const key of Object.keys(controls.features))controls.features[key]=true;
 const defaults=emptySettings();const settings=assertSettings({...defaults,domainRevisions:{...defaults.domainRevisions,controls:0,workshop:0},controls,workshop:assertWorkshop(global)});
 const chat=Array.from({length:24},(_,floor)=>({id:`sample-message-${floor}`,mes:`【固定虚构第${floor}楼】港口居民查看公告，讨论天气和下一班渡船的出发时间。`,is_user:floor%2===0,is_system:false,send_date:`sample-date-${floor}`}));
 let serial=0;prepareWorkshopIdentities(chat,{makeId:()=>`sample-reply-${++serial}`});
 const raw=assertRawSummarySource({epoch:0,messages:chat.map((message,floor)=>({floor,identity:JSON.stringify([floor,message.id,message.send_date]),role:message.is_user?'user':'assistant',system:false,text:message.mes,date:message.send_date,swipeId:null,replyId:message.extra?.[WORKSHOP_REPLY_KEY]??null}))});
 let tracking=setTrackingPreferences(emptyTracking(),{itemsEnabled:true,npcsEnabled:true});
 for(let i=0;i<8;i++)for(const kind of ['item','npc'])tracking=addTrackingRecord(tracking,{kind,name:`虚构${kind==='item'?'物品':'居民'} ${i+1}`,...(kind==='item'?{introduction:'港口清单中用于占位的虚构物品。',location:'虚构仓库',owner:'虚构居民'}:{appearance:'穿着普通外套的虚构居民。',identity:'港口居民',relationToUser:'虚构样本中的邻居',lastAppearanceTurn:6})},{makeId:()=>`sample-${kind}-${i}`});
 const latest=emptyLatest();latest.preferences.enabled=true;
 latest.records=raw.messages.filter(row=>row.role==='assistant').map(row=>({id:`sample-summary-${row.floor}`,body:`【固定虚构摘要 ${row.floor}】港口公告与街区日常\n`+'居民在公告栏核对渡船时间，商铺整理物资，行人沿着街道前往市场。所有地点、人物和事件均为固定样本。\n'.repeat(3),sourceSnapshot:storedLatestSource(prepareLatestSource(raw,{floor:row.floor,rules:[]})),createdAt:DATE,updatedAt:DATE}));
 const root=assertRoot({...emptyRoot('transition-sample-root'),binding:{kind:'character',owner:AVATAR,name:NAME,integrity:null,lineageParent:null},workshop:assertWorkshop(chatWorkshop),latest:assertLatest(latest),tracking},{rootId:'transition-sample-root'});
 let disk={lantai_benmo_memory:root},chatDisk=clone(chat),settingsDisk={[SETTINGS_KEY]:settings,[APPEARANCE_KEY]:assertAppearance({schema:1,revision:0,theme:isTheme(theme)?theme:DEFAULT_THEME})};
 const ctx={chatId:NAME,characterId:0,groupId:null,characters:[{avatar:AVATAR,chat:NAME,name:'虚构港口居民'}],chatMetadata:clone(disk),chat:clone(chatDisk),extensionSettings:clone(settingsDisk),eventTypes,
  eventSource:{on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeListener(name,fn){listeners.get(name)?.delete(fn);}},
  getCurrentChatId:()=>NAME,getRequestHeaders:()=>({'Content-Type':'application/json'}),
  saveMetadata:async()=>{if(disposed)return blocked();disk=clone(ctx.chatMetadata);chatDisk=clone(ctx.chat);},setExtensionPrompt:(name,...values)=>slots.set(name,clone(values)),generateRaw:blocked,
 };
 const saveSettings=async()=>{if(disposed)return blocked();settingsDisk=clone(ctx.extensionSettings);emit('SETTINGS_UPDATED');};
 const allowedStyles=new Set(Object.values(styleEntries).filter(Array.isArray).flat().map(entry=>entry.url?.href).filter(Boolean));
 async function request(url,options={}){
  if(disposed)return blocked();
  if(url instanceof URL&&allowedStyles.has(url.href)){
   if(Object.keys(options).length||typeof assetFetch!=='function')return blocked();
   return assetFetch(new URL(url.href),{credentials:'same-origin',redirect:'error'});
  }
  if(typeof url!=='string'||options.method!=='POST')return blocked();
  if(url==='/api/settings/get'){calls.push('settings-read');return reply({settings:JSON.stringify({extension_settings:settingsDisk})});}
  if(url==='/api/chats/get'){
   const body=JSON.parse(options.body??'{}');if(body.file_name!==NAME||body.avatar_url!==AVATAR)return blocked();
   calls.push('sample-chat-read');return reply([{chat_metadata:disk},...chatDisk]);
  }
  return blocked();
 }
 return {id:TRANSITION_SAMPLE_ID,ctx,request,calls,
  runtimeOptions:{settingsOptions:{saveHost:saveSettings},mainIdentityOptions:{loadModule:async()=>({})},jquery:()=>({on(){},off(){}}),workshopRegexOptions:{saveHost:saveSettings,loadEngine:async()=>({SCRIPT_TYPES:{GLOBAL:0},getScriptsByType:()=>ctx.extensionSettings.regex??[],saveScriptsByType:async value=>{ctx.extensionSettings.regex=clone(value);}})}},
  appearanceOptions:{saveHost:saveSettings},
  dispose(){disposed=true;listeners.clear();slots.clear();},
 };
}
