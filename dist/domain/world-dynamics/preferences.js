export const WORLD_CONTEXT_INTRO='以下是对世界未来发展的预言，是一份仅供参考的可选的创作灵感，并非既定事实，也不代表角色已经知晓。你可以按剧情需要采纳、忽略或改变，让预言成真或不再发生。一切安排都应服务于故事的合理性、逻辑与剧情发展，不得因此改写已经发生的正文。正文才是正典，预言的发展和正文事实冲突时，你可以直接调整或舍弃对应预言。这是预言全貌：';
export const defaultWorldPreferences=()=>({enabled:false,depth:3,display:false});
export function assertWorldPreferences(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!['enabled','depth','display','displayMode','injectionPrompt'].includes(key))||Object.keys(value).length!==3+Number(Object.hasOwn(value,'displayMode'))+Number(Object.hasOwn(value,'injectionPrompt'))||Object.hasOwn(value,'injectionPrompt')&&typeof value.injectionPrompt!=='string'||Object.hasOwn(value,'displayMode')&&!['builtin','regex'].includes(value.displayMode)||typeof value.enabled!=='boolean'||typeof value.display!=='boolean'||!Number.isSafeInteger(value.depth)||value.depth<0||value.depth>10000)throw new Error('世界动态设置无效');
 return {...value};
}
export const worldPreferences=value=>assertWorldPreferences(value?.preferences??defaultWorldPreferences());

// Frontend display and the root revision do not change a prepared model prompt.
export function worldInjectionAuthority(domain){const {revision,...rest}=domain,{displayMode,...preferences}=worldPreferences(domain);return {...rest,preferences:{...preferences,display:false,injectionPrompt:preferences.injectionPrompt??WORLD_CONTEXT_INTRO}};}
