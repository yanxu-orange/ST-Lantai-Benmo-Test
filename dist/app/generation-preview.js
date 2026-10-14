// The summary controller's draft contract: mutate in place, invalidate the
// preview, and let the owner persist/publish later. Input never requests render.
export const sameGenerationParams=(a,b)=>!!a&&!!b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.is(a[key],b[key]));
export function changeGenerationDraft(params,mutator,invalidate){
  const before=structuredClone(params);mutator(params);
  if(sameGenerationParams(before,params))return false;
  invalidate();return true;
}
// One transient preview state per controller/page. Sequence invalidation stops
// late preparation from reopening a closed or edited form; no materials cache
// survives a source/target invalidation.
export function createGenerationPreview(state){
  let sequence=0;
  return {
    invalidate({close=false}={}){sequence++;state.preview=null;state.previewBusy=false;if(close)state.previewOpen=false;},
    toggle(){sequence++;state.previewOpen=!state.previewOpen;state.previewBusy=false;},
    view(value){state.previewView=value;},
    async prepare(resolve,isCurrent=()=>true){
      const request=++sequence;state.previewBusy=true;
      try{const value=await resolve();if(request===sequence&&isCurrent()){state.preview=value;state.previewOpen=true;return true;}return false;}
      finally{if(request===sequence)state.previewBusy=false;}
    },
  };
}
