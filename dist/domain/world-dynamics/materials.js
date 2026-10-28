// These boundaries belong to the editable template, not to the supplied data.
export const WORLD_MATERIALS=Object.freeze({
 currentDate:{name:'当前日期',tag:'LTcurrentDate'},
 worldInfo:{name:'世界资料',tag:'LTworldInfo'},
 characterInfo:{name:'人物资料',tag:'LTcharacterInfo'},
 festivalInfo:{name:'近期节日',tag:'LTfestivalInfo'},
 plotHistory:{name:'已有长期剧情库',tag:'LTplotHistory'},
 worldHistory:{name:'上一版世界动态',tag:'LTworldHistory'},
 storyContext:{name:'本轮剧情资料',tag:'LTstoryContext'},
 userNotes:{name:'本次补充要求',tag:'LTuserNotes'}
});
export const defaultMaterialEnabled=()=>Object.fromEntries(Object.keys(WORLD_MATERIALS).map(key=>[key,true]));
export const materialEnabled=(config,key)=>config?.materialEnabled?.[key]!==false&&(key!=='storyContext'||config?.readStory!==false)&&(key!=='plotHistory'||config?.taskModules?.plot?.enabled!==false);
const boundary=(name,edge)=>`<!-- ${name}:${edge} -->`;
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fail=name=>{throw new Error(`“${name}”资料边界不完整或无法确定，请核对 <!-- ${name}:start --> 与 <!-- ${name}:end -->；原文已保留。`);};
function ranges(text){
 const found=[];
 for(const match of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)){
  const comment=match[0],inner=comment.replace(/^<!--\s*/,'').replace(/\s*-->$/,'').trim(),known=Object.values(WORLD_MATERIALS).find(({name})=>inner.startsWith(name+':')||inner.startsWith(name+'：'));
  if(known&&!['start','end'].some(edge=>comment===boundary(known.name,edge)))fail(known.name);
  if(!known&&/[:：](?:start|end)\s*$/.test(inner))fail('未知');
 }
 for(const [key,{name,tag}]of Object.entries(WORLD_MATERIALS)){
  const opens=[...text.matchAll(new RegExp(`<${tag}>`,'g'))],closes=[...text.matchAll(new RegExp(`</${tag}>`,'g'))];
  const start=boundary(name,'start'),end=boundary(name,'end'),starts=[...text.matchAll(new RegExp(escaped(start),'g'))],ends=[...text.matchAll(new RegExp(escaped(end),'g'))];
  if(starts.length||ends.length){
   if(starts.length!==1||ends.length!==1||starts[0].index>=ends[0].index||opens.length!==1||closes.length!==1||opens[0].index>=closes[0].index)fail(name);
   const a=starts[0].index,b=ends[0].index+end.length,body=text.slice(a+start.length,ends[0].index);
   if([...body.matchAll(new RegExp(`<${tag}>`,'g'))].length!==1||[...body.matchAll(new RegExp(`</${tag}>`,'g'))].length!==1)fail(name);
   found.push({key,name,tag,start:a,end:b,bodyStart:a+start.length,bodyEnd:ends[0].index});continue;
  }
  // Old templates are recognized only when the named description immediately
  // precedes the unique slot. Never infer ownership from an arbitrary paragraph.
  if(!opens.length&&!closes.length){if(text.includes(name+'：'))fail(name);continue;}
  if(opens.length!==1||closes.length!==1||opens[0].index>=closes[0].index)fail(name);
  const prefix=text.slice(0,opens[0].index),description=prefix.match(new RegExp(`(^|\n)(${escaped(name)}：[^\n]*\n)[ \t]*$`));
  if(!description)fail(name);
  const a=description.index+description[1].length,b=closes[0].index+closes[0][0].length;
  found.push({key,name,tag,start:a,end:b,bodyStart:a,bodyEnd:b});
 }
 found.sort((a,b)=>a.start-b.start);
 for(let i=1;i<found.length;i++)if(found[i].start<found[i-1].end)fail(found[i].name);
 return found;
}
export function markWorldMaterials(template){
 let result=template;for(const row of ranges(template).reverse())if(row.bodyStart===row.start)result=result.slice(0,row.start)+boundary(row.name,'start')+'\n'+result.slice(row.start,row.end)+'\n'+boundary(row.name,'end')+result.slice(row.end);return result;
}
export function assembleWorldMaterials(template,config,inputs){
 let result=template;
 for(const row of ranges(template).reverse()){
  let body=template.slice(row.bodyStart,row.bodyEnd);
  if(!materialEnabled(config,row.key))body='';
  else if(Object.hasOwn(inputs,row.tag))body=body.replace(new RegExp(`<${row.tag}>[\\s\\S]*?</${row.tag}>`),()=>`<${row.tag}>\n${inputs[row.tag]}\n</${row.tag}>`);
  result=result.slice(0,row.start)+body+result.slice(row.end);
 }
 return result;
}
