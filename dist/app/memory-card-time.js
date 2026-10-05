// Card-only display compression. Keep the source times intact for editing,
// persistence, parsing, and recall. Unknown or mixed formats stay verbatim.
const CLOCK='(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?';
const numericDate=new RegExp(`^([1-9]\\d{3})([/\\-])(\\d{1,2})\\2(\\d{1,2})[ \\t]+(${CLOCK})$`,'u');
const chineseDate=new RegExp(`^([1-9]\\d{3})年(\\d{1,2})月(\\d{1,2})日[ \\t]*(${CLOCK})$`,'u');
const eraDate=/^((?:(?![〇零一二三四五六七八九十百千两])\p{Script=Han}){2,8})([〇零一二三四五六七八九十百千两]+|[1-9]\d{0,3})年((?:十[一二]|[一二三四五六七八九十]|[1-9]|1[0-2])月)((?:初[一二三四五六七八九十]|十[一二三四五六七八九]?|二十[一二三四五六七八九]?|三十|廿[一二三四五六七八九]?|[1-9]|[12]\d|30)日?)([子丑寅卯辰巳午未申酉戌亥]时)$/u;

function validGregorian(year,month,day){
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()+1===month&&date.getUTCDate()===day;
}

function parseTime(value){
  const numeric=numericDate.exec(value);
  if(numeric){
    const [,year,separator,month,day,clock]=numeric;
    if(!validGregorian(+year,+month,+day))return null;
    return {kind:'gregorian',style:separator,year,month:+month,day:+day,
      time:clock,withoutYear:value.slice(year.length+separator.length)};
  }
  const chinese=chineseDate.exec(value);
  if(chinese){
    const [,year,month,day,clock]=chinese;
    if(!validGregorian(+year,+month,+day))return null;
    return {kind:'gregorian',style:'年',year,month:+month,day:+day,
      time:clock,withoutYear:value.slice(year.length+1)};
  }
  const era=eraDate.exec(value);
  if(era){
    const [,name,year,month,day,time]=era;
    const prefix=`${name}${year}年`;
    return {kind:'era',style:`${/\d/.test(month)?'digit':'han'}-${/\d/.test(day)?'digit':'han'}-${day.endsWith('日')?'day-suffix':'no-day-suffix'}`,
      year:prefix,monthDay:month+day,time,withoutYear:value.slice(prefix.length)};
  }
  return null;
}

export function formatMemoryCardTime(startTime,endTime){
  const start=String(startTime??''),end=String(endTime??'');
  if(!start.trim())return end.trim()?end:'';
  if(!end.trim())return start;
  const full=`${start}—${end}`,left=parseTime(start),right=parseTime(end);
  if(!left||!right||left.kind!==right.kind||left.style!==right.style)return full;
  if(left.kind==='gregorian'){
    if(left.year!==right.year)return full;
    return `${start}—${left.month===right.month&&left.day===right.day?right.time:right.withoutYear}`;
  }
  if(left.year!==right.year)return full;
  return `${start}—${left.monthDay===right.monthDay?right.time:right.withoutYear}`;
}
