import {createMultichannelBuilder} from '../../domain/recall/multichannel-build.js';

// This module owns computation only. No settings, credentials, host or storage.
const pending=new Map();let nextId=0;
const request=(method,args)=>new Promise((resolve,reject)=>{
 const id=++nextId;pending.set(id,{resolve,reject});self.postMessage({type:'rpc',id,method,args});
});
const build=createMultichannelBuilder({
 vectorIndex:{query:({text,dateById})=>request('vector',{text,dates:[...dateById].map(([id,row])=>[id,{blocked:row.blocked,partialScope:row.partialScope}])})},
 provider:{rerank:({query,documents})=>request('rerank',{query,documents})}
});
self.onmessage=async({data})=>{
 if(data.type==='rpc-result'){
  const entry=pending.get(data.id);if(!entry)return;pending.delete(data.id);
  if(data.error)entry.reject(Object.assign(Error(),{code:data.error}));else entry.resolve(data.value);return;
 }
 if(data.type!=='build')return;
 try{
  const countTokens=data.hostCounter?text=>request('count',{text}):null;
  const result=await build({...data.input,countTokens},{vectorConfig:data.hasVectorConfig?{source:'plugin'}:null});
  self.postMessage({type:'result',result});
 }catch(error){
  const known={'召回语境无效':'invalid-context','召回快照无效':'invalid-snapshot','召回身份重复':'duplicate-id','召回记忆重复':'duplicate-id','duplicate-recall-id':'duplicate-id','召回 Token 计数失败':'token-count'};
  const code=known[error?.message]??error?.code;
  const diagnostic={name:['Error','TypeError','RangeError','SyntaxError','DataCloneError','AbortError','AiProviderError'].includes(error?.name)?error.name:'Error',...(['invalid-context','invalid-snapshot','duplicate-id','token-count','cancelled','stale','configuration','capability','mapping','timeout','http','authentication','endpoint','rate_limit','cors_network','request','task_preset_missing','unavailable','storage'].includes(code)?{code}:{})};
  self.postMessage({type:'failed',diagnostic});
 }
};
self.postMessage({type:'ready'});

