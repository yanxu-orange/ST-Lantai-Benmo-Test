import {storyDate} from './point.js';
import {maskMarkup} from './text.js';
import {toUnifiedYear} from './chronology.js';
import {parseNumeral} from './transition.js';
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const NUM='[\\d零〇元一二两三四五六七八九十]+';
const notCurrent=/(如果|假如|假设|倘若|梦里|梦中|梦见|回忆|回想|想起|记得|曾经|过去|提到|此前|当年|当时|当初|那是\s*\d{1,4}年(?:初|底|末)|那段时间|早在|档案|资料|记录显示|计划|打算|准备在|将于|预定|预计)/;
export function dayNumber(text){
 if(text.startsWith('初'))return /^初[一二三四五六七八九十]$/.test(text)?parseNumeral(text.slice(1)):null;
 if(text.startsWith('廿'))return /^廿[一二三四五六七八九]?$/.test(text)?20+(text.length===1?0:parseNumeral(text.slice(1))):null;
 if(/^[零〇元一二两三四五六七八九]{2,}$/.test(text))return null;
 return parseNumeral(text);
}
export function monthIndex(calendar,year,token){
 if(!Number.isSafeInteger(year)||year<1||year>9999)return null;
 const list=calendar.months(year),exact=list.findIndex(item=>item.name===token);
 if(exact>=0)return exact+1;
 const raw=token.replace(/月$/,''),leap=raw.startsWith('闰'),body=leap?raw.slice(1):raw;
 const number=({正:1,冬:11,腊:12})[body]??parseNumeral(body);
 if(!number)return null;
 if(calendar.definition.type==='dynasty'){
  const i=list.findIndex(item=>(item.number??item.ordinal)===number&&Boolean(item.isLeap)===leap);
  if(i>=0)return i+1;
  // Imported names are identities even when ordinal metadata is absent.
  const aliases=[`${leap?'闰':''}${number}月`,`${leap?'闰':''}${({1:'正',11:'冬',12:'腊'})[number]??number}月`];
  const named=list.findIndex(item=>{
   if(aliases.includes(item.name))return true;
   const name=item.name.replace(/月$/,'');if(name.startsWith('闰')!==leap)return false;
   const body=leap?name.slice(1):name;return (({正:1,冬:11,腊:12})[body]??parseNumeral(body))===number;
  });return named<0?null:named+1;
 }
 return leap?null:number;
}
export function absoluteCandidates(calendar,text,{chronology={eras:[]},offset=0,bounded=false}={}){
 if(typeof text!=='string'||!Number.isSafeInteger(offset)||offset<0)throw new TypeError('日期来源无效');
 const plain=maskMarkup(text);
 const found=[],eraSpans=[];
 const add=(match,year,month,day)=>{
  if(!bounded){const before=plain.slice(0,match.index).split(/[\r\n。！？!?]/).at(-1),after=plain.slice(match.index).split(/[\r\n。！？!?]/)[0];if(notCurrent.test(before+after))return;}
  try { const date=calendar.validate({calendarId:calendar.definition.id,year,month,day});found.push({kind:'absolute',date,start:offset+match.index,end:offset+match.index+match[0].length}); } catch { /* Invalid date does not become a current date. */ }
 };
 const namedMonths=calendar.definition.type==='custom'?calendar.definition.months.map(item=>escape(item.name)).sort((a,b)=>b.length-a.length):[];
 const monthToken=namedMonths.length?`(?:${namedMonths.join('|')})`:`(?:闰)?(?:正|冬|腊|${NUM})月`;
 for(const era of [...(chronology.eras??[])].sort((a,b)=>b.name.length-a.name.length)){
  const pattern=new RegExp(`${escape(era.name)}\\s*(${NUM})\\s*年\\s*(${monthToken})\\s*((?:初|廿)?${NUM}|廿)(?:\\s*[日号])?(?![\\d零〇元一二两三四五六七八九十])`,'g');
  for(const match of plain.matchAll(pattern)){
   if(eraSpans.some(([start,end])=>match.index<end&&match.index+match[0].length>start))continue;
   eraSpans.push([match.index,match.index+match[0].length]);
   const year=toUnifiedYear(chronology,era.name,parseNumeral(match[1]));if(year===null)continue;
   add(match,year,monthIndex(calendar,year,match[2]),dayNumber(match[3]));
  }
 }
 const pattern=/(?<!\d)(\d{1,4})\s*(?:年\s*|[/.\-]\s*)(\d{1,2})\s*(?:月\s*|[/.\-]\s*)(\d{1,2})(?:\s*[日号])?(?![\d.．eE零〇元一二两三四五六七八九十])/g;
 for(const match of plain.matchAll(pattern)){
  if(eraSpans.some(([start,end])=>match.index>=start&&match.index<end))continue;
  const prefix=plain.slice(0,match.index),linePrefix=prefix.split(/[\r\n]/).at(-1);
  if(match[1].length<=2&&/\d[:：]\s*$/.test(prefix))continue;
  if(/[-+−.．]\s*$/.test(prefix)||/公元前\s*$/.test(prefix))continue;
  if(/[\p{Script=Han}]\s*$/u.test(linePrefix)&&!/(?:公元|日期|时间|今天|当前|现在|来到|到了|到|至|进入|推进到|推进至|是|为|于)\s*$/.test(linePrefix))continue;
  if((chronology.eras??[]).some(era=>prefix.trimEnd().endsWith(era.name)))continue;
  add(match,Number(match[1]),monthIndex(calendar,Number(match[1]),`${Number(match[2])}月`),Number(match[3]));
 }
 if(namedMonths.length){
  const custom=new RegExp(`(?<!\\d)(\\d{1,4})\\s*年\\s*(${monthToken})\\s*(\\d{1,2})(?:\\s*[日号])?(?![\\d.．eE零〇元一二两三四五六七八九十])`,'g');
  for(const match of plain.matchAll(custom)){
   if(eraSpans.some(([start,end])=>match.index>=start&&match.index<end))continue;
   const prefix=plain.slice(0,match.index),linePrefix=prefix.split(/[\r\n]/).at(-1);
   if(match[1].length<=2&&/\d[:：]\s*$/.test(prefix))continue;
  if(/[-+−.．]\s*$/.test(prefix)||/公元前\s*$/.test(prefix))continue;
   if(/[\p{Script=Han}]\s*$/u.test(linePrefix)&&!/(?:公元|日期|时间|今天|当前|现在|来到|到了|到|至|进入|推进到|推进至|是|为|于)\s*$/.test(linePrefix))continue;
   add(match,Number(match[1]),monthIndex(calendar,Number(match[1]),match[2]),Number(match[3]));
  }
 }
 return [...new Map(found.map(item=>[`${item.start}:${item.end}:${item.date.year}:${item.date.month}:${item.date.day}`,item])).values()].sort((a,b)=>a.start-b.start||a.end-b.end);
}

