import {createCalendar} from './calendar.js';
import {yearLabel} from './chronology.js';
import {storyDate} from './point.js';
import {factsForDate,reminderChannels} from './occurrence.js';
import {canRemindScheduleCandidate} from './schedule-model.js';
import {validateTimeReminders,DEFAULT_STORY_DATE_PROMPT} from '../../shared/settings/time-reminders.js';
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
 if(settings.current.enabled){const template=settings.current.prompt;result.current.prompt=template===DEFAULT_STORY_DATE_PROMPT?template:template.includes('{当前故事日期}')?template.replaceAll('{当前故事日期}',label):[`当前故事日期：${label}`,template].filter(Boolean).join('\n');}
 const facts=factsForDate(calendar,time.items,time.currentDate,settings);
 Object.assign(result,reminderChannels(facts,settings,{storyDate:label,formatDate:date=>formatStoryDate(calendar,date,time.chronology)}));
 return result;
}

const normalizePlanText=value=>value.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();

export function composeUnscheduledPlanPrompt(time){
 const enabled=new Set(time.scheduleStoryReminderIds??[]);
 if(!enabled.size)return '';
 const selected=(time.candidates??[]).filter(plan=>{
  if(!enabled.has(plan.id)||!canRemindScheduleCandidate(plan))return false;
  const title=normalizePlanText(plan.title),description=normalizePlanText(plan.description);
  return !time.items.some(item=>item.kind==='schedule'&&normalizePlanText(item.title)===title&&
   (item.dateText===plan.dateText||description&&normalizePlanText(item.description)===description));
 });
 if(!selected.length)return '';
 const lines=selected.map((plan,index)=>[`${index+1}. ${plan.title}`,`时间线索：${plan.dateText}`,plan.description&&`计划说明：${plan.description}`].filter(Boolean).join('\n'));
 return ['【未排期计划】',...lines,'日期尚未排定。按原有描述区分提议、约定和已经发生的事实，并尊重角色各自知道的内容。根据当前情境决定是否接续，保留原有时间线索，等剧情给出明确日期。'].join('\n\n');
}
