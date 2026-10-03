// Conservative Gregorian facts for narrative ordering, never date qualification.
// A period such as 下午 is retained in event text and never converted to minutes.
export function parseStoryTimePoint(raw){
  const text=String(raw??'').trim();
  const match=/^(\d{4})(?:年(?:(\d{1,2})月(?:(\d{1,2})日)?)?|[-/](\d{1,2})(?:[-/](\d{1,2}))?)?(.*)$/u.exec(text);
  if(!match||/约|大概|左右/u.test(text))return {status:'unknown',raw:text};
  const year=Number(match[1]),month=Number(match[2]??match[4])||null,day=Number(match[3]??match[5])||null,suffix=match[6].trim();
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month!==null&&(month<1||month>12)||day!==null&&(day<1||day>days[month-1]))return {status:'unknown',raw:text};
  let hour=null,minute=null;
  if(suffix){const clock=/^(?:T|\s)?(\d{1,2})[:：](\d{2})$/u.exec(suffix);if(clock&&day!==null){hour=Number(clock[1]);minute=Number(clock[2]);if(hour>23||minute>59)return {status:'unknown',raw:text};}else if(!/^(?:凌晨|清晨|早晨|上午|中午|午后|下午|傍晚|晚上|夜间|深夜)(?:\d{1,2}[时点](?:半|\d{1,2}分)?)?$/u.test(suffix))return {status:'unknown',raw:text};}
  return {status:'parsed',raw:text,value:{year,month,day,hour,minute,calendarId:'gregorian',calendar:'gregorian'}};
}
export function compareTimeValues(left,right){
  for(const key of ['year','month','day','hour','minute']){if(left?.[key]==null&&right?.[key]==null)return 0;if(left?.[key]==null||right?.[key]==null)return null;if(left[key]!==right[key])return left[key]<right[key]?-1:1;}return 0;
}
