export const DEFAULT_STORY_DATE_PROMPT='<time_keyword_story_time>\n当前故事日期：{当前故事日期}\n请以此维持当前剧情的日期连续性，不要被前文中的旧日期、回忆、梦境、档案或计划日期覆盖。\n</time_keyword_story_time>';
export function defaultTimeReminders(){return {current:{enabled:false,prompt:DEFAULT_STORY_DATE_PROMPT,depth:0},schedule:{prompt:'',depth:3},anniversary:{prompt:'',depth:3,advanceDays:3},holiday:{prompt:'',depth:3,advanceDays:3}};}
export function validateTimeReminders(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==4||['current','schedule','anniversary','holiday'].some(key=>!Object.hasOwn(value,key)))throw new Error('时间提醒设置无效');
 for(const [kind,item]of Object.entries(value)){
  const keys=['prompt','depth',...(kind==='current'?['enabled']:[]),...(['anniversary','holiday'].includes(kind)?['advanceDays']:[])];
  if(!item||Object.getPrototypeOf(item)!==Object.prototype||Object.keys(item).length!==keys.length||keys.some(key=>!Object.hasOwn(item,key))||typeof item.prompt!=='string'||!Number.isSafeInteger(item.depth)||item.depth<0||item.depth>10000)throw new Error('提醒提示词或深度无效');
  if(kind==='current'&&typeof item.enabled!=='boolean')throw new Error('当前日期提醒开关无效');
  if(['anniversary','holiday'].includes(kind)&&(!Number.isSafeInteger(item.advanceDays)||item.advanceDays<0||item.advanceDays>365))throw new Error('默认提前天数无效');
 }
 return structuredClone(value);
}
