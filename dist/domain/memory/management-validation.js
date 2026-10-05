import { detailWordError, validateEventForSave } from './model.js';
export const equalData = (a,b) => {
 if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equalData(a[key],b[key]));
};
export const exactKeys = (value,keys) => !!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
export function strings(value,{nonempty=false}={}) {
 return Array.isArray(value)&&(!nonempty||value.length>0)&&new Set(value).size===value.length&&value.every(word=>typeof word==='string'&&word.trim()===word&&word.length>0);
}
export function validateIndexes(data,ids,availableNames) {
 if(!exactKeys(data,['indexes'])||!Array.isArray(data.indexes)||data.indexes.length!==ids.length)return false;
 const seen=new Set(),available=new Set(availableNames);
 for(const index of data.indexes) {
  if(!exactKeys(index,['draftId','eventKeywords','detailKeywords','detailAliases'])||!ids.includes(index.draftId)||seen.has(index.draftId)||!strings(index.eventKeywords)||!strings(index.detailKeywords)||index.eventKeywords.some(word=>!available.has(word))||!Array.isArray(index.detailAliases))return false;
  seen.add(index.draftId);const parents=new Set();
  for(const record of index.detailAliases) {
   if(!exactKeys(record,['parentDetail','aliases'])||!index.detailKeywords.includes(record.parentDetail)||parents.has(record.parentDetail)||!strings(record.aliases,{nonempty:true}))return false;
   parents.add(record.parentDetail);if(detailWordError({word:record.parentDetail,aliases:record.aliases},[{word:record.parentDetail}]))return false;
  }
 }
 return seen.size===ids.length;
}
export function validateMergedText(value) {
 return exactKeys(value,['title','body','coherenceWarning'])&&typeof value.title==='string'&&typeof value.body==='string'&&!!value.body.trim()&&typeof value.coherenceWarning==='string';
}
export function validateReview(fields,base) {
 if(!exactKeys(fields,['title','body','people','places','startTime','endTime'])||!strings(fields.people)||!strings(fields.places))throw new Error('审核字段无效');
 return validateEventForSave({...base,...fields});
}
export function originalSnapshot(value,ranges) {
 if(!exactKeys(value,['messages'])||!Array.isArray(value.messages))throw new Error('原文来源快照无效');
 const count=ranges.reduce((total,range)=>total+range.end-range.start+1,0),seen=new Set();
 if(!Number.isSafeInteger(count)||value.messages.length!==count)throw new Error('原文来源不完整');
 for(const item of value.messages) {
  if(!exactKeys(item,['floor','text'])||!Number.isSafeInteger(item.floor)||seen.has(item.floor)||typeof item.text!=='string'||!ranges.some(range=>item.floor>=range.start&&item.floor<=range.end))throw new Error('原文来源不完整或越界');
  seen.add(item.floor);
 }
 return {messages:structuredClone(value.messages).sort((a,b)=>a.floor-b.floor)};
}
