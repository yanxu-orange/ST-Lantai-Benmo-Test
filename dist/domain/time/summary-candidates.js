import {createCalendar} from './calendar.js';
import {absoluteCandidates} from './absolute.js';
import {calendarCandidateKey,hasScheduleDateClue} from './schedule-model.js';

const copy=structuredClone;
const normalized=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/g,' ');
const summaryKey=(batchId,evidence)=>JSON.stringify(['summary',batchId,evidence.name,evidence.storyDate,evidence.reason]);
function dateOf(time,dateText,calendarId){
 const definition=time.calendars.find(row=>row.id===calendarId);
 if(!definition)return null;
 const text=dateText.trim(),dates=absoluteCandidates(createCalendar(definition),text,{chronology:time.chronology,bounded:true});
 return dates.length===1&&dates[0].start===0&&dates[0].end===text.length?dates[0].date:null;
}
function generatedId(sourceKey,candidates,items){
 // The digest labels the row; full source keys remain its reuse authority.
 let hash=2166136261;for(let index=0;index<sourceKey.length;index++){hash^=sourceKey.charCodeAt(index);hash=Math.imul(hash,16777619);}
 const prefix=`summary-date-${(hash>>>0).toString(16)}`,used=new Set([...candidates,...items].map(row=>row.id));
 let id=prefix,index=1;while(used.has(id))id=`${prefix}-${index++}`;return id;
}
function sameCandidate(left,right){
 return calendarCandidateKey(left)===calendarCandidateKey(right)||
  (left.calendarId===null||right.calendarId===null)&&left.kind===right.kind&&normalized(left.title)===normalized(right.title)&&normalized(left.dateText)===normalized(right.dateText);
}

// This consumes preserved first-stage evidence. Reviewed event order and IDs
// cannot establish ownership, so provenance names the batch and raw candidate.
export function importSummaryCandidates(time,batches,{calendarId=time.activeCalendarId}={}){
 const next=copy(time),items=next.items??[];let candidates=next.candidates??[];
 let changed=false;
 for(const batch of batches??[]){
  if(typeof batch?.id!=='string'||typeof batch.sourceSnapshot?.fingerprint!=='string')continue;
  const activeKeys=new Set((batch.generatedCandidates??[]).flatMap(original=>(original.specialDateCandidates??[]).map(evidence=>summaryKey(batch.id,evidence))));
  candidates=candidates.filter(candidate=>{
   if(candidate.status!=='pending'||candidate.manual===true)return true;
   const sources=candidate.sources??[candidate.source],removed=sources.filter(source=>source?.kind==='summary'&&source.batchId===batch.id&&!activeKeys.has(summaryKey(batch.id,source.evidence)));
   if(!removed.length)return true;
   const remaining=sources.filter(source=>!removed.includes(source));changed=true;
   if(!remaining.length)return false;
   const removedKeys=new Set(removed.map(source=>summaryKey(batch.id,source.evidence)));
   candidate.sources=remaining;candidate.sourceKeys=[candidate.sourceKey,...(candidate.sourceKeys??[])].filter((key,index,keys)=>!removedKeys.has(key)&&keys.indexOf(key)===index);
   if(removedKeys.has(candidate.sourceKey)){candidate.source=copy(remaining[0]);candidate.sourceKey=candidate.sourceKeys[0];}
   return true;
  });
  for(const original of batch.generatedCandidates??[])for(const evidence of original.specialDateCandidates??[]){
   if(typeof evidence?.name!=='string'||!evidence.name.trim()||!hasScheduleDateClue(evidence.storyDate)||typeof evidence.reason!=='string'||!evidence.reason.trim())continue;
   const sourceKey=summaryKey(batch.id,evidence);
   if(candidates.some(row=>row.sourceKey===sourceKey||row.sourceKeys?.includes(sourceKey)))continue;
   const resolvedCalendar=next.calendars.some(row=>row.id===calendarId)?calendarId:null;
   const source={kind:'summary',batchId:batch.id,fingerprint:batch.sourceSnapshot.fingerprint,evidence:copy(evidence),originalCandidate:copy(original),range:copy(batch.actualRange)};
   const candidate={id:'',kind:'anniversary',title:evidence.name.trim(),dateText:evidence.storyDate.trim(),reason:evidence.reason.trim(),description:evidence.reason.trim(),calendarId:resolvedCalendar,startDate:dateOf(next,evidence.storyDate,resolvedCalendar),repeat:'yearly',durationDays:1,status:'pending',sourceKey,source,sourceKeys:[sourceKey],sources:[source],itemId:null};
   const existing=candidates.find(row=>sameCandidate(row,candidate));
   if(existing){
    existing.sourceKeys=[...new Set([existing.sourceKey,...(existing.sourceKeys??[]),sourceKey])];
    existing.sources=[...(existing.sources??[existing.source]),source];changed=true;continue;
   }
   const item=candidate.startDate?items.find(row=>row.kind==='anniversary'&&calendarCandidateKey(row)===calendarCandidateKey(candidate)):null;
   if(item){candidate.status='adopted';candidate.itemId=item.id;}
   candidate.id=generatedId(sourceKey,candidates,items);candidates.push(candidate);changed=true;
  }
 }
 if(changed)next.candidates=candidates;
 return next;
}
