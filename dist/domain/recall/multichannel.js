import {tokenizerV2} from './body-tokenizer.js';
import {RECALL_REQUEST_LIMITS} from '../../shared/ai/recall-provider.js';

export const CHANNEL_CANDIDATE_LIMIT=5;
export const RRF_K=60;
export const CARD_TEXT_VERSION='event-card-v1';
export function eventCardText(event){
 return [`时间：${event.startTime??''}${event.endTime?' — '+event.endTime:''}`,`标题：${event.title??''}`,`人物：${event.people.join('、')}`,`地点：${event.places.join('、')}`,`事件：${event.eventWords.join('、')}`,`细节：${event.detailWords.map(row=>row.word).join('、')}`,`正文：${event.body}`].join('\n');
}
export function recallQueryText(current,history){
 if(!history.some(row=>row.cleaned.trim()))return current;
 return `当前输入\n${current}\n\n最近语境\n${history.map(row=>`[距当前 ${row.distanceFromCurrent} 楼]\n${row.cleaned}`).join('\n\n')}`;
}
export function createBodyIndex(events,excludedTerms=[]){
 const names=events.flatMap(event=>[...event.people,...event.places,...(event.locationAliases??[]).flatMap(row=>row.aliases)]);
 const tokenize=tokenizerV2(names,excludedTerms);
 const docs=events.map((event,libraryIndex)=>{const tokens=tokenize(event.body),tf=new Map();for(const term of tokens)tf.set(term,(tf.get(term)??0)+1);return{id:event.id,libraryIndex,length:tokens.length,tf};});
 const df=new Map();for(const doc of docs)for(const term of doc.tf.keys())df.set(term,(df.get(term)??0)+1);
 return{docs,df,tokenize,average:docs.reduce((n,row)=>n+row.length,0)/Math.max(1,docs.length)};
}
function maskRange(text,ranges){
 const chars=text.split('');for(const [start,end]of ranges)for(let i=start;i<end;i++)chars[i]=' ';return chars.join('');
}
// Time evidence comes from the same domain parser used by K. No keyword
// qualification is consulted when deciding B/V eligibility.
export function dateEligibility(timeResult){
 const fragments=timeResult.fragments;
 return new Map(timeResult.evaluated.map(row=>{
  const local=new Map(fragments.map(fragment=>{
   const evidence=row.evaluations.filter(item=>item.target.fragmentId===fragment.id);
   const support=evidence.some(item=>item.relation==='support');
   const veto=!support&&evidence.some(item=>item.relation==='conflict'&&item.target.canVetoFragment!==false);
   const keys=[...new Set(evidence.filter(item=>Array.isArray(item.target.scopeRange)).map(item=>JSON.stringify(item.target.scopeRange)))];
   const ranges=keys.flatMap(key=>{const group=evidence.filter(item=>JSON.stringify(item.target.scopeRange)===key);return group.some(item=>item.relation==='support')||!group.some(item=>item.relation==='conflict')?[]:[JSON.parse(key)];});
   return[fragment.id,{veto,ranges}];
  }));
  return[row.memoryId,{blocked:local.get('current:0')?.veto===true,partialScope:!!local.get('current:0')?.ranges.length&&!local.get('current:0')?.veto,
   textFor:fragment=>{const item=local.get(fragment.id);return item?.veto?'':maskRange(fragment.cleanedText,item?.ranges??[]);}}];
 }));
}
export function rankBodyIndex(index,fragments,dateById=new Map()){
 const queryTerms=new Map();
 return index.docs.map(doc=>{
  const date=dateById.get(doc.id);if(date?.blocked)return null;
  let score=0;const contributions=[];
  for(const fragment of fragments){
   const query=date?date.textFor(fragment):fragment.cleanedText;
   if(!queryTerms.has(query))queryTerms.set(query,[...new Set(index.tokenize(query))]);
   const terms=queryTerms.get(query),matched=terms.filter(term=>doc.tf.has(term)),termContributions=[];let raw=0;
   for(const term of matched){const tf=doc.tf.get(term),idf=Math.log(1+(index.docs.length-index.df.get(term)+0.5)/(index.df.get(term)+0.5)),value=idf*tf*2.2/(tf+1.2*(0.25+0.75*doc.length/(index.average||1)));raw+=value;termContributions.push({term,score:value});}
   const weight=fragment.sourceKind==='current'?1:1/(1+0.2*fragment.distanceFromCurrent);
   if(raw>0)contributions.push({fragmentId:fragment.id,sourceKind:fragment.sourceKind,distanceFromCurrent:fragment.distanceFromCurrent,matchedTerms:matched,termContributions,score:raw,weight});score+=raw*weight;
  }
  return{id:doc.id,score,libraryIndex:doc.libraryIndex,contributions};
 }).filter(row=>row&&Number.isFinite(row.score)&&row.score>0).sort((a,b)=>b.score-a.score||a.libraryIndex-b.libraryIndex).map((row,i)=>({...row,rank:i+1}));
}
export function rankDateCandidates(timeResult,dateById=dateEligibility(timeResult)){
 return timeResult.evaluated.flatMap(row=>{
  if(dateById.get(row.memoryId)?.blocked)return [];
  // Matching a scene/background date can remain non-veto evidence for another
  // route, but never grants independent D membership. D requires a surviving
  // explicit lookup scope; same-scope query alternatives retain support-wins.
  const supports=row.evaluations.filter(item=>item.relation==='support'&&item.target.timeRole==='recall-target'&&item.target.canSupport!==false&&item.target.status==='resolved'&&item.domain.comparable);
  if(!supports.length)return [];
  return[{id:row.memoryId,libraryIndex:row.libraryIndex,nearestDistance:Math.min(...supports.map(item=>item.target.distanceFromCurrent)),supports}];
 }).sort((a,b)=>a.nearestDistance-b.nearestDistance||a.libraryIndex-b.libraryIndex).map((row,index)=>({...row,rank:index+1}));
}
export function collectRouteCandidates(rankings,libraryOrder,limit=CHANNEL_CANDIDATE_LIMIT){
 const counts=typeof limit==='number'?Object.fromEntries(['keyword','bm25','vector','date'].map(route=>[route,limit])):limit;
 if(!counts||Object.keys(counts).length!==4||['keyword','bm25','vector','date'].some(route=>!Number.isSafeInteger(counts[route])||counts[route]<0||counts[route]>RECALL_REQUEST_LIMITS.candidatePerRoute))throw Error('candidate-limit');
 const routes=['keyword','bm25','vector','date'].filter(route=>rankings[route]);
 const state=Object.fromEntries(routes.map(route=>[route,{pointer:0,claimed:0,scanned:[]}])) ,candidates=new Map();
 for(const route of routes){const rows=rankings[route];if(!Array.isArray(rows)||rows.some(row=>!libraryOrder.has(row.id))||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('invalid-route-id');}
 while(routes.some(route=>state[route].pointer<rankings[route].length&&state[route].claimed<counts[route])){
  for(const route of routes){const lane=state[route];if(lane.claimed>=counts[route]||lane.pointer>=rankings[route].length)continue;
   const item=rankings[route][lane.pointer++],rank=lane.pointer;lane.scanned.push({id:item.id,rank});
   let card=candidates.get(item.id);if(!card){card={id:item.id,claimedBy:route,sources:[],hits:[]};candidates.set(item.id,card);lane.claimed++;}
   card.sources.push(route);card.hits.push({route,rank});
  }
 }
 // Quotas decide membership only. A selected card can also occur after another
 // lane's scan limit; preserve that real hit and its original rank for fusion.
 for(const route of routes)for(const [index,item]of rankings[route].entries()){
  const card=candidates.get(item.id);if(card&&!card.sources.includes(route)){card.sources.push(route);card.hits.push({route,rank:index+1});}
 }
 for(const card of candidates.values()){card.sources.sort((a,b)=>routes.indexOf(a)-routes.indexOf(b));card.hits.sort((a,b)=>routes.indexOf(a.route)-routes.indexOf(b.route));}
 const cards=[...candidates.values()].map(card=>({...card,score:card.hits.reduce((n,hit)=>n+1/(RRF_K+hit.rank),0)}))
  .sort((a,b)=>b.score-a.score||(libraryOrder.get(a.id)??Infinity)-(libraryOrder.get(b.id)??Infinity)).map((row,index)=>({...row,rank:index+1}));
 return{cards,routes:state};
}
export function cosine(left,right){
 if(left.length!==right.length)throw Error('dimension-mismatch');
 const a=Math.hypot(...left),b=Math.hypot(...right);if(!Number.isFinite(a)||!Number.isFinite(b)||a===0||b===0)throw Error('invalid-vector');
 let value=0;for(let i=0;i<left.length;i++)value+=(left[i]/a)*(right[i]/b);
 if(!Number.isFinite(value))throw Error('invalid-vector');return Math.max(-1,Math.min(1,value));
}
