import {normalizeDateRule,ruleDate,ruleDates,ruleYearBounds} from './date-rule.js';
const positive = (n, label) => {if (!Number.isSafeInteger(n) || n < 1 || n > 366) throw new RangeError(`${label}须为1–366的整数`);return n;};
function at(calendar, item, start) {
  const duration = item.kind === 'anniversary' ? 1 : positive(item.durationDays, '持续天数');
  const end = calendar.shiftDays(start, duration - 1);
  // An interval extending beyond the supported calendar has no representable occurrence.
  // Never truncate it or throw merely while looking for a distant future reminder.
  if (!end) return null;
  return {start, end, duration};
}
function atOrNull(calendar,item,start){return start?at(calendar,item,start):null;}
export function occurrence(calendar, item, today) {
  calendar.validate(today);
  if (!item || item.calendarId !== calendar.definition.id || item.enabled === false) return null;
  if (!['schedule','anniversary','holiday'].includes(item.kind)) throw new TypeError('事项类型无效');
  if(item.dateRule){
    const rule=normalizeDateRule(item.dateRule),bounds=ruleYearBounds(calendar,rule);
    const first=Math.max(bounds.min,item.startYear??bounds.min);
    const duration=item.kind==='anniversary'?1:positive(item.durationDays,'持续天数');
    if(item.repeat==='once')return item.startYear?atOrNull(calendar,item,ruleDate(calendar,rule,item.startYear)):null;
    if(item.repeat!=='yearly')throw new Error('重复方式无效');
    // Restrict look-back by duration, including tiny fictional calendar years.
    const earliest=calendar.fromOrdinal(Math.max(0,calendar.ordinal(today)-duration+1)).year;
    let ongoing=null;
    const last=Math.min(bounds.max,Math.max(first,today.year)+(calendar.definition.type==='modern'?400:calendar.definition.type==='custom'?1:calendar.definition.importedYears.length));
    for(let y=Math.max(first,earliest-1);y<=last;y++){
      for(const start of ruleDates(calendar,rule,y)){
       const value=at(calendar,item,start);if(!value)continue;
       if(calendar.compare(start,today)>0)return ongoing??value;
       if(calendar.compare(today,value.end)<=0)ongoing=value;
      }
    }
    return ongoing;
  }
  const start = calendar.validate(item.startDate);
  if (!['once','yearly'].includes(item.repeat)) throw new Error('重复方式无效');
  if (item.repeat === 'once') return at(calendar, item, start);
  const duration = item.kind === 'anniversary' ? 1 : positive(item.durationDays, '持续天数');
  // Search the nearest prior valid annual start. This supports tiny custom years,
  // not just Gregorian events crossing a single previous year.
  for (let y = today.year; y >= start.year; y--) {
    const point = calendar.annualDate(start, y);
    if (point && calendar.compare(point, today) <= 0) {
      if (calendar.distance(point, today) < duration) return at(calendar, item, point);
      break;
    }
  }
  for (let y = Math.max(start.year, today.year),end=Math.min(9999,Math.max(start.year,today.year)+(calendar.definition.type==='modern'?400:calendar.definition.type==='custom'?1:calendar.definition.importedYears.length)); y <= end; y++) {
    const point = calendar.annualDate(start, y);
    if (point && calendar.compare(point, today) > 0) return at(calendar, item, point);
  }
  return null;
}
export function reminderFact(calendar, item, today, {advanceDays = item?.advanceDays ?? 0} = {}) {
  if (!Number.isSafeInteger(advanceDays) || advanceDays < 0 || advanceDays > 365) throw new RangeError('提前提醒天数无效');
  const value = occurrence(calendar, item, today);
  if (!value) return null;
  const until = calendar.distance(today, value.start);
  const since = -until;
  if (until > advanceDays || calendar.compare(today, value.end) > 0) return null;
  return {id:item.id, kind:item.kind, title:item.title ?? '', description:item.description ?? '', instruction:item.instruction ?? '',
    ...value, phase:until > 0 ? 'upcoming' : 'ongoing', daysUntil:Math.max(0,until), dayIndex:until > 0 ? null : since + 1,
    anniversaryYears:item.kind==='anniversary'&&Number.isSafeInteger(item.startYear)?Math.max(0,value.start.year-item.startYear):null,remind:item.remind === true};
}
export function reminderText(fact) {
  const timing = fact.phase === 'upcoming' ? `还有${fact.daysUntil}天开始，共${fact.duration}天` : `今天是第${fact.dayIndex}天，共${fact.duration}天`;
  return [`${fact.title}${fact.anniversaryYears>0?`（${fact.anniversaryYears}周年）`:''}：${timing}`, fact.description, fact.instruction].filter(Boolean).join('\n');
}
export function reminderChannels(facts, settings) {
  const result = {};
  for (const kind of ['schedule','anniversary','holiday']) {
    const config=settings[kind];
    if (!config || !Number.isInteger(config.depth) || config.depth < 0 || config.depth > 10000) throw new RangeError('提醒深度无效');
    const selected=structuredClone(facts.filter(fact=>fact.kind===kind && fact.remind));
    result[kind]={depth:config.depth, items:selected, prompt:selected.length ? [config.prompt,...selected.map(reminderText)].filter(Boolean).join('\n\n') : ''};
  }
  return result;
}

export function advanceFor(item,settings){
 if(item.kind==='holiday')return settings.holiday.advanceDays;
 if(item.kind==='anniversary')return item.advanceDays??settings.anniversary.advanceDays;
 return item.advanceDays;
}
export function factsForDate(calendar,items,today,settings){
 if(!today||today.month==null||today.day==null)return [];
 return items.map(item=>reminderFact(calendar,item,today,{advanceDays:advanceFor(item,settings)})).filter(Boolean);
}
export function itemsOnDate(calendar,items,date){
 return items.filter(item=>item.show!==false).map(item=>{const value=occurrence(calendar,item,date);return value&&calendar.compare(value.start,date)<=0&&calendar.compare(date,value.end)<=0?{...item,...value,dayIndex:calendar.distance(value.start,date)+1}:null;}).filter(Boolean);
}

// Calendar browsing is independent of AI reminder windows. Ongoing items are
// already shown under today; preview each new occurrence starting tomorrow–day 7.
export function upcomingItems(calendar,items,today){
 if(!today||today.month==null||today.day==null)return [];
 const result=[];
 for(let daysUntil=1;daysUntil<=7;daysUntil++){
  const date=calendar.shiftDays(today,daysUntil);if(!date)break;
  for(const item of itemsOnDate(calendar,items,date)){
   if(calendar.compare(item.start,date)===0)result.push({...item,daysUntil,phase:'upcoming'});
  }
 }
 return result;
}
