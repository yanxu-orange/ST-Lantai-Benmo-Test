export const defaultWorldPreferences=()=>({enabled:false,depth:3,display:false});
export function assertWorldPreferences(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!['enabled','depth','display','displayMode'].includes(key))||Object.keys(value).length!==(Object.hasOwn(value,'displayMode')?4:3)||Object.hasOwn(value,'displayMode')&&!['builtin','regex'].includes(value.displayMode)||typeof value.enabled!=='boolean'||typeof value.display!=='boolean'||!Number.isSafeInteger(value.depth)||value.depth<0||value.depth>10000)throw new Error('世界动态设置无效');
 return {...value};
}
export const worldPreferences=value=>assertWorldPreferences(value?.preferences??defaultWorldPreferences());

// Frontend display and the root revision do not change a prepared model prompt.
export function worldInjectionAuthority(domain){const {revision,...rest}=domain,{displayMode,...preferences}=worldPreferences(domain);return {...rest,preferences:{...preferences,display:false}};}
