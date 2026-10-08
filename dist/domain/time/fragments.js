import {storyDate,compareStoryDates} from './point.js';
import {absoluteCandidates,incompleteCandidates,monthIndex,dayNumber} from './absolute.js';
import {parseNumeral} from './transition.js';
import {maskMarkup} from './text.js';
const NUM='[\\d零〇元一二两三四五六七八九十]+';
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Partial dates only have meaning with an established date; never manufacture year 1.
function monthRank(token){const raw=token.replace(/月$/,''),leap=raw.startsWith('闰'),body=leap?raw.slice(1):raw;const n=({正:1,冬:11,腊:12})[body]??parseNumeral(body);return Number.isSafeInteger(n)?n*2+(leap?1:0):null;}
export function partialDate(calendar,text,base,{rollover=false}={}){
 if(!base||typeof text!=='string')return null;
 const origin=storyDate(calendar,base),names=calendar.months(origin.year).map(item=>escape(item.name)).sort((a,b)=>b.length-a.length);
 const monthToken=`(?:${names.join('|')}|(?:闰)?(?:正|冬|腊|${NUM})月)`;
 const patterns=[
  {re:new RegExp(`^(${monthToken})\\s*((?:初|廿)?${NUM}|廿)(?:\\s*[日号])?(?![\\d.．eE零〇元一二两三四五六七八九十])`),named:true},
  {re:/^(\d{1,2})[/.](\d{1,2})(?:\s*[日号])?(?![\d/.．eE零〇元一二两三四五六七八九十])/,named:false},
 ];
 for(const {re,named} of patterns){const m=text.match(re);if(!m)continue;
  const token=named?m[1]:`${m[1]}月`,sourceMonth=monthIndex(calendar,origin.year,token),day=dayNumber(m[2]);
  const sourceRank=(origin.month===null?null:monthRank(calendar.months(origin.year)[origin.month-1].name)),targetRank=monthRank(token);
  const crosses=sourceMonth!==null?sourceMonth<origin.month:sourceRank!==null&&targetRank!==null&&targetRank<sourceRank;
  const year=rollover&&crosses?origin.year+1:origin.year;
  const month=monthIndex(calendar,year,token);
  try{return {date:calendar.validate({...origin,year,month,day}),length:m[0].length,hasMonth:true};}catch{return null;}
 }
 const day=text.match(new RegExp(`^((?:初|廿)?${NUM}|廿)\\s*[日号](?![\\d零〇元一二两三四五六七八九十])`));
 if(day&&origin.month!==null){try{return {date:calendar.validate({...origin,day:dayNumber(day[1])}),length:day[0].length,hasMonth:false};}catch{return null;}}
 return null;
}
export function explicitPartialCandidates(calendar,text,base,{offset=0,bounded=false}={}){
 if(typeof text!=='string'||!Number.isSafeInteger(offset)||offset<0)throw new TypeError('日期片段来源无效');
 if(!base)return [];
 const plain=maskMarkup(text),results=[];
 const cue=/(?:今天|今日|现在|当前)\s*(?:是|到了?)?\s*|(?:(?:时间|剧情|故事)\s*)?(?:来到了?|到了?|推进到|推进至|进入了?)\s*|(?:当前)?(?:故事|剧情)?(?:日期|时间)[】\]]?\s*(?:显示(?:的是|为)?|变成了?|成为了?|是|为|[:：])\s*[：:—–\-]*\s*(?:(?:她|他|我|我们|他们|她们)\s*来到了?\s*)?/g;
 for(const match of plain.matchAll(cue)){
  const prefix=plain.slice(0,match.index).split(/[\r\n。！？!?]/).at(-1);
  const suffix=plain.slice(match.index).split(/[\r\n。！？!?]/)[0];
  if(/如果|假如|假设|倘若|梦里|梦中|梦见|回忆|回想|想起|记得|曾经|过去|提到|此前|当年|档案|资料|记录显示|准备在|计划|打算|将于|预定|预计/.test(prefix+suffix))continue;
  const start=match.index+match[0].length,part=partialDate(calendar,plain.slice(start),base);
  if(part)results.push({kind:'absolute',date:part.date,start:offset+start,end:offset+start+part.length});
 }
 if(bounded){const leading=plain.length-plain.trimStart().length,part=partialDate(calendar,plain.slice(leading),base);if(part)results.push({kind:'absolute',date:part.date,start:offset+leading,end:offset+leading+part.length});}
 return results;
}
// A complete explicit range is one textual candidate. Invalid/unknown ends
// invalidate that range instead of quietly accepting its left side.
export function rangeCandidates(calendar,text,{chronology={eras:[]},offset=0,bounded=false,baseDate=null,allowPartial=false,includeInvalid=false}={}){
 const plain=maskMarkup(text),absolute=[...absoluteCandidates(calendar,text,{chronology,offset:0,bounded}),...incompleteCandidates(calendar,text,{chronology,offset:0,bounded}),...(allowPartial?explicitPartialCandidates(calendar,text,baseDate,{bounded}):[])].sort((a,b)=>a.start-b.start||a.end-b.end);
 const consumed=new Set(),ranges=[];
 for(const left of absolute){
  if(consumed.has(left))continue;
  const tail=plain.slice(left.end);
  const separator=tail.match(/^[\s，,（()）]*(?:(?:星期[一二三四五六日天]|周[一二三四五六日天]|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[\s，,（()）]*)?(?:\d{1,2}[:：]\d{1,2}(?:[:：]\d{1,2})?[\s，,（()）]*)?(至|到|—|–|~|～|--|-)\s*/i);
  if(!separator)continue;
  const rightStart=left.end+separator[0].length,rightText=plain.slice(rightStart);
  const dateLike=/^(?:待定|未知|不详|\d|正月|冬月|腊月|闰|初|廿|[零〇元一二两三四五六七八九十]+[年月日号])/.test(rightText)||(chronology.eras??[]).some(era=>rightText.startsWith(era.name))||calendar.months(left.date.year).some(month=>rightText.startsWith(month.name));
  if(!dateLike)continue;
  const existing=absolute.find(item=>item.start===rightStart);
  const explicit=[...absoluteCandidates(calendar,rightText,{chronology,bounded:true}),...incompleteCandidates(calendar,rightText,{chronology,bounded:true})].find(item=>item.start===0);
  let right=explicit?{date:explicit.date,length:explicit.end,hasMonth:true}:partialDate(calendar,rightText,left.date,{rollover:true});
  const clock=rightText.match(/^(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?(?!\d)/);
  if(!right&&clock&&Number(clock[1])<24&&Number(clock[2])<60&&(clock[3]===undefined||Number(clock[3])<60))right={date:left.date,length:clock[0].length,hasMonth:false};
  consumed.add(left);if(existing)consumed.add(existing);
  if(!right){if(includeInvalid){const stop=rightText.search(/[\r\n。！？!?，,；;]/),next=absolute.find(item=>item.start>rightStart);const length=Math.min(stop<0?rightText.length:stop,next?next.start-rightStart:Infinity);ranges.push({kind:'invalidRange',range:true,start:offset+left.start,end:offset+rightStart+length});}continue;}
  const comparison=compareStoryDates(calendar,right.date,left.date);
  const date=comparison===null||comparison>=0?right.date:left.date;
  ranges.push({kind:'absolute',range:true,date,start:offset+left.start,end:offset+rightStart+right.length});
 }
 return [...absolute.filter(item=>!consumed.has(item)).map(item=>({...item,start:item.start+offset,end:item.end+offset})),...ranges].sort((a,b)=>a.start-b.start||a.end-b.end);
}
