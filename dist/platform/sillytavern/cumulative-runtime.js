import {sameTarget} from '../../domain/memory/repository.js';

export const CUMULATIVE_PROMPT_KEY = 'lantai_benmo_cumulative_context';
const supported = new Set(['normal','regenerate','swipe','continue']);
export function cumulativeGenerationSupported(messages, type = 'normal') {
  return supported.has(type) && !messages?.some(item => String(item?.mes ?? item?.content ?? '').includes('[LANTAI_BACKGROUND_TASK:'));
}

// This consumer owns only its slot. Saved source messages are not its authority.
export function createCumulativeRuntime({repository, settings, getContext} = {}) {
  let disposed = false, serial = 0, proof = null, status = {status:'empty'}, enabled = true;
  const releases = [];
  const valid = receipt => {
    try { return !disposed && enabled && receipt.serial === serial && sameTarget(receipt.target,repository.captureTarget())
      && repository.matchesCumulative(receipt.target,receipt.selection) && settings.matchesCumulativeGeneration(receipt.config); }
    catch { return false; }
  };
  function clear(reason = 'cleared') {
    const ticket = ++serial; proof = null;
    try {
      const context = getContext();
      if (typeof context?.setExtensionPrompt !== 'function') throw new Error();
      context.setExtensionPrompt(CUMULATIVE_PROMPT_KEY,'',1,0,false,0);
      // Synchronous host callbacks may have already installed a newer round.
      if (serial === ticket) status = {status:'cleared',reason};
      return true;
    } catch {
      if (serial === ticket) status = {status:'unconfirmed',reason:'cleanup',message:'古法槽清理尚未确认'};
      return false;
    }
  }
  async function intercept(messages, _size, _abort, type = 'normal') {
    if (disposed) return;
    const ticket = serial + 1;
    if (!clear('before-generation') || serial !== ticket || !enabled || !cumulativeGenerationSupported(messages,type)) return;
    let receipt;
    try {
      const target = repository.captureTarget(), config = settings.captureCumulativeGeneration();
      const selection = await repository.captureCumulative(target);
      receipt = {target:Object.freeze(target),config,selection,serial:ticket};
      if (!valid(receipt)) throw new Error('stale');
      const domain = selection.cumulative, current = domain.versions.find(item => item.id === domain.currentVersionId);
      if (!current) {status={status:'empty'};return;}
      const depth = config.generation.injectionPosition ?? 9999;
      if (!Number.isSafeInteger(depth) || depth < 0 || depth > 10000 || typeof current.body !== 'string' || !current.body.trim()) throw new Error('invalid');
      const context = getContext();
      if (typeof context?.setExtensionPrompt !== 'function') throw new Error('unavailable');
      context.setExtensionPrompt(CUMULATIVE_PROMPT_KEY,current.body,1,depth,false,0);
      if (!valid(receipt)) throw new Error('stale');
      proof = Object.freeze(receipt);
      status = {status:'injected',type,depth,prompt:current.body,currentVersionId:current.id};
    } catch {
      // An old async continuation must not clear a newly installed slot.
      if (!disposed && serial === ticket) {
        if (clear('failed')) status={status:'failed',type,message:'本轮古法正文未注入'};
      }
    }
  }
  function preparationFailed(expectedTarget = null) {
    if (disposed) return;
    if(expectedTarget) {
      try {if(!sameTarget(expectedTarget,repository.captureTarget()))return;} catch {return;}
    }
    const ticket=serial+1;
    if(clear('preparation-failed') && serial===ticket) status={status:'failed',message:'本轮古法准备失败'};
  }
  const context = getContext();
  for (const name of ['CHAT_CHANGED','CHAT_CREATED','GENERATION_ENDED','GENERATION_STOPPED']) {
    const event=context?.eventTypes?.[name], source=context?.eventSource;
    if (!event || typeof source?.on !== 'function') continue;
    const listener=()=>clear(name);
    source.on(event,listener);releases.push(()=>(source.off ?? source.removeListener)?.call(source,event,listener));
  }
  if(typeof settings.subscribe==='function')releases.push(settings.subscribe(()=>{
    if(proof && !valid(proof))clear('configuration-invalidated');
  }));
  return Object.freeze({intercept,clear,preparationFailed,
    inspect:()=>structuredClone(status),
    getReplacementProof:()=>proof && valid(proof) ? proof : null,
    setEnabled(value){enabled=value===true;if(!enabled)clear('disabled');},
    dispose(){if(disposed)return;disposed=true;clear('dispose');for(const off of releases)off();}
  });
}
