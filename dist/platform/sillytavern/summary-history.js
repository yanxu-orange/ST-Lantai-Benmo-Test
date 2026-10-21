// ST rewrites mes and supplies a filtered index. Neither is a source identity.
export function mapSummaryPromptFloors(prompt,original) {
  if(!Array.isArray(prompt)||!Array.isArray(original)||prompt===original)return null;
  const originalObjects=new Set(original);if(prompt.some(message=>originalObjects.has(message)))return null;
  const byId=new Map(),byDate=new Map();
  const add=(map,key,value)=>{const items=map.get(key);if(items)items.push(value);else map.set(key,[value]);};
  original.forEach((source,floor)=>{if(!source)return;const item={source,floor};
    if(typeof source.id==='string'||Number.isSafeInteger(source.id))add(byId,source.id,item);
    if(typeof source.send_date==='string'||Number.isFinite(source.send_date))add(byDate,source.send_date,item);
  });
  const used=new Set(),floors=[];
  for(const message of prompt) {
    const hasId=typeof message.id==='string'||Number.isSafeInteger(message.id),hasDate=typeof message.send_date==='string'||Number.isFinite(message.send_date);
    if(!hasId&&!hasDate)return null;
    const matches=((hasId?byId.get(message.id):byDate.get(message.send_date))??[]).filter(({source})=>source&&source.is_user===message.is_user&&source.name===message.name
      &&(hasId?source.id===message.id:source.send_date===message.send_date)
      &&(!message.extra||source.extra===message.extra));
    if(matches.length!==1||used.has(matches[0].floor))return null;
    used.add(matches[0].floor);floors.push(matches[0].floor);
  }
  return floors;
}
