import {normalizeDateRule,ruleSupport,ruleDate} from './date-rule.js';
import {resolveManualAnchor} from './anchor.js';
import {storyDate} from './point.js';
import {createCalendar,normalizeCalendar} from './calendar.js';
import {normalizeChronology} from './chronology.js';
import {recognitionSettings} from './source.js';
const clone=structuredClone;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const text=value=>typeof value==='string'&&!!value.trim();
export function emptyTime(){return {schema:1,revision:0,calendars:[],activeCalendarId:null,recognition:recognitionSettings(),chronology:{eras:[]},items:[],currentDate:null,manualAnchor:null};}
export function assertTime(value){
 const keys=['schema','revision','calendars','activeCalendarId','recognition','chronology','items','currentDate','manualAnchor'];
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('时间数据字段无效');
 if(!value||value.schema!==1||!integer(value.revision)||!Array.isArray(value.calendars)||!Array.isArray(value.items))throw new Error('时间数据结构无效');
 const calendars=new Map(),normalizedCalendars=[];
 for(const definition of value.calendars){const normalized=normalizeCalendar(definition);normalizedCalendars.push(normalized);const calendar=createCalendar(normalized);if(calendars.has(definition.id))throw new Error('历法身份重复');calendars.set(definition.id,calendar);}
 if(value.activeCalendarId!==null&&!calendars.has(value.activeCalendarId))throw new Error('当前历法不存在');
 if(!value.recognition||['users','assistant'].some(key=>typeof value.recognition[key]!=='boolean')||!Array.isArray(value.recognition.groups)||!value.chronology||!Array.isArray(value.chronology.eras))throw new Error('日期识别设置无效');
 recognitionSettings(value.recognition);normalizeChronology(value.chronology);
 if(value.currentDate!==null){const calendar=calendars.get(value.activeCalendarId);if(!calendar)throw new Error('当前日期缺少历法');storyDate(calendar,value.currentDate);}
 if(value.manualAnchor!==null){
  const anchor=value.manualAnchor,calendar=calendars.get(anchor?.date?.calendarId);
  if(!calendar||anchor.date.calendarId!==value.activeCalendarId||!integer(anchor.nextFloor)||!Array.isArray(anchor.boundary))throw new Error('手动日期锚点无效');storyDate(calendar,anchor.date);
  let previous=-1;
  for(const message of anchor.boundary){if(!message||!integer(message.floor)||message.floor<=previous||message.floor>=anchor.nextFloor||!text(message.identity)||typeof message.text!=='string'||!['user','assistant','system','tool'].includes(message.role))throw new Error('手动日期边界无效');previous=message.floor;}
 }
 const ids=new Set();
 for(const item of value.items){
  if(!item||!text(item.id)||ids.has(item.id)||!['schedule','anniversary','holiday'].includes(item.kind)||!text(item.title)||!calendars.has(item.calendarId))throw new Error('时间事项身份无效');ids.add(item.id);
  const calendar=calendars.get(item.calendarId);
  if(item.dateRule){
   const rule=normalizeDateRule(item.dateRule);
   if(item.kind==='schedule'||!ruleSupport(calendar,rule).supported)throw new Error('当前事项不支持此日期规则');
   if(item.startDate!=null)throw new Error('日期规则不能同时填写开始日期');
   if(item.repeat==='once'&&(!Number.isSafeInteger(item.startYear)||!ruleDate(calendar,rule,item.startYear)))throw new Error('单次规则须有有效起始年份');
  }else calendar.validate(item.startDate);
  if(item.startYear!=null&&(!Number.isSafeInteger(item.startYear)||item.startYear<1||item.startYear>9999))throw new Error('起始年份无效');
  if(item.show!=null&&typeof item.show!=='boolean')throw new Error('日历显示开关无效');
  if(!['once','yearly'].includes(item.repeat)||!Number.isSafeInteger(item.durationDays)||item.durationDays<1||item.durationDays>366||(item.advanceDays===null?item.kind==='schedule':!integer(item.advanceDays)||item.advanceDays>365))throw new Error('时间事项区间无效');
  if(item.kind==='anniversary'&&item.durationDays!==1)throw new Error('纪念日持续天数须为1');
  if(typeof item.enabled!=='boolean'||typeof item.remind!=='boolean'||typeof item.description!=='string'||typeof item.instruction!=='string')throw new Error('时间事项字段无效');
 }
 const result={...clone(value),calendars:normalizedCalendars,recognition:recognitionSettings(value.recognition),chronology:normalizeChronology(value.chronology)};
 if(result.currentDate!==null)result.currentDate=storyDate(calendars.get(value.activeCalendarId),result.currentDate);
 if(result.manualAnchor!==null)result.manualAnchor.date=storyDate(calendars.get(value.activeCalendarId),result.manualAnchor.date);
 result.items=result.items.map(item=>item.dateRule?{...item,dateRule:normalizeDateRule(item.dateRule),startDate:null}:{...item,startDate:calendars.get(item.calendarId).validate(item.startDate)});
 return result;
}
export function timeOf(root){return Object.hasOwn(root,'time')?assertTime(root.time):emptyTime();}
// The caller must prove the full anchor boundary in the actual child before reuse.
export function inheritTime(value,{messages=null}={}){
 const result=assertTime(value),anchor=result.manualAnchor,definition=result.calendars.find(item=>item.id===result.activeCalendarId);
 result.revision=0;result.currentDate=null;
 result.manualAnchor=anchor&&definition&&Array.isArray(messages)&&resolveManualAnchor(createCalendar(definition),anchor,messages,{branch:true})?anchor:null;
 return result;
}
