import {FEATURES,defaultControls,defaultChatControls,effectiveControls} from '../domain/controls/model.js';
import {sameTarget} from '../domain/memory/repository.js';
export function createControlSession({settings,repository,prepareTarget}={}){
 let disposed=false,sequence=0,pending=null,writing=null,target=null,globalSnapshot=null,chatSnapshot=null;
 let state={status:'loading',busy:null,error:'',controls:defaultControls(),chat:defaultChatControls()};
 let policy=effectiveControls({...defaultControls(),enabled:false}),epochs=Object.fromEntries(['enabled',...FEATURES].map(key=>[key,0]));
 const listeners=new Set(),queued=new Set(),unconfirmedKeys=new Set();
 const current=()=>{try{return !!target&&sameTarget(target,repository.captureTarget());}catch{return false;}};
 function publish(){
  const confirmed=globalSnapshot?.controls??defaultControls(),chatConfirmed=chatSnapshot?.controls??defaultChatControls();
  const controls={enabled:state.controls.enabled&&confirmed.enabled&&!unconfirmedKeys.has('enabled'),features:Object.fromEntries(FEATURES.map(key=>[key,state.controls.features[key]&&confirmed.features[key]&&!unconfirmedKeys.has(key)]))};
  const chat={enabled:state.chat.enabled&&chatConfirmed.enabled&&!unconfirmedKeys.has('chat')};
  const next=effectiveControls(state.status==='ready'?controls:{...controls,enabled:false},chat);
  for(const key of ['enabled',...FEATURES])if(next[key]!==policy[key])epochs[key]++;
  policy=next;
  for(const fn of [...listeners])try{fn(inspect());}catch{/* Consumers cannot break persistence. */}
 }
 function inspect(){return structuredClone({...state,policy:current()?policy:effectiveControls({...defaultControls(),enabled:false})});}
 function syncGlobal(){
  if(disposed||writing||state.busy||state.status!=='ready')return;
  try{globalSnapshot=settings.captureControls();state.controls=structuredClone(globalSnapshot.controls);publish();}
  catch{state.status='unconfirmed';state.error='设置尚未确认，请重新读取';publish();}
 }
 const unsubscribe=settings.subscribe(notice=>{if(notice?.confirmed===false)return;syncGlobal();});
 async function refresh({fresh=false}={}){
  if(disposed||writing||state.busy)return false;
  const serial=++sequence;state.status='loading';state.error='';publish();
  try{
   if(fresh)await settings.read();else await settings.ensure();
   const nextTarget=prepareTarget?await prepareTarget():repository.captureTarget();
   const nextChat=await repository.captureControls(nextTarget);
   if(disposed||serial!==sequence||!sameTarget(nextTarget,repository.captureTarget()))return false;
   target=nextTarget;globalSnapshot=settings.captureControls();chatSnapshot=nextChat;
   state={status:'ready',busy:null,error:'',controls:structuredClone(globalSnapshot.controls),chat:structuredClone(chatSnapshot.controls)};publish();return true;
  }catch(error){if(!disposed&&serial===sequence){state.status='unconfirmed';state.error=error.message;publish();}return false;}
 }
 function toggle(key){
  if(disposed||state.status!=='ready'||!current()||!['enabled','chat',...FEATURES].includes(key))return Promise.resolve(false);
  if(key==='chat')state.chat.enabled=!state.chat.enabled;
  else if(key==='enabled')state.controls.enabled=!state.controls.enabled;
  else state.controls.features[key]=!state.controls.features[key];
  queued.add(key);unconfirmedKeys.add(key);state.error='';publish();
  if(writing)return writing;
  const job=flush();writing=job;job.finally(()=>{if(writing===job)writing=null;});return job;
 }
 async function flush(){
  const serial=sequence,valid=()=>!disposed&&serial===sequence&&current();
  try{
   while(queued.size&&valid()){
    const key=queued.values().next().value,isChat=key==='chat';
    const keys=[...queued].filter(item=>(item==='chat')===isChat);
    for(const item of keys)queued.delete(item);
    const draft=structuredClone(isChat?state.chat:state.controls);state.busy=key;publish();
    if(isChat){
     const result=await repository.updateControls(target,chatSnapshot,draft,{isCurrent:valid});
     if(!valid())return false;chatSnapshot=result.selection;
    }else{
     const result=await settings.saveControls(draft,{expectedEpoch:globalSnapshot.epoch,isCurrent:valid});
     if(!valid())return false;if(result.status!=='committed')throw new Error('功能设置保存尚未确认');globalSnapshot=settings.captureControls();
    }
    for(const item of keys)if(!queued.has(item))unconfirmedKeys.delete(item);
    state.busy=queued.size?queued.values().next().value:null;publish();
   }
   return valid();
  }catch(error){
   if(valid()){
    queued.clear();unconfirmedKeys.clear();
    state={...state,status:'unconfirmed',busy:null,error:error.message,controls:structuredClone(globalSnapshot.controls),chat:structuredClone(chatSnapshot.controls)};publish();
   }
   return false;
  }
 }

 return {
  inspect,refresh:()=>refresh({fresh:true}),
  ensure(){if(state.status==='ready'&&current())return Promise.resolve(true);if(pending)return pending;const job=refresh();pending=job;job.finally(()=>{if(pending===job)pending=null;});return job;},
  toggle,
  allowed(key){return !disposed&&current()&&state.status==='ready'&&policy[key]===true;},
  capture(key){return {key,epoch:epochs[key],target:target&&structuredClone(target)};},
  matches(snapshot){return !!snapshot&&this.allowed(snapshot.key)&&snapshot.epoch===epochs[snapshot.key]&&sameTarget(snapshot.target,target);},
  invalidate(){sequence++;pending=null;writing=null;queued.clear();unconfirmedKeys.clear();target=null;state.status='loading';state.busy=null;publish();},
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  dispose(){disposed=true;sequence++;unsubscribe();listeners.clear();},
 };
}
