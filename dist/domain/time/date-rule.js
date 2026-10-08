import {MIN_YEAR,MAX_YEAR,toModern,solarTermsForYear,importYears} from './lunar.js';
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const terms=new Set(solarTermsForYear(2025).map(item=>item.name));
export function normalizeDateRule(input){
 if(!input||!['fixed','lunar','lunar-year-end','solar-term'].includes(input.type))throw new Error('日期规则无效');
 if(input.type==='solar-term'){if(!terms.has(input.name))throw new Error('节气名称无效');return {type:input.type,name:input.name};}
 if(input.type==='lunar-year-end')return {type:input.type};
 if(!integer(input.month,1,input.type==='fixed'?13:12)||!integer(input.day,1,input.type==='fixed'?31:30))throw new Error('规则月日无效');
 if(input.isLeap!=null&&typeof input.isLeap!=='boolean')throw new Error('闰月标记无效');
 const result={type:input.type,month:input.month,day:input.day};
 if(input.type==='lunar')result.isLeap=input.isLeap===true;
 if(input.type==='fixed'&&input.monthId!=null){if(typeof input.monthId!=='string'||!input.monthId.trim())throw new Error('月份身份无效');result.monthId=input.monthId;}
 return result;
}
export function ruleSupport(calendar,rule){
 rule=normalizeDateRule(rule);const definition=calendar.definition;
 if(rule.type==='fixed')return {supported:true};
 if(definition.type==='custom')return {supported:false,reason:'自定义历法请使用本历法月日'};
 if(rule.type==='solar-term'&&definition.type==='dynasty'&&(definition.includeTerms!==true||!definition.importedYears.some(year=>year.solarTerms?.length)))return {supported:false,reason:'当前历法未导入节气数据'};
 return {supported:true};
}
// The year is the rule's source year. Lunar December may fall in the next Gregorian year.
export function ruleDate(calendar,input,year){
 const rule=normalizeDateRule(input),definition=calendar.definition;
 if(!integer(year,1,9999)||!ruleSupport(calendar,rule).supported)return null;
 const point=(month,day)=>{try{return calendar.validate({calendarId:definition.id,year,month,day});}catch{return null;}};
 if(rule.type==='fixed'){if(definition.type==='dynasty'&&rule.monthId){const index=calendar.months(year).findIndex(month=>month.id===rule.monthId);return index<0?null:point(index+1,rule.day);}return point(rule.month,rule.day);}
 if(definition.type==='modern'){
  if(year<MIN_YEAR||year>MAX_YEAR)return null;
  if(rule.type==='solar-term'){const term=solarTermsForYear(year).find(item=>item.name===rule.name);return term?point(term.month,term.day):null;}
  const last=rule.type==='lunar-year-end'?importYears(year,year)[0].months.at(-1):null;
  const date=toModern({y:year,m:last?.number??rule.month,d:last?.days??rule.day},last?.isLeap??rule.isLeap);
  return date?calendar.validate({calendarId:definition.id,year:date.y,month:date.m,day:date.d}):null;
 }
 const scheme=definition.importedYears[(year-1)%definition.importedYears.length],months=scheme.months;
 if(rule.type==='solar-term'){const term=scheme.solarTerms?.find(item=>item.name===rule.name);return term?point(term.monthIndex,term.day):null;}
 if(rule.type==='lunar-year-end')return point(months.length,months.at(-1).days);
 const index=months.findIndex(month=>(month.number??month.ordinal)===rule.month&&Boolean(month.isLeap)===rule.isLeap);
 return index>=0?point(index+1,rule.day):null;
}
export function ruleYearBounds(calendar,rule){
 return calendar.definition.type==='modern'&&rule.type!=='fixed'?{min:MIN_YEAR,max:MAX_YEAR}:{min:1,max:9999};
}

export function ruleDates(calendar,input,year){
 const rule=normalizeDateRule(input),definition=calendar.definition;
 if(rule.type==='solar-term'&&definition.type==='dynasty'&&integer(year,1,9999)&&ruleSupport(calendar,rule).supported){
  const scheme=definition.importedYears[(year-1)%definition.importedYears.length];
  return (scheme.solarTerms??[]).filter(term=>term.name===rule.name).flatMap(term=>{try{return [calendar.validate({calendarId:definition.id,year,month:term.monthIndex,day:term.day})];}catch{return [];}}).sort(calendar.compare);
 }
 const value=ruleDate(calendar,rule,year);return value?[value]:[];
}
