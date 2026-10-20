import {AiProviderError, assertAiCurrent} from './provider.js';

export const RECALL_REQUEST_LIMITS = Object.freeze({embeddingBatch:64,rerankBatch:200,candidatePerRoute:50,inputBytes:512000,dimensions:8192,timeoutMs:30000});
const bad = code => { throw new AiProviderError(code); };
export function embeddingProtocol(model, requested) {
  if(requested!==undefined&&!['openai','voyage'].includes(requested))bad('configuration');
  return requested??(['voyageai/voyage-4-large','voyage-4-large'].includes(model)?'voyage':'openai');
}
export function freezeRecallConfig(value, capability) {
  if (!['embedding','rerank'].includes(capability) || value?.source !== 'plugin' || value.capability !== capability) bad('capability');
  if (![value.endpoint,value.model,value.credentialId].every(item=>typeof item==='string'&&item.trim())
    || !Number.isSafeInteger(value.credentialEpoch)||value.credentialEpoch<0) bad('configuration');
  let endpoint;
  try { endpoint=new URL(value.endpoint.trim());if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error(); }
  catch { bad('configuration'); }
  return Object.freeze({source:'plugin',capability,endpoint:endpoint.toString().replace(/\/$/,''),model:value.model.trim(),credentialId:value.credentialId.trim(),credentialEpoch:value.credentialEpoch,
    ...(capability==='embedding'?{protocol:embeddingProtocol(value.model.trim(),value.protocol)}:{})});
}
function rowsCopy(rows, max) {
  if (!Array.isArray(rows)||!rows.length||rows.length>max) bad('request');
  const ids=new Set();
  const copy=rows.map(row=>{
    if(!row||typeof row.id!=='string'||!row.id.trim()||row.id.length>200||ids.has(row.id)||typeof row.text!=='string'||!row.text.trim())bad('request');
    ids.add(row.id);return Object.freeze({id:row.id,text:row.text});
  });
  return Object.freeze(copy);
}
export function prepareRecallRequest(capability, {inputs,documents,query,inputType,expectedDimensions}={}) {
  const rows=rowsCopy(capability==='embedding'?inputs:documents,capability==='embedding'?RECALL_REQUEST_LIMITS.embeddingBatch:RECALL_REQUEST_LIMITS.rerankBatch);
  if(capability==='embedding'){
    if(!['query','document'].includes(inputType)||expectedDimensions!==undefined&&(!Number.isSafeInteger(expectedDimensions)||expectedDimensions<1||expectedDimensions>RECALL_REQUEST_LIMITS.dimensions))bad('request');
  }else if(capability!=='rerank'||typeof query!=='string'||!query.trim())bad('request');
  const bytes=new TextEncoder().encode(rows.map(row=>row.text).join('')+(query??'')).length;
  if(bytes>RECALL_REQUEST_LIMITS.inputBytes)bad('request');
  return Object.freeze({rows,...(capability==='embedding'?{inputType,expectedDimensions}:{query})});
}
export function validateRecallResponse(capability,response,request,expectedModel){
  if(!response||typeof response!=='object'||response.error)bad('mapping');
  const aliases=expectedModel==='voyageai/voyage-4-large'?['voyage-4-large']:expectedModel==='qwen/qwen3-embedding-8b'?['Qwen/Qwen3-Embedding-8B']:expectedModel==='qwen/qwen3-reranker-8b'?['Qwen/Qwen3-Reranker-8B','accounts/fireworks/models/qwen3-reranker-8b','fireworks/qwen3-reranker-8b']:[];
  if(response.model!==undefined&&(typeof expectedModel!=='string'||typeof response.model!=='string'||![expectedModel,...aliases].includes(response.model)))bad('mapping');
  const modelIdentity=Object.freeze({requestedModel:expectedModel??null,observedModel:response.model??null,verified:response.model!==undefined});
  const rows=capability==='embedding'?response.data:response.results;
  if(!Array.isArray(rows)||rows.length!==request.rows.length)bad('mapping');
  const seen=new Set(),ordered=new Array(rows.length);let dimensions=request.expectedDimensions;
  for(const row of rows){
    const index=row?.index;
    if(!Number.isSafeInteger(index)||index<0||index>=rows.length||seen.has(index))bad('mapping');
    seen.add(index);
    if(capability==='embedding'){
      const vector=row.embedding;
      if(!Array.isArray(vector)||!vector.length||vector.length>RECALL_REQUEST_LIMITS.dimensions||vector.some(value=>typeof value!=='number'||!Number.isFinite(value)))bad('mapping');
      dimensions??=vector.length;
      if(vector.length!==dimensions)bad('mapping');
      const norm=Math.hypot(...vector);if(!Number.isFinite(norm)||norm===0)bad('mapping');
      ordered[index]=Object.freeze({id:request.rows[index].id,embedding:Object.freeze([...vector])});
    }else{
      if(typeof row.relevance_score!=='number'||!Number.isFinite(row.relevance_score)
        ||row.document?.text!==undefined&&row.document.text!==request.rows[index].text)bad('mapping');
      ordered[index]=Object.freeze({id:request.rows[index].id,index,score:row.relevance_score});
    }
  }
  return capability==='embedding'?Object.freeze({rows:Object.freeze(ordered),dimensions,modelIdentity}):Object.freeze({rows:Object.freeze(ordered.sort((a,b)=>b.score-a.score||a.index-b.index)),modelIdentity});
}

// No credentials, network globals, Node imports or persistent input cache here.
export function createRecallAiProvider({getConfig,transport,signal:lifecycleSignal}={}){
  if(typeof getConfig!=='function'||typeof transport?.request!=='function')bad('configuration');
  function configFor(capability){
    try{return freezeRecallConfig(getConfig(capability),capability);}
    catch(error){bad(error?.code==='TASK_PRESET_MISSING'?'task_preset_missing':error?.code==='TASK_CAPABILITY_MISMATCH'?'capability':error instanceof AiProviderError?error.code:'configuration');}
  }
  async function perform(capability,args={}){
    if(typeof args.isCurrent!=='function')bad('request');
    assertAiCurrent(args.signal,args.isCurrent);
    assertAiCurrent(lifecycleSignal,args.isCurrent);
    const config=configFor(capability),fingerprint=JSON.stringify(config),request=prepareRecallRequest(capability,args);
    const current=()=>{try{return args.isCurrent()===true&&JSON.stringify(configFor(capability))===fingerprint;}catch{return false;}};
    const controller=new AbortController(),abort=()=>controller.abort();
    const sources=[...new Set([args.signal,lifecycleSignal].filter(Boolean))];
    for(const source of sources){source.addEventListener('abort',abort,{once:true});if(source.aborted)controller.abort();}
    try{
      assertAiCurrent(controller.signal,current);
      const response=await transport.request({config,request,signal:controller.signal,isCurrent:current});
      assertAiCurrent(controller.signal,current);
      const result=validateRecallResponse(capability,response,request,config.model);
      assertAiCurrent(controller.signal,current);
      return Object.freeze({...result,provider:Object.freeze({source:'plugin',capability})});
    }catch(error){assertAiCurrent(controller.signal,current);throw new AiProviderError(error instanceof AiProviderError?error.code:'transport');}
    finally{for(const source of sources)source.removeEventListener('abort',abort);controller.abort();}
  }
  return Object.freeze({embed:args=>perform('embedding',args),rerank:args=>perform('rerank',args)});
}
