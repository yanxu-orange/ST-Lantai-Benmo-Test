import {frozenSettingsCopy,recallChannels,recallCandidateCounts} from '../../shared/settings/model.js';
import {assertAiCurrent} from '../../shared/ai/provider.js';
import {buildRecall,prepareRecallData,bindings,memoryPrompt,reasonsOf,rankingFacts} from './build.js';
import {evaluateOrdinaryRecallWithAliases} from './detail-alias-relevance.js';
import {collectStoryTimeRecallEvidence} from './story-time-evidence.js';
import {collectSpecialDateRecallEvidence} from './special-date-evidence.js';
import {selectSpecialDateCandidates} from './special-date-selection.js';
import {orderMemoriesForNarrative} from './narrative-ordering.js';
import {createBodyIndex,rankBodyIndex,scoreBodyHistoryTermMax,rankDateCandidates,dateEligibility,collectRouteCandidates,scoreScannedRouteCandidates,scoreRankSensitiveRouteCandidates,recallQueryText,eventCardText,RRF_K} from './multichannel.js';

const safeCode=error=>['cancelled','stale','configuration','capability','mapping','timeout','http','authentication','endpoint','rate_limit','cors_network','request','task_preset_missing'].includes(error?.code)?error.code:'channel-failed';
const now=()=>globalThis.performance?.now?.()??Date.now();
export function usesMultichannel(settings){const value=recallChannels(settings);return Object.values(recallCandidateCounts(settings)).some(count=>count!==5)||!value.keyword||value.bm25||value.vector||value.rerank;}

