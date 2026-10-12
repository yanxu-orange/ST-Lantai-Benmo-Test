export const OLD_DEFAULT_STORY_DATE_PROMPT='<time_keyword_story_time>\n当前故事日期：{当前故事日期}\n请以此维持当前剧情的日期连续性，不要被前文中的旧日期、回忆、梦境、档案或计划日期覆盖。\n</time_keyword_story_time>';
export const DEFAULT_STORY_DATE_PROMPT='续写时，请从上一段结束的时刻接着写，根据人物实际完成的动作与交谈推进时间。连续发生的短暂互动保持时间连贯；需要跨过较长时间时，交代这段时间里发生的事情。场景的转换应顺着当前情节展开，不默认以深夜、天亮或次日作为收尾。';
export const TIME_REMINDER_COPY=Object.freeze({
 schedule:Object.freeze({intro:'这是一则日程提醒，请合理做好日程规划。',outro:'续写时，请结合角色已经知道的安排及眼前的情境，让已有日程自然影响角色的生活。尚未到来的安排仍是计划，是否如期进行取决于后续剧情。'}),
 holiday:Object.freeze({intro:'这是一则节日提醒，让生活里出现节日的氛围吧：',outro:'续写时，请结合故事背景、当地习俗和角色的生活方式，考虑节日对环境、交谈与日常安排的影响。临近节日时可以描写准备与期待；节日到来后，再结合当天的情境选择适合的活动和祝语。'}),
 anniversary:Object.freeze({intro:'这是重要的纪念日提醒，请结合它对角色的意义，考虑相应的剧情安排，把握住这个特殊的时间带来的剧情发展机会：',outro:'规划剧情时，请结合角色对这一天的了解、双方的关系及当前处境，考虑是否提前准备或作出安排。可以在合适的时机留下细小的铺垫，让纪念日当天的行动与此前的准备相呼应，带来符合角色性格的惊喜。庆祝的方式与规模由情境决定，也可以是隆重的惊喜，也可以是一句问候或一件小事。'}),
});
export const DEFAULT_TIME_REMINDER_PROMPTS=Object.freeze(Object.fromEntries(Object.entries(TIME_REMINDER_COPY).map(([kind,{intro,outro}])=>[kind,`${intro}\n\n${outro}`])));
export function defaultTimeReminders(){return {current:{enabled:false,prompt:DEFAULT_STORY_DATE_PROMPT,depth:0},schedule:{prompt:DEFAULT_TIME_REMINDER_PROMPTS.schedule,depth:3},anniversary:{prompt:DEFAULT_TIME_REMINDER_PROMPTS.anniversary,depth:3,advanceDays:3},holiday:{prompt:DEFAULT_TIME_REMINDER_PROMPTS.holiday,depth:3,advanceDays:3}};}
// Only an exact known default can be upgraded. Empty and custom reminder copy
// remain intentional user values, even when the former default was empty.
export function reviseTimeRemindersDefaults(value){
 const next=validateTimeReminders(value);
 if(next.current.prompt===OLD_DEFAULT_STORY_DATE_PROMPT)next.current.prompt=DEFAULT_STORY_DATE_PROMPT;
 return next;
}
export function validateTimeReminders(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==4||['current','schedule','anniversary','holiday'].some(key=>!Object.hasOwn(value,key)))throw new Error('时间提醒设置无效');
 for(const [kind,item]of Object.entries(value)){
  const keys=['prompt','depth',...(kind==='current'?['enabled']:[]),...(['anniversary','holiday'].includes(kind)?['advanceDays']:[])];
  if(!item||Object.getPrototypeOf(item)!==Object.prototype||Object.keys(item).length!==keys.length||keys.some(key=>!Object.hasOwn(item,key))||typeof item.prompt!=='string'||!Number.isSafeInteger(item.depth)||item.depth<0||item.depth>10000)throw new Error('提醒提示词或深度无效');
  if(kind==='current'&&typeof item.enabled!=='boolean')throw new Error('时间推进开关无效');
  if(['anniversary','holiday'].includes(kind)&&(!Number.isSafeInteger(item.advanceDays)||item.advanceDays<0||item.advanceDays>365))throw new Error('默认提前天数无效');
 }
 return structuredClone(value);
}
