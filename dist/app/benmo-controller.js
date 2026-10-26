import {sameTarget} from '../domain/memory/repository.js';
import {TRACKING_FIELDS} from '../domain/tracking/model.js';
const BENMO_FEATURES=['summary','item','npc','self','outline'];
const copy=structuredClone,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createBenmoController({latestRuntime,trackingRuntime,narrativeRuntime,repository,adapter,getControls,isReadOnly=()=>false,loadBudgetMs=5000,onPublication=()=>{}}={}) {
  // Page reads have their own lifetime; abandoning one never cancels a paid task or host write.
  let loadAttempt=0,cancelWait=null;
  let summaryCache=null,trackingCache=null,narrativeCache=null;
  let disposed=false,target=null,status='loading',error='',busy=null,sequence=0,loading=null,sourceProof=null,projectionProof=null,dataView=null,readOnly=false,loadingReadOnly=false,readOnlyRecovery=null;
  const listeners=new Set(),availabilityListeners=new Set();
  const current=()=>{try{return !disposed&&target&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  const browsing=()=>isReadOnly()===true;
  const master=()=>!getControls||getControls()?.allowed('enabled')===true;
  // Navigation must not build record lists or inspect full global settings.
  function availability(){
    const control=getControls?.(),info=control?.inspect?.();let navigationTarget=target;try{navigationTarget=control?.capture?.('enabled')?.target??target??repository.captureTarget();}catch{/* Unconfirmed controls cannot grant navigation. */}
    let active=false;try{active=!disposed&&master()&&!!navigationTarget&&sameTarget(navigationTarget,repository.captureTarget());}catch{/* No confirmed target. */}
    const enabled=Object.fromEntries(BENMO_FEATURES.map(key=>[key,info?.controls?.features?.[key]===true]));
    const policy={...Object.fromEntries(BENMO_FEATURES.map(key=>[key,active&&control?.allowed(key)===true&&(!['self','outline'].includes(key)||!!narrativeRuntime)])),enabled:active};
    policy.benmo=BENMO_FEATURES.some(key=>policy[key]);
    return {enabled,policy,status,dataStatus:status,busy,error,target:navigationTarget&&copy(navigationTarget)};
  }
  function snapshotWithSummary(projection,{tracking:trackingProjection,narrative:narrativeProjection,cached=false,summaryChanged=false}={}){
    const latest=projection??(cached&&!summaryChanged?summaryCache:null)??latestRuntime.library(),tracked=trackingProjection??(cached?trackingCache:null)??trackingRuntime.snapshot(),narrated=narrativeProjection??(cached&&!narrativeCache?.requestPreview?narrativeCache:null)??narrativeRuntime?.snapshot();
    let binding=target;try{binding??=repository.captureTarget();}catch{/* Unavailable bindings own no source data. */}
    if(binding&&sameTarget(latest.target,binding))summaryCache=latest;
    if(binding&&sameTarget(tracked.target,binding))trackingCache=trackingProjection?copy(tracked):tracked;
    if(binding&&narrated&&sameTarget(narrated.target,binding))narrativeCache=narrativeProjection?copy(narrated):narrated;
    const summary=summaryCache??{records:[],missing:[],running:[],preferences:{enabled:false,recentFloors:6,prompt:latestRuntime.defaultPrompt??''}},tracking=trackingCache??{records:[],preferences:{itemsEnabled:false,npcsEnabled:false}};
    const narrative=narrativeCache??{self:{},outline:{}};
    return copy({summary,tracking,narrative,narrativePreviewBlocked:!current()||!master()||status!=='ready'||(narrative.preferencesWriteBlocked??narrative.writeBlocked)===true||!sameTarget(narrative.target,binding),narrativeConfigWriteBlocked:!current()||!master()||status!=='ready'||(narrative.preferencesWriteBlocked??narrative.writeBlocked)===true||!sameTarget(narrative.target,binding),...availability(),error:error||tracking.error||narrative.error||'',writeBlocked:readOnly||browsing()||!current()||!master()||status!=='ready'||tracking.writeBlocked===true||narrative.writeBlocked===true});
  }
  const snapshot=()=>snapshotWithSummary();
  const publish=(projections,value)=>{
    if(disposed)return;
    if(availabilityListeners.size)try{const value=availability();for(const fn of availabilityListeners)try{fn(copy(value));}catch{/* Navigation cannot break saved facts. */}}catch{/* Unavailable state cannot break a runtime publication. */}
    if(listeners.size)try{const output=value??snapshotWithSummary(undefined,projections);for(const fn of listeners)try{fn(copy(output));}catch{/* Rendering cannot break saved facts. */}}catch{/* Unavailable state cannot break a runtime publication. */}
  };
  // Domain notifications already carry a snapshot for this synchronous publication.
  // Latest notifications carry inspect state instead, so its library stays a fresh read.
  const observePublication=source=>{try{onPublication(source,!loading);}catch{}};
  const offLatest=latestRuntime.subscribe(()=>{observePublication('latest');if(!loading)publish({cached:true,summaryChanged:true});}),offTracking=trackingRuntime.subscribe(tracking=>{observePublication('tracking');if(!loading)publish({tracking,cached:true});}),offNarrative=narrativeRuntime?.subscribe(narrative=>{observePublication('narrative');if(!loading)publish({narrative,cached:true});});
  async function load(){
    if(disposed)throw new Error('本末已关闭');if(loading)return loading;
    let loadTarget;const ticket=sequence,attempt=++loadAttempt;const check=()=>{if(disposed||ticket!==sequence||attempt!==loadAttempt||loadTarget&&!sameTarget(loadTarget,repository.captureTarget()))throw Object.assign(new Error('页面读取已结束，请重新读取'),{code:'PANEL_LOAD_CANCELLED'});};status='loading';error='';publish({cached:true});
    let timer;
    const work=(async()=>{
      const next=await adapter.prepare();loadTarget=copy(next);check();const proof=adapter.captureChatSource?.(next),readOnlyPass=browsing();
      loadingReadOnly=readOnlyPass;
      let readView;
      if(readOnlyPass){
        // Browsing confirmed facts does not need story collection or a stable
        // streaming tail. A fixed root view still rejects uncertain saves.
        readView=await repository.capturePanelData?.(next);
        check();await latestRuntime.read({target:next,readView});
      }else{
        // Modern runtimes coalesce their automatic initialization with this pass.
        check();if(!latestRuntime.panelReadView){await latestRuntime.read();check();}
        await (latestRuntime.ensureData?.()??latestRuntime.refresh());check();
        readView=latestRuntime.panelReadView?.()??await repository.capturePanelData?.(next);
      }
      let projection;
      do{
        check();projection=latestRuntime.captureSource?.(next);
        await trackingRuntime.load({target:next,readView,raw:projection});check();await narrativeRuntime?.load({target:next,readView});check();
        if(disposed||ticket!==sequence||!sameTarget(next,repository.captureTarget()))throw new Error('聊天已变化，请重新打开本末');
        if(!readView||repository.matchesPanelData(next,readView))break;
        // Never stamp a new proof on projections from an earlier root. Refresh
        // every domain together when a concurrent write changed the fixed view.
        readView=await repository.capturePanelData(next);check();await latestRuntime.read({target:next,readView});check();
      }while(true);
      target=copy(next);sourceProof=proof;projectionProof=projection;dataView=readView;const sourceCurrent=(!proof||adapter.matchesChatSource?.(next,proof)!==false)&&(!latestRuntime.matchesSource||latestRuntime.matchesSource(next,projection));readOnly=readOnlyPass||browsing();status=sourceCurrent||readOnly?'ready':'unconfirmed';error=sourceCurrent||readOnly?'':'来源在读取期间已变化，请重新读取本末';const value=snapshot();publish(undefined,value);return value;
    })();
    // Observe the underlying work after the UI deadline; every later domain entry checks its ticket.
    const deadline=new Promise((_,reject)=>{const end=(message,code)=>{if(attempt===loadAttempt)loadAttempt++;reject(Object.assign(new Error(message),{code}));};cancelWait=()=>end('页面读取已结束，请重新读取','PANEL_LOAD_CANCELLED');timer=setTimeout(()=>end('读取等待已超时，请重新读取','PANEL_WAIT_TIMEOUT'),loadBudgetMs);});
    const job=Promise.race([work,deadline]).catch(failure=>{if(!disposed&&ticket===sequence&&loading===job){status='unconfirmed';error=failure.message;publish();}throw failure;}).finally(()=>{clearTimeout(timer);if(loading===job){loading=null;loadingReadOnly=false;cancelWait=null;}});
    loading=job;return job;
  }
  function writable(kind){if(readOnly||browsing())throw new Error('正文生成中，只能浏览已确认的本末资料');if(!current()||!master()||status!=='ready')throw new Error(error||'聊天已变化，请重新读取本末');const tracking=trackingRuntime.writeState?.()??trackingRuntime.snapshot();if(tracking.writeBlocked)throw new Error(error||tracking.error||'聊天已变化，请重新读取本末');if(kind&&!availability().policy[kind])throw new Error('该功能已关闭');if(['self','outline'].includes(kind)){const narrative=narrativeRuntime?.writeState?.()??narrativeRuntime?.snapshot();if(narrative?.writeBlocked)throw new Error(narrative.error||'请重新读取本末');}}
  function configurable(kind){
    if(!current()||!master()||status!=='ready')throw new Error(error||'聊天已变化，请重新读取本末');
    if(kind&&!availability().policy[kind])throw new Error('该功能已关闭');
    const narrative=narrativeRuntime?.snapshot();
    if(!narrative||!sameTarget(narrative.target,target)||(narrative.preferencesWriteBlocked??narrative.writeBlocked)===true)throw new Error(narrative?.error||'请重新读取本末');
  }
  function previewable(options={}){configurable();for(const kind of options.kinds??(options.kind?[options.kind]:['self','outline']))if(!availability().policy[kind])throw new Error('该功能已关闭');}
  async function write(kind,operation,{configuration=false}={}){
    if(configuration)configurable(kind);else writable(kind);const ticket=sequence,t=copy(target);busy=kind;publish();
    try{await operation();if(disposed||ticket!==sequence||!sameTarget(t,repository.captureTarget()))throw new Error('聊天已变化，请重新读取本末');error='';return snapshot();}
    catch(failure){if(!disposed&&ticket===sequence){error=failure.message;if(failure.code==='COMMIT_UNCONFIRMED')status='unconfirmed';publish();}throw failure;}
    finally{if(!disposed&&ticket===sequence){busy=null;publish();}}
  }
  function ensure(){
    if(loading){
      if(loadingReadOnly&&!browsing()){
        if(!readOnlyRecovery){
          const owner=copy(repository.captureTarget()),ticket=sequence,previous=loading;
          const work=previous.then(()=>{
            if(disposed||ticket!==sequence||!sameTarget(owner,repository.captureTarget()))throw new Error('聊天已变化，请重新打开本末');
            return ensure();
          }).finally(()=>{if(readOnlyRecovery===work)readOnlyRecovery=null;});
          readOnlyRecovery=work;
        }
        return readOnlyRecovery;
      }
      return loading;
    }
    if(current()&&status==='ready'&&readOnly&&browsing()&&dataView&&repository.matchesPanelData(target,dataView))return Promise.resolve(snapshot());
    // Reuse subscribed runtime state only while the exact chat source is current.
    // Adapters without a source proof keep the conservative reload path.
    if(current()&&status==='ready'&&sourceProof&&typeof adapter.matchesChatSource==='function'){
      // The current runtime validates source + root and projects in one
      // synchronous pass. Its enriched source also covers the adapter proof.
      let summary=null;
      if(dataView&&projectionProof&&latestRuntime.projectPanel)summary=latestRuntime.projectPanel(dataView,{target,source:projectionProof});
      else if(latestRuntime.matchesSource?latestRuntime.matchesSource(target,projectionProof):adapter.matchesChatSource?.(target,sourceProof)&&(!latestRuntime.captureSource||equal(projectionProof,latestRuntime.captureSource(target))))summary=undefined;
      if(summary!==null){const value=snapshotWithSummary(summary);if(!value.writeBlocked)return Promise.resolve(value);}
    }
    return load();
  }
  return {snapshot,inspect:snapshot,availability,load,refresh:load,ensure,cancelLoad(){if(cancelWait){const cancel=cancelWait;loading=null;loadingReadOnly=false;cancelWait=null;status='unconfirmed';cancel();}},
    observeSummaryVisibility:options=>latestRuntime.observeVisibility?.(options)??(()=>{}),
    defaultPrompt:latestRuntime.defaultPrompt,
    defaultTrackingPrompts:trackingRuntime.defaultPrompts,
    defaultNarrativePrompts:narrativeRuntime?.defaultPrompts,
    saveNarrativePreferences(kind,patch,options){return write(kind,()=>narrativeRuntime.savePreferences(kind,patch,options),{configuration:true});},
    saveNarrativeEntries(kind,entries,options){return write(kind,()=>narrativeRuntime.saveEntries(kind,entries,options));},
    previewNarrative(options){previewable(options);return narrativeRuntime.preview(options);},
    previewNarrativeRequest(options){previewable(options);return narrativeRuntime.previewRequest(options);},
    confirmNarrativeReview(){return write(null,()=>narrativeRuntime.confirmReview());},
    startNarrative(options){return write(null,()=>narrativeRuntime.start(options));},
    saveNarrativeRunPreferences(patch){return write(null,()=>narrativeRuntime.saveRunPreferences(patch),{configuration:true});},
    pauseNarrative(){return narrativeRuntime.pause();},
    continueNarrative(){return write(null,()=>narrativeRuntime.resume());},
    retryNarrative(){return write(null,()=>narrativeRuntime.retry());},
    skipNarrative(){return write(null,()=>narrativeRuntime.skip());},
    generateNarrative(kind,options={}){const scoped={...options};delete scoped.kind;delete scoped.kinds;Object.assign(scoped,kind==='both'?{kinds:['self','outline']}:{kind});return write(kind==='both'?null:kind,()=>narrativeRuntime.start(scoped));},
    cancelNarrative(kind){return write(kind,()=>narrativeRuntime.cancel(kind));},
    saveTrackingPrompt(kind,prompt,options){return write(kind,()=>trackingRuntime.savePrompt(kind,prompt,options));},
    saveExclusionNames(kind,names,options){return write(kind,()=>trackingRuntime.saveExclusionNames(kind,names,options));},
    setRecordExcluded(kind,id,excluded){return write(kind,()=>trackingRuntime.setRecordExcluded(kind,id,excluded));},
    refreshAvailability:publish,
    rebindTarget(next){if(target&&(target.chatId!==next.chatId||target.rootId!==next.rootId))throw new Error('聊天已变化');sequence++;target=copy(next);loading=null;busy=null;status='unconfirmed';error='聊天已重新读取，请重新读取本末';trackingRuntime.rebindTarget?.(next);narrativeRuntime?.rebindTarget?.(next);publish();},
    saveSummary(id,body,options={}){return write('summary',()=>latestRuntime.editRecord(id,body,options));},
    manualSummary(floor,body,options={}){return write('summary',()=>latestRuntime.manualRecord(floor,body,options));},
    estimateSummaryBackfill(range){writable('summary');return copy(latestRuntime.estimateBackfill(range));},
    startSummaryBackfill(range){return write('summary',()=>latestRuntime.startBackfill(range));},
    stopSummaryBackfill(){
      if(!current())throw new Error('聊天已变化，请重新读取本末');
      latestRuntime.stopBackfill();publish();return snapshot();
    },
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
    dispose(){cancelWait?.();disposed=true;sequence++;offLatest();offTracking();offNarrative?.();listeners.clear();availabilityListeners.clear();},
  };
}
