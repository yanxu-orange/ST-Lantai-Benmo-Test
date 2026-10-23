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
// Compatibility map for B/V callers: date evidence never blocks or masks text.
export function dateEligibility(timeResult){
 return new Map(timeResult.evaluated.map(row=>[row.memoryId,{
  blocked:false,partialScope:false,textFor:fragment=>fragment.cleanedText,
 }]));
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
// Adopted K+B and healthy K/B/V keep the current query intact and consume
// each historical term once, after its original distance weight. Equal values retain the first
// fragment; evidence contains only the contributions that actually vote.
export function scoreBodyHistoryTermMax(rows){
 return rows.map(row=>{
  const winners=new Map();
  row.contributions.forEach((fragment,index)=>{if(fragment.sourceKind==='current')return;for(const term of fragment.termContributions){const weighted=term.score*fragment.weight,old=winners.get(term.term);if(!old||weighted>old.weighted)winners.set(term.term,{index,weighted});}});
  const contributions=row.contributions.flatMap((fragment,index)=>{
   if(fragment.sourceKind==='current')return [fragment];
   const terms=fragment.termContributions.filter(term=>winners.get(term.term)?.index===index);if(!terms.length)return [];
   return [{...fragment,matchedTerms:terms.map(term=>term.term),termContributions:terms,score:terms.reduce((sum,term)=>sum+term.score,0)}];
  });
  return {...row,contributions,score:contributions.reduce((sum,fragment)=>sum+fragment.score*fragment.weight,0)};
 }).sort((a,b)=>b.score-a.score||a.libraryIndex-b.libraryIndex).map((row,index)=>({...row,rank:index+1}));
}
export function rankDateCandidates(timeResult,dateById=dateEligibility(timeResult)){
 return timeResult.evaluated.flatMap(row=>{
  if(dateById.get(row.memoryId)?.blocked)return [];
  // Every resolved, comparable date support may propose a D candidate.
  const supports=row.evaluations.filter(item=>item.relation==='support'&&item.target.canSupport!==false&&item.target.status==='resolved'&&item.domain.comparable);
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
// Candidate discovery and complete provenance stay intact. Only actual scanned
// hits vote; duplicate-refill hits retain their original (possibly deep) rank.
export function scoreScannedRouteCandidates(collected,libraryOrder){
 const scanned=new Map(Object.entries(collected.routes).map(([route,lane])=>[route,new Map(lane.scanned.map(hit=>[hit.id,hit.rank]))]));
 const cards=collected.cards.map(card=>({...card,score:card.hits.reduce((sum,hit)=>sum+(scanned.get(hit.route)?.get(card.id)===hit.rank?1/(RRF_K+hit.rank):0),0)}))
  .sort((a,b)=>b.score-a.score||(libraryOrder.get(a.id)??Infinity)-(libraryOrder.get(b.id)??Infinity)).map((card,index)=>({...card,rank:index+1}));
 return{...collected,cards};
}
// Healthy K/B/V fusion uses the same complete real hits with greater rank
// discrimination. Membership, ownership and scan/refill provenance stay intact.
export function scoreRankSensitiveRouteCandidates(collected,libraryOrder){
 const cards=collected.cards.map(card=>({...card,score:card.hits.reduce((sum,hit)=>sum+1/hit.rank,0)}))
  .sort((a,b)=>b.score-a.score||(libraryOrder.get(a.id)??Infinity)-(libraryOrder.get(b.id)??Infinity)).map((card,index)=>({...card,rank:index+1}));
 return{...collected,cards};
}
export function cosine(left,right){
 if(left.length!==right.length)throw Error('dimension-mismatch');
 const a=Math.hypot(...left),b=Math.hypot(...right);if(!Number.isFinite(a)||!Number.isFinite(b)||a===0||b===0)throw Error('invalid-vector');
 let value=0;for(let i=0;i<left.length;i++)value+=(left[i]/a)*(right[i]/b);
 if(!Number.isFinite(value))throw Error('invalid-vector');return Math.max(-1,Math.min(1,value));
}
