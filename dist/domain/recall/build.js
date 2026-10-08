import {activeEvents,validateEvent} from '../memory/model.js';
import {assertBatch} from '../summary/data.js';
import {applySummaryCleaningRules} from '../summary/cleaning.js';
import {assertRecallSettings,defaultRecallSettings,frozenSettingsCopy} from '../../shared/settings/model.js';
import {evaluateOrdinaryRecallWithAliases} from './detail-alias-relevance.js';
import {orderMemoriesForNarrative} from './narrative-ordering.js';
import {dateContext,memoryDatePoint} from './date-facts.js';
import {collectSpecialDateRecallEvidence} from './special-date-evidence.js';
import {routeRecallPoolsV2} from './special-date-selection.js';
import {parseStoryTimePoint} from './narrative-time.js';

const copy=value=>structuredClone(value);
export function extractRecallInputs(chat,{recentFloorCount=6,input,currentIndex}={}){
  if(!Array.isArray(chat)||!Number.isSafeInteger(recentFloorCount)||recentFloorCount<0)throw new TypeError('召回输入无效');
  const text=message=>String(message?.mes??message?.content??'').trim(),eligible=message=>message&&!message.is_system&&message.role!=='system';
  if(currentIndex===undefined){currentIndex=chat.findLastIndex(message=>eligible(message)&&message.is_user===true&&text(message));if(currentIndex<0)currentIndex=chat.findLastIndex(message=>eligible(message)&&text(message));}
  if(input!==undefined&&typeof input!=='string')throw new TypeError('召回当前文本无效');
  if(!Number.isSafeInteger(currentIndex)||currentIndex< -1||currentIndex>chat.length||(currentIndex===chat.length&&typeof input!=='string'))throw new TypeError('召回楼层无效');
  const history=chat.slice(0,Math.max(0,currentIndex)).map((message,floor)=>({floor,text:text(message),eligible:eligible(message)})).filter(item=>item.eligible&&item.text).reverse().slice(0,recentFloorCount).map(item=>({floor:item.floor,text:item.text,distanceFromCurrent:currentIndex-item.floor}));
  return {input:input??(currentIndex>=0?text(chat[currentIndex]):''),currentIndex,recentHistory:history};
}
function evidenceMemories(events,settings,batches){
  const excluded=new Set(settings.excludedTerms),ordinals=new Map();
  for(const batch of batches){try{assertBatch(batch);}catch{continue;}
    const members=batch.eventIds.map(id=>events.find(event=>event.id===id));
    if(members.some(event=>!event||event.supersededBy||event.mergedFrom||event.batch?.id!==batch.id||JSON.stringify(event.batch.sources)!==JSON.stringify([batch.actualRange])))continue;
    members.forEach((event,index)=>ordinals.set(event.id,{batchId:batch.id,eventOrdinal:index+1}));
  }
  return events.map(event=>({id:event.id,mode:event.mode,title:excluded.has(event.title)?'':event.title,body:event.body,
    people:event.people.filter(word=>!excluded.has(word)),locations:event.places.filter(word=>!excluded.has(word)),
    keywords:{event:event.eventWords.filter(word=>!excluded.has(word)),detail:event.detailWords.filter(term=>!excluded.has(term.word)).map(term=>term.word)},
    time:{start:parseStoryTimePoint(event.startTime),end:parseStoryTimePoint(event.endTime)},source:ordinals.get(event.id)??{},
    terms:event.detailWords.filter(term=>!excluded.has(term.word)).map(term=>({...term,aliases:term.aliases.filter(alias=>!excluded.has(alias))}))}));
}
function bindings(memories){return memories.flatMap(memory=>memory.terms.map((term,detailIndex)=>({memoryId:memory.id,termId:term.id,detailIndex,parentDetail:term.word,aliases:term.aliases})));}
function reasonsOf(evaluation,aliases,id){
  const reasons=[];
  for(const parent of evaluation?.structuredEvidence?.evidence?.parentFacts??[])for(const witness of parent.witnesses??[])reasons.push({code:'keyword-match',field:witness.field,term:witness.storedValue,sourceKind:witness.sourceKind,distanceFromCurrent:witness.distanceFromCurrent,fragmentId:witness.fragmentId});
  for(const alias of aliases?.candidates??[])if(alias.memoryId===id)reasons.push({code:'alias-match',term:alias.parentDetail,alias:alias.matchedAlias,sourceKind:alias.sourceKind,distanceFromCurrent:alias.distanceFromCurrent,qualified:alias.qualificationEligible,rankingEligible:alias.rankingEligible,suppressionReasons:alias.suppressionReasons});
  for(const path of evaluation?.qualificationPaths??[])reasons.push({code:path.reason?.code??path.channel,sourceKind:path.sourceKind,distanceFromCurrent:path.distanceFromCurrent});
  return [...new Map(reasons.map(reason=>[JSON.stringify(reason),reason])).values()];
}
function rankingFacts(entry,rank){
  const evidence=entry.structuredEvidence;
  return {rank,score:entry.structuredRelevance??0,
    contributions:(evidence?.parentContributions??[]).map(parent=>({term:parent.selectedWitness?.storedValue,
      field:parent.selectedWitness?.field,sourceKind:parent.selectedWitness?.sourceKind,distanceFromCurrent:parent.selectedWitness?.distanceFromCurrent,
      value:parent.consumedValue,sourceReliability:parent.sourceReliability,frequencyAdjustment:parent.frequencyAdjustment,
      specificityAdjustment:parent.specificityAdjustment,matchReliability:parent.matchReliability,saturationFactor:parent.saturationFactor??1,
      suppressionReasons:parent.suppressionReasons})),
    combinations:(evidence?.bundleContributions??[]).filter(bundle=>bundle.consumedValue>0).map(bundle=>({roles:bundle.roles,value:bundle.consumedValue}))};
}
export function memoryPrompt(events){if(!events.length)return '';return ['<lantai_event_memory>','以下内容是过去已经发生的记忆，可能与最近的讨论有关。请将其作为事实与经历参考，自然保持连续性；不要机械复述，也不要声称看见了记忆条目。',...events.map(event=>`【${event.startTime&&event.endTime?`${event.startTime} — ${event.endTime}`:event.startTime||event.endTime}｜${event.title}】\n${event.body}`),'</lantai_event_memory>'].join('\n\n');}

