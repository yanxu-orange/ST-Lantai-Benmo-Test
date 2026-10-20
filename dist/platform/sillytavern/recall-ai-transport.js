import {AiProviderError,assertAiCurrent} from '../../shared/ai/provider.js';
import {freezeRecallConfig,RECALL_REQUEST_LIMITS} from '../../shared/ai/recall-provider.js';

export function recallEndpoint(config,kind){
  const endpoint=new URL(config.endpoint);
  let path=endpoint.pathname.replace(/\/$/,'');
  const terminal=/\/(embeddings|rerank)$/.exec(path);
  if(terminal){if(kind!=='models'&&terminal[1]!==kind)throw new AiProviderError('capability');path=path.slice(0,-terminal[0].length);}
  if(/\/chat\/completions$/.test(path))throw new AiProviderError('configuration');
  endpoint.pathname=path+'/'+kind;
  if(kind==='models'&&endpoint.hostname==='openrouter.ai')endpoint.search='?output_modalities='+({embedding:'embeddings',rerank:'rerank'}[config.capability]);
  return endpoint.toString();
}
export function recallPayload(config,request){
  const payload=config.capability==='embedding'?{model:config.model,input:request.rows.map(row=>row.text),encoding_format:'float',...(config.protocol==='voyage'?{input_type:request.inputType}:{})}
    :{model:config.model,query:request.query,documents:request.rows.map(row=>row.text),top_n:request.rows.length};
  // OpenRouter's dedicated endpoints accept this routing guard. Other endpoints
  // use their native compatible schema; no automatic URL/provider switching.
  if(new URL(config.endpoint).hostname==='openrouter.ai')payload.provider={allow_fallbacks:false,require_parameters:true};
  return payload;
}

// Dedicated JSON endpoints must permit browser CORS. Never use the host's chat
// completions proxy to carry vectors or rerank scores, or forward host cookies.
export function createRecallAiTransport({fetchImpl=globalThis.fetch,resolveCredential,timeoutMs=RECALL_REQUEST_LIMITS.timeoutMs}={}){
  if(typeof fetchImpl!=='function'||typeof resolveCredential!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>RECALL_REQUEST_LIMITS.timeoutMs)throw new AiProviderError('configuration');
  async function send({config:configured,request,signal,isCurrent,models=false}){
    const config=freezeRecallConfig(models?{...configured,model:'models-only'}:configured,configured?.capability);
    if(typeof isCurrent!=='function')throw new AiProviderError('request');
    assertAiCurrent(signal,isCurrent);
    const controller=new AbortController();let timer,abortListener,timedOut=false;
    const current=()=>isCurrent()===true;
    try{
      const publicCatalog=models&&new URL(config.endpoint).hostname==='openrouter.ai',headers={Accept:'application/json'};
      if(!publicCatalog){let key;try{key=resolveCredential(config,{taskGroup:config.capability});}catch{throw new AiProviderError('configuration');}
       if(typeof key!=='string'||!key.trim()||key.length>8192||/[\u0000-\u001f\u007f-\u009f]/.test(key))throw new AiProviderError('configuration');headers.Authorization=`Bearer ${key}`;}
      if(!models)headers['Content-Type']='application/json';
      const url=recallEndpoint(config,models?'models':config.capability==='embedding'?'embeddings':'rerank');
      const cancellation=new Promise((_,reject)=>{
        abortListener=()=>{controller.abort();reject(new AiProviderError('cancelled'));};
        signal?.addEventListener('abort',abortListener,{once:true});
        timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new AiProviderError('timeout'));},timeoutMs);
      });
      assertAiCurrent(signal,current);
      const work=(async()=>{
        const response=await fetchImpl(url,{method:models?'GET':'POST',headers,signal:controller.signal,credentials:'omit',mode:'cors',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',...(models?{}:{body:JSON.stringify(recallPayload(config,request))})});
        assertAiCurrent(signal,current);
        if(!response?.ok)throw new AiProviderError([401,403].includes(response?.status)?'authentication':response?.status===404?'endpoint':response?.status===429?'rate_limit':'http');
        let data;try{data=await response.json();}catch{throw new AiProviderError('mapping');}assertAiCurrent(signal,current);
        if(models){
          if(!data||data.error||!Array.isArray(data.data))throw new AiProviderError('mapping');
          const modality=config.capability==='embedding'?'embeddings':'rerank',rows=publicCatalog?data.data.filter(row=>row?.architecture?.input_modalities?.includes('text')&&row.architecture?.output_modalities?.includes(modality)):data.data,secret=headers.Authorization?.slice(7),ids=rows.map(row=>row?.id);
          if(ids.some(id=>typeof id!=='string'||!id.trim()||id.length>300||secret&&id.includes(secret)))throw new AiProviderError('mapping');
          return [...new Set(ids)].sort();
        }
        return data;
      })();
      return await Promise.race([work,cancellation]);
    }catch(error){assertAiCurrent(signal,current);throw new AiProviderError(timedOut?'timeout':error instanceof AiProviderError?error.code:'cors_network');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abortListener);controller.abort();}
  }
  return Object.freeze({request:args=>send(args),fetchModels:args=>send({...args,models:true})});
}
