import {createCalendar} from '../time/calendar.js';
import {selectedWorldVersions} from './tasks.js';
import {worldFields} from './output.js';
import {WORLD_KINDS,worldCalendar} from './data.js';
export {WORLD_CONTEXT_INTRO} from './preferences.js';
const dates=(text,cal)=>[...text.matchAll(/(\d{1,4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})日?/g)].map(m=>cal.validate({calendarId:cal.definition.id,year:+m[1],month:+m[2],day:+m[3]}));
export function projectWorldOutcomes(domain,time){
 const definition=time?.calendars?.find(row=>row.id===time.activeCalendarId);if(!definition||time.currentDate?.day==null)return {entries:[],text:''};
 const cal=createCalendar(definition),today=cal.validate(time.currentDate),entries=[];
 for(const row of selectedWorldVersions(domain,domain?.config)){
  if(JSON.stringify(worldCalendar(definition))!==JSON.stringify(worldCalendar(row.version.calendar)))continue;
  for(const entry of row.entries){
   const fields=worldFields(entry.text);let text=entry.text;
   if(['world','region','activity','opinion','plot'].includes(entry.kind)){const range=dates(fields.时间,cal);if(range.length!==2||cal.compare(range[1],today)<0)continue;}
   if(entry.kind==='aftermath'){const ended=dates(fields.完结日期,cal),until=dates(fields.有效至,cal);if(ended.length!==1||until.length!==1||cal.compare(ended[0],today)>0||cal.compare(until[0],today)<0)continue;}
   if(entry.kind==='weather'){
    const lines=entry.text.split('\n'),future=lines.filter(line=>{if(line.trim().startsWith('地点：'))return true;const days=dates(line,cal);return days.length===1&&cal.compare(days[0],today)>=0;});
    if(!future.some(line=>!line.trim().startsWith('地点：')))continue;text=future.join('\n');
   }
   entries.push({...entry,text});
  }
 }
 return {entries,text:entries.map(entry=>`【${entry.kind==='custom'?(entry.name??WORLD_KINDS.custom):WORLD_KINDS[entry.kind]}】\n${entry.text}`).join('\n\n')};
}