export async function buildRecall({events,batches=[],input='',recentHistory=[],settings=defaultRecallSettings(),countTokens=null,time=null,timeAvailable=true,timeReminders=null}={}){
  settings=assertRecallSettings(settings);
  if(!Array.isArray(events)||!Array.isArray(batches)||typeof input!=='string'||!Array.isArray(recentHistory)||countTokens!==null&&typeof countTokens!=='function')throw new TypeError('召回快照无效');
  const ids=new Set();for(const event of events){validateEvent(event);if(ids.has(event.id))throw new TypeError('召回身份重复');ids.add(event.id);}
  const active=copy(activeEvents(events)),memoryById=new Map(active.map(event=>[event.id,event]));
  const cleaning=raw=>{const result=applySummaryCleaningRules(raw,settings.recallCleaning.rules);return {raw,cleaned:result.text,cleaningResults:result.results};};
  const current=cleaning(input),distances=new Set();
  const history=recentHistory.slice(0,settings.recentFloorCount).map(item=>{if(!item||!Number.isSafeInteger(item.floor)||item.floor<0||!Number.isSafeInteger(item.distanceFromCurrent)||item.distanceFromCurrent<1||distances.has(item.distanceFromCurrent)||typeof item.text!=='string')throw new TypeError('召回语境无效');distances.add(item.distanceFromCurrent);return {floor:item.floor,distanceFromCurrent:item.distanceFromCurrent,...cleaning(item.text)};});
  const memories=evidenceMemories(active,settings,batches),recent=history.map(item=>({rawPosition:item.floor,distanceFromCurrent:item.distanceFromCurrent,originalText:item.raw,cleanedText:item.cleaned}));
  const context=dateContext(time,{available:timeAvailable}),dated=memories.map(memory=>({...memory,time:{start:memoryDatePoint(memoryById.get(memory.id).startTime,context),end:memoryDatePoint(memoryById.get(memory.id).endTime,context)}}));
  const evaluation=evaluateOrdinaryRecallWithAliases({memories:dated,currentInput:current.cleaned,recentHistory:recent,bindings:bindings(memories),currentStoryTime:context.current,fictionalCalendar:context}),base=evaluation.base??evaluation,aliases=evaluation.aliasResult;
  const residents=dated.filter(memory=>memory.mode==='resident'),residentEvidence=residents.length?evaluateOrdinaryRecallWithAliases({memories:residents.map(memory=>({...memory,mode:'trigger'})),currentInput:current.cleaned,recentHistory:recent,bindings:bindings(residents),currentStoryTime:context.current,fictionalCalendar:context}):null;
  const residentBase=residentEvidence?.base??residentEvidence;
  const aliasRanks=new Map((aliases?.rankedReference??[]).map((item,index)=>[item.memoryId,index]));
  const special=collectSpecialDateRecallEvidence({memories:dated,currentStoryTime:context.current,fictionalCalendar:context,items:time?.items??[],advanceDays:timeReminders?.anniversary?.advanceDays??3,automaticSameDayEnabled:settings.automaticSameDayEnabled});
  const routing=routeRecallPoolsV2({memories:dated,ordinaryResult:base,specialResult:special,specialLimit:settings.anniversaryPoolLimit,ordinaryLimit:settings.maxCount,ordinaryRankedReference:aliases?.rankedReference??null,fictionalCalendar:context});
  const ranked=routing.ordinary.canonical,specialIds=new Set(routing.specialPool.selectedIds),specialById=new Map(special.evaluated.map(x=>[x.memoryId,x]));
  const asItem=(id,pool,entry)=>({id,event:copy(memoryById.get(id)),pool,qualified:pool==='resident'||pool==='special'||entry?.ordinaryQualified===true,rank:pool==='trigger'&&entry?.ordinaryQualified===true?ranked.findIndex(item=>item.memoryId===id)+1:null,reasons:[...(pool==='resident'?[{code:'resident'}]:[]),...reasonsOf(entry,pool==='resident'?residentEvidence?.aliasResult:aliases,id).map(reason=>({...reason,...(reason.term&&memoryById.get(id).detailWords.find(term=>term.word===reason.term)?{termId:memoryById.get(id).detailWords.find(term=>term.word===reason.term).id}:{})}))],tokens:null,estimated:false});
  const selected=[...residents.map(memory=>asItem(memory.id,'resident',residentBase?.evaluated.find(item=>item.memoryId===memory.id))),...routing.specialPool.selected.map(item=>asItem(item.memoryId,'special',base.evaluated.find(e=>e.memoryId===item.memoryId)))],unselected=[];
  let totalTokens=0,estimated=false,tokenStopped=false;
  for(const entry of ranked){const item=asItem(entry.memoryId,'trigger',entry);if(item.rank>settings.maxCount){unselected.push({...item,excludedReason:'count-limit'});continue;}if(tokenStopped){unselected.push({...item,excludedReason:'token-limit'});continue;}
    if(settings.maxTokens!==null){try{const measured=countTokens?await countTokens(item.event.body):{tokens:Math.ceil(item.event.body.length/2),estimated:true};const tokens=typeof measured==='number'?measured:measured?.tokens;if(!Number.isFinite(tokens)||tokens<0)throw new Error();item.tokens=tokens;item.estimated=typeof measured==='object'&&measured.estimated===true;estimated||=item.estimated;totalTokens+=tokens;tokenStopped=totalTokens>=settings.maxTokens;}catch{throw new Error('召回 Token 计数失败');}}
    selected.push(item);
  }
  for(const entry of base.evaluated.filter(item=>!item.ordinaryQualified&&!specialIds.has(item.memoryId)))unselected.push({...asItem(entry.memoryId,'trigger',entry),excludedReason:specialById.get(entry.memoryId)?.eligible?'special-limit':'insufficient-evidence'});
  // Explanation only: capture the exact competition keys before narrative reordering.
  const competitionRanks=new Map(ranked.map((entry,index)=>[entry.memoryId,index+1]));
  const factsById=new Map(base.evaluated.map(entry=>[entry.memoryId,rankingFacts(entry,competitionRanks.get(entry.memoryId)??null)]));
  for(const item of [...selected,...unselected]){
    const entry=(item.pool==='resident'?residentBase:base)?.evaluated.find(x=>x.memoryId===item.id);
    item.dateEvidence={ordinary:entry?.timeEvaluations??[],suppressed:entry?.suppressedPaths??[],special:specialById.get(item.id)?.evidence??[]};
    item.reasons.push(...item.dateEvidence.special.map(e=>({code:e.kind,yearsAgo:e.yearsAgo,targetDate:e.targetDate,matchedDate:e.matchedDate})));
    if(item.pool==='special'){item.ranking={pool:'special',rank:routing.specialPool.selectedIds.indexOf(item.id)+1,maxCount:settings.anniversaryPoolLimit};continue;}
    if(item.pool==='resident'){item.ranking={pool:'resident',rank:null};continue;}
    const facts=factsById.get(item.id);
    item.ranking={pool:'trigger',...facts,maxCount:settings.maxCount};
  }
  const memoryMap=new Map(memories.map(memory=>[memory.id,memory])),ordering=orderMemoriesForNarrative({items:selected.map(item=>({memory:memoryMap.get(item.id),memoryId:item.id,libraryIndex:memories.findIndex(memory=>memory.id===item.id)}))});
  const byId=new Map(selected.map(item=>[item.id,item])),ordered=ordering.orderedIds.map(id=>byId.get(id));
  if(new Set(ordering.orderedIds).size!==ordering.orderedIds.length)throw new Error('召回记忆重复');
  return frozenSettingsCopy({version:'event-recall-v2',time:{status:context.status,current:context.current,targets:base.timeResult.targets,specialTargets:special.targetResult.targets,diagnostics:special.targetResult.diagnostics},specialBudget:{limit:settings.anniversaryPoolLimit,selectedCount:routing.specialPool.selectedIds.length},matching:{input:current,history},selected:ordered,unselected,prompt:memoryPrompt(ordered.map(item=>item.event)),selectedIds:ordering.orderedIds,
    budget:{maxCount:settings.maxCount,maxTokens:settings.maxTokens,totalTokens:settings.maxTokens===null?null:totalTokens,estimated,scope:'ordinary-body',soft:true},
    ordering:{orderedIds:ordering.orderedIds,strongEdges:ordering.strongEdges,retainedOrdinalEdges:ordering.retainedOrdinalEdges,suppressedOrdinalEdges:ordering.suppressedOrdinalEdges,diagnostics:ordering.diagnostics},diagnostics:aliases?.diagnostics??[]});
}
