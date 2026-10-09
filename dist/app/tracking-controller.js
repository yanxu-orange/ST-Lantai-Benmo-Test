import {TRACKING_FIELDS,TRACKING_KINDS} from '../domain/tracking/model.js';

// A kind-local UI adapter. The runtime owns persistence and the captured chat.
export function createTrackingController({runtime,kind}={}) {
  if(!runtime||!TRACKING_KINDS.includes(kind))throw new Error('追踪页面类型无效');
  const preferenceKey=kind==='item'?'itemsEnabled':'npcsEnabled';
  const editable=['name','aliases','pinned',...TRACKING_FIELDS[kind]];
  let value=runtime.snapshot(),failure=null,disposed=false;
  const listeners=new Set();
  const sameBinding=(a,b)=>!!a&&!!b&&a.chatId===b.chatId&&a.rootId===b.rootId&&a.epoch===b.epoch;
  const current=()=>!disposed&&(!runtime.isCurrent||runtime.isCurrent()===true)&&sameBinding(value?.target,runtime.snapshot()?.target);
  const message=error=>error?.message??(typeof error==='string'?error:'');
  function apply(next){value=structuredClone(next??runtime.snapshot());return snapshot();}
  function snapshot(){
    const latest=runtime.snapshot();
    return {records:structuredClone(value?.records??[]).filter(row=>row.kind===kind),
      exclusions:structuredClone(value?.exclusions?.[kind]??{names:[],ids:[]}),
      enabled:value?.preferences?.[preferenceKey]===true,
      writeBlocked:!!failure||!!latest?.writeBlocked||!!latest?.readOnly||!current(),
      error:message(failure)||message(latest?.error)||message(value?.error),target:structuredClone(value?.target)};
  }
  function assertCurrent(){if(!current())throw new Error('聊天已变化，请重新打开追踪');}
  function assertWritable(){
    assertCurrent();
    const latest=runtime.snapshot();
    if(failure||latest?.writeBlocked||latest?.readOnly)throw failure??new Error(message(latest?.error)||'追踪资料当前无法修改，请重新读取');
    return latest;
  }
  async function write(action){
    assertWritable();
    try{const next=await action();assertCurrent();return apply(next);}
    catch(error){failure=error;throw error;}
  }
  const unsubscribe=runtime.subscribe?.(next=>{
    if(disposed)return;
    if(sameBinding(value?.target,next?.target))value=structuredClone(next);
    for(const listener of listeners)try{listener(snapshot());}catch{/* A view cannot interrupt persistence. */}
  });
  return {
    kind,
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    snapshot,
    async load(options={}){
      assertCurrent();
      if(failure&&options.refresh!==true)throw failure;
      try{const next=await runtime.load(options);assertCurrent();failure=null;return apply(next);}
      catch(error){failure=error;throw error;}
    },
    rebindTarget(next){
      if(disposed)throw new Error('追踪页面已关闭');
      if(!value?.target||value.target.chatId!==next?.chatId||value.target.rootId!==next?.rootId)throw new Error('聊天已变化');
      runtime.rebindTarget(next);value={...value,target:structuredClone(next)};
      failure=new Error('聊天已重新读取，请重新读取追踪');
    },
    saveRecord(draft,{original}={}){
      const latest=assertWritable();
      if(!draft||typeof draft.id!=='string'||!draft.id)throw new Error('追踪记录身份无效');
      if(original&&original.id!==draft.id)throw new Error('追踪记录身份不符');
      const before=original??value?.records?.find(row=>row.id===draft.id);
      if(before?.kind!==undefined&&before.kind!==kind)throw new Error('追踪记录类型不符');
      if(before&&!latest.records?.some(row=>row.id===draft.id&&row.kind===kind))throw new Error('追踪记录已变化，请重新读取');
      const patch={id:draft.id};
      // Sending only edited fields lets future background updates keep working.
      for(const key of editable)if(Object.hasOwn(draft,key)&&(!before||JSON.stringify(draft[key])!==JSON.stringify(before[key])))patch[key]=structuredClone(draft[key]);
      return write(()=>runtime.saveRecord(kind,patch));
    },
    deleteRecord(id){
      const latest=assertWritable();
      if(!value?.records?.some(row=>row.id===id&&row.kind===kind)||!latest.records?.some(row=>row.id===id&&row.kind===kind))throw new Error('追踪记录已变化，请重新读取');
      return write(()=>runtime.deleteRecord(kind,id));
    },
    saveExclusionNames(names,options){return write(()=>runtime.saveExclusionNames(kind,names,options));},
    setRecordExcluded(id,excluded){return write(()=>runtime.setRecordExcluded(kind,id,excluded));},
    savePreferences({enabled}={}){
      if(typeof enabled!=='boolean')throw new Error('追踪设置无效');
      return write(()=>runtime.savePreferences({[preferenceKey]:enabled}));
    },
    dispose(){disposed=true;unsubscribe?.();listeners.clear();},
  };
}
