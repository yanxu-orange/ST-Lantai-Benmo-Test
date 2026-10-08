import {createWorkshopExamples,reviseWorkshopExamples} from '../domain/workshop/examples.js';
import {allocateCaptureTag,validateModule} from '../domain/workshop/model.js';
import {visibleResults,resultText,editResult,deleteResult} from '../domain/workshop/results.js';
import {sameTarget} from '../domain/memory/repository.js';
export function createWorkshopController({repository,settings,target,runtime,ensureRegex,getCharacterName,onProgress,onMemory,onTime,onSettings,onClose}={}) {
  let disposed=false,globalSnapshot,chatSnapshot,binding,busy=0,warning='',writeFailure=null,tail=Promise.resolve(),generation=0,operationGeneration=0;
  const enabledIntents=new Map(),toggleTasks=new Map(),deleting=new Set(),saving=new Set();
  const current=()=>!disposed&&operationGeneration===generation&&sameTarget(target,repository.captureTarget());
  async function loadNow({refresh=false}={}){
    if(!current())throw new Error('聊天已变化，请重新打开工坊');
    warning='';onProgress?.('正在读取工坊设置…');
    if(refresh||!settings.ensure)await settings.read();else await settings.ensure();
    if(!current())throw new Error('工坊已关闭或聊天已变化');
    onProgress?.('正在准备工坊显示规则…');
    if(ensureRegex){try{await ensureRegex({settingsReady:true});}catch(error){warning='正则自动安装未完成：'+error.message;}}
    if(!current())throw new Error('工坊已关闭或聊天已变化');
    globalSnapshot=settings.captureWorkshop();chatSnapshot=await repository.captureWorkshop(target);
    const dropGlobal=new Set(),dropChat=new Set();
    for(const globalModule of globalSnapshot.workshop.modules){
      const chatModule=chatSnapshot.workshop.modules.find(m=>m.id===globalModule.id);if(!chatModule)continue;
      const globalVersion=globalModule.moveVersion??0,chatVersion=chatModule.moveVersion??0;
      if(globalVersion===chatVersion)throw new Error('模块作用范围冲突，原始数据已保留');
      if(globalVersion>chatVersion)dropChat.add(globalModule.id);else dropGlobal.add(globalModule.id);
    }
    if(dropChat.size)await commitChat({...chatSnapshot.workshop,modules:chatSnapshot.workshop.modules.filter(m=>!dropChat.has(m.id))});
    if(dropGlobal.size)await commitGlobal({...globalSnapshot.workshop,modules:globalSnapshot.workshop.modules.filter(m=>!dropGlobal.has(m.id))});
    if(!current())throw new Error('工坊已关闭或聊天已变化');
    onProgress?.('正在同步已收集的内容…');
    await runtime?.request();
    chatSnapshot=await repository.captureWorkshop(target);
    binding=(await repository.read(target)).binding;
    if(!current())throw new Error('工坊已关闭或聊天已变化');
    onProgress?.('正在准备工坊页面…');
    if(!chatSnapshot.workshop.imports.includes('examples-v3')&&chatSnapshot.workshop.modules.some(row=>row.example)){
      const revisedChat=reviseWorkshopExamples(chatSnapshot.workshop.modules);
      await commitChat({...chatSnapshot.workshop,modules:revisedChat,imports:[...chatSnapshot.workshop.imports,'examples-v3']});
    }
    if(!globalSnapshot.workshop.imports.includes('examples-v3')){
      let seeded=structuredClone(globalSnapshot.workshop);
      const initialized=seeded.imports.includes('examples-v1');
      if(initialized)seeded.modules=reviseWorkshopExamples(seeded.modules);
      for(const example of createWorkshopExamples()){
        if(initialized&&example.id!=='lantai-example-injection')continue;
        if([...seeded.modules,...chatSnapshot.workshop.modules].some(row=>row.id===example.id))continue;
        if(example.lifecycle!=='prompt'){const allocation=allocateCaptureTag(seeded,'global');seeded=allocation.workshop;example.captureTag=allocation.tag;}
        seeded.modules.push(example);
      }
      if(!initialized)seeded.imports.push('examples-v1');
      seeded.imports.push('examples-v3');await commitGlobal(seeded);
    }
    if(!current())throw new Error('聊天已变化，请重新打开工坊');
    return snapshot();
  }
  function snapshot(){
    const globals=globalSnapshot.workshop.modules.filter(module=>module.scope==='global'||module.scope==='character'&&module.characterKey===binding?.owner);
    const visible=new Map([...globals,...chatSnapshot.workshop.modules].map(module=>[module.id,module]));
    const modules=[...visible.values()].sort((a,b)=>Number(!!b.example)-Number(!!a.example)).map(module=>({...structuredClone(module),kind:module.lifecycle,...(enabledIntents.has(module.id)?{enabled:enabledIntents.get(module.id)}:{})}));
    const results=Object.fromEntries(modules.map(module=>[module.id,(module.lifecycle==='sync'?visibleResults(chatSnapshot.workshop.results,module.id).slice(-3).reverse():visibleResults(chatSnapshot.workshop.results,module.id)).map(row=>({...row,text:resultText(row),edited:row.manualValue!==null}))]));
    return {modules,results,warning,pendingIds:[...toggleTasks.keys()],deletingIds:[...deleting],writeBlocked:!!writeFailure,characterName:getCharacterName?.(binding)??'当前角色',canUseCharacter:binding?.kind==='character'};
  }
  async function commitGlobal(value,options={}){
    const result=await settings.saveWorkshop(value,{...options,expectedEpoch:globalSnapshot.epoch,isCurrent:current});
    if(result.status!=='committed')throw new Error('模块保存尚未确认');
    globalSnapshot=settings.captureWorkshop();
  }
  async function commitChat(value,options={}){
    const result=await repository.updateWorkshop(target,chatSnapshot,value,{...options,isCurrent:current});
    chatSnapshot=result.selection;
  }
  function exclusive(action,{reconcile=false}={}){
    busy++;const queuedGeneration=generation;
    const work=tail.then(async()=>{
      if(queuedGeneration!==generation)throw new Error('聊天已重新读取，请重新读取工坊');
      operationGeneration=queuedGeneration;
      if(!current())throw new Error('工坊已关闭或聊天已变化');
      if(writeFailure&&!reconcile)throw writeFailure;
      try{
        await action();
        if(!current())throw new Error('工坊已关闭或聊天已变化');
        return snapshot();
      }catch(error){writeFailure=error;throw error;}
    }).finally(()=>{busy--;});
    tail=work.catch(()=>{});
    return work;
  }
  function load(options={}){return exclusive(async()=>{
    if(options.refresh){enabledIntents.clear();deleting.clear();}
    await loadNow(options);
    if(options.refresh)writeFailure=null;
  },{reconcile:options.refresh===true});}
  function toggle(id,enabled){
    if(!current()||writeFailure||deleting.has(id)||saving.has(id))return Promise.reject(writeFailure??new Error('模块当前无法修改，请重新读取'));
    const module=snapshot().modules.find(row=>row.id===id);
    if(!module)return Promise.reject(new Error('模块已不存在'));
    enabledIntents.set(id,typeof enabled==='boolean'?enabled:!module.enabled);
    if(toggleTasks.has(id))return toggleTasks.get(id);
    const work=exclusive(async()=>{
      while(current()&&enabledIntents.has(id)&&!deleting.has(id)){
        const desired=enabledIntents.get(id);
        const module=[...globalSnapshot.workshop.modules,...chatSnapshot.workshop.modules].find(row=>row.id===id);
        if(!module)throw new Error('模块已不存在');
        if(module.enabled!==desired){
          const store=structuredClone(module.scope==='chat'?chatSnapshot.workshop:globalSnapshot.workshop);
          store.modules.find(row=>row.id===id).enabled=desired;
          if(module.scope==='chat')await commitChat(store);else await commitGlobal(store);
        }
        // Keep a newer explicit intent; never invert the just-saved value.
        if(enabledIntents.get(id)===desired)enabledIntents.delete(id);
      }
    }).finally(()=>{toggleTasks.delete(id);});
    toggleTasks.set(id,work);
    return work;
  }
  function prepareModule(draft){
    const all=[...globalSnapshot.workshop.modules,...chatSnapshot.workshop.modules];
    const old=all.find(module=>module.id===draft.id);
    const destination=draft.scope==='chat'?'chat':'global';
    let store=structuredClone(destination==='chat'?chatSnapshot.workshop:globalSnapshot.workshop);
    const lifecycle=draft.kind??draft.lifecycle;
    let captureTag=old?.captureTag??null;
    if(lifecycle!=='prompt'&&(!captureTag||old?.scope!==draft.scope)){const allocation=allocateCaptureTag(store,draft.scope);captureTag=allocation.tag;store=allocation.workshop;}
    const module=validateModule({id:old?.id??draft.id??crypto.randomUUID(),name:draft.name,content:draft.content,scope:draft.scope,role:draft.role,depth:Number(draft.depth),enabled:draft.enabled,lifecycle,captureTag:lifecycle==='prompt'?null:captureTag,
      ...(old?.example?{example:true}:{}),
      moveVersion:(old?.moveVersion??0)+(old&&((old.scope==='chat')!==(draft.scope==='chat'))?1:0),
      ...(old?.captureTag&&old.captureTag!==captureTag?{captureAliases:[...(old.captureAliases??[]),{tag:old.captureTag,rootId:target.rootId}]}:old?.captureAliases?{captureAliases:old.captureAliases}:{}),
      ...(draft.scope==='character'?{characterKey:binding?.kind==='character'?binding.owner:null}:{})});
    if(destination==='chat'&&globalSnapshot.workshop.imports.includes('examples-v3')&&!store.imports.includes('examples-v3')){
      store.modules=reviseWorkshopExamples(store.modules);store.imports.push('examples-v3');
    }
    const index=store.modules.findIndex(row=>row.id===module.id);if(index<0)store.modules.push(module);else store.modules[index]=module;
    return {destination,store,module};
  }
  function saveModule(value){
    if(!current()||writeFailure||deleting.has(value.id)||saving.has(value.id))throw writeFailure??new Error('模块当前无法保存，请重新读取');
    const draft=structuredClone(value);draft.id??=crypto.randomUUID();
    prepareModule(draft); // Validate and freeze the input before entering the queue.
    saving.add(draft.id);
    return exclusive(async()=>{
      const {destination,store,module}=prepareModule(draft);
      const source=structuredClone(destination==='chat'?globalSnapshot.workshop:chatSnapshot.workshop);
      const moving=source.modules.some(row=>row.id===module.id);
      // A cross-store move confirms its destination before deleting its source.
      // Ordinary same-store edits use the host's normal lightweight persistence.
      if(destination==='chat')await commitChat(store,{requireConfirmation:moving});
      else await commitGlobal(store,{requireConfirmation:moving});
      if(moving){
        source.modules=source.modules.filter(row=>row.id!==module.id);
        if(destination==='chat')await commitGlobal(source);else await commitChat(source);
      }
    }).finally(()=>{saving.delete(draft.id);});
  }
  return {load,snapshot,saveModule,rebindTarget(next){if(next.chatId!==target.chatId||next.rootId!==target.rootId)throw new Error('聊天已变化');if(!sameTarget(target,next)){generation++;enabledIntents.clear();writeFailure=new Error('聊天已重新读取，请重新读取工坊');}target=structuredClone(next);},
    toggle,
    deleteModule(id){if(deleting.has(id))return Promise.reject(new Error('正在删除模块'));deleting.add(id);enabledIntents.delete(id);return exclusive(async()=>{const module=[...globalSnapshot.workshop.modules,...chatSnapshot.workshop.modules].find(row=>row.id===id);if(!module)throw new Error('模块已不存在');if(module){const store=structuredClone(module.scope==='chat'?chatSnapshot.workshop:globalSnapshot.workshop);store.modules=store.modules.filter(row=>row.id!==id);if(module.scope==='chat')await commitChat(store);else await commitGlobal(store);}deleting.delete(id);});},
    editResult(id,text){return exclusive(()=>commitChat({...chatSnapshot.workshop,results:editResult(chatSnapshot.workshop.results,id,text)}));},
    deleteResult(id){return exclusive(()=>commitChat({...chatSnapshot.workshop,results:deleteResult(chatSnapshot.workshop.results,id)}));},
    memory:()=>onMemory?.(),time:()=>onTime?.(),settings:()=>onSettings?.(),close:()=>onClose?.(),
    dispose(){disposed=true;enabledIntents.clear();},isBusy:()=>busy>0,
  };
}
