// Sample-only ownership ledger. It never drains or reschedules MutationObserver records.
export function createSampleHiddenFilter({limit=128}={}){
 let epoch=0,pending=[],invalid=false,writing=false;
 function reset(){epoch++;pending=[];invalid=false;writing=false;}
 function begin(){
  if(writing)invalid=true;
  writing=true;
  return {epoch,writes:[],finished:false};
 }
 function write(token,target,value){
  const oldValue=target.getAttribute('hidden');
  // Removing an absent boolean attribute produces no mutation record.
  if(value||oldValue!==null)token.writes.push({target,oldValue});
  target.hidden=value;
 }
 function finish(token,success){
  if(token.epoch!==epoch)return;
  if(token.finished){invalid=true;return;}
  token.finished=true;writing=false;
  if(!success||pending.length+token.writes.length>limit){invalid=true;pending=[];return;}
  if(!invalid)pending.push(...token.writes);
 }
 function matches(records){
  const owned=!invalid&&!writing&&pending.length>0&&records.length===pending.length&&records.every((record,index)=>
   record.type==='attributes'&&record.attributeName==='hidden'&&record.target===pending[index].target&&record.oldValue===pending[index].oldValue);
  reset();return owned;
 }
 return {begin,write,finish,matches,reset};
}
