import {createManagementNotifications} from './management-notifications.js';
export function createSummaryNotifications({document,service,styles,openTask,duration}={}) {
  const seen=new Set();
  const controller={subscribeNotices(listener){return service.subscribe(state=>{
    let phase=null,message='';
    if(state.status==='starting'){phase='started';message='已开始总结';}
    if(state.status==='awaiting-user'&&state.snapshot.params.reviewBeforeCommit){phase='complete';message=`总结完成，共 ${state.candidate.events.length} 条`;}
    if(state.status==='succeeded'){phase='complete';message='本批总结已保存';}
    if(['failed','stale','cancelled'].includes(state.status)){phase='failed';message=state.outcome==='unconfirmed'?'总结保存待确认':'总结未完成，请查看';}
    const key=`${state.taskId}:${state.attempt}:${phase}`;if(!phase||seen.has(key))return;seen.add(key);
    listener({taskId:state.taskId,phase,message,id:'lantai-summary-notice'});
  });}};
  return createManagementNotifications({document,controller,styles,openTask,duration});
}
