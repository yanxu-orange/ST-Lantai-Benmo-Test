// Date facts for recall. Unlike story-date recognition, recollections are valid
// query evidence; this module never advances or persists the story clock.
import {formatStoryDate} from '../time/prompts.js';
import {createCalendar} from '../time/calendar.js';
import {normalizeChronology,toUnifiedYear} from '../time/chronology.js';
import {monthIndex,dayNumber} from '../time/absolute.js';
import {parseNumeral} from '../time/transition.js';
export {parseNumeral};
const modern={id:'gregorian',type:'modern',name:'公历'};
const calendars=new WeakMap();
export function recallCalendar(context={}){if(!calendars.has(context))calendars.set(context,createCalendar(context.definition??modern));return calendars.get(context);}
export const timePrecisionRank=value=>({year:1,month:2,day:3})[value?.precision]??0;
export function parseStoryTimeValue(raw,{fictionalCalendar={}}={}){
 let text=String(raw??'').trim();
 // Only a complete clock suffix may carry approximation. Never strip an
 // approximation attached to the date itself or invent time-of-day precision.
 const clock='(?:(?:约|大概)\\s*)?(?:(?:凌晨|清晨|早晨|上午|中午|午后|下午|傍晚|晚上|夜间|深夜)\\s*)?(?:(?:约|大概)\\s*)?(?:(?:[01]?\\d|2[0-3])[:：][0-5]\\d(?::[0-5]\\d)?|(?:[零一二两三四五六七八九十]+|\\d{1,2})[时点](?:半|\\d{1,2}分)?)(?:\\s*(?:左右|前后))?';
 const period='(?:(?:约|大概)\\s*)?(?:凌晨|清晨|早晨|上午|中午|午后|下午|傍晚|晚上|夜间|深夜)(?:\\s*(?:左右|前后))?';
 const suffix=text.match(/^(.*?(?:[日号]|\d{1,4}[-/.]\d{1,2}[-/.]\d{1,2}))\s*(?:T)?(.+)$/u);
 if(suffix&&new RegExp(`^(?:${clock}|${period})(?:\\s*[—–~～至到-]\\s*(?:${clock}|${period}))?$`,'u').test(suffix[2].trim()))text=suffix[1].trim();
 if(!text||/约|大概|左右|不详|未知|待定|前后/.test(text))return null;
 if(/^公元\s*/u.test(text)&&fictionalCalendar.definition&&fictionalCalendar.definition.type!=='modern')return parseStoryTimeValue(text,{fictionalCalendar:{}});
 const cal=recallCalendar(fictionalCalendar),chronology=normalizeChronology(fictionalCalendar.chronology??{eras:[]});
 let year,tail,era=null;
 for(const item of [...chronology.eras].sort((a,b)=>b.name.length-a.name.length)){
  if(!text.startsWith(item.name))continue;
  const m=text.slice(item.name.length).match(/^\s*([\d零〇元一二两三四五六七八九十]+)年(.*)$/u);
  if(!m)return null;year=toUnifiedYear(chronology,item.name,parseNumeral(m[1]));tail=m[2];era=item.name;break;
 }
 if(tail===undefined){
  const iso=text.match(/^(?:公元\s*)?(\d{1,4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(.*)$/u);
  if(iso&&(!iso[4]||!iso[4].startsWith('年'))){
   year=Number(iso[1]);tail=iso[2]?`${iso[2]}月${iso[3]?`${iso[3]}日`:''}${iso[4]}`:iso[4];
  }else{const m=text.match(/^(?:公元\s*)?(\d{1,4})年(.*)$/u);if(!m)return null;year=Number(m[1]);tail=m[2];}
 }
 if(!Number.isSafeInteger(year)||year<1||year>9999)return null;
 let month=null,day=null;tail=tail.trim();
 if(tail){
  const names=cal.months(year).map(x=>x.name).sort((a,b)=>b.length-a.length);
  const name=names.find(x=>tail.startsWith(x));
  const generic=tail.match(/^((?:闰)?(?:正|冬|腊|[\d零〇一二两三四五六七八九十]+)月)/u);
  const token=name??generic?.[1];if(!token)return null;
  month=monthIndex(cal,year,token);if(month===null)return null;tail=tail.slice(token.length).trim();
  if(tail){const m=tail.match(/^((?:初|廿)?[\d零〇一二两三四五六七八九十]+|廿)(?:日|号)?(.*)$/u);if(m){day=dayNumber(m[1]);tail=m[2].trim();if(day===null)return null;}}
 }
 if(tail&&!/^(?:(?:凌晨|清晨|早晨|上午|中午|午后|下午|傍晚|晚上|夜间|深夜)(?:\d{1,2}[时点](?:半|\d{1,2}分)?)?|(?:T|\s)?(?:[01]?\d|2[0-3])[:：][0-5]\d(?::[0-5]\d)?)$/u.test(tail))return null;
 if(day!==null){try{cal.validate({calendarId:cal.definition.id,year,month,day});}catch{return null;}}
 if(month!==null&&(month<1||month>cal.months(year).length))return null;
 return {calendarId:cal.definition.id,calendar:cal.definition.type,era:null,year,month,day,precision:day!==null?'day':month!==null?'month':'year',hour:null,minute:null,sourceEra:era};
}
export function compareTimeValues(a,b){
 if(!a||!b||a.calendarId!==b.calendarId)return null;
 for(const key of ['year','month','day']){if(a[key]==null||b[key]==null)return 0;if(a[key]!==b[key])return Math.sign(a[key]-b[key]);}return 0;
}
export function formatStoryTimeValue(value){return value?`${value.year}年${value.month==null?'':`${value.month}月`}${value.day==null?'':`${value.day}日`}`:'';}
export function shiftStoryYears(value,delta,context={}){
 if(!value||!Number.isSafeInteger(delta))return null;const year=value.year+delta;if(year<1||year>9999)return null;
 if(value.month==null)return {...value,year};
 const cal=recallCalendar(context),origin={calendarId:cal.definition.id,year:value.year,month:value.month,day:value.day??1},date=cal.shiftYears(origin,delta);
 return date?{...value,...date,day:value.day==null?null:date.day}:null;
}
export function shiftStoryDays(value,delta,context={}){
 if(!value||timePrecisionRank(value)<3)return null;const date=recallCalendar(context).shiftDays(value,delta);return date?{...value,...date}:null;
}
export function dateContext(time,{available=true}={}){
 const definition=time?.calendars?.find(x=>x.id===time.activeCalendarId);
 if(!definition)return {definition:modern,chronology:{eras:[]},current:null,status:'no-calendar'};
 const context={definition:structuredClone(definition),chronology:structuredClone(time.chronology??{eras:[]}),current:null,status:available?'ready':'unavailable'};
 if(available&&time.currentDate){const value=time.currentDate;context.current={status:'parsed',calendarId:definition.id,raw:formatStoryDate(recallCalendar(context),value,context.chronology),value:{...value,calendar:definition.type,era:null,precision:value.day!=null?'day':value.month!=null?'month':'year',hour:null,minute:null}};}
 return context;
}
export function memoryDatePoint(raw,context){const value=parseStoryTimeValue(raw,{fictionalCalendar:context});return value?{status:'parsed',raw,value}:{status:'unknown',raw};}