// Incomplete story dates keep their known precision; invalid complete dates
// cannot fall back to a seemingly valid year-only result.
export function incompleteCandidates(calendar,text,{chronology={eras:[]},offset=0,bounded=false}={}){
 const plain=maskMarkup(text),result=[],reserved=[];
 const names=calendar.definition.type==='custom'?calendar.definition.months.map(item=>item.name).sort((a,b)=>b.length-a.length).map(escape).join('|'):null;
 const monthToken=names?`(?:${names})`:`(?:闰)?(?:正|冬|腊|${NUM})月`;
 const add=(match,year,token)=>{
  const suffix=plain.slice(match.index+match[0].length);
  if(/^\s*(?:前|后|以前|以后|之前|之后|过去了)/.test(suffix))return;
  if(/^\s*(?:[+−-]?\d|[.．]\d|初|廿)/.test(suffix)||token&&/^\s*[零〇元一二两三四五六七八九十]/.test(suffix))return;
  const before=plain.slice(0,match.index).split(/[\r\n。！？!?]/).at(-1),after=plain.slice(match.index).split(/[\r\n。！？!?]/)[0];
  if(!bounded&&notCurrent.test(before+after))return;
  try { const date=storyDate(calendar,{calendarId:calendar.definition.id,year,month:token?monthIndex(calendar,year,token):null,day:null});if(token&&date.month===null)return;result.push({kind:'absolute',date,start:offset+match.index,end:offset+match.index+match[0].length}); }catch{}
 };
 for(const era of [...(chronology.eras??[])].sort((a,b)=>b.name.length-a.name.length)){
  const pattern=new RegExp(`${escape(era.name)}\\s*(${NUM})\\s*年(?:\\s*(${monthToken}))?`,'g');
  for(const match of plain.matchAll(pattern)){
   if(reserved.some(([start,end])=>match.index<end&&match.index+match[0].length>start))continue;
   reserved.push([match.index,match.index+match[0].length]);const year=toUnifiedYear(chronology,era.name,parseNumeral(match[1]));if(year!==null)add(match,year,match[2]);
  }
 }
 const pattern=new RegExp(`(?<!\\d)(\\d{1,4})\\s*年(?:\\s*(${monthToken}))?`,'g');
 for(const match of plain.matchAll(pattern)){
  if(reserved.some(([start,end])=>match.index>=start&&match.index<end))continue;
  const prefix=plain.slice(0,match.index),linePrefix=prefix.split(/[\r\n]/).at(-1);
  if(/[-+−.．]\s*$/.test(prefix)||/公元前\s*$/.test(prefix))continue;
  if(/[\p{Script=Han}]\s*$/u.test(linePrefix)&&!/(?:公元|日期|时间|今天|当前|现在|来到|到了|到|至|进入|推进到|推进至|是|为|于)\s*$/.test(linePrefix))continue;
  if((chronology.eras??[]).some(era=>prefix.trimEnd().endsWith(era.name)))continue;
  add(match,Number(match[1]),match[2]);
 }
 return result;
}
