import {taskEnabled} from './tasks.js';
import {createCalendar} from '../time/calendar.js';
const fail=()=>{throw new Error('世界动态输出格式或日期不完整，已保留原成果');};
export function worldFields(text){return Object.fromEntries([...text.matchAll(/^([^：\n]+)：[ \t]*(.*)$/gm)].map(m=>[m[1].trim(),m[2].trim()]));}
function dates(text,calendar){const result=[];for(const m of text.matchAll(/(\d{1,4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})日?/g)){try{result.push(calendar.validate({calendarId:calendar.definition.id,year:+m[1],month:+m[2],day:+m[3]}));}catch{fail();}}return result;}
export function validateWorldEntry(entry,definition,currentDate){
 const cal=createCalendar(definition),f=worldFields(entry.text),needed={world:['名称','时间','动向内容'],region:['名称','时间','动态内容'],activity:['名称','时间','地点','活动内容'],opinion:['名称','时间','舆论内容'],character:['姓名','地点','动态'],aftermath:['事件','完结日期','影响','有效至'],plot:['名称','时间','关键节点'],weather:['地点']}[entry.kind];
 if(!needed||needed.some(k=>!f[k]&&k!=='关键节点'))fail();
 if(['world','region','activity','opinion','plot'].includes(entry.kind)){const range=dates(f.时间,cal);if(range.length!==2||cal.compare(range[0],range[1])>0||cal.compare(range[1],currentDate)<0)fail();if(entry.kind==='activity'&&cal.ordinal(range[0])-cal.ordinal(currentDate)>7)fail();if(entry.kind==='plot'){const nodes=dates(entry.text.split('关键节点：')[1]??'',cal);if(!nodes.length||nodes.some(d=>cal.compare(d,range[0])<0||cal.compare(d,range[1])>0))fail();}}
 if(entry.kind==='aftermath'){const ended=dates(f.完结日期,cal),until=dates(f.有效至,cal);if(ended.length!==1||until.length!==1||cal.compare(ended[0],currentDate)>0||cal.compare(until[0],currentDate)<0||cal.compare(ended[0],until[0])>0)fail();}
 if(entry.kind==='weather'){const lines=entry.text.split('\n').map(v=>v.trim()).filter(Boolean).filter(line=>!line.startsWith('地点：'));if(lines.length!==7)fail();for(let i=0;i<lines.length;i++){const match=lines[i].match(/^(.+?)：\s*(\S[\s\S]*)$/);if(!match)fail();const day=dates(match[1],cal);if(day.length!==1||cal.ordinal(day[0])!==cal.ordinal(currentDate)+i||!match[2].trim())fail();}}
 return entry;
}
function splitWorldDesign(output){
 if(typeof output!=='string'||!output.trim())fail();const text=output.trim().replace(/^```(?:text|xml)?\s*\n([\s\S]*?)\n```$/,'$1'),designs=[...text.matchAll(/<LTdesign>([\s\S]*?)<\/LTdesign>/g)];
 if(designs.length>1||designs.some(m=>/<\/?LTdesign\b/.test(m[1])))fail();const body=text.replace(/<LTdesign>[\s\S]*?<\/LTdesign>/g,'');if(/<\/?LTdesign\b/.test(body))fail();return {text:body,design:designs[0]?.[1].trim()};
}
export function extractWorldDesign(output){return splitWorldDesign(output).design;}
export function parseWorldOutput(output,{calendar,date,config}={}){
 let {text}=splitWorldDesign(output);
 const entries=[],seen=new Set(),prefix={world:'world',region:'region',weather:'weather',activity:'activity',character:'character',opinion:'opinion',plot:'plot',aftermath:'aftermath'};
 text=text.replace(/<LT(world\d+|region\d+|weather|activity\d+|character\d+|opinion\d+|plot\d+|aftermath\d+)>([\s\S]*?)<\/LT\1>/g,(_,tag,body)=>{if(seen.has(tag))fail();seen.add(tag);const kind=prefix[tag.replace(/\d+$/,'')],entry={id:'LT'+tag,kind,text:body.trim()};if(!taskEnabled(config,kind))fail();validateWorldEntry(entry,calendar,date);entries.push(entry);return '';});
 for(const kind of ['world','region','activity','opinion'])if(taskEnabled(config,kind)&&(!seen.has(kind+'1')||!seen.has(kind+'2')||entries.filter(e=>e.kind===kind).length!==2))fail();
 if(taskEnabled(config,'weather')&&!seen.has('weather'))fail();
 for(const [kind,max,marker]of [['character',3,'角色动态：无'],['aftermath',2,'完结区：无'],['plot',Infinity,'长期剧情库：无']]){if(!taskEnabled(config,kind))continue;const list=entries.filter(e=>e.kind===kind);if(list.length>max||!list.length&&!text.includes(marker)||list.length&&text.includes(marker))fail();if(list.some((_,i)=>!seen.has(kind+(i+1))))fail();text=text.replace(marker,'');}
 if(text.trim())fail();return entries;
}
