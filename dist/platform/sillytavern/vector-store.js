import {vectorOwner,validStoredVector} from '../../domain/recall/vector-records.js';

const failure=()=>Object.assign(Error('向量缓存未能读取或保存。'),{code:'storage'});
const cancelled=()=>Object.assign(Error('向量处理已取消。'),{code:'cancelled'});
const check=(signal,isCurrent)=>{if(signal?.aborted)throw cancelled();try{if(isCurrent()===true)return;}catch{}throw cancelled();};
const scope=(target,identity)=>JSON.stringify([vectorOwner(target),identity]);
// Same-origin browser cache only. No vectors enter chat metadata, exports or
// the formal root queue. Each bounded batch is one independent IDB transaction.
export function createVectorStore({indexedDB=globalThis.indexedDB,name='lantai-benmo-derived-vectors-v1',timeoutMs=10000}={}){
 let opening=null,closed=false,connection=null;const active=new Set();
 async function open(){
  if(closed||!indexedDB?.open)throw failure();if(opening)return opening;
  opening=new Promise((resolve,reject)=>{
   let request,settled=false;const timer=setTimeout(()=>finish(failure()),timeoutMs);
   function finish(error,db){if(settled){db?.close();return;}settled=true;clearTimeout(timer);if(error){db?.close();opening=null;reject(error);}else{connection=db;db.onversionchange=()=>{db.close();connection=null;opening=null;};resolve(db);}}
   try{request=indexedDB.open(name,1);}catch{finish(failure());return;}
   request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('vectors')){const store=db.createObjectStore('vectors',{keyPath:'key'});store.createIndex('scope','scope');store.createIndex('owner','owner');}};
   request.onerror=()=>finish(failure());request.onblocked=()=>finish(failure());request.onsuccess=()=>closed?finish(failure(),request.result):finish(null,request.result);
  }).catch(error=>{opening=null;throw error;});return opening;
 }
 async function transact(mode,action,{signal,isCurrent=()=>true}={}){
  const current=()=>!closed&&isCurrent()===true;
  check(signal,current);const db=await open();check(signal,current);
  return new Promise((resolve,reject)=>{
   let tx,result,settled=false;const timer=setTimeout(()=>abort(failure()),timeoutMs);
   function finish(error){if(settled)return;settled=true;active.delete(onClose);clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(error)reject(error);else{try{check(signal,current);resolve(result);}catch(error){reject(error);}}}
   function abort(error){try{tx?.abort();}catch{}finish(error);}
   const onAbort=()=>abort(cancelled()),onClose=()=>abort(cancelled());active.add(onClose);signal?.addEventListener('abort',onAbort,{once:true});
   try{check(signal,current);tx=db.transaction('vectors',mode);tx.oncomplete=()=>finish();tx.onerror=()=>finish(failure());tx.onabort=()=>finish(signal?.aborted||closed?cancelled():failure());action(tx.objectStore('vectors'),value=>{result=value;});}catch(error){abort(error?.code==='cancelled'?error:failure());}
  });
 }
 return Object.freeze({
  async load({target,identity},options){const expected=scope(target,identity);return transact('readonly',(store,set)=>{const request=store.index('scope').getAll(expected);request.onsuccess=()=>set(request.result.filter(row=>row.owner===vectorOwner(target)&&row.scope===expected&&validStoredVector(row)).map(row=>({id:row.id,version:row.version,dimensions:row.dimensions,vector:Array.from(row.vector),modelIdentityVerified:row.modelIdentityVerified})));},options);},
  async save({target,identity,rows},options){
   if(!Array.isArray(rows)||!rows.length||rows.length>64||rows.some(row=>!validStoredVector(row))||new Set(rows.map(row=>row.id)).size!==rows.length)throw failure();
   const owner=vectorOwner(target),group=scope(target,identity);
   return transact('readwrite',store=>{for(const row of rows)store.put({key:JSON.stringify([group,row.id]),owner,scope:group,id:row.id,version:row.version,dimensions:row.dimensions,vector:new Float64Array(row.vector),modelIdentityVerified:row.modelIdentityVerified});},options);
  },
  async prune({target,ids},options){
   const keep=new Set(ids);return transact('readwrite',store=>{const request=store.index('owner').openKeyCursor(vectorOwner(target));request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;let id;try{id=JSON.parse(cursor.primaryKey)[1];}catch{}if(!keep.has(id))store.delete(cursor.primaryKey);cursor.continue();};},options);
  },
  close(){closed=true;for(const abort of [...active])abort();connection?.close();connection=null;opening=null;},
 });
}
