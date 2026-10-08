import {createCalendar} from './calendar.js';
import {yearLabel} from './chronology.js';
import {storyDate} from './point.js';
import {factsForDate,reminderChannels} from './occurrence.js';
import {validateTimeReminders} from '../../shared/settings/time-reminders.js';
export function formatStoryDate(calendar,date,chronology={eras:[]}){
 if(!date)return '';
 const point=storyDate(calendar,date),year=yearLabel(chronology,point.year);
 if(point.month===null)return year;
 const month=calendar.months(point.year)[point.month-1].name;
 return `${year}${month}${point.day===null?'':`${point.day}日`}`;
}
export function composeTimePrompts(time,config){
 const settings=validateTimeReminders(config),result=Object.fromEntries(Object.entries(settings).map(([kind,value])=>[kind,{depth:value.depth,prompt:'',items:[]}])) ;
 const definition=time.calendars.find(item=>item.id===time.activeCalendarId);
 if(!definition||!time.currentDate)return result;
 const calendar=createCalendar(definition),label=formatStoryDate(calendar,time.currentDate,time.chronology);
 if(settings.current.enabled){const template=settings.current.prompt;result.current.prompt=template.includes('{当前故事日期}')?template.replaceAll('{当前故事日期}',label):[`当前故事日期：${label}`,template].filter(Boolean).join('\n');}
 const facts=factsForDate(calendar,time.items,time.currentDate,settings);
 Object.assign(result,reminderChannels(facts,settings));
 return result;
}
