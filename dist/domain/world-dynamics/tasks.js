// Ordered task ownership is shared by assembly, output validation and reading.
export const WORLD_TASKS=Object.freeze({world:'世界动向',region:'地区动态',weather:'天气环境',activity:'活动机遇',character:'角色动态',opinion:'舆论动态',plot:'长期剧情库'});
export const taskEnabled=(config,kind)=>kind==='aftermath'||config?.taskModules?.[kind]?.enabled!==false;
export function splitWorldTasks(sections){
 const names=Object.entries(WORLD_TASKS),tasks=sections.tasks,design=sections.design;
 const headings=[...tasks.matchAll(/^\[([^\n]+)\]$/gm)];
 if(headings.length!==8||headings.some((m,i)=>m[1]!==([...Object.values(WORLD_TASKS),'完结区'])[i])||tasks.slice(0,headings[0].index).trim())return null;
 const phases=[...design.matchAll(/^Phase ([1-6])｜[^\n]+$/gm)];
 if(phases.length!==6||phases.some((m,i)=>+m[1]!==i+1))return null;
 const phase3=design.slice(phases[2].index+phases[2][0].length,phases[3].index),steps=[...phase3.matchAll(/^Step ([1-6])：回读\[([^\]]+)\]/gm)];
 if([...phase3.matchAll(/^Step \d+：/gm)].length!==6||steps.length!==6||steps.some((m,i)=>+m[1]!==i+1||m[2]!==names[i][1])||phase3.slice(0,steps[0].index).trim())return null;
 // Unknown insertion markers cannot safely be reassigned to a task.
 if([...tasks.matchAll(/\{\{([^}]+)\}\}/g)].some(m=>!['regionThemes','plotIdeas','user','char'].includes(m[1])))return null;
 for(const marker of ['regionThemes','plotIdeas'])if(tasks.split('{{'+marker+'}}').length>2)return null;
 const taskModules={};
 for(let i=0;i<names.length;i++){
  const [key]=names[i],content=tasks.slice(headings[i].index+headings[i][0].length,headings[i+1].index);
  if(key!=='region'&&content.includes('{{regionThemes}}')||key!=='plot'&&content.includes('{{plotIdeas}}'))return null;
  taskModules[key]={enabled:true,content:content.replace('{{regionThemes}}','').replace('{{plotIdeas}}',''),design:i<6?phase3.slice(steps[i].index,steps[i+1]?.index):design.slice(phases[3].index,phases[4].index)};
 }
 return {taskModules,commonTasks:tasks.slice(headings[7].index),commonDesign:{before:design.slice(0,phases[2].index+phases[2][0].length)+phase3.slice(0,steps[0].index),after:design.slice(phases[4].index)}};
}
export function modularWorldConfig(config){
 if(config.taskModules)return {config:structuredClone(config),error:''};
 const split=splitWorldTasks(config.sections);
 return split?{config:{...structuredClone(config),...split},error:''}:{config:structuredClone(config),error:'旧任务或设计文本无法确定分区边界，原文已保留。请核对任务区的七个标题、完结区及设计区 Phase / Step 标题后重新读取；不会替换为默认文本。'};
}
export function selectedWorldVersions(domain,config){
 const selected=[];
 for(const kind of [...Object.keys(WORLD_TASKS),'aftermath']){
  if(!taskEnabled(config,kind))continue;
  const version=domain?.current?.entries.some(e=>e.kind===kind)?domain.current:domain?.retained?.[kind];
  if(version)selected.push({kind,version,entries:version.entries.filter(e=>e.kind===kind)});
 }
 return selected;
}
