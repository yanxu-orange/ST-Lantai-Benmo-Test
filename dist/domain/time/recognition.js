import {recognitionSettings,textSegments} from './source.js';
import {rangeCandidates} from './fragments.js';
import {advanceCandidates} from './transition.js';
import {selectMessageDate} from './replay.js';
// The replay/runtime controls history windows and manual boundaries. This parser
// consumes one eligible source message against its immutable incoming date.
export function createMessageDateParser(calendar,{settings={},chronology={eras:[]}}={}){
 const config=recognitionSettings(settings),eras=structuredClone(chronology);
 return (message,incomingDate)=>{
  if(!message||!['user','assistant'].includes(message.role))return null;
  if(message.role==='user'&&!config.users||message.role==='assistant'&&!config.assistant)return null;
  const text=message.text??message.content??'',candidates=[];
  for(const segment of textSegments(text,config)){
   const options={chronology:eras,offset:segment.start,bounded:config.scope==='tags',baseDate:incomingDate,allowPartial:message.role==='user'||config.scope==='tags'||/(?:当前)?(?:故事|剧情)?(?:时间|日期)\s*[:：]/.test(segment.text),includeInvalid:true};
   candidates.push(...rangeCandidates(calendar,segment.text,options));
   candidates.push(...advanceCandidates(segment.text,segment.start));
  }
  const ranges=candidates.filter(item=>item.range);
  const selected=candidates.filter(item=>item.kind!=='invalidRange'&&!ranges.some(range=>range!==item&&range.start<=item.start&&range.end>=item.end&&(range.start<item.start||range.end>item.end)));
  return selectMessageDate(calendar,selected,incomingDate);
 };
}
