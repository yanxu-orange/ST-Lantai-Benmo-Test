import { blankEvent,emptyRoot } from '../../domain/memory/model.js';
import { createBackgroundTaskManager } from '../../shared/runtime/background-tasks.js';
import { createAiProvider } from '../../shared/ai/provider.js';
import { createMemoryManagementService } from '../../domain/memory/management-service.js';
import { createManagementController } from '../../app/management-controller.js';

// Explicit disposable fixture; none of these values are production defaults.
export const managementSeed={A:{...emptyRoot('fiction-management-A'),events:['a','b','c'].map((id,index)=>({...blankEvent(id),title:['船票与约定','码头相遇','归途'][index],body:('这是一段虚构的审核测试正文。两人讨论33计划，随后约定下次见面。\n').repeat(index+1),startTime:`2025年6月${index+1}日下午`,endTime:'',sources:[{start:index*3,end:index*3+1}],people:['她','他'],places:['码头'],eventWords:['旧词'],detailWords:[{id:`old-${id}`,word:'旧计划',aliases:['旧']}]}))}};
export function createManagementFixture(repository,{delay=0,respond}={}) {
 const settings={epoch:0,eventWords:[{name:'约定',definition:'明确约定再次见面'}],promptOverrides:{}},config={source:null},requests=[];
 let fail=false,originalEpoch=0;
 const original=(target,ranges)=>({messages:ranges.flatMap(range=>Array.from({length:range.end-range.start+1},(_,offset)=>({floor:range.start+offset,text:`虚构聊天第${range.start+offset}楼，与33计划有关。版本${originalEpoch}`})))});
 const provider=createAiProvider({getConfig:()=>config,transport:{generate:async request=>{requests.push(request);if(delay)await new Promise(done=>setTimeout(done,delay));if(fail){fail=false;throw Error('fixture failure');}return JSON.stringify(respond?await respond(request):request.task==='memory.merge'?{title:'船票与再次见面的约定',body:('两人围绕33计划讨论船票并约定在码头再见。\n').repeat(12),coherenceWarning:'来源之间存在楼层间隙，请核对正文衔接。'}:{indexes:JSON.parse(request.messages.at(-1).content).summaryDrafts.map(draft=>({draftId:draft.draftId,eventKeywords:['约定'],detailKeywords:['33计划'],detailAliases:[{parentDetail:'33计划',aliases:['33']}]}))});}}});
 const manager=createBackgroundTaskManager(),service=createMemoryManagementService({repository,manager,provider,getGenerationSettings:()=>settings,getOriginalSnapshot:original});
 const controller=createManagementController({service,repository,getSettingsEpoch:()=>settings.epoch,getOriginalSnapshot:original,originalAvailable:()=>true});
 return {settings,config,requests,service,controller,getOriginalSnapshot:original,changeOriginal(){originalEpoch++;},enable(){config.source='sillytavern';settings.epoch++;},disable(){config.source=null;settings.epoch++;},failNext(){fail=true;}};
}
