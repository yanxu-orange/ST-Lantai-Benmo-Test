import {validateTasks} from '../background/round.js';
import {bindPromptNames,latestSourceMessages,promptIdentities} from '../latest/requests.js';

export const WORKSHOP_IDENTITY='你是一名精通场外线索梳理的资深编辑，长期协助作者整理“连载故事”的故事外补充内容，包括番外、发展走向、信息整理等丰富的场外信息。现在，请依据现有的多种资料，按各项任务规定的内容与范围完成工作。';
const readable=value=>typeof value==='string'?value:JSON.stringify(value,null,2);
const present=value=>value!==undefined&&value!==null&&(typeof value==='string'?!!value.trim():Array.isArray(value)?value.length>0:Object.keys(value).length>0);
// Ordered, optional read-only material slots. Readers and selection policy live
// outside the prompt builder; no source is fetched or persisted here.
export function buildWorkshopRoundRequest({source,tasks,materials={},identities={}}={}){
  validateTasks(tasks);
  const names=promptIdentities(identities),parts=[];
  const add=(name,role,content,key=null)=>parts.push({name,role,content,fixed:key===null,key});
  add('工坊身份','system',WORKSHOP_IDENTITY);
  add('资料介绍','user','以下是你可以参考的信息：');
  const protagonists=[materials.char,materials.user].filter(present);
  if(protagonists.length)add('主角资料','user','这是故事的主角们：\n'+protagonists.map(readable).join('\n\n'));
  for(const [key,name,title] of [
    ['worldInfo','故事设定','这是故事的相关设定：'],
    ['custom','补充信息','以下是额外的补充信息：'],
    ['recall','相关往事','以下是与当前情节相关的过往记忆：'],
    ['history','前情提要','这是故事的前情提要：'],
  ])if(present(materials[key]))add(name,'user',title+'\n'+readable(materials[key]));
  add('最新发展','user','这是故事的最新发展：\n'+readable(latestSourceMessages(source)));
  add('工坊任务衔接','system','阅读完上述资料后，请理清整个故事的脉络，而后执行以下任务。');
  for(const [index,task] of tasks.entries()){
    const body=[`任务 ${index+1}：${task.name}\n任务 ID：${task.id}`,task.namesBound===true?task.instructions:bindPromptNames(task.instructions,names)];
    add(task.name,'system',body.join('\n\n'),task.id);
    if(present(task.previousState))add(task.name+'此前记录','user',`任务 ID：${task.id}\n【此前记录】\n`+readable(task.previousState));
  }
  add('工坊返回协议','system',[
    '每个任务仅输出一个 <lantai_task id="任务 ID">正文</lantai_task> 分段，使用对应任务的真实 ID。不得省略、重复、嵌套或新增任务分段，不输出分段外说明。',
    '各任务要求中的正文格式用于对应分段内部，保留其内部格式。',
    ...tasks.map(task=>`<lantai_task id="${task.id}">\n本任务结果正文\n</lantai_task>`),
  ].join('\n\n'));
  return {task:'workshop.round',title:'工坊生成',messages:parts.map(({role,content})=>({role,content})),previewParts:parts};
}
