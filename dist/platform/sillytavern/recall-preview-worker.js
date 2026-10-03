import {buildRecall} from '../../domain/recall/build.js';

const counters=new Map();let nextId=0;
self.onmessage=async({data})=>{
  if(data.type==='count-result'){
    const pending=counters.get(data.id);if(!pending)return;counters.delete(data.id);
    if(data.failed)pending.reject(new Error('token-count-failed'));else pending.resolve(data.value);return;
  }
  if(data.type!=='build')return;
  try{
    const countTokens=data.hostCounter?text=>new Promise((resolve,reject)=>{
      const id=++nextId;counters.set(id,{resolve,reject});self.postMessage({type:'count',id,text});
    }):null;
    const result=await buildRecall({...data.input,countTokens});self.postMessage({type:'result',result});
  }catch{self.postMessage({type:'failed'});}
};
self.postMessage({type:'ready'});
