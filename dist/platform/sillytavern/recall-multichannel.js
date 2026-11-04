import {AiProviderError,assertAiCurrent} from '../../shared/ai/provider.js';
import {activeEvents} from '../../domain/memory/event-model.js';

const safeCode=error=>['configuration','capability','mapping','timeout','http','cors_network','request','task_preset_missing','authentication','endpoint','rate_limit','storage'].includes(error?.code)?error.code:'transport';
// Each busy worker owns one captured input; one idle worker keeps its BM25 cache.
// API/IDB/host work stays in this caller;
// credentials, provider objects and callbacks never cross postMessage.
export function createMultichannelWorkerBuilder({Worker:WorkerClass=globalThis.Worker,vectorIndex,provider,loadTimeout=5000}={}){
 let idle=null,scope=null,disposed=false;const active=new Set();
 const destroy=state=>{if(state.dead)return;state.dead=true;if(idle===state)idle=null;state.worker.onmessage=null;state.worker.onerror=null;state.worker.terminate();};
 const reset=()=>{if(idle)destroy(idle);for(const state of [...active])state.finish(new AiProviderError('cancelled'));scope=null;};
 const build=async(input,{signal,isCurrent=()=>true,target,vectorConfig,taskProvider=provider}={})=>{
  if(disposed)throw new AiProviderError('cancelled');
  assertAiCurrent(signal,isCurrent);
  if(typeof WorkerClass!=='function')throw new AiProviderError('unavailable');
  const nextScope=JSON.stringify([target?.chatId??null,target?.rootId??null]);if(scope!==nextScope){if(idle)destroy(idle);scope=nextScope;}
  let state=idle;idle=null;
  if(!state)try{state={worker:new WorkerClass(new URL('./recall-multichannel-worker.js',import.meta.url),{type:'module'}),scope,ready:false,dead:false};}catch{throw new AiProviderError('unavailable');}
  const worker=state.worker;active.add(state);
  return new Promise((resolve,reject)=>{
   let finished=false,timer=null;const seen=new Set();
   const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);active.delete(state);state.finish=null;worker.onmessage=null;
    if(error||disposed||state.scope!==scope||idle)destroy(state);else{idle=state;worker.onerror=()=>destroy(state);}
    if(error)reject(error);else resolve(value);};state.finish=finish;
   const check=()=>{if(finished)return false;try{assertAiCurrent(signal,isCurrent);return true;}catch(error){finish(error);return false;}};
   const abort=()=>finish(new AiProviderError('cancelled'));
   const send=()=>{const {countTokens,...captured}=input;try{worker.postMessage({type:'build',input:captured,hostCounter:typeof countTokens==='function',hasVectorConfig:vectorConfig?.source==='plugin'});}catch{finish(new AiProviderError('request'));}};
   if(!state.ready)timer=setTimeout(()=>finish(new AiProviderError('unavailable')),loadTimeout);
   signal?.addEventListener('abort',abort,{once:true});
   worker.onerror=()=>finish(new AiProviderError(state.ready?'mapping':'unavailable'));
   worker.onmessage=async({data})=>{
    if(!check())return;
    if(data.type==='ready'){
     if(state.ready)return;state.ready=true;clearTimeout(timer);send();
    }else if(data.type==='rpc'){
     if(!state.ready||!Number.isSafeInteger(data.id)||seen.has(data.id)){finish(new AiProviderError('mapping'));return;}seen.add(data.id);
     try{
      let value;
      if(data.method==='count'&&typeof data.args?.text==='string'&&typeof input.countTokens==='function')value=await input.countTokens(data.args.text);
      else if(data.method==='vector'&&typeof data.args?.text==='string'&&Array.isArray(data.args.dates)&&vectorIndex?.query&&vectorConfig?.source==='plugin'){
       value=await vectorIndex.query({target,events:activeEvents(input.events),config:vectorConfig,text:data.args.text,dateById:new Map(data.args.dates),signal,isCurrent,requestProvider:taskProvider});
      }else if(data.method==='rerank'&&typeof data.args?.query==='string'&&Array.isArray(data.args.documents)&&taskProvider?.rerank){
       value=await taskProvider.rerank({query:data.args.query,documents:data.args.documents,signal,isCurrent});
      }else throw new AiProviderError('configuration');
      if(check())worker.postMessage({type:'rpc-result',id:data.id,value});
     }catch(error){if(check())worker.postMessage({type:'rpc-result',id:data.id,error:safeCode(error)});}
    }else if(data.type==='result'&&state.ready)finish(null,data.result);
    else if(data.type==='failed'&&state.ready){
     const error=new AiProviderError('mapping'),value=data.diagnostic;
     error.workerDiagnostic={name:['Error','TypeError','RangeError','SyntaxError','DataCloneError','AbortError','AiProviderError'].includes(value?.name)?value.name:'Error',...(['invalid-context','invalid-snapshot','duplicate-id','token-count','cancelled','stale','configuration','capability','mapping','timeout','http','authentication','endpoint','rate_limit','cors_network','request','task_preset_missing','unavailable','storage'].includes(value?.code)?{code:value.code}:{})};
     finish(error);
    }else finish(new AiProviderError('mapping'));
   };
   if(check()&&state.ready)send();
  });
 };
 return Object.assign(build,{reset,dispose(){disposed=true;reset();}});
}
