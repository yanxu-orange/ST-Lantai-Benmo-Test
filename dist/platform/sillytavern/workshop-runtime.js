import {featureGate} from '../../domain/controls/gate.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {extractResults,reconcileResults} from '../../domain/workshop/results.js';
import {applicableModules,composeWorkshopPrompts} from '../../domain/workshop/prompts.js';
import {prepareWorkshopIdentities} from './workshop-identities.js';
const supported = new Set(['normal','regenerate','swipe','continue']);
const roleIds = {system:0,user:1,assistant:2};
export function createWorkshopRuntime({repository,settings,getContext,captureSource,matchesSource,getControls}={}) {
  const gates=Object.fromEntries(['prompt','collect','sync'].map(key=>[key,featureGate(getControls,key)]));
  let disposed=false,serial=0,pending=null,identityUnconfirmed=true;
  const keys=new Set(),releases=[];
  function clear(){
    serial++;const context=getContext();let okay=true;
    for(const key of keys){try{context.setExtensionPrompt(key,'',1,0,false,0);}catch{okay=false;}}
    if(okay)keys.clear();return okay;
  }
  async function collect(){
    if(disposed)return;
    const collectSerial=serial;
    const target=repository.captureTarget(),config=settings.captureWorkshop(),selection=await repository.captureWorkshop(target);
    if(disposed||serial!==collectSerial||!sameTarget(target,repository.captureTarget())||!settings.matchesWorkshop(config))return;
    const root=await repository.read(target);
    const modules=applicableModules(config.workshop,selection.workshop,root.binding?.kind==='character'?root.binding.owner:null).filter(module=>gates[module.lifecycle].allowed());
    const collectors=modules.filter(module=>module.lifecycle!=='prompt');
    if(!collectors.length)return {target,selection,config,modules};
    if(disposed||serial!==collectSerial||!sameTarget(target,repository.captureTarget())||!settings.matchesWorkshop(config))return;
    const prepared=prepareWorkshopIdentities(getContext().chat,{allowPendingLast:true});
    if(prepared.changed)identityUnconfirmed=true;
    const source=captureSource?.(target);
    const guard=()=>!disposed&&serial===collectSerial&&sameTarget(target,repository.captureTarget())&&settings.matchesWorkshop(config)&&(!matchesSource||matchesSource(target,source));
    if(!guard())return;
    const snapshots=collectors.flatMap(module=>prepared.selected.map(reply=>({moduleId:module.id,replyId:reply.replyId,floor:reply.floor,values:[module.captureTag,...(module.captureAliases??[]).filter(alias=>alias.rootId===target.rootId).map(alias=>alias.tag)].flatMap(tag=>extractResults(reply.text,tag))})));
    const next={...selection.workshop,results:reconcileResults(selection.workshop.results,snapshots,{moduleIds:collectors.map(module=>module.id)})};
    const forceSave=prepared.changed||identityUnconfirmed;
    let saved;
    try{saved=await repository.updateWorkshop(target,selection,next,{isCurrent:guard,forceSave,workshopProof:prepared.selected.map(({floor,swipeId,replyId})=>({floor,swipeId,replyId}))});}
    catch(error){identityUnconfirmed=true;throw error;}
    if(!guard())return;
    if(saved.status==='committed')identityUnconfirmed=false;
    return {target,selection:saved.selection,config,modules};
  }
  function request(){
    if(!gates.collect.allowed()&&!gates.sync.allowed()&&!gates.prompt.allowed())return Promise.resolve(null);
    const requestedSerial=serial;
    const work=(pending??Promise.resolve()).catch(()=>{}).then(()=>requestedSerial===serial?collect():null);
    pending=work;work.finally(()=>{if(pending===work)pending=null;}).catch(()=>{});return work;
  }
  async function intercept(messages,_size,_abort,type='normal'){
    if(disposed||!clear()||!supported.has(type)||messages?.some(message=>String(message?.mes??message?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
    const ticket=serial;
    try{
      const state=await request();if(!state||disposed||serial!==ticket)return;
      const {target,config,selection,modules}=state,source=captureSource?.(target);
      const valid=()=>!disposed&&serial===ticket&&sameTarget(target,repository.captureTarget())&&settings.matchesWorkshop(config)&&(!matchesSource||matchesSource(target,source));
      const latest=await repository.captureWorkshop(target);
      if(!valid()||JSON.stringify(latest.workshop)!==JSON.stringify(selection.workshop))return;
      for(const prompt of composeWorkshopPrompts(modules,selection.workshop.results)){
        if(!valid()){if(serial===ticket)clear();return;}
        const key=`lantai_benmo_workshop_${prompt.id}`;keys.add(key);
        getContext().setExtensionPrompt(key,prompt.text,1,prompt.depth,false,roleIds[prompt.role]);
        if(!valid()){if(serial===ticket)clear();return;}
      }
    }catch{if(!disposed&&serial===ticket)clear();}
  }
  const context=getContext();let timer;
  for(const name of ['MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','GENERATION_ENDED']){
    const event=context?.eventTypes?.[name],events=context?.eventSource;if(!event||!events?.on)continue;
    const listener=()=>{clear();clearTimeout(timer);timer=setTimeout(()=>request().catch(()=>{}),0);};
    events.on(event,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,event,listener));
  }
  for(const name of ['CHAT_CHANGED','CHAT_CREATED','GENERATION_STOPPED']){
    const event=context?.eventTypes?.[name],events=context?.eventSource;if(!event||!events?.on)continue;
    const listener=()=>{clearTimeout(timer);clear();};events.on(event,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,event,listener));
  }
  return {request,intercept,clear,dispose(){if(disposed)return;clear();disposed=true;clearTimeout(timer);for(const release of releases)release();}};
}
