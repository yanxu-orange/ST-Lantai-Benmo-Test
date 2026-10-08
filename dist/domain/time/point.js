// Story dates preserve the precision actually known. Calendar day arithmetic
// continues to require complete dates; no missing component is persisted as 1.
export function storyDate(calendar,value){
 if(!value||value.calendarId!==calendar.definition.id||!Number.isSafeInteger(value.year)||value.year<1||value.year>9999)throw new Error('故事年份无效');
 const month=value.month??null,day=value.day??null;
 if(month===null){if(day!==null)throw new Error('缺少月份时不能填写日期');return {calendarId:value.calendarId,year:value.year,month:null,day:null};}
 const months=calendar.months(value.year);
 if(!Number.isSafeInteger(month)||month<1||month>months.length)throw new Error('故事月份无效');
 if(day===null)return {calendarId:value.calendarId,year:value.year,month,day:null};
 return calendar.validate(value);
}
export function compareStoryDates(calendar,left,right){
 const a=storyDate(calendar,left),b=storyDate(calendar,right);
 for(const key of ['year','month','day']){if(a[key]===null||b[key]===null)return null;if(a[key]!==b[key])return Math.sign(a[key]-b[key]);}
 return 0;
}
export function shiftStoryDate(calendar,input,kind,amount){
 const date=storyDate(calendar,input);
 if(!Number.isSafeInteger(amount))throw new Error('故事日期偏移无效');
 if(kind==='shiftDays')return date.day===null?null:calendar.shiftDays(date,amount);
 if(kind==='shiftMonths'&&date.month===null)return null;
 if(kind==='shiftYears'&&date.month===null){const year=date.year+amount;return year>=1&&year<=9999?{...date,year}:null;}
 if(!['shiftMonths','shiftYears'].includes(kind))throw new Error('故事日期偏移类型无效');
 const result=calendar[kind]({...date,day:date.day??1},amount);
 return result?{...result,day:date.day===null?null:result.day}:null;
}
