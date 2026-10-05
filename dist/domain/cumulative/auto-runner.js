import {sameTarget} from '../memory/repository.js';
import {assertRawSummarySource} from '../summary/source.js';
export function automaticCumulativePlan(cumulative,raw) {
  const source=assertRawSummarySource(raw),config=cumulative.preferences.auto;
  const start=Math.max(config.startFloor,(cumulative.progress.lastProcessedFloor??(config.startFloor-1))+1),end=start+config.batchSize-1;
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(end)||!Number.isSafeInteger(config.batchSize)||config.batchSize<1)throw new Error('古法自动范围无效');
  const selected=source.messages.filter(message=>message.floor>=start&&message.floor<=end);
  return {status:selected.length===config.batchSize?'ready':'waiting',startFloor:start,endFloor:end};
}
export function createAutomaticCumulativeRunner({service,repository,captureSource}={}) {
  let run=null,disposed=false;const listeners=new Set();
  const inspect=()=>run?{status:run.status,taskId:run.taskId,target:structuredClone(run.target),stopRequested:run.stopRequested,error:run.error}:{status:'idle',taskId:null,target:null,stopRequested:false,error:''};
  const notify=()=>{for(const listener of [...listeners])try{listener(inspect());}catch{/* observation only */}};
  const targetCurrent=active=>sameTarget(active.target,repository.captureTarget());
  const reviewResolution=active=>{const state=service.inspect(active.taskId);return state?.outcome!=='unconfirmed'&&['committed','discarded'].includes(state?.reviewResolution)?state.reviewResolution:null;};
  async function pump(active) {
    if(active.pumping||disposed||run!==active||active.status!=='running')return;active.pumping=true;
    try{
      while(run===active&&!disposed&&active.status==='running'){
        if(!targetCurrent(active)){active.status='stopped';break;}if(active.stopRequested){active.status='stopped';break;}
        const selection=await repository.captureCumulative(active.target);if(!targetCurrent(active)){active.status='stopped';break;}
        if(active.stopRequested){active.status='stopped';break;}
        const plan=automaticCumulativePlan(selection.cumulative,captureSource(active.target));if(plan.status!=='ready'){active.status='waiting';break;}
        active.taskId=await service.start('auto',plan);notify();const result=await service.completed(active.taskId);
        if(run!==active||disposed)return;
        if(result?.status==='awaiting-user'){active.status='awaiting-user';break;}
        if(result?.status!=='succeeded'){active.status='failed';active.error=result?.outcome==='unconfirmed'?'保存结果尚未确认，请明确重新读取':'本批未完成，请明确重试或调整参数';break;}
      }
    }catch{if(run===active){active.status='failed';active.error='本批未完成，请明确重试或调整参数';}}
    finally{active.pumping=false;notify();}
  }
  const runner={inspect,
    start(){if(disposed)return false;const target=repository.captureTarget();if(run?.invalidated&&run.target.chatId===target.chatId)return false;if(run&&!sameTarget(run.target,target)&&run.target.chatId===target.chatId&&run.target.rootId===target.rootId)return false;if(run&&sameTarget(run.target,target)&&(run.status==='running'||run.status==='awaiting-user'&&!reviewResolution(run)))return false;if(run?.taskId&&!sameTarget(run.target,target))service.cancel(run.taskId);run={target,status:'running',taskId:null,stopRequested:false,error:'',pumping:false};notify();void pump(run);return true;},
    continue(){return runner.start();},
    stop(){if(!run||!['running','waiting','awaiting-user'].includes(run.status))return false;run.stopRequested=true;if(!run.pumping&&run.status!=='awaiting-user')run.status='stopped';notify();return true;},
    resolveReview({resume=false}={}){if(typeof resume!=='boolean'||!run||run.status!=='awaiting-user'||!targetCurrent(run))return false;const resolution=reviewResolution(run);if(!resolution)return false;run.status=!resume||run.stopRequested||resolution==='discarded'?'stopped':'running';run.error=resolution==='discarded'?'已放弃本批，请明确继续':'';notify();if(resume)void pump(run);return true;},
    afterReview(){return runner.resolveReview({resume:true});},
    transferTask(taskId){const state=service.inspect(taskId),active=run;if(disposed||!active||!state||active.pumping||!sameTarget(active.target,state.target)||!targetCurrent(active))return false;active.taskId=taskId;active.status='running';active.error='';active.pumping=true;notify();
      void service.completed(taskId).then(result=>{if(disposed||run!==active||active.taskId!==taskId)return;active.status=result?.status==='awaiting-user'?'awaiting-user':result?.status==='succeeded'?(active.stopRequested?'stopped':'running'):'failed';if(active.status==='failed')active.error='本批未完成，请明确重试或调整参数';}).catch(()=>{if(run===active){active.status='failed';active.error='本批未完成，请明确重试或调整参数';}}).finally(()=>{if(run===active){active.pumping=false;notify();void pump(active);}});return true;
    },
    discard(){return runner.afterReview();},
    invalidateTarget(previousTarget){if(disposed||!run||!sameTarget(run.target,previousTarget))return false;run={...run,status:'stopped',pumping:false,invalidated:true};notify();return true;},
    settleRebind(receipt){if(disposed||service.matchesReboundReadback?.(receipt)!==true)return false;if(!run)return true;if(sameTarget(run.target,receipt.nextTarget)&&run.status==='stopped'&&run.taskId===null)return true;if(!sameTarget(run.target,receipt.previousTarget))return false;run={...run,target:structuredClone(receipt.nextTarget),status:'stopped',taskId:null,pumping:false,invalidated:false,error:''};notify();return true;},
    wake(){if(disposed||run?.status!=='waiting'||run.stopRequested)return false;if(!targetCurrent(run)){run.status='stopped';notify();return false;}run.status='running';void pump(run);return true;},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){if(disposed)return;disposed=true;if(run?.taskId)service.cancel(run.taskId);run=null;listeners.clear();},
  };return Object.freeze(runner);
}
