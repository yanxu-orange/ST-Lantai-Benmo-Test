import { blankEvent, validateEventForSave } from '../memory/model.js';
import { exactKeys, strings, validateIndexes } from '../memory/management-validation.js';

const draftKeys = ['title','storyTime','body','people','locations','classificationTags','specialDateCandidates'];
const textArray = { type:'array',items:{type:'string'} };
const properties = {title:{type:'string'},body:{type:'string'},storyTime:{type:'object',additionalProperties:false,required:['start','end'],properties:{start:{type:'string'},end:{type:'string'}}},people:textArray,locations:textArray,classificationTags:textArray,specialDateCandidates:{type:'array',items:{type:'object',additionalProperties:false,required:['name','storyDate','reason'],properties:{name:{type:'string'},storyDate:{type:'string'},reason:{type:'string'}}}}};
// Only invalid alias text is disposable. Structure and ownership stay strict.
export function normalizeSummaryAliases(data,{stage,events=[]}={}) {
  const copy=structuredClone(data),diagnostics=[];
  const rows=stage==='fast'?copy?.memories:copy?.indexes;
  if(!Array.isArray(rows))return {data:copy,diagnostics};
  for(const [rowIndex,row] of rows.entries()) {
    if(!row||!Array.isArray(row.detailAliases))continue;
    const details=stage==='aliases'?events.find(event=>event.id===row.draftId)?.detailWords.map(term=>term.word):row.detailKeywords;
    if(!Array.isArray(details)){if(stage==='aliases')throw new Error('简称草稿身份无效');continue;}
    const parents=new Set(),filtered=[];
    for(const [relationIndex,relation] of row.detailAliases.entries()) {
      if(!exactKeys(relation,['parentDetail','aliases'])||!details.includes(relation.parentDetail)||parents.has(relation.parentDetail)||!Array.isArray(relation.aliases)||relation.aliases.some(alias=>typeof alias!=='string'))throw new Error('简称结构或父词绑定无效');
      parents.add(relation.parentDetail);
      const seen=new Set(),aliases=[];
      for(const [aliasIndex,alias] of relation.aliases.entries()) {
        if(!/^[\p{Script=Han}0-9]+$/u.test(alias)||alias===relation.parentDetail||!relation.parentDetail.includes(alias)||seen.has(alias))diagnostics.push({rowIndex,relationIndex,aliasIndex,code:'invalid-alias-discarded'});
        else {seen.add(alias);aliases.push(alias);}
      }
      if(aliases.length)filtered.push({...relation,aliases});
      else diagnostics.push({rowIndex,relationIndex,code:'empty-alias-group-discarded'});
    }
    row.detailAliases=filtered;
  }
  return {data:copy,diagnostics};
}
export function summarySchema(complete=false) {
  const fields=complete?{...properties,eventKeywords:textArray,detailKeywords:textArray,detailAliases:{type:'array',items:{type:'object',additionalProperties:false,required:['parentDetail','aliases'],properties:{parentDetail:{type:'string'},aliases:textArray}}}}:properties;
  return {name:complete?'event_summary':'event_summary_drafts',value:{type:'object',additionalProperties:false,required:['memories'],properties:{memories:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,required:Object.keys(fields),properties:fields}}}}};
}
export function validDrafts(data,{complete=false,availableNames=[]}={}) {
  if(!exactKeys(data,['memories'])||!Array.isArray(data.memories)||!data.memories.length)return false;
  return data.memories.every((item,index)=>{
    if(!exactKeys(item,complete?[...draftKeys,'eventKeywords','detailKeywords','detailAliases']:draftKeys)||!exactKeys(item.storyTime,['start','end'])||[item.title,item.body,item.storyTime.start,item.storyTime.end].some(value=>typeof value!=='string')||!item.body.trim()||!strings(item.people)||!strings(item.locations)||!Array.isArray(item.classificationTags)||item.classificationTags.length||!Array.isArray(item.specialDateCandidates))return false;
    if(item.specialDateCandidates.some(date=>!exactKeys(date,['name','storyDate','reason'])||[date.name,date.storyDate,date.reason].some(value=>typeof value!=='string'||!value.trim())))return false;
    return !complete||validateIndexes({indexes:[{draftId:String(index),eventKeywords:item.eventKeywords,detailKeywords:item.detailKeywords,detailAliases:item.detailAliases}]},[String(index)],availableNames);
  });
}
export function draftsToEvents(data,ranges,uuid=()=>crypto.randomUUID()) {
  return data.memories.map(item=>({...blankEvent(uuid()),title:item.title,body:item.body,startTime:item.storyTime.start,endTime:item.storyTime.end,people:[...item.people],places:[...item.locations],sources:structuredClone(ranges)}));
}
export function applyIndexes(events,data,uuid=()=>crypto.randomUUID()) {
  return events.map(event=>{
    const index=data.indexes.find(item=>item.draftId===event.id);
    return {...event,eventWords:[...index.eventKeywords],detailWords:index.detailKeywords.map(word=>({id:uuid(),word,aliases:[...(index.detailAliases.find(item=>item.parentDetail===word)?.aliases??[])]}))};
  });
}
export function reviewEvents(value,originals) {
  const copied=structuredClone(value);
  if(!Array.isArray(copied)||!copied.length||new Set(copied.map(item=>item?.id)).size!==copied.length)throw new Error('请保留至少一条有效记忆');
  const owners=new Map();for(const event of originals)for(const term of event.detailWords)owners.set(term.id,event.id);
  const termIds=new Set();
  return copied.map(event=>{
    const original=originals.find(item=>item.id===event?.id);
    if(!original||!exactKeys(event,Object.keys(original))||JSON.stringify(event.sources)!==JSON.stringify(original.sources)||JSON.stringify(event.batch)!==JSON.stringify(original.batch)||event.createdAt!==original.createdAt||event.updatedAt!==original.updatedAt)throw new Error('候选身份或来源已变化');
    for(const term of event.detailWords){if(termIds.has(term.id)||owners.has(term.id)&&owners.get(term.id)!==event.id)throw new Error('细节词绑定无效');termIds.add(term.id);}
    return validateEventForSave(event);
  });
}
