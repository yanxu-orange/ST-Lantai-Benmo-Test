// Optional per-item settings. Reading an old item never writes these defaults.
export const DEFAULT_WORKSHOP_MATERIALS=Object.freeze({recentDialogue:false,recentFloorCount:6,recalledMemory:false,character:false,userPersona:false,worldInfo:false,custom:false,customText:'',history:false});
export function workshopMaterials(module){
 const value=module.generationMaterials;
 if(value===undefined)return {...DEFAULT_WORKSHOP_MATERIALS};
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_WORKSHOP_MATERIALS,key))
  ||['recentDialogue','recalledMemory','character'].some(key=>typeof value[key]!=='boolean')
  ||['userPersona','worldInfo','custom','history'].some(key=>Object.hasOwn(value,key)&&typeof value[key]!=='boolean')
  ||Object.hasOwn(value,'customText')&&typeof value.customText!=='string'
  ||!Number.isSafeInteger(value.recentFloorCount)||value.recentFloorCount<2||value.recentFloorCount>200)throw new Error('工坊生成资料设置无效');
 return {...DEFAULT_WORKSHOP_MATERIALS,...value};
}
export function hasWorkshopMaterials(module){const v=workshopMaterials(module);return module.lifecycle!=='prompt'&&(module.generationSource??'story')==='background'&&(v.recalledMemory||v.character||v.userPersona||v.worldInfo||v.custom||v.history);}
export function prepareWorkshopMaterials({module,source,raw,character=null,userPersona=null,worldInfo={status:'unavailable',entries:[]},history={status:'unavailable',messages:[]},recall={status:'unavailable',memories:[]}}){
 const options=workshopMaterials(module),materials={},availability={};
 // Old recentDialogue/count are retained configuration, never silently
 // reinterpreted as the broader summary-policy history source.
 if(options.history){availability.history=history.status;if(history.policy)availability.historyPolicy=structuredClone(history.policy);if(history.status==='available'&&history.messages.length)materials['前情提要']=structuredClone(history.messages);}
 if(options.userPersona){availability.userPersona=userPersona?'available':'unavailable';if(userPersona)materials['用户人设']=structuredClone(userPersona);}
 if(options.worldInfo){availability.worldInfo=worldInfo.status;if(worldInfo.status==='available'&&worldInfo.entries.length)materials['世界书']=structuredClone(worldInfo.entries);}
 if(options.custom&&options.customText.trim())materials['自定义补充资料']=options.customText;
 if(options.recalledMemory){availability.recalledMemory=recall.status;if(recall.status==='matched'&&recall.memories.length)materials['本轮召回记忆']=recall.memories.map(({startTime,endTime,title,body})=>({起始时间:startTime,结束时间:endTime,标题:title,正文:body}));}
 if(options.character){availability.character=character?'available':'unavailable';if(character)materials['角色资料']=structuredClone(character);}
 return {materials,availability};
}
