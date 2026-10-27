import {WORLD_TASKS,modularWorldConfig,taskEnabled} from './tasks.js';
import {WORLD_PRESET_SOURCE} from './preset-source.js';
import {assertWorldConfig,WORLD_KINDS} from './data.js';
const labels={identity:'AI身份区',rules:'基本规则',materials:'资料区',tasks:'任务区',design:'设计区'};
export function defaultWorldConfig(){
 const matches=[...WORLD_PRESET_SOURCE.replaceAll('\r\n','\n').matchAll(/^\[(AI身份区|基本规则|资料区|任务区|设计区)\]$/gm)];
 const sections={};for(let i=0;i<matches.length;i++){const key=Object.keys(labels).find(k=>labels[k]===matches[i][1]);sections[key]=WORLD_PRESET_SOURCE.replaceAll('\r\n','\n').slice(matches[i].index+matches[i][0].length,matches[i+1]?.index).trim();}
 const themes=[...sections.tasks.matchAll(/地区动态主题库：([^\n]+)\n([\s\S]*?)(?=地区动态主题库：|\[天气环境\])/g)].map((m,i)=>({id:`theme-${i}`,name:m[1].trim(),content:m[2].trim(),enabled:true}));
 sections.tasks=sections.tasks.replace(/地区动态主题库：政治主题[\s\S]*?(?=\[天气环境\])/,'{{regionThemes}}\n\n');
 sections.tasks=sections.tasks.replace(/灵感库：用户填写的条目名称[\s\S]*$/,'{{plotIdeas}}');
 sections.tasks+='\n\n[完结区]\n普通事件（世界、地区、活动、舆论）结束后，值得保留的影响输出为LTaftermath1、LTaftermath2独立标签，最多2条；字段为事件、完结日期、影响、有效至。无影响输出“完结区：无”。只保留一句话影响与截止日期；新内容替换最早完结的事件，截止日期成为昨天时删除。天气、人物和长期剧情不参与长尾影响判断。\n日期统一用本历法数字“年/月/日”完整表达。人物不足3名按实际人数，没有人物输出“角色动态：无”。除LTdesign与正式标签和明确空区标记外，不输出其他文字。';
 sections.design+='\n\n检查普通事件完结后是否值得留下影响，已有影响是否需要调整或移除；遵守完结区上限。';
 return modularWorldConfig({sections,themes,ideas:[],worldRefs:[],characterRefs:[],extraPeople:'',extra:'',notes:'',readStory:true,initialScope:'all',initialCount:100}).config;
}
export function worldResultText(version,{includePlot=true}={}){return version?version.entries.filter(e=>includePlot||e.kind!=='plot').map(e=>`【${WORLD_KINDS[e.kind]}】\n${e.text}`).join('\n\n'):'';}
export const worldDateText=d=>`${d.year}年${d.month}月${d.day}日`;
export function assembleWorldRequest(config,inputs){
 const migrated=modularWorldConfig(assertWorldConfig(config));if(migrated.error)throw new Error(migrated.error);const c=migrated.config;if(!Object.values(c.taskModules).some(t=>t.enabled))throw new Error('请至少开启一个世界动态任务');if(taskEnabled(c,'region')&&!c.themes.some(t=>t.enabled))throw new Error('请至少开启一个地区主题');
 const themes=c.themes.filter(t=>t.enabled).map(t=>`地区动态主题库：${t.name}\n\n${t.content}`).join('\n\n');
 const ideas='灵感库：\n'+(c.ideas.filter(t=>t.enabled).map(t=>`${t.name}\n- ${t.content}`).join('\n\n')||'无');
 const tasks=Object.entries(WORLD_TASKS).filter(([key])=>taskEnabled(c,key));
 const taskText=tasks.map(([key,label])=>`[${label}]\n${c.taskModules[key].content}${key==='region'?'\n'+themes:key==='plot'?'\n'+ideas:''}`).join('\n\n')+'\n\n'+c.commonTasks+'\n\n本轮只输出上述开启任务的正式成品及公共完结区；未开启任务不输出标签或空区标记。';
 const design=c.commonDesign.before+'\n'+tasks.map(([key,label])=>`[${label}]\n${c.taskModules[key].design}`).join('\n\n')+'\n'+c.commonDesign.after;
 let content=Object.entries(labels).map(([key,label])=>`[${label}]\n\n${key==='tasks'?taskText:key==='design'?design:c.sections[key]}`).join('\n\n');
 for(const [tag,value]of Object.entries(inputs))content=content.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`),()=>`<${tag}>\n${value}\n</${tag}>`);
 return {task:'worldDynamics.generate',messages:[{role:'user',content}]};
}
