import { INDEX_FIELDS,MERGE_FIELDS,INDEX_SCHEMA } from './management-prompt-defaults.js';
export const MERGE_SCHEMA={name:'merged_memory_text',value:{type:'object',additionalProperties:false,required:['title','body','coherenceWarning'],properties:{title:{type:'string'},body:{type:'string',minLength:1},coherenceWarning:{type:'string'}}}};
export function generationSettings(value) {
 if(!value||!Number.isSafeInteger(value.epoch)||value.epoch<0||!Array.isArray(value.eventWords))throw new Error('生成设置或版本无效');
 const words=value.eventWords.filter(word=>word?.enabled!==false);
 if(words.some(word=>typeof word?.name!=='string'||!word.name.trim()||word.name.trim()!==word.name||typeof word.definition!=='string')||new Set(words.map(word=>word.name)).size!==words.length)throw new Error('事件词库无效');
 const promptOverrides=value.promptOverrides??{},keys=new Set([...INDEX_FIELDS,...MERGE_FIELDS].map(field=>field.key));
 if(!promptOverrides||typeof promptOverrides!=='object'||Array.isArray(promptOverrides)||Object.entries(promptOverrides).some(([key,text])=>!keys.has(key)||typeof text!=='string'))throw new Error('提示词设置无效');
 return {epoch:value.epoch,eventWords:words.map(({name,definition})=>({name,definition})),promptOverrides:structuredClone(promptOverrides)};
}
const instructions=(fields,settings)=>fields.map(field=>Object.hasOwn(settings.promptOverrides,field.key)?settings.promptOverrides[field.key]:field.defaultText).join('\n\n');
export const fixedFacts = event => ({draftId:event.id,title:event.title,body:event.body,storyTime:{start:event.startTime,end:event.endTime},people:event.people,locations:event.places});
export function indexRequest(events,settings) {
 return {task:'memory.indexes',jsonSchema:structuredClone(INDEX_SCHEMA),messages:[{role:'system',content:instructions(INDEX_FIELDS,settings)+'\n\n现行简称规则补充：简称可以是父词中连续汉字或数字片段（含组合），不能等于完整父词，不允许英文、拼接、重复或空白。必须返回完整indexes及draftId/eventKeywords/detailKeywords/detailAliases字段，根对象和各记录不允许额外字段。每个输入draftId恰好出现一次。\n'+JSON.stringify(INDEX_SCHEMA.value)},{role:'user',content:JSON.stringify({summaryDrafts:events.map(fixedFacts),availableEventWords:settings.eventWords})}]};
}
export function mergeRequest(events,settings,mode,original) {
 const input={sourceMode:mode,memories:events.map(fixedFacts)};if(mode==='original')input.original=original;
 return {task:'memory.merge',jsonSchema:structuredClone(MERGE_SCHEMA),messages:[{role:'system',content:instructions(MERGE_FIELDS,settings)+'\n仅返回title/body/coherenceWarning三个字符串字段的JSON。\n'+JSON.stringify(MERGE_SCHEMA.value)},{role:'user',content:JSON.stringify(input)}]};
}
