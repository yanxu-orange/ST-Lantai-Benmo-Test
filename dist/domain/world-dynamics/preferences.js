export const WORLD_CONTEXT_INTRO='以下是可能随正文改变的世界发展安排，供续写参考；不直接代表已经发生的事实或角色已知信息。';
export const defaultWorldPreferences=()=>({enabled:false,depth:3,display:false});
export function assertWorldPreferences(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!['enabled','depth','display','displayMode','injectionPrompt'].includes(key))||Object.keys(value).length!==3+Number(Object.hasOwn(value,'displayMode'))+Number(Object.hasOwn(value,'injectionPrompt'))||Object.hasOwn(value,'injectionPrompt')&&typeof value.injectionPrompt!=='string'||Object.hasOwn(value,'displayMode')&&!['builtin','regex'].includes(value.displayMode)||typeof value.enabled!=='boolean'||typeof value.display!=='boolean'||!Number.isSafeInteger(value.depth)||value.depth<0||value.depth>10000)throw new Error('世界动态设置无效');
 return {...value};
}
export const worldPreferences=value=>assertWorldPreferences(value?.preferences??defaultWorldPreferences());

// Frontend display and the root revision do not change a prepared model prompt.
export function worldInjectionAuthority(domain){const {revision,...rest}=domain,{displayMode,...preferences}=worldPreferences(domain);return {...rest,preferences:{...preferences,display:false,injectionPrompt:preferences.injectionPrompt??WORLD_CONTEXT_INTRO}};}
