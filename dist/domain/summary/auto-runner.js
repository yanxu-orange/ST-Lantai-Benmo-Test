import {sameTarget} from '../memory/repository.js';
export function automaticSummaryPlan(summary,raw) {
  const config=summary.preferences.auto;
  const start=Math.max(config.startFloor,(summary.progress.lastProcessedFloor??(config.startFloor-1))+1),nominalEnd=start+config.batchSize-1;
  const last=raw.messages.at(-1)?.floor??-1,safeEnd=last-config.recentFloors;
  const endpoint=raw.messages.find(message=>message.floor>=nominalEnd&&message.floor<=safeEnd&&message.role==='assistant'&&!message.system);
  return endpoint?{status:'ready',startFloor:start,endFloor:endpoint.floor}:{status:'waiting',startFloor:start,endFloor:nominalEnd};
}
export function createAutomaticSummaryRunner({service,repository,captureSource}={}) {
  let run=null,disposed=false;const listeners=new Set();
  const inspect=()=>run?{status:run.status,taskId:run.taskId,target:run.target,stopRequested:run.stopRequested,error:run.error}: {status:'idle',taskId:null,target:null,stopRequested:false,error:''};
  const notify=()=>{for(const listener of [...listeners])try{listener(inspect());}catch{/* display only */}};
  async function pump(active) {
    if(active.pumping||disposed||run!==active||active.status!=='running')return;
    active.pumping=true;
    try {
      while(run===active&&!disposed&&active.status==='running') {
        if(active.stopRequested){active.status='stopped';break;}
        const selected=await repository.captureSummary(active.target),raw=captureSource(active.target),plan=automaticSummaryPlan(selected.summary,raw);
        if(plan.status!=='ready'){active.status=plan.status;break;}
        active.taskId=await service.start('auto',plan);notify();
        const outcome=await service.completed(active.taskId);
        if(run!==active||disposed)return;
        if(outcome?.status==='awaiting-user'){active.status='awaiting-user';break;}
        if(outcome?.status!=='succeeded'){active.status='failed';active.error=outcome?.outcome==='unconfirmed'?'保存结果尚未确认，请重新读取':'本批未完成，请明确重试';break;}
        notify();
      }
    } catch(error){if(run===active){active.status='failed';active.error=error.message;}}
    finally{active.pumping=false;notify();}
  }
  return Object.freeze({
    inspect,
    start(){const target=repository.captureTarget();if(disposed)return false;if(run&&!sameTarget(run.target,target)){if(run.taskId)service.cancel(run.taskId);run=null;}if(run&&['running','awaiting-user'].includes(run.status))return false;run={target,status:'running',taskId:null,stopRequested:false,error:'',pumping:false};notify();void pump(run);return true;},
    stop(){if(!run||!['running','waiting','awaiting-user'].includes(run.status))return false;run.stopRequested=true;if(!run.pumping&&run.status!=='awaiting-user')run.status='stopped';notify();return true;},
    afterReview(){if(!run||run.status!=='awaiting-user')return;run.status=run.stopRequested?'stopped':'running';notify();void pump(run);},
    transferTask(taskId){
      const task=service.inspect(taskId),active=run;if(!active||!task||!sameTarget(active.target,task.target)||!sameTarget(task.target,repository.captureTarget()))return false;
      active.taskId=taskId;active.status='running';active.error='';active.pumping=true;notify();
      void service.completed(taskId).then(outcome=>{if(disposed||run!==active||active.taskId!==taskId)return;active.status=outcome?.status==='awaiting-user'?'awaiting-user':'failed';if(active.status==='failed')active.error='本批未完成，请明确重试';}).catch(()=>{if(run===active&&active.taskId===taskId){active.status='failed';active.error='本批未完成，请明确重试';}}).finally(()=>{if(run===active&&active.taskId===taskId){active.pumping=false;notify();}});return true;
    },
    discard(){if(run){run.status='failed';run.error='已放弃本批，请明确重试';notify();}},
    wake(){if(run?.status==='waiting'&&!run.stopRequested){if(!sameTarget(run.target,repository.captureTarget())){run.status='stopped';notify();return;}run.status='running';void pump(run);}},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){disposed=true;if(run?.taskId)service.cancel(run.taskId);run=null;listeners.clear();}
  });
}
