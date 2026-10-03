import {buildRecall} from '../../domain/recall/build.js';

// Only an already captured, public preview input crosses this boundary.
// The worker has no host context, slots, settings store or AI transport.
export function createRecallPreviewBuilder({Worker:WorkerClass=globalThis.Worker,build=buildRecall,loadTimeout=5000}={}){
  return async(input,{signal,isCurrent=()=>true}={})=>{
    const current=()=>{try{return !signal?.aborted&&isCurrent()===true;}catch{return false;}};
    const cancelled=()=>new Error('preview-cancelled');
    if(!current())throw cancelled();
    if(typeof WorkerClass!=='function')return build(input);
    let worker;
    try{worker=new WorkerClass(new URL('./recall-preview-worker.js',import.meta.url),{type:'module'});}catch{
      if(!current())throw cancelled();return build(input);
    }
    return new Promise((resolve,reject)=>{
      let ready=false,finished=false;
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();};
      const finish=(error,value)=>{if(finished)return;finished=true;cleanup();if(error)reject(error);else resolve(value);};
      const abort=()=>finish(cancelled());
      const loadFailed=()=>{
        if(finished)return;
        if(ready){finish(new Error('preview-computation-failed'));return;}
        finished=true;cleanup();
        if(!current()){reject(cancelled());return;}
        // Compatibility only: loading/capability failure, never computation or
        // tokenizer failure. This branch retains the original CPU cost.
        Promise.resolve().then(()=>{if(!current())throw cancelled();return build(input);}).then(resolve,reject);
      };
      const timer=setTimeout(loadFailed,loadTimeout);
      signal?.addEventListener('abort',abort,{once:true});
      worker.onerror=loadFailed;
      worker.onmessage=async({data})=>{
        if(finished)return;
        if(!current()){abort();return;}
        if(data.type==='ready'){
          ready=true;clearTimeout(timer);const {countTokens,...captured}=input;
          try{worker.postMessage({type:'build',input:captured,hostCounter:typeof countTokens==='function'});}catch{finish(new Error('preview-computation-failed'));}
        }else if(data.type==='count'){
          try{
            if(typeof data.text!=='string'||typeof input.countTokens!=='function')throw new Error();
            const value=await input.countTokens(data.text);
            if(finished)return;if(!current()){abort();return;}
            worker.postMessage({type:'count-result',id:data.id,value});
          }catch{if(!finished&&current())worker.postMessage({type:'count-result',id:data.id,failed:true});else abort();}
        }else if(data.type==='result')finish(null,data.result);
        else if(data.type==='failed')finish(new Error('preview-computation-failed'));
      };
      if(!current())abort();
    });
  };
}