// Owns only a local BM25 corpus cache. API credentials and host objects never
// enter the pure evidence/selection helpers or the existing preview worker.
export function createMultichannelBuilder({vectorIndex,provider}={}){
 let bodyCache=null;
 return async function buildMultichannel(input,{signal,isCurrent=()=>true,target,vectorConfig}={}){
  if(!usesMultichannel(input.settings))return buildRecall(input);
  assertAiCurrent(signal,isCurrent);const started=now(),data=prepareRecallData(input),{settings,active,memoryById,current,history,memories,recent,context,dated}=data;
  const enabled=recallChannels(settings),triggers=active.filter(event=>event.mode==='trigger'),order=new Map(active.map((event,index)=>[event.id,index]));
  const timeResult=collectStoryTimeRecallEvidence({memories:dated,currentInput:current.cleaned,recentHistory:recent,currentStoryTime:context.current,fictionalCalendar:context});
  const dateById=dateEligibility(timeResult),query=recallQueryText(current.cleaned,history),rankings={};
  const channels={keyword:{enabled:enabled.keyword,status:enabled.keyword?'ready':'disabled',qualified:0},bm25:{enabled:enabled.bm25,status:enabled.bm25?'ready':'disabled',qualified:0},vector:{enabled:enabled.vector,status:enabled.vector?'missing-index':'disabled',qualified:0},rerank:{enabled:enabled.rerank,status:enabled.rerank?'no-candidates':'disabled',elapsedMs:0}};
  let keyword=null,base=null;
  rankings.date=rankDateCandidates(timeResult,dateById);channels.date={enabled:true,status:'ready',qualified:rankings.date.length};
  if(enabled.keyword){
   keyword=evaluateOrdinaryRecallWithAliases({memories:dated,currentInput:current.cleaned,recentHistory:recent,bindings:bindings(memories),currentStoryTime:context.current,fictionalCalendar:context});base=keyword.base??keyword;
   const aliasOrder=new Map((keyword.aliasResult?.rankedReference??[]).map((row,index)=>[row.memoryId,index]));
   rankings.keyword=base.evaluated.filter(row=>row.qualificationPaths.some(path=>path.channel==='structured')).sort((a,b)=>(b.structuredRelevance??0)-(a.structuredRelevance??0)||(aliasOrder.has(a.memoryId)&&aliasOrder.has(b.memoryId)?aliasOrder.get(a.memoryId)-aliasOrder.get(b.memoryId):0)||a.libraryIndex-b.libraryIndex).map((row,index)=>({id:row.memoryId,rank:index+1,score:row.structuredRelevance??0}));
   channels.keyword.qualified=rankings.keyword.length;
  }
  if(enabled.bm25){
   try{
    const signature=JSON.stringify([triggers.map(event=>[event.id,event.body,event.people,event.places,event.locationAliases??[]]),settings.excludedTerms]);
    if(bodyCache?.signature!==signature)bodyCache={signature,index:createBodyIndex(triggers,settings.excludedTerms)};
    const bodyRows=rankBodyIndex(bodyCache.index,timeResult.fragments,dateById);
    rankings.bm25=enabled.keyword&&!enabled.vector&&!enabled.rerank?scoreBodyHistoryTermMax(bodyRows):bodyRows;channels.bm25.qualified=rankings.bm25.length;
   }catch{rankings.bm25=[];channels.bm25.status='failed';channels.bm25.error='local-retrieval-failed';}
  }
  if(enabled.vector){
   const started=now();
   try{
    if(!vectorIndex||!vectorConfig||vectorConfig.source!=='plugin')throw Object.assign(Error(),{code:'configuration'});
    const result=await vectorIndex.query({target,events:active,config:vectorConfig,text:query,signal,isCurrent,dateById});
    assertAiCurrent(signal,isCurrent);rankings.vector=result.rows;channels.vector={...channels.vector,...result,rows:undefined,qualified:result.rows.length};delete channels.vector.rows;
   }catch(error){assertAiCurrent(signal,isCurrent);rankings.vector=[];channels.vector.status='failed';channels.vector.error=safeCode(error);}
   channels.vector.elapsedMs=now()-started;
  }
  let collected=collectRouteCandidates(rankings,order,recallCandidateCounts(settings)),candidateById=new Map(collected.cards.map(row=>[row.id,row]));
  let ranked=[...collected.cards],orderingMethod='rrf',rrfK=RRF_K;
  if(enabled.rerank&&ranked.length){
   const started=now();
   try{
    if(!provider?.rerank)throw Object.assign(Error(),{code:'configuration'});
    const response=await provider.rerank({query,documents:ranked.map(row=>({id:row.id,text:eventCardText(memoryById.get(row.id))})),signal,isCurrent});
    assertAiCurrent(signal,isCurrent);
    if(!Array.isArray(response.rows)||response.rows.length!==ranked.length||new Set(response.rows.map(row=>row.id)).size!==ranked.length||response.rows.some(row=>!candidateById.has(row.id)||!Number.isFinite(row.score)))throw Object.assign(Error(),{code:'mapping'});
    ranked=response.rows.map((row,index)=>({...candidateById.get(row.id),rank:index+1,rerankScore:row.score}));orderingMethod='rerank';
    channels.rerank.status='ready';channels.rerank.modelIdentity=response.modelIdentity;
   }catch(error){assertAiCurrent(signal,isCurrent);channels.rerank.status='fallback';channels.rerank.error=safeCode(error);}
   channels.rerank.elapsedMs=now()-started;
  }
  // Keep successful rerank requests/results on the full-RRF candidate order.
  // Offline K+B uses actual scanned hits. Healthy K/B/V uses full hits with
  // reciprocal original ranks; unavailable/partial V keeps full RRF60.
  if(orderingMethod==='rrf'&&enabled.keyword&&enabled.bm25&&!enabled.vector){
   collected=scoreScannedRouteCandidates(collected,order);candidateById=new Map(collected.cards.map(row=>[row.id,row]));ranked=[...collected.cards];
  }else if(orderingMethod==='rrf'&&enabled.keyword&&enabled.bm25&&enabled.vector&&channels.vector.status==='ready'&&channels.bm25.status==='ready'){
   collected=scoreRankSensitiveRouteCandidates(collected,order);candidateById=new Map(collected.cards.map(row=>[row.id,row]));ranked=[...collected.cards];rrfK=0;
  }
  const timeById=new Map(timeResult.evaluated.map(row=>[row.memoryId,row]));
  const special=collectSpecialDateRecallEvidence({memories:dated,currentStoryTime:context.current,fictionalCalendar:context,items:input.time?.items??[],advanceDays:input.timeReminders?.anniversary?.advanceDays??3,automaticSameDayEnabled:settings.automaticSameDayEnabled});
  // Existing time-pool relevance is independent of whether K contributes to
  // ordinary candidates. Compute it only when time candidates actually exist.
  const timeRelevance=base??(special.candidates.length?evaluateOrdinaryRecallWithAliases({memories:dated,currentInput:current.cleaned,recentHistory:recent,bindings:bindings(memories),currentStoryTime:context.current,fictionalCalendar:context}):null);
  const specialRank=selectSpecialDateCandidates({specialResult:special,ordinaryResult:timeRelevance?.base??timeRelevance,limit:settings.anniversaryPoolLimit,fictionalCalendar:context});
  const specialById=new Map(special.evaluated.map(row=>[row.memoryId,row])),keywordById=new Map((base?.evaluated??[]).map(row=>[row.memoryId,row]));
  const routeById=Object.fromEntries(Object.entries(rankings).map(([route,rows])=>[route,new Map(rows.map(row=>[row.id,row]))]));
  const make=(id,pool,rank=null)=>{
   const card=candidateById.get(id),date=specialById.get(id)?.evidence??[],entry=keywordById.get(id);
   return{id,event:structuredClone(memoryById.get(id)),pool,qualified:true,rank,tokens:null,estimated:false,
    sources:pool==='resident'?['resident']:pool==='special'?[...(card?.sources??[]),'time']:[...(card?.sources??[])],
    reasons:[...(pool==='resident'?[{code:'resident'}]:[]),...reasonsOf(entry,keyword?.aliasResult,id),...date.map(row=>({code:row.kind,yearsAgo:row.yearsAgo,targetDate:row.targetDate,matchedDate:row.matchedDate}))],
    routeEvidence:{...(entry&&routeById.keyword?.has(id)?{keyword:rankingFacts(entry,routeById.keyword.get(id).rank)}:{}),...(routeById.bm25?.has(id)?{bm25:routeById.bm25.get(id)}:{}),...(routeById.vector?.has(id)?{vector:routeById.vector.get(id)}:{}),...(routeById.date?.has(id)?{date:routeById.date.get(id)}:{}),...(orderingMethod==='rerank'&&ranked.some(row=>row.id===id)?{rerank:{rank:ranked.find(row=>row.id===id).rank,score:ranked.find(row=>row.id===id).rerankScore}}:{})},
    dateEvidence:{ordinary:timeById.get(id)?.evaluations??[],suppressed:entry?.suppressedPaths??[],special:date},
    ranking:{pool,rank,maxCount:pool==='trigger'?settings.maxCount:pool==='special'?settings.anniversaryPoolLimit:null,...(pool==='trigger'?{score:card?.score??0,method:orderingMethod}:{} )}};
  };
  const ordinary=[],excluded=new Map();let totalTokens=0,estimated=false,tokenStopped=false;
  for(const row of ranked){
   if(row.rank>settings.maxCount){excluded.set(row.id,'count-limit');continue;}
   if(tokenStopped){excluded.set(row.id,'token-limit');continue;}
   const item=make(row.id,'trigger',row.rank);
   if(settings.maxTokens!==null){
    let measured;try{measured=input.countTokens?await input.countTokens(item.event.body):{tokens:Math.ceil(item.event.body.length/2),estimated:true};}catch{throw Error('召回 Token 计数失败');}assertAiCurrent(signal,isCurrent);
    const tokens=typeof measured==='number'?measured:measured?.tokens;if(!Number.isFinite(tokens)||tokens<0)throw Error('召回 Token 计数失败');
    item.tokens=tokens;item.estimated=typeof measured==='object'&&measured.estimated===true;estimated||=item.estimated;totalTokens+=tokens;tokenStopped=totalTokens>=settings.maxTokens;
   }
   ordinary.push(item);
  }
  const used=new Set(ordinary.map(row=>row.id)),specialSelected=[];
  for(const row of specialRank.canonical){if(specialSelected.length>=specialRank.limit)break;if(used.has(row.memoryId))continue;used.add(row.memoryId);specialSelected.push(make(row.memoryId,'special',specialSelected.length+1));}
  const selected=[...active.filter(event=>event.mode==='resident').map(event=>make(event.id,'resident')),...ordinary,...specialSelected],selectedIds=new Set(selected.map(row=>row.id));
  const eligibleSomewhere=new Set(Object.values(rankings).flatMap(rows=>rows.map(row=>row.id))),unselected=triggers.filter(event=>!selectedIds.has(event.id)).map(event=>{
   const item=make(event.id,'trigger',ranked.find(row=>row.id===event.id)?.rank??null);item.qualified=candidateById.has(event.id);
   item.excludedReason=excluded.get(event.id)??(specialById.get(event.id)?.eligible?'special-limit':dateById.get(event.id)?.blocked?'date-conflict':eligibleSomewhere.has(event.id)?'candidate-limit':!enabled.keyword&&!enabled.bm25&&!enabled.vector?'channel-disabled':enabled.vector&&['failed','missing-index'].includes(channels.vector.status)?'channel-unavailable':'insufficient-evidence');return item;
  });
  for(const item of selected)if(item.pool==='trigger'&&specialById.get(item.id)?.eligible&&!item.sources.includes('time'))item.sources.push('time');
  const memoryMap=new Map(memories.map(memory=>[memory.id,memory]));
  const narrative=orderMemoriesForNarrative({items:selected.map(item=>({memory:memoryMap.get(item.id),memoryId:item.id,libraryIndex:order.get(item.id)}))}),byId=new Map(selected.map(item=>[item.id,item]));
  const ordered=narrative.orderedIds.map(id=>byId.get(id));if(new Set(narrative.orderedIds).size!==selected.length)throw Error('duplicate-recall-id');assertAiCurrent(signal,isCurrent);
  return frozenSettingsCopy({version:'event-recall-multichannel-v1',time:{status:context.status,current:context.current,targets:timeResult.targets,specialTargets:special.targetResult.targets,diagnostics:special.targetResult.diagnostics},
   specialBudget:{limit:settings.anniversaryPoolLimit,selectedCount:specialSelected.length},matching:{input:current,history},selected:ordered,unselected,prompt:memoryPrompt(ordered.map(row=>row.event)),selectedIds:narrative.orderedIds,
   budget:{maxCount:settings.maxCount,maxTokens:settings.maxTokens,totalTokens:settings.maxTokens===null?null:totalTokens,estimated,scope:'ordinary-body',soft:true},ordering:{...narrative},diagnostics:keyword?.aliasResult?.diagnostics??[],
   multichannel:{channels,candidates:collected.cards,routeClaims:collected.routes,orderingMethod,rrfK,candidateCount:collected.cards.length,totalMs:now()-started,selectionNetworkMs:(channels.vector.elapsedMs??0)+(channels.rerank.elapsedMs??0)}});
 };
}
