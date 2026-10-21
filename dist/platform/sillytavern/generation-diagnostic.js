// Diagnostic-only, in-memory and closed-schema. Never retain event objects,
// input values, task payloads, prompts, URLs, errors or credentials.
const TYPES = new Set(['normal','regenerate','swipe','quiet','continue','impersonate']);
const ACTIONS = new Set(['api-save','api-test','api-models','task-api-save','summary-regenerate','summary-open','summary-prompt-save','memory-save','memory-mode-change','memory-time-change','settings-change','panel-click','host-regenerate','host-swipe-left','host-swipe-right','host-send','export']);
const KEYS = new Set(['Enter','ArrowLeft','ArrowRight','Escape','Tab']);
const GROUPS = new Set(['summary','event','cumulative','latest','tracking','workshop','self','outline','narrative','api-test']);
const safe = fn => { try { return fn(); } catch { return undefined; } };
export function createGenerationDiagnostic({clock=()=>Date.now(),limit=300}={}) {
  const cap=Number.isSafeInteger(limit)&&limit>0?Math.min(limit,300):300;
  let rows=[],sequence=0,requestSequence=0,active=0,enabled=false,epoch=0,lastAction=null,lastKey=null,releases=[];
  const panelReleases=new Set();
  function record(kind,fields={}) {
    return safe(()=>{if(!enabled)return;const at=clock();const row={sequence:++sequence,time:Number.isFinite(at)?at:null,kind,...fields,activeRequests:active};rows.push(row);if(rows.length>cap)rows.shift();return row.sequence;});
  }
  function action(value) { if(!ACTIONS.has(value))return; const id=record('ui-action',{action:value});if(id)lastAction=id; }
  function key(value,scope,modified=false) {if(!KEYS.has(value))return;const id=record('key',{key:value,scope:scope==='lantai'?'lantai':'host',modified:modified===true});if(id)lastKey=id;}
  function generation(type,dryRun=false) {record('generation-start',{type:TYPES.has(type)?type:type===undefined?'normal-default':'other',dryRun:dryRun===true,lastAction,lastKey});}
  function request(route,group) {
    if(!enabled)return ()=>{};
    const ticket=epoch,id=++requestSequence;active++;record('request-start',{request:id,route:route==='raw'?'raw':'independent',group:GROUPS.has(group)?group:'other',lastAction,lastKey});
    let finished=false;
    return status=>safe(()=>{if(finished||ticket!==epoch)return;finished=true;active=Math.max(0,active-1);record('request-end',{request:id,status:['success','cancelled','failed'].includes(status)?status:'failed'});});
  }
  function observe(event,panelScope=false) {safe(()=>{
    const path=event.composedPath?.()??[event.target];
    const lantai=panelScope||path.some(node=>node?.id==='lantai-benmo-panel');
    if(event.type==='keydown') {key(event.key,lantai?'lantai':'host',!!(event.ctrlKey||event.altKey||event.metaKey||event.shiftKey));return;}
    const nodes=path.filter(node=>typeof node?.getAttribute==='function');
    if(!lantai){if(event.type!=='click')return;for(const node of nodes){const id=node.id;if(id==='option_regenerate'){action('host-regenerate');return;}if(id==='send_but'){action('host-send');return;}if(node.classList?.contains('swipe_left')){action('host-swipe-left');return;}if(node.classList?.contains('swipe_right')){action('host-swipe-right');return;}}return;}
    if(event.type==='submit'){if(nodes.some(n=>n.getAttribute('data-ss-form')==='prompt'))action('summary-prompt-save');else if(nodes.some(n=>n.id==='lt-editor'))action('memory-save');return;}
    if(event.type==='change'){const target=nodes[0];if(['startTime','endTime'].includes(target?.getAttribute('data-field')))action('memory-time-change');else if(target?.getAttribute('name')==='mode')action('memory-mode-change');else action('settings-change');return;}
    if(event.type!=='click')return;
    for(const node of nodes){
      const api=node.getAttribute('data-api-action');
      if(['save','save-as'].includes(api)){action('api-save');return;}
      if(api==='test'){action('api-test');return;}
      if(api==='fetch-models'||node.hasAttribute('data-task-api-fetch')){action('api-models');return;}
      if(node.getAttribute('data-task-api-action')==='save'){action('task-api-save');return;}
      if(node.hasAttribute('data-summary-regenerate')||node.getAttribute('data-action')==='regenerate-batch'){action('summary-regenerate');return;}
      if(node.getAttribute('data-action')==='summary-manual'){action('summary-open');return;}
      if(node.getAttribute('data-action')==='save'){action('memory-save');return;}
      if(['bulk-resident','bulk-trigger'].includes(node.getAttribute('data-action'))){action('memory-mode-change');return;}
      if(node.getAttribute('data-settings-action')==='generation-diagnostic'){action('export');return;}
    }
    action('panel-click');
  });}
  function bindPanel(shadow){
    const listener=event=>observe(event,true);let done=false;
    const release=()=>{if(done)return;done=true;for(const type of ['change','submit'])safe(()=>shadow?.removeEventListener(type,listener,true));panelReleases.delete(release);};
    panelReleases.add(release);for(const type of ['change','submit'])safe(()=>shadow?.addEventListener(type,listener,true));return release;
  }
  function dispose(){enabled=false;epoch++;active=0;const off=releases;releases=[];for(const release of off)safe(release);for(const release of [...panelReleases])safe(release);}
  function bind({document:doc,context}={}) {dispose();enabled=true;lastAction=null;lastKey=null;
    safe(()=>{for(const type of ['click','keydown']){doc?.addEventListener(type,observe,true);releases.push(()=>doc?.removeEventListener(type,observe,true));}});
    const source=context?.eventSource,types=context?.eventTypes;
    for(const [name,listener] of [['GENERATION_STARTED',(type,_options,dryRun)=>safe(()=>generation(type,dryRun))],['GENERATION_ENDED',()=>record('generation-ended')],['GENERATION_STOPPED',()=>record('generation-stopped')]]){
      safe(()=>{const type=types?.[name];if(!type||typeof source?.on!=='function'||typeof(source.off??source.removeListener)!=='function')return;source.on(type,listener);releases.push(()=>(source.off??source.removeListener)?.call(source,type,listener));});
    }
    record('diagnostic-bound');const bindingEpoch=epoch;return ()=>{if(epoch===bindingEpoch)dispose();};
  }
  function snapshot(){return {schema:'lantai-generation-diagnostic-v1',storage:'memory-only-cleared-on-refresh',limit:cap,events:rows.map(row=>({...row}))};}
  function download(doc=globalThis.document,urlApi=globalThis.URL,BlobType=globalThis.Blob){return safe(()=>{
    const blob=new BlobType([JSON.stringify(snapshot(),null,2)],{type:'application/json'}),url=urlApi.createObjectURL(blob);let anchor;
    try{anchor=doc.createElement('a');anchor.href=url;anchor.download='lantai-generation-diagnostic.json';anchor.hidden=true;doc.body.append(anchor);anchor.click();}
    finally{anchor?.remove();setTimeout(()=>safe(()=>urlApi.revokeObjectURL(url)),1000);}
    return true;
  })===true;}
  return Object.freeze({bind,bindPanel,dispose,action,key,generation,request,snapshot,download});
}
export const generationDiagnostic=createGenerationDiagnostic();
// These boundaries fail closed for recording, never for the business request.
export const beginGenerationRequest=(route,group)=>safe(()=>generationDiagnostic.request(route,group))??(()=>{});
export const bindGenerationDiagnostic=options=>safe(()=>generationDiagnostic.bind(options))??(()=>{});
export const downloadGenerationDiagnostic=(doc)=>generationDiagnostic.download(doc);

export const bindGenerationDiagnosticPanel=shadow=>safe(()=>generationDiagnostic.bindPanel(shadow))??(()=>{});
