import {AiProviderError,assertAiCurrent} from '../../shared/ai/provider.js';
import {activeEvents} from '../../domain/memory/event-model.js';

const safeCode=error=>['configuration','capability','mapping','timeout','http','cors_network','request','task_preset_missing','authentication','endpoint','rate_limit','storage'].includes(error?.code)?error.code:'transport';
// One captured input per worker. API/IDB/host work stays in this caller;
// credentials, provider objects and callbacks never cross postMessage.
export function createMultichannelWorkerBuilder({Worker:WorkerClass=globalThis.Worker,vectorIndex,provider,loadTimeout=5000}={}){
 return async(input,{signal,isCurrent=()=>true,target,vectorConfig}={})=>{
  assertAiCurrent(signal,isCurrent);
  if(typeof WorkerClass!=='function')throw new AiProviderError('unavailable');
  let worker;try{worker=new WorkerClass(new URL('./recall-multichannel-worker.js',import.meta.url),{type:'module'});}catch{throw new AiProviderError('unavailable');}
  return new Promise((resolve,reject)=>{
   let finished=false,ready=false;const seen=new Set();
   const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(value);};
   const check=()=>{if(finished)return false;try{assertAiCurrent(signal,isCurrent);return true;}catch(error){finish(error);return false;}};
   const abort=()=>finish(new AiProviderError('cancelled'));
   const timer=setTimeout(()=>finish(new AiProviderError('unavailable')),loadTimeout);
   signal?.addEventListener('abort',abort,{once:true});
   worker.onerror=()=>finish(new AiProviderError(ready?'mapping':'unavailable'));
   worker.onmessage=async({data})=>{
    if(!check())return;
    if(data.type==='ready'){
     if(ready)return;ready=true;clearTimeout(timer);
     const {countTokens,...captured}=input;
     try{worker.postMessage({type:'build',input:captured,hostCounter:typeof countTokens==='function',hasVectorConfig:vectorConfig?.source==='plugin'});}catch{finish(new AiProviderError('request'));}
    }else if(data.type==='rpc'){
     if(!ready||!Number.isSafeInteger(data.id)||seen.has(data.id)){finish(new AiProviderError('mapping'));return;}seen.add(data.id);
     try{
      let value;
      if(data.method==='count'&&typeof data.args?.text==='string'&&typeof input.countTokens==='function')value=await input.countTokens(data.args.text);
      else if(data.method==='vector'&&typeof data.args?.text==='string'&&Array.isArray(data.args.dates)&&vectorIndex?.query&&vectorConfig?.source==='plugin'){
       value=await vectorIndex.query({target,events:activeEvents(input.events),config:vectorConfig,text:data.args.text,dateById:new Map(data.args.dates),signal,isCurrent});
      }else if(data.method==='rerank'&&typeof data.args?.query==='string'&&Array.isArray(data.args.documents)&&provider?.rerank){
       value=await provider.rerank({query:data.args.query,documents:data.args.documents,signal,isCurrent});
      }else throw new AiProviderError('configuration');
      if(check())worker.postMessage({type:'rpc-result',id:data.id,value});
     }catch(error){if(check())worker.postMessage({type:'rpc-result',id:data.id,error:safeCode(error)});}
    }else if(data.type==='result'&&ready)finish(null,data.result);
    else if(data.type==='failed'&&ready){
     const error=new AiProviderError('mapping'),value=data.diagnostic;
     error.workerDiagnostic={name:['Error','TypeError','RangeError','SyntaxError','DataCloneError','AbortError','AiProviderError'].includes(value?.name)?value.name:'Error',...(['invalid-context','invalid-snapshot','duplicate-id','token-count','cancelled','stale','configuration','capability','mapping','timeout','http','authentication','endpoint','rate_limit','cors_network','request','task_preset_missing','unavailable','storage'].includes(value?.code)?{code:value.code}:{})};
     finish(error);
    }else finish(new AiProviderError('mapping'));
   };
   check();
  });
 };
}

