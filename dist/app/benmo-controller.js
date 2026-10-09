import {sameTarget} from '../domain/memory/repository.js';
import {TRACKING_FIELDS} from '../domain/tracking/model.js';
const copy=structuredClone,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createBenmoController({latestRuntime,trackingRuntime,repository,adapter,getControls}={}) {
  let summaryCache=null,trackingCache=null;
  let disposed=false,target=null,status='loading',error='',busy=null,sequence=0,loading=null,sourceProof=null,projectionProof=null;
  const listeners=new Set(),availabilityListeners=new Set();
  const current=()=>{try{return !disposed&&target&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  const master=()=>!getControls||getControls()?.allowed('enabled')===true;
  // Navigation must not build record lists or inspect full global settings.
  function availability(){
    const control=getControls?.(),info=control?.inspect?.(),active=current()&&master();
    const enabled=Object.fromEntries(['summary','item','npc'].map(key=>[key,info?.controls?.features?.[key]===true]));
    const policy={...Object.fromEntries(['summary','item','npc'].map(key=>[key,active&&control?.allowed(key)===true])),enabled:active};
    policy.benmo=policy.summary||policy.item||policy.npc;
    return {enabled,policy,status,busy,error,target:target&&copy(target)};
  }
  function snapshot(){
    const latest=latestRuntime.library(),tracked=trackingRuntime.snapshot();
    let binding=target;try{binding??=repository.captureTarget();}catch{/* Unavailable bindings own no source data. */}
    if(binding&&sameTarget(latest.target,binding))summaryCache=latest;
    if(binding&&sameTarget(tracked.target,binding))trackingCache=tracked;
    const summary=summaryCache??{records:[],missing:[],running:[],preferences:{enabled:false,recentFloors:6,prompt:latestRuntime.defaultPrompt??''}},tracking=trackingCache??{records:[],preferences:{itemsEnabled:false,npcsEnabled:false}};
    return copy({summary,tracking,...availability(),error:error||tracking.error||'',writeBlocked:!current()||!master()||status==='unconfirmed'||tracking.writeBlocked===true});
  }
  const publish=()=>{
    if(disposed)return;
    if(availabilityListeners.size)try{const value=availability();for(const fn of availabilityListeners)try{fn(copy(value));}catch{/* Navigation cannot break saved facts. */}}catch{/* Unavailable state cannot break a runtime publication. */}
    if(listeners.size)try{const value=snapshot();for(const fn of listeners)try{fn(copy(value));}catch{/* Rendering cannot break saved facts. */}}catch{/* Unavailable state cannot break a runtime publication. */}
  };
  const offLatest=latestRuntime.subscribe(publish),offTracking=trackingRuntime.subscribe(publish);
  async function load(){
    if(disposed)throw new Error('本末已关闭');if(loading)return loading;
    const ticket=sequence;status='loading';error='';publish();
    const job=(async()=>{
      const next=await adapter.prepare(),proof=adapter.captureChatSource?.(next);await latestRuntime.read();await latestRuntime.refresh();const projection=latestRuntime.captureSource?.(next);await trackingRuntime.load();
      if(disposed||ticket!==sequence||!sameTarget(next,repository.captureTarget()))throw new Error('聊天已变化，请重新打开本末');
      target=copy(next);sourceProof=proof;projectionProof=projection;status='ready';error='';publish();return snapshot();
    })().catch(failure=>{if(!disposed&&ticket===sequence){status='unconfirmed';error=failure.message;publish();}throw failure;}).finally(()=>{if(loading===job)loading=null;});
    loading=job;return job;
  }
  function writable(kind){if(!current()||!master()||status==='unconfirmed'||trackingRuntime.snapshot().writeBlocked===true)throw new Error(error||trackingRuntime.snapshot().error||'聊天已变化，请重新读取本末');if(kind&&!snapshot().policy[kind])throw new Error('该功能已关闭');}
  async function write(kind,operation){
    writable(kind);const ticket=sequence,t=copy(target);busy=kind;publish();
    try{await operation();if(disposed||ticket!==sequence||!sameTarget(t,repository.captureTarget()))throw new Error('聊天已变化，请重新读取本末');error='';return snapshot();}
    catch(failure){if(!disposed&&ticket===sequence){error=failure.message;if(failure.code==='COMMIT_UNCONFIRMED')status='unconfirmed';publish();}throw failure;}
    finally{if(!disposed&&ticket===sequence){busy=null;publish();}}
  }
  function ensure(){
    if(loading)return loading;
    // Reuse subscribed runtime state only while the exact chat source is current.
    // Adapters without a source proof keep the conservative reload path.
    if(current()&&status==='ready'&&sourceProof&&adapter.matchesChatSource?.(target,sourceProof)&&(!latestRuntime.captureSource||equal(projectionProof,latestRuntime.captureSource(target)))){
      const value=snapshot();if(!value.writeBlocked)return Promise.resolve(value);
    }
    return load();
  }
  return {snapshot,inspect:snapshot,availability,load,refresh:load,ensure,
    defaultPrompt:latestRuntime.defaultPrompt,
    defaultTrackingPrompts:trackingRuntime.defaultPrompts,
    saveTrackingPrompt(kind,prompt,options){return write(kind,()=>trackingRuntime.savePrompt(kind,prompt,options));},
    refreshAvailability:publish,
    rebindTarget(next){if(target&&(target.chatId!==next.chatId||target.rootId!==next.rootId))throw new Error('聊天已变化');sequence++;target=copy(next);loading=null;busy=null;status='unconfirmed';error='聊天已重新读取，请重新读取本末';trackingRuntime.rebindTarget?.(next);publish();},
    saveSummary(id,body,options={}){return write('summary',()=>latestRuntime.editRecord(id,body,options));},
    saveSummaryPreferences(patch){return write('summary',()=>latestRuntime.savePreferences(patch));},
    generateSummary(floor){return write('summary',async()=>{const okay=await latestRuntime.generate(floor);if(!okay){const info=latestRuntime.floorInfo(floor);if(info?.error)throw new Error(info.error);}});},
    saveRecord(kind,draft,{original}={}){
      return write(kind,async()=>{
        const existing=trackingRuntime.snapshot().records.find(row=>row.id===draft.id),before=original??existing,patch={id:draft.id};
        if(original&&!existing)throw new Error('记录已变化，请重新读取');
        for(const key of ['name','aliases','pinned',...TRACKING_FIELDS[kind]])if(Object.hasOwn(draft,key)&&(!before||!equal(draft[key],before[key])))patch[key]=copy(draft[key]);
        if(Object.hasOwn(draft,'customFields')&&(!before||!equal(draft.customFields,before.customFields??[]))){
          const originalFields=new Map((before?.customFields??[]).map(field=>[field.id,field])),currentFields=new Map((existing?.customFields??[]).map(field=>[field.id,field]));
          patch.customFields=draft.customFields.map(field=>{
            const originalField=originalFields.get(field.id),currentField=currentFields.get(field.id);
            if(originalField&&!currentField)throw new Error('自定义字段已变化，请重新读取');
            return !originalField?copy(field):{id:field.id,...Object.fromEntries(['name','requirement','value'].map(key=>[key,equal(field[key],originalField[key])?currentField[key]:field[key]]))};
          });
          for(const field of currentFields.values())if(!originalFields.has(field.id)&&!patch.customFields.some(row=>row.id===field.id))patch.customFields.push(copy(field));
        }
        await trackingRuntime.saveRecord(kind,patch);
      });
    },
    deleteRecord(kind,id){return write(kind,()=>trackingRuntime.deleteRecord(kind,id));},
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    subscribeAvailability(fn){availabilityListeners.add(fn);return()=>availabilityListeners.delete(fn);},
    dispose(){disposed=true;sequence++;offLatest();offTracking();listeners.clear();availabilityListeners.clear();},
  };
}
