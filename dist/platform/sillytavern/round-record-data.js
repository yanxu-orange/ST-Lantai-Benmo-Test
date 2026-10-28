// Display projections only. No saved copies, generation or prompt authority.
const statuses=new Set(['idle','ready','running','failed','cancelled']);
const status=row=>statuses.has(row?.status)?row.status:'idle';
const encode=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export const roundRecordPreview=text=>{const chars=Array.from(text??'');return {text:chars.slice(0,600).join(''),long:chars.length>600};};
export function partitionRoundRecords(summary,workshop,appearance={}){
 const base=[];if(summary)base.push({id:'summary',kind:'summary',name:'摘要',...summary});
 for(const task of workshop?.tasks??[])if(['tracking','schedule'].includes(task.kind))base.push(task);
 const modules=(workshop?.tasks??[]).filter(task=>task.kind==='workshop'),mode=appearance.roundRecordMode;
 const native=mode==='builtin'?base.slice():[],regex=mode==='regex'&&base.length?[{id:'record',kind:'record',tasks:base}]:[];
 for(const task of modules){const selected=Object.hasOwn(appearance.workshopModes??{},task.id)?appearance.workshopModes[task.id]:null;if(selected==='builtin')native.push(task);if(selected==='regex')regex.push({id:task.id,kind:'workshop',tasks:[task]});}
 return {native,regex};
}
const taskText=(task,tag)=>`<${tag} status="${status(task)}">\n<LTname>${encode(task.name)}</LTname>\n<LTbody>${encode(task.body)}</LTbody>${task.error?`\n<LTerror>${encode(task.error)}</LTerror>`:''}\n</${tag}>`;
export function serializeRoundRecord(card){
 if(card.kind==='workshop')return `<LTworkshopRecord version="1">\n${taskText(card.tasks[0],'LTtask')}\n</LTworkshopRecord>`;
 return `<LTroundRecord version="1">\n${card.tasks.map(task=>taskText(task,{summary:'LTsummary',tracking:'LTtracking',schedule:'LTschedule'}[task.kind])).join('\n')}\n</LTroundRecord>`;
}
