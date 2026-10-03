const copy = value => structuredClone(value);
export function parseCleaningPattern(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error('正则须为 /表达式/flags');
  const end = value.lastIndexOf('/');
  if (end < 1) throw new Error('正则格式无效');
  const source = value.slice(1, end), flags = value.slice(end + 1);
  if (!source || !/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error('正则标记无效');
  new RegExp(source, flags);
  return { source, flags };
}
export function normalizeCleaningRule(value) {
  if (!value || typeof value.id !== 'string' || !value.id.trim() || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.enabled !== 'boolean' || !['extract', 'exclude', 'replace'].includes(value.action)
    || !Number.isSafeInteger(value.captureGroup) || value.captureGroup < 0 || typeof value.replacement !== 'string') throw new Error('清洗规则无效');
  parseCleaningPattern(value.pattern);
  return copy({ id:value.id,name:value.name,enabled:value.enabled,action:value.action,pattern:value.pattern,captureGroup:value.captureGroup,replacement:value.replacement });
}
export const DEFAULT_SUMMARY_CLEANING_RULES = Object.freeze([
  Object.freeze({id:'comments',name:'HTML 注释',enabled:true,action:'exclude',pattern:'/<!--[\\s\\S]*?-->/su',captureGroup:0,replacement:''}),
  Object.freeze({id:'content-context',name:'正文标签',enabled:true,action:'extract',pattern:'/<(content|context)\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>/sui',captureGroup:2,replacement:''}),
]);
export const createDefaultCleaningRules = () => copy(DEFAULT_SUMMARY_CLEANING_RULES);
export const BUILTIN_SUMMARY_CLEANING_SHORTCUTS = Object.freeze([
  {name:'HTML 注释',action:'exclude',pattern:'/<!--[\\s\\S]*?-->/su'},
  {name:'<think>',action:'exclude',pattern:'/<think(?:\\s[^>]*)?>[\\s\\S]*?<\\/think\\s*>/sui'},
  {name:'<thinking>',action:'exclude',pattern:'/<thinking(?:\\s[^>]*)?>[\\s\\S]*?<\\/thinking\\s*>/sui'},
  {name:'<details>',action:'exclude',pattern:'/<details(?:\\s[^>]*)?>[\\s\\S]*?<\\/details\\s*>/sui'},
  {name:'<content>',action:'extract',pattern:'/(?<=<content>)[\\s\\S]*?(?=<\\/content>)/su'},
  {name:'<scene>',action:'extract',pattern:'/(?<=<scene>)[\\s\\S]*?(?=<\\/scene>)/su'},
  {name:'文生图提示词（3 种）',action:'exclude',pattern:'/<(imgthink|bbi_image)(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>|image###[\\s\\S]*?###/sui'},
].map(value => Object.freeze({...value,enabled:false,captureGroup:0,replacement:''})));
export function applySummaryCleaningRules(source, rules = DEFAULT_SUMMARY_CLEANING_RULES) {
  if (typeof source !== 'string' || !Array.isArray(rules)) throw new Error('清洗输入无效');
  const prepared = rules.map(normalizeCleaningRule);
  if (new Set(prepared.map(rule=>rule.id)).size !== prepared.length) throw new Error('清洗规则身份重复');
  const expression = (rule, indices=false) => {const parsed=parseCleaningPattern(rule.pattern);return new RegExp(parsed.source,[...new Set(parsed.flags+'g'+(indices?'d':''))].join(''));};
  const excluded = prepared.filter(rule=>rule.enabled&&rule.action==='exclude').flatMap(rule=>[...source.matchAll(expression(rule,true))].map(match=>match.indices[0]).filter(([start,end])=>end>start));
  const spans = [], results = [];
  for (const rule of prepared) {
    if (!rule.enabled) {results.push({id:rule.id,status:'disabled',matches:0});continue;}
    if (rule.action !== 'extract') continue;
    const matches=[...source.matchAll(expression(rule,true))];
    for (const match of matches) {
      const span=match.indices[rule.captureGroup];
      if (span && span[1]>span[0]) {
        // Subtract exclusions in original coordinates, before extraction can
        // cut away the opening tag needed by a later exclusion expression.
        let pieces=[span];
        for(const [start,end] of excluded)pieces=pieces.flatMap(([left,right])=>end<=left||start>=right?[[left,right]]:[...(left<start?[[left,start]]:[]),...(end<right?[[end,right]]:[])]);
        spans.push(...pieces);
      }
    }
    results.push({id:rule.id,status:matches.length?'applied':'unmatched',matches:matches.length});
  }
  spans.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const merged=[];
  for(const [start,end] of spans){const last=merged.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);}
  let text=merged.length?merged.map(([start,end])=>source.slice(start,end)).join('\n'):source;
  for(const rule of prepared.filter(rule=>rule.enabled&&rule.action!=='extract')){
    const matches=[...text.matchAll(expression(rule))].length;
    text=text.replace(expression(rule),rule.action==='replace'?rule.replacement:'');
    results.push({id:rule.id,status:matches?'applied':'unmatched',matches});
  }
  return {text:text.trim(),results:prepared.map(rule=>results.find(result=>result.id===rule.id))};
}
export function cleanSummaryFloors(floors,{rules=DEFAULT_SUMMARY_CLEANING_RULES,includeUser=true}={}) {
  if(!Array.isArray(floors)||typeof includeUser!=='boolean')throw new Error('清洗楼层无效');
  return floors.filter(floor=>floor.role!=='system'&&!floor.system&&(includeUser||floor.role!=='user')).flatMap(floor=>{const result=applySummaryCleaningRules(floor.text,rules);return result.text?[{...copy(floor),text:result.text,cleaningResults:result.results}]:[];});
}
