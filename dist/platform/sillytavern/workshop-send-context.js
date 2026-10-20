import {sameTarget} from '../../domain/memory/repository.js';
import {WORKSHOP_REPLY_KEY} from './workshop-identities.js';
const supported=new Set(['normal','regenerate','swipe','continue']);
const row=message=>({message,text:message?.mes,hidden:message?.is_system===true,swipe:message?.swipe_id??0});
const matches=(saved,message)=>saved.message===message&&saved.text===message?.mes&&saved.hidden===(message?.is_system===true)&&saved.swipe===(message?.swipe_id??0);
// One foreground send and at most one completed reply. No monitor/test input,
// storage, prompt text, or cross-session history enters this receipt.
export function createWorkshopSendContext({getContext,captureTarget}){
 let generation=0,foreground=null,pending=null,bound=null;
 const clear=()=>{generation++;foreground=null;pending=null;bound=null;};
 function begin(type,{worldInfoAmbiguous=false}={}){clear();if(supported.has(type))foreground={type,generation,worldInfoBlocked:worldInfoAmbiguous};}
 function seal(type,injection,history=null){
  pending=null;bound=null;
  if(!foreground||foreground.type!==type||!supported.has(type))return false;
  const send=foreground;foreground=null;
  const chat=getContext().chat;if(!Array.isArray(chat)||!chat.length)return false;
  const tail=chat.at(-1),hasAssistant=tail?.is_user===false;
  if(type==='normal'&&hasAssistant&&tail.mes?.trim())return false;
  const floor=chat.length-(hasAssistant?1:0);
  pending={...send,target:structuredClone(captureTarget()),floor,prefix:chat.slice(0,floor).map(row),tail:hasAssistant?tail:null,injection,history};return true;
 }
 function receive({floor,message,type,target}){
  const p=pending;
  try{
   const chat=getContext().chat;
   if(!p||p.generation!==generation||p.type!==type||floor!==p.floor||!sameTarget(p.target,target)||!sameTarget(target,captureTarget())||chat?.[floor]!==message||chat.length!==floor+1||message?.is_user!==false||message.is_system||typeof message.mes!=='string'||!message.mes.trim()||p.prefix.some((r,i)=>!matches(r,chat[i]))||p.type==='continue'&&p.tail!==message)return false;
   pending=null;bound={...p,message,reply:row(message)};return true;
  }catch{return false;}
 }
 function boundFor(source){
  const b=bound,chat=getContext().chat,message=chat?.[source.assistantFloor];
  if(!b||b.generation!==generation||!sameTarget(b.target,captureTarget())||b.floor!==source.assistantFloor||!matches(b.reply,message)||message?.extra?.[WORKSHOP_REPLY_KEY]!==source.replyId||b.prefix.some((r,i)=>!matches(r,chat[i])))return null;
  return b;
 }
 function capture(source){
  try{
   const b=boundFor(source);if(!b?.injection?.isCurrent())return {status:'unavailable',memories:[]};
   const memories=structuredClone(b.injection.memories);return {status:memories.length?'matched':'matched-empty',memories};
  }catch{return {status:'unavailable',memories:[]};}
 }
 function observeWorldInfo(entries){
  try{
   const p=pending,chat=getContext().chat;
   if(!p||p.worldInfoBlocked||p.worldInfoClosed||p.generation!==generation||!sameTarget(p.target,captureTarget())||p.prefix.some((r,i)=>!matches(r,chat[i]))||!Array.isArray(entries))return false;
   // A second activation cannot be assigned confidently to this sealed send.
   if(p.worldInfo!==undefined){p.worldInfo={status:'unavailable',entries:[]};return false;}
   const content=entries.flatMap(entry=>typeof entry?.content==='string'&&entry.content.trim()?[{content:entry.content}]:[]);
   p.worldInfo={status:content.length?'available':'unavailable',entries:content};return true;
  }catch{return false;}
 }
 function closeWorldInfoWindow(){for(const owner of [foreground,pending])if(owner)owner.worldInfoClosed=true;}
 function blockWorldInfo(){for(const owner of [foreground,pending,bound])if(owner){owner.worldInfoBlocked=true;owner.worldInfo={status:'unavailable',entries:[]};}}
 function captureWorldInfo(source){
  try{return structuredClone(boundFor(source)?.worldInfo??{status:'unavailable',entries:[]});}catch{return {status:'unavailable',entries:[]};}
 }
 function captureHistory(source){
  try{const b=boundFor(source);return b?.history?.isCurrent()?b.history:null;}catch{return null;}
 }
 return Object.freeze({begin,seal,receive,capture,captureWorldInfo,observeWorldInfo,blockWorldInfo,closeWorldInfoWindow,captureHistory,clear,replace(){pending=null;bound=null;}});
}
