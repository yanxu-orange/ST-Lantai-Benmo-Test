export const LEGACY_FEATURES=Object.freeze(['event','cumulative','time','prompt','collect','sync']);
export const BENMO_FEATURES=Object.freeze(['summary','item','npc']);
export const FEATURES=Object.freeze([...LEGACY_FEATURES,...BENMO_FEATURES]);
export const FEATURE_GROUPS=Object.freeze([['记忆',['event','cumulative']],['时间',['time']],['本末',BENMO_FEATURES],['工坊',['prompt','collect','sync']]]);
export const FEATURE_LABELS=Object.freeze({event:'事件记忆',cumulative:'古法总结',time:'时间管理',prompt:'提示词注入',collect:'内容收集',sync:'长期追踪',summary:'最新摘要',item:'物品追踪',npc:'角色追踪'});
export function defaultControls(){return {enabled:true,features:Object.fromEntries(FEATURES.map(key=>[key,!['item','npc'].includes(key)]))};}
export function defaultChatControls(){return {enabled:true};}
function exact(value,keys){return value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
export function assertControls(value){
 if(!exact(value,['enabled','features'])||typeof value.enabled!=='boolean'||!exact(value.features,FEATURES)||FEATURES.some(key=>typeof value.features[key]!=='boolean'))throw new Error('功能开关格式无效');
 return structuredClone(value);
}
// Upgrade only global settings. Never derive new paid-task switches from a chat.
export function normalizeControls(value){
 if(exact(value,['enabled','features'])&&exact(value.features,LEGACY_FEATURES)){
  return assertControls({...value,features:{...value.features,...Object.fromEntries(BENMO_FEATURES.map(key=>[key,key==='summary']))}});
 }
 return assertControls(value);
}
export function assertChatControls(value){
 if(!exact(value,['enabled'])||typeof value.enabled!=='boolean')throw new Error('当前聊天开关格式无效');
 return structuredClone(value);
}
export function effectiveControls(global=defaultControls(),chat=defaultChatControls()){
 const controls=assertControls(global),local=assertChatControls(chat),enabled=controls.enabled&&local.enabled;
 const features=Object.fromEntries(FEATURES.map(key=>[key,enabled&&controls.features[key]]));
 return Object.freeze({...features,enabled,memory:features.event||features.cumulative,benmo:features.summary||features.item||features.npc,workshop:features.prompt||features.collect||features.sync,settings:true});
}
