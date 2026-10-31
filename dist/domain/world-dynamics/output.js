import {taskEnabled,customWorldConfig,WORLD_TASKS} from './tasks.js';
import {createCalendar} from '../time/calendar.js';
const PREFIX='世界动态输出格式或日期不完整，已保留原成果';
export const WORLD_DIAGNOSTIC_CODES=Object.freeze(['field','dates','range','expired','activity-window','plot-nodes','weather-days','weather-date','count','missing','empty-conflict','custom-empty','aftermath-future']);
export const WORLD_DIAGNOSTIC_FIELDS=['天气日期','名称','时间','动向内容','动态内容','地点','活动内容','舆论内容','姓名','动态','事件','完结日期','影响','有效至','关键节点'];
export function describeWorldDiagnostic(d){
 const text={field:`缺少${d.field??'必要字段'}`,dates:`${d.field??'日期'}需使用完整年月日`,range:d.field==='完结日期'?'完结日期晚于有效至':'开始日期晚于结束日期',expired:d.field==='有效至'?'有效至日期已早于当前日期':'结束日期已早于当前日期','aftermath-future':'完结日期晚于当前日期','activity-window':'活动开始日期超出未来七天','plot-nodes':'关键节点缺少日期或超出支线起止日期','weather-days':`需连续7天天气，实际${d.actualCount??0}行`,'weather-date':`天气日期应为${d.expectedDate}，实际为${d.actualDate}`,count:`条数应为${d.expectedCount}，实际为${d.actualCount}`,missing:'缺少本区成果或规定的无内容标记','empty-conflict':'成果与无内容标记同时存在','custom-empty':'自定义成果不能为空'};
 return text[d.code]??'输出格式不完整';
}
function invalid(d){const error=new Error(PREFIX+'：'+describeWorldDiagnostic(d));error.worldDiagnostic=d;throw error;}
const fail=()=>{throw new Error(PREFIX+'：无法可靠划分输出标签或存在额外正文');};
export function normalizeWorldBody(text){
 let value=text.replaceAll('\r\n','\n').replaceAll('\r','\n');
 const names=WORLD_DIAGNOSTIC_FIELDS.join('|');
 for(const pattern of [new RegExp('^(\\s*)\\*\\*('+names+')\\s*[:：]\\*\\*[ \\t]*','gm'),new RegExp('^(\\s*)\\*\\*('+names+')\\*\\*\\s*[:：][ \\t]*','gm'),new RegExp('^(\\s*)('+names+')\\s*[:：][ \\t]*','gm')])value=value.replace(pattern,(_,space,name)=>space+name+'：');
 // Weather date headings use the same colon convention. Custom text never enters this function.
 return value.replace(/^(\s*(?:[-*]\s*)?\d{1,4}\s*(?:年|[-/])\s*\d{1,2}\s*(?:月|[-/])\s*\d{1,2}\s*日?[^：:\n]*):[ \t]*/gm,'$1：');
}
export function worldFields(text){return Object.fromEntries([...normalizeWorldBody(text).matchAll(/^([^：\n]+)：[ \t]*(.*)$/gm)].map(m=>[m[1].trim(),m[2].trim()]));}
export function worldDates(text,calendar,field='日期'){
 const result=[];for(const m of String(text??'').matchAll(/(\d{1,4})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})\s*日?/g)){
  try{result.push(calendar.validate({calendarId:calendar.definition.id,year:+m[1],month:+m[2],day:+m[3]}));}catch{invalid({code:'dates',field});}
 }return result;
}
const dateText=d=>`${d.year}年${d.month}月${d.day}日`;
export function validateWorldEntry(entry,definition,currentDate){
 if(entry.kind==='custom'){if(entry.id!=='LTcustom'||typeof entry.text!=='string'||!entry.text.trim())invalid({code:'custom-empty'});return entry;}
 const cal=createCalendar(definition),body=normalizeWorldBody(entry.text),f=worldFields(body),needed={world:['名称','时间','动向内容'],region:['名称','时间','动态内容'],activity:['名称','时间','地点','活动内容'],opinion:['名称','时间','舆论内容'],character:['姓名','地点','动态'],aftermath:['事件','完结日期','影响','有效至'],plot:['名称','时间','关键节点'],weather:['地点']}[entry.kind];
 if(!needed)invalid({code:'field'});for(const field of needed)if(!f[field]&&field!=='关键节点')invalid({code:'field',field});
 if(['world','region','activity','opinion','plot'].includes(entry.kind)){
  const range=worldDates(f.时间,cal,'时间');if(range.length!==2)invalid({code:'dates',field:'时间'});if(cal.compare(range[0],range[1])>0)invalid({code:'range'});if(cal.compare(range[1],currentDate)<0)invalid({code:'expired'});
  if(entry.kind==='activity'&&cal.ordinal(range[0])-cal.ordinal(currentDate)>7)invalid({code:'activity-window'});
  if(entry.kind==='plot'){const nodes=worldDates(body.split('关键节点：')[1]??'',cal,'关键节点');if(!nodes.length||nodes.some(d=>cal.compare(d,range[0])<0||cal.compare(d,range[1])>0))invalid({code:'plot-nodes'});}
 }
 if(entry.kind==='aftermath'){
  const ended=worldDates(f.完结日期,cal,'完结日期'),until=worldDates(f.有效至,cal,'有效至');if(ended.length!==1)invalid({code:'dates',field:'完结日期'});if(until.length!==1)invalid({code:'dates',field:'有效至'});if(cal.compare(ended[0],currentDate)>0)invalid({code:'aftermath-future',field:'完结日期',expectedDate:dateText(currentDate),actualDate:dateText(ended[0])});if(cal.compare(until[0],currentDate)<0)invalid({code:'expired',field:'有效至',expectedDate:dateText(currentDate),actualDate:dateText(until[0])});if(cal.compare(ended[0],until[0])>0)invalid({code:'range',field:'完结日期'});
 }
 if(entry.kind==='weather'){
  const lines=body.split('\n').map(v=>v.trim()).filter(Boolean).filter(line=>!line.startsWith('地点：'));if(lines.length!==7)invalid({code:'weather-days',actualCount:lines.length});
  for(let i=0;i<lines.length;i++){const match=lines[i].match(/^(.+?)：\s*(\S[\s\S]*)$/);if(!match)invalid({code:'dates',field:'天气日期'});const day=worldDates(match[1],cal,'天气日期');if(day.length!==1)invalid({code:'dates',field:'天气日期'});if(cal.ordinal(day[0])!==cal.ordinal(currentDate)+i){const expected=cal.shiftDays(currentDate,i);if(!expected)invalid({code:'dates',field:'天气日期'});invalid({code:'weather-date',expectedDate:dateText(expected),actualDate:dateText(day[0])});}}
 }
 return entry;
}
const protocol='LT(?:design|custom|world\\d+|region\\d+|weather|activity\\d+|character\\d+|opinion\\d+|plot\\d+|aftermath\\d+)';
function splitWorldDesign(output){
 if(typeof output!=='string'||!output.trim())fail();
 // Do not normalize opaque custom content, including its legal HTML and LT-like text.
 const source=output.trim().replace(/^```(?:text|xml)?\s*\n([\s\S]*?)\n```$/,'$1');
 let text='',design,custom,at=0;const starts=new RegExp('<\\s*('+protocol+')\\s*>','g');let match;
 while((match=starts.exec(source))){
  const outside=source.slice(at,match.index);if(/<\/?LT(?:design|custom)\b/.test(outside))fail();text+=outside;
  const tag=match[1],closing=new RegExp('<\\s*/\\s*'+tag+'\\s*>','g');closing.lastIndex=starts.lastIndex;const end=closing.exec(source);if(!end)fail();const body=source.slice(starts.lastIndex,end.index);
  if(new RegExp('<\\s*/?\\s*'+tag+'\\b').test(body))fail();
  if(tag==='LTdesign'){if(design!==undefined)fail();design=body.trim();}
  else if(tag==='LTcustom'){if(custom!==undefined)fail();custom=body;}
  else {if(/<\s*\/?\s*LT(?:world\d+|region\d+|weather|activity\d+|character\d+|opinion\d+|plot\d+|aftermath\d+)\b/.test(body))fail();text+='<'+tag+'>'+normalizeWorldBody(body)+'</'+tag+'>';}
  at=end.index+end[0].length;starts.lastIndex=at;
 }
 const tail=source.slice(at);if(/<\/?LT(?:design|custom)\b/.test(tail))fail();text+=tail;return {text,design,custom};
}
export function extractWorldDesign(output){return splitWorldDesign(output).design;}
export function parseWorldOutputSections(output,{calendar,date,config}={}){
 let {text,custom}=splitWorldDesign(output);const groups=new Map(),seen=new Set(),accepted=[],failures=[],entries=[];
 text=text.replace(/<LT(world\d+|region\d+|weather|activity\d+|character\d+|opinion\d+|plot\d+|aftermath\d+)>([\s\S]*?)<\/LT\1>/g,(_,tag,body)=>{
  if(seen.has(tag))fail();seen.add(tag);const kind=tag.replace(/\d+$/,'');if(!taskEnabled(config,kind))fail();const list=groups.get(kind)??[];list.push({id:'LT'+tag,kind,text:body.trim()});groups.set(kind,list);return '';
 });
 const markers={character:'角色动态',aftermath:'完结区',plot:'长期剧情库'},empty=new Set();
 for(const [kind,label]of Object.entries(markers)){const pattern=new RegExp('^\\s*'+label+'\\s*[:：]\\s*无\\s*$','gm');const matches=[...text.matchAll(pattern)];if(matches.length>1)fail();if(matches.length){if(!taskEnabled(config,kind))fail();empty.add(kind);text=text.replace(pattern,'');}}
 if(text.trim())fail();
 for(const kind of [...Object.keys(WORLD_TASKS),'custom','aftermath']){
  if(!taskEnabled(config,kind))continue;
  try{
   const list=kind==='custom'?(custom===undefined?[]:[{id:'LTcustom',kind:'custom',name:customWorldConfig(config).name.trim(),text:custom.trim()}]):groups.get(kind)??[];
   if(kind==='custom'&&custom===undefined)invalid({code:'missing'});
   if(['world','region','activity','opinion'].includes(kind)&&list.length!==2)invalid({code:'count',expectedCount:2,actualCount:list.length});
   if(kind==='weather'&&!list.length)invalid({code:'missing'});
   if(empty.has(kind)&&list.length)invalid({code:'empty-conflict'});
   if(markers[kind]&&!list.length&&!empty.has(kind))invalid({code:'missing'});
   const max=kind==='character'?3:kind==='aftermath'?2:Infinity;if(list.length>max)invalid({code:'count',expectedCount:max,actualCount:list.length});
   if(list.some((_,i)=>!list.some(entry=>entry.id===('LT'+kind+(kind==='weather'||kind==='custom'?'':i+1)))))invalid({code:'missing'});
   for(const entry of list)validateWorldEntry(entry,calendar,date);
   entries.push(...list);accepted.push(kind);
  }catch(error){if(!error.worldDiagnostic)throw error;failures.push({kind,...error.worldDiagnostic});}
 }
 if(custom!==undefined&&!taskEnabled(config,'custom'))fail();
 return {entries,accepted,failures};
}
export function parseWorldOutput(output,options={}){const report=parseWorldOutputSections(output,options);if(report.failures.length)invalid(report.failures[0]);return report.entries;}
