import {formatStoryDate} from '../time/prompts.js';
import {recallCalendar,timePrecisionRank,compareTimeValues} from './date-facts.js';
import {occurrence} from '../time/occurrence.js';
import {ruleDates,ruleYearBounds} from '../time/date-rule.js';
export function buildSpecialDateEligibilityTargets({currentStoryTime=null,automaticSameDayEnabled=true,fictionalCalendar={},items=[],advanceDays=3}={}){
 const current=currentStoryTime?.value,targets=[],diagnostics=[];
 if(!current||timePrecisionRank(current)<3)return {targets,diagnostics:[{code:'current-story-time-insufficient'}],occurrences:[]};
 const cal=recallCalendar(fictionalCalendar);
 for(const item of items){
  if(item.kind!=='anniversary'||!item.enabled||item.calendarId!==cal.definition.id)continue;
  const value=occurrence(cal,item,current);if(!value)continue;
  const until=cal.distance(current,value.start),lead=item.advanceDays??advanceDays;
  if(until<0||until>lead)continue;
  const originYear=item.startYear??item.startDate?.year??null;
  const targetDate={...value.start,precision:'day',calendar:cal.definition.type,era:null};
  const name={id:item.id,name:item.title,startYearRaw:originYear===null?'':String(originYear),startYear:originYear===null?null:{...targetDate,year:originYear,month:null,day:null,precision:'year'}};
  targets.push({id:JSON.stringify(['named',item.id,targetDate]),kind:'named',targetDate,dateRule:item.dateRule?structuredClone(item.dateRule):null,calendarIdentity:{calendar:cal.definition.type,calendarId:cal.definition.id,era:null},occurrence:{occurrenceKind:until?'advance':'day',daysUntil:until,anniversary:{id:item.id,status:'enabled',month:targetDate.month,day:targetDate.day,names:[name]}}});
 }
 if(automaticSameDayEnabled)targets.push({id:JSON.stringify(['automatic',current]),kind:'automatic',targetDate:{...current},calendarIdentity:{calendar:cal.definition.type,calendarId:cal.definition.id,era:null},occurrence:null});
 return {targets,diagnostics,occurrences:targets.filter(x=>x.occurrence).map(x=>x.occurrence)};
}
function interval(memory){
 const a=memory.time?.start,b=memory.time?.end;
 const start=a?.status==='parsed'?a.value:null,end=b?.status==='parsed'?b.value:null;
 if(!start&&a?.raw?.trim()||!end&&b?.raw?.trim())return null;
 const from=start??end,to=end??start;
 if(!from||!to||timePrecisionRank(from)<3||timePrecisionRank(to)<3||compareTimeValues(from,to)===null||compareTimeValues(from,to)>0)return null;
 return {from,to};
}
function matchYear(cal,range,target,year,dateRule=null){
 if(!dateRule&&(year<range.from.year||year>range.to.year||year>=target.year))return null;
 const points=dateRule?ruleDates(cal,dateRule,year):[cal.shiftYears(target,year-target.year)];
 return points.find(point=>point&&point.year<target.year&&(dateRule||point.day===target.day)&&cal.compare(point,range.from)>=0&&cal.compare(point,range.to)<=0)??null;
}
export function collectSpecialDateRecallEvidence({memories=[],currentStoryTime=null,automaticSameDayEnabled=true,fictionalCalendar={},items=[],advanceDays=3}={}){
 const targetResult=buildSpecialDateEligibilityTargets({currentStoryTime,automaticSameDayEnabled,fictionalCalendar,items,advanceDays}),cal=recallCalendar(fictionalCalendar);
 const evaluated=memories.map((memory,libraryIndex)=>{
  const range=interval(memory),evidence=[],diagnostics=[];
  if(!range)diagnostics.push({code:'memory-date-range-unavailable'});
  else for(const target of targetResult.targets){
   if(range.from.calendarId!==target.targetDate.calendarId||range.to.calendarId!==target.targetDate.calendarId){diagnostics.push({code:'incomparable-calendar',targetId:target.id});continue;}
   let point=null;const bounds=target.dateRule?ruleYearBounds(cal,target.dateRule):{min:1,max:9999};
   for(let year=Math.min(range.to.year,target.targetDate.year-1,bounds.max);year>=Math.max(bounds.min,range.from.year-(target.dateRule?1:0));year--){
    point=matchYear(cal,range,target.targetDate,year,target.dateRule);if(point)break;
   }
   if(!point)continue;
   const basis={targetId:target.id,targetDate:structuredClone(target.targetDate),memoryEnd:structuredClone(range.to),matchedDate:point,matchedLabel:formatStoryDate(cal,point,fictionalCalendar.chronology),memoryInterval:structuredClone(range),calendarIdentity:{target:target.calendarIdentity,memory:{calendarId:range.from.calendarId}},comparable:true,yearsAgo:target.targetDate.year-point.year};
   if(target.kind==='automatic'){evidence.push({kind:'automatic-same-day',...basis});continue;}
   evidence.push({kind:'named-same-day',...basis,anniversaryId:target.occurrence.anniversary.id,occurrenceKind:target.occurrence.occurrenceKind,names:structuredClone(target.occurrence.anniversary.names)});
   for(const name of target.occurrence.anniversary.names){
    const origin=name.startYear&&matchYear(cal,range,target.targetDate,name.startYear.year,target.dateRule);
    if(origin)evidence.push({kind:'named-origin',...basis,matchedDate:origin,matchedLabel:formatStoryDate(cal,origin,fictionalCalendar.chronology),yearsAgo:target.targetDate.year-origin.year,anniversaryId:target.occurrence.anniversary.id,occurrenceKind:target.occurrence.occurrenceKind,name:structuredClone(name),startYear:structuredClone(name.startYear)});
   }
  }
  return {memoryId:memory.id,libraryIndex,mode:memory.mode,memoryEnd:range?structuredClone(range.to):null,eligible:evidence.length>0,evidence,diagnostics};
 });
 return {version:'special-date-interval-v2',targetResult,occurrences:targetResult.occurrences,evaluated,candidates:evaluated.filter(x=>x.eligible),candidateIds:evaluated.filter(x=>x.eligible).map(x=>x.memoryId)};
}
