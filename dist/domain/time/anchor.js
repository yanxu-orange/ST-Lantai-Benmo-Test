import {storyDate} from './point.js';
// Persist only a small source boundary for a user's explicit date calibration.
// Full chat text is not copied into the anchor.
export function createManualAnchor(calendar,date,messages,{now=()=>new Date().toISOString()}={}){
 if(!Array.isArray(messages))throw new TypeError('校准来源无效');
 const boundary=messages.slice(-3).map((message,index)=>{
  const floor=messages.length-Math.min(3,messages.length)+index;
  if(!message||typeof message.identity!=='string'||!message.identity||typeof message.text!=='string'||!['user','assistant','system','tool'].includes(message.role))throw new Error('校准来源身份无效');
  return {floor,identity:message.identity,text:message.text,role:message.role};
 });
 return {date:storyDate(calendar,date),nextFloor:messages.length,boundary,setAt:now()};
}
// Runtime source identities encode [floor, stable host id, send date]. Ignore
// displaced floors only when stable host evidence remains; never match by text.
function stableIdentity(identity){
 try{const parts=JSON.parse(identity);if(Array.isArray(parts)&&parts.length===3&&(parts[1]!==null||parts[2]!==null))return JSON.stringify(parts.slice(1));}catch{}
 return identity;
}
export function resolveManualAnchor(calendar,anchor,messages,{branch=false}={}){
 if(!anchor)return null;
 if(!Array.isArray(messages)||!Number.isSafeInteger(anchor.nextFloor)||anchor.nextFloor<0||!Array.isArray(anchor.boundary))return null;
 if(anchor.nextFloor>0&&!anchor.boundary.length)return null;
 let startIndex=0;
 if(branch){
  if(anchor.nextFloor>messages.length||anchor.boundary.some(item=>!Number.isSafeInteger(item.floor)||item.floor<0||item.floor>=anchor.nextFloor||!messages[item.floor]||messages[item.floor].identity!==item.identity||messages[item.floor].text!==item.text||messages[item.floor].role!==item.role))return null;
  startIndex=anchor.nextFloor;
 }else if(anchor.nextFloor>0){
  let found=false;
  for(const item of [...anchor.boundary].reverse()){
   const matches=messages.flatMap((message,index)=>message&&stableIdentity(message.identity)===stableIdentity(item.identity)?[index]:[]);
   if(matches.length>1)return null;
   if(matches.length===1){startIndex=matches[0]+1;found=true;break;}
  }
  if(!found){
   const anchorTime=Date.parse(anchor.setAt);
   const times=messages.map(message=>Date.parse(message?.date));
   if(!Number.isFinite(anchorTime)||times.some(time=>!Number.isFinite(time)))return null;
   const firstNew=times.findIndex(time=>time>anchorTime);startIndex=firstNew<0?messages.length:firstNew;
  }
 }
 try{return {date:storyDate(calendar,anchor.date),startIndex};}catch{return null;}
}
