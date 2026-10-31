import {worldDateText} from './prompts.js';
const tags=Object.freeze({world:'LTworld',region:'LTregion',weather:'LTweather',activity:'LTactivity',character:'LTcharacter',opinion:'LTopinion',plot:'LTplot',aftermath:'LTaftermath',custom:'LTcustom'});
const encode=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const safe=(entry,prefix)=>['weather','custom'].includes(entry.kind)?entry.id===prefix:new RegExp('^'+prefix+'[1-9]\\d*$').test(entry.id);
// Display protocol only: template data is encoded once, never parsed as model HTML.
export function worldDisplayText({entries,date,sectionDates}){
 const reserved=new Set(entries.filter(entry=>tags[entry.kind]&&safe(entry,tags[entry.kind])).map(entry=>entry.id)),used=new Set(),counts={};
 const parts=entries.flatMap(entry=>{const prefix=tags[entry.kind];if(!prefix)return [];let tag=safe(entry,prefix)&&!used.has(entry.id)?entry.id:null;while(!tag){const count=counts[entry.kind]=(counts[entry.kind]??0)+1,candidate=entry.kind==='weather'&&count===1?prefix:prefix+count;if(!reserved.has(candidate)&&!used.has(candidate))tag=candidate;}used.add(tag);const origin=sectionDates?.[entry.kind],note=origin?.retained?`<!-- ${entry.kind}: ${encode(worldDateText(origin.date))} -->\n`:'';return [`${note}<${tag}${entry.kind==='custom'?` name="${encode(entry.name??'自定义区')}"`:''}>\n${encode(entry.text)}\n</${tag}>`];});
 return `<LTworldDynamics>\n<LTworldDate>${encode(worldDateText(date))}</LTworldDate>\n${parts.join('\n\n')}\n</LTworldDynamics>`;
}
