import {WORLD_TASKS,modularWorldConfig,taskEnabled,worldDesignText} from './tasks.js';
import {WORLD_PRESET_SOURCE} from './preset-source.js';
import {assertWorldConfig,WORLD_KINDS} from './data.js';
import {markWorldMaterials,assembleWorldMaterials,defaultMaterialEnabled} from './materials.js';
const labels={identity:'AI身份区',rules:'基本规则',materials:'资料区',tasks:'任务区',design:'设计区'};
export function defaultWorldConfig(){
 const matches=[...WORLD_PRESET_SOURCE.replaceAll('\r\n','\n').matchAll(/^\[(AI身份区|基本规则|资料区|任务区|设计区)\]$/gm)];
 const sections={};for(let i=0;i<matches.length;i++){const key=Object.keys(labels).find(k=>labels[k]===matches[i][1]);sections[key]=WORLD_PRESET_SOURCE.replaceAll('\r\n','\n').slice(matches[i].index+matches[i][0].length,matches[i+1]?.index).trim();}
 const themes=[...sections.tasks.matchAll(/地区动态主题库：([^\n]+)\n([\s\S]*?)(?=地区动态主题库：|\[天气环境\])/g)].map((m,i)=>({id:`theme-${i}`,name:m[1].trim(),content:m[2].trim(),enabled:true}));
 sections.tasks=sections.tasks.replace(/地区动态主题库：政治主题[\s\S]*?(?=\[天气环境\])/,'{{regionThemes}}\n\n');
 sections.tasks=sections.tasks.replace(/灵感库：用户填写的条目名称[\s\S]*$/,'{{plotIdeas}}');
 sections.rules+='\n\n- 日期与输出：日期使用本历法完整的数字年月日；正式成品按各任务规定的标签或空区标记输出，不附加其他文字。';
 sections.tasks=sections.tasks.replace('格式要求：\n\n<LTcharacter1>','格式要求：\n\n没有可用角色时，输出“角色动态：无”。\n\n<LTcharacter1>');
 sections.tasks+=`

[完结区]

任务：依据“当前日期”“上一版世界动态”与“本轮剧情资料”，维护当前有效的长尾影响，最多2条。

要求：

- 仅判断世界动向、地区动态、活动机遇、舆论动态中已完结的事件；天气环境、角色动态和长期剧情不参与。
- 事件结束后，值得留下具体影响才保留；没有价值则不留，不凑数。
- 未被本轮剧情改变且未过期的旧影响保留；被改变则调整或提前移除。有效至日期成为昨天时移除。
- 新影响加入时，现有影响不足2条则直接加入；已满2条才替换完结日期最早的一条。
- 每条用一句话写明具体影响，并提供完整的完结日期和有效至日期。

格式要求：

每条影响使用独立标签，按输出顺序编号为LTaftermath1、LTaftermath2；只有1条时只输出LTaftermath1。没有任何有效影响时，输出“完结区：无”。

<LTaftermath1>

事件：已完结事件名称
完结日期：完整年月日
影响：一句话简述事件结束后仍然存在的具体影响。
有效至：完整年月日

</LTaftermath1>`;
 sections.design=sections.design.replace('Phase 3｜构思各区内容','Step 3：回读[完结区]：哪些已完结的普通事件值得留下什么具体影响，持续至何日？已有影响应保留、调整还是移除？加入新影响时是否需要替换？\n\nPhase 3｜构思各区内容')
  .replace('舆论动态、长期剧情库的顺序检查','舆论动态、长期剧情库、完结区的顺序检查')
  +'\n织野，现在，认真阅读资料，然后从<LTdesign>开始创作吧。';
 sections.materials=markWorldMaterials(sections.materials);
 return modularWorldConfig({sections,materialEnabled:defaultMaterialEnabled(),themes,ideas:[],worldRefs:[],characterRefs:[],extraPeople:'',extra:'',notes:'',readStory:true,initialScope:'all',initialCount:100}).config;
}
export function worldResultText(version,{includePlot=true}={}){return version?version.entries.filter(e=>includePlot||e.kind!=='plot').map(e=>`【${WORLD_KINDS[e.kind]}】\n${e.text}`).join('\n\n'):'';}
export const worldDateText=d=>`${d.year}年${d.month}月${d.day}日`;
export function assembleWorldRequest(config,inputs){
 const migrated=modularWorldConfig(assertWorldConfig(config));if(migrated.error)throw new Error(migrated.error);const c=migrated.config;if(!Object.values(c.taskModules).some(t=>t.enabled))throw new Error('请至少开启一个世界动态任务');if(taskEnabled(c,'region')&&!c.themes.some(t=>t.enabled))throw new Error('请至少开启一个地区主题');
 const themes=c.themes.filter(t=>t.enabled).map(t=>`地区动态主题库：${t.name}\n\n${t.content}`).join('\n\n');
 const ideas='灵感库：\n'+(c.ideas.filter(t=>t.enabled).map(t=>`${t.name}\n- ${t.content}`).join('\n\n')||'无');
 const tasks=Object.entries(WORLD_TASKS).filter(([key])=>taskEnabled(c,key));
 const taskText=tasks.map(([key,label])=>`[${label}]\n${c.taskModules[key].content}${key==='region'?'\n'+themes:key==='plot'?'\n'+ideas:''}`).join('\n\n')+'\n\n'+c.commonTasks+'\n\n本轮只输出上述开启任务的正式成品及公共完结区；未开启任务不输出标签或空区标记。';
 const design=worldDesignText(c,{enabledOnly:true});
 const materials=assembleWorldMaterials(c.sections.materials,c,inputs);
 const content=Object.entries(labels).map(([key,label])=>`[${label}]\n\n${key==='tasks'?taskText:key==='design'?design:key==='materials'?materials:c.sections[key]}`).join('\n\n');
 return {task:'worldDynamics.generate',messages:[{role:'user',content}]};
}
