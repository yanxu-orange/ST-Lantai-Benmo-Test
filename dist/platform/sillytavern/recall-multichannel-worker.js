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
 }catch{self.postMessage({type:'failed'});}
};
self.postMessage({type:'ready'});
