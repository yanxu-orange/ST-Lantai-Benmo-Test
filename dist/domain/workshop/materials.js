// Optional per-item settings. Reading an old item never writes these defaults.
export const DEFAULT_WORKSHOP_MATERIALS=Object.freeze({recentDialogue:false,recentFloorCount:6,recalledMemory:false,character:false});
export function workshopMaterials(module){
 const value=module.generationMaterials;
 if(value===undefined)return {...DEFAULT_WORKSHOP_MATERIALS};
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_WORKSHOP_MATERIALS,key))
  ||['recentDialogue','recalledMemory','character'].some(key=>typeof value[key]!=='boolean')||!Number.isSafeInteger(value.recentFloorCount)||value.recentFloorCount<2||value.recentFloorCount>200)throw new Error('工坊生成资料设置无效');
 return {...value};
}
export function hasWorkshopMaterials(module){const v=workshopMaterials(module);return module.lifecycle!=='prompt'&&(module.generationSource??'story')==='background'&&(v.recentDialogue||v.recalledMemory||v.character);}
export function prepareWorkshopMaterials({module,source,raw,character=null,recall={status:'unavailable',memories:[]}}){
 const options=workshopMaterials(module),materials={},availability={};
 if(options.recentDialogue){
  const start=Math.max(0,source.assistantFloor-options.recentFloorCount+1),identity=row=>row.objectTicket??row.identity,base=new Set(source.rawMessages.map(identity));
  // Window first, then remove native hidden/system/tool/empty rows. Never fill
  // a gap from before the fixed window, nor read transformed sending copies.
  materials['最近对话']=raw.messages.filter(row=>row.floor>=start&&row.floor<=source.assistantFloor&&!row.system&&row.semanticRole!=='system'&&['user','assistant'].includes(row.role)&&(!row.specialPayload||row.latestTextOnly===true)&&row.text.trim()&&!base.has(identity(row))).map(row=>({role:row.role,content:row.text}));
 }
 if(options.recalledMemory){availability.recalledMemory=recall.status;if(recall.status==='matched'&&recall.memories.length)materials['本轮召回记忆']=recall.memories.map(({startTime,endTime,title,body})=>({起始时间:startTime,结束时间:endTime,标题:title,正文:body}));}
 if(options.character){availability.character=character?'available':'unavailable';if(character)materials['角色资料']=structuredClone(character);}
 return {materials,availability};
}
