import {rollbackValueProof} from './rollback-proof.js';
// Compact inverse history. No historical source arrays or pool references live here.
import {clone, same, exact, integer, text, narrativeMemoryRows} from './core.js';
import {resolveNarrativeSource, importNarrativeSource, compactNarrativePool} from './source-pool.js';
import {durableSourceMessages, sourceFingerprint} from '../summary/source.js';
const kinds=['self','outline'];
const fail=()=>{throw new Error('叙事回退历史无效');};
function rowsDelta(before,after,{ordered=true}={}){
  const a=new Map(before.map((row,index)=>[row.id,{row,index}])),b=new Map(after.map((row,index)=>[row.id,{row,index}]));
  return [...new Set([...a.keys(),...b.keys()])].flatMap(id=>{const x=a.get(id),y=b.get(id);return (ordered?same(x,y):same(x?.row,y?.row))?[]:[{id,before:x?{index:x.index,row:y&&same(x.row,y.row)?null:clone(x.row)}:null,after:y?{index:y.index,proof:rollbackValueProof(y.row)}:null}];});
}
function undoRows(rows,delta,{ordered=true}={}){
  const map=new Map(rows.map((row,index)=>[row.id,{row,index}]));
  for(const item of delta){const current=map.get(item.id);if(item.after===null?!!current:!current||(ordered&&current.index!==item.after.index)||rollbackValueProof(current.row)!==item.after.proof)fail();}
  for(const item of delta){if(item.before)map.set(item.id,{index:item.before.index,row:item.before.row===null?map.get(item.id).row:clone(item.before.row)});else map.delete(item.id);}
  return [...map.values()].sort((a,b)=>a.index-b.index).map(item=>item.row);
}
function contentRows(domain,kind){
  return kind==='outline'?domain.outline:domain.self.flatMap(character=>[{id:`c:${character.id}`,name:character.name,characterId:character.id},...character.entries.map(entry=>({id:`e:${entry.id}`,characterId:character.id,entry}))]);
}
function setContent(domain,kind,rows){
  if(kind==='outline'){domain.outline=rows;return;}
  domain.self=rows.filter(row=>row.id.startsWith('c:')).map(row=>({id:row.characterId,name:row.name,entries:rows.filter(entry=>entry.id.startsWith('e:')&&entry.characterId===row.characterId).map(entry=>entry.entry)}));
}
function metadata(progress){if(!progress)return null;const {sourceSnapshot,memorySnapshot,...rest}=progress;return {...rest,requestedRange:clone(sourceSnapshot.requestedRange)};}
function fieldDelta(before,after){return [...new Set([...Object.keys(before??{}),...Object.keys(after??{})])].flatMap(key=>same(before?.[key],after?.[key])?[]:[{key,before:before&&Object.hasOwn(before,key)?clone(before[key]):null,after:after&&Object.hasOwn(after,key)?clone(after[key]):null}]);}
function progressDelta(before,after){
  const a=metadata(before),b=metadata(after),ar=a?.materialsReport,br=b?.materialsReport;
  if(a)delete a.materialsReport;if(b)delete b.materialsReport;
  return {beforePresent:!!before,afterPresent:!!after,fields:fieldDelta(a,b),report:{beforePresent:ar!=null,afterPresent:br!=null,fields:fieldDelta(ar,br)},};
}
function undoFields(current,fields){const result=clone(current??{});for(const item of fields){if(!same(result[item.key]??null,item.after))fail();if(item.before===null)delete result[item.key];else result[item.key]=clone(item.before);}return result;}
function undoProgress(domain,kind,delta,witness){
  const current=domain.progress[kind];if(!!current!==delta.afterPresent)fail();
  const currentMeta=metadata(current);if(currentMeta)delete currentMeta.materialsReport;
  const restored=undoFields(currentMeta,delta.fields),report=undoFields(current?.materialsReport,delta.report.fields);
  if(!delta.beforePresent){domain.progress[kind]=null;return;}
  const {requestedRange,...fields}=restored;
  domain.progress[kind]={...fields,sourceSnapshot:{requestedRange},materialsReport:delta.report.beforePresent?report:null};
}
function materializeProgress(domain,kind){
  const progress=domain.progress[kind];if(progress)progress.sourceSnapshot={requestedRange:{...progress.sourceSnapshot.requestedRange}};
}
export function assertNarrativeRollback(value){
  if(value===undefined)return;
  if(!exact(value,kinds))fail();
  for(const kind of kinds){const history=value[kind];if(history===null)continue;
    if(!exact(history,['boundary','operations'])||!(history.boundary===null||integer(history.boundary))||!Array.isArray(history.operations))fail();
    for(const op of history.operations){
      if(!exact(op,['type','content',...(op.type==='generation'?['range','recordId','pairId','progress','highWater']:[])])||!['manual','generation'].includes(op.type)||!Array.isArray(op.content))fail();
      if(op.type==='generation'&&(!exact(op.range,['startFloor','endFloor'])||!integer(op.range.startFloor)||!integer(op.range.endFloor,op.range.startFloor)||!text(op.recordId)||!text(op.pairId)||!(op.highWater===null||integer(op.highWater))||!op.progress))fail();
      if(op.type==='generation'){
        const p=op.progress;
        if(!exact(p,['beforePresent','afterPresent','fields','report'])||typeof p.beforePresent!=='boolean'||typeof p.afterPresent!=='boolean'||!exact(p.report,['beforePresent','afterPresent','fields'])||typeof p.report.beforePresent!=='boolean'||typeof p.report.afterPresent!=='boolean')fail();
        for(const [fields,allowed] of [[p.fields,['lastProcessedFloor','taskId','updatedAt','requestedRange']],[p.report.fields,['budget','tokens','estimated','trimmed','originalRanges','memoryRanges','omittedMemoryCount','unavailableMemoryCount','requiredTokens','promptTokens','outputReserve','tokenMethod','joint']]]){
          if(!Array.isArray(fields)||new Set(fields.map(item=>item.key)).size!==fields.length)fail();
          for(const item of fields)if(!exact(item,['key','before','after'])||!allowed.includes(item.key))fail();
        }
      }
      // Delta values are validated again by the ordinary narrative validator after replay.
      for(const delta of [op.content])for(const item of delta){if(!exact(item,['id','before','after'])||!text(item.id))fail();if(item.before!==null&&(!exact(item.before,['row','index'])||!integer(item.before.index)||item.before.row!==null&&item.before.row?.id!==item.id))fail();if(item.after!==null&&(!exact(item.after,['proof','index'])||!integer(item.after.index)||typeof item.after.proof!=='string'||!/^([a-f0-9]{64})$/.test(item.after.proof)))fail();if(item.before?.row===null&&!item.after)fail();}
    }
  }
}
export function recordNarrativeManual(next,before,kind){
  const content=rowsDelta(contentRows(before,kind),contentRows(next,kind));if(!content.length)return next;
  const history=before.rollback?.[kind];
  next.rollback=clone(before.rollback??{self:null,outline:null});
  // A legacy state is a boundary, never an invented generation checkpoint.
  next.rollback[kind]=history?clone(history):{boundary:before.progress[kind]?.lastProcessedFloor??null,operations:[]};
  next.rollback[kind].operations.push({type:'manual',content});return next;
}
export function recordNarrativeInverse(next,before,kind,{range,pairId,nonlinear=false}){
  const previous=before.progress[kind],current=next.progress[kind],end=previous?.lastProcessedFloor??-1;
  const initial=!previous&&!contentRows(before,kind).length;
  const append=!nonlinear&&(previous||initial)&&range.startFloor===end+1;
  next.rollback??={self:null,outline:null};
  if(!append){next.rollback[kind]={boundary:current.lastProcessedFloor,operations:[]};return next;}
  const history=before.rollback?.[kind]??{boundary:initial?null:end,operations:[]};
  next.rollback[kind]=clone(history);
  next.rollback[kind].operations.push({type:'generation',range:clone(range),recordId:current.taskId,pairId,content:rowsDelta(contentRows(before,kind),contentRows(next,kind)),progress:progressDelta(previous,current),highWater:before.highWater?.[kind]??previous?.lastProcessedFloor??null});
  return next;
}
export function invalidateNarrativeRollback(domain){if(domain.rollback)domain.rollback={self:null,outline:null};return domain;}
// Called only from the verified deletion root transaction; ordinary projections never replay.
export function rollbackNarrativeTail(value,deletion){
  const domain=clone(value),outcomes=[],first=deletion.after.messages.length;
  const clearAffected=kind=>{
    const latest=domain.latestGeneration?.[kind];
    if(latest&&latest.range.endFloor>=first&&(!latest.baseline.progress||latest.baseline.progress.lastProcessedFloor<first)){
      domain[kind]=clone(latest.baseline.entries);domain.progress[kind]=clone(latest.baseline.progress);
    }else{
      domain[kind]=kind==='outline'?[]:domain.self.map(row=>({...row,entries:[]}));domain.progress[kind]=null;
    }
    if(domain.generationRecords)domain.generationRecords[kind]=domain.progress[kind]?domain.generationRecords[kind].filter(row=>row.endFloor<=domain.progress[kind].lastProcessedFloor):[];
    domain.highWater??={self:null,outline:null};domain.highWater[kind]=domain.progress[kind]?.lastProcessedFloor??null;
    if(domain.latestGeneration)domain.latestGeneration[kind]=null;
    domain.rollback??={self:null,outline:null};domain.rollback[kind]=null;
    outcomes.push({kind,status:'restored',lastProcessedFloor:domain.progress[kind]?.lastProcessedFloor??null});
  };
  delete domain.rollbackUnavailable;
  for(const kind of kinds){
    const progress=domain.progress[kind];
    if(!progress){
      if((kind==='outline'?domain.outline:domain.self.flatMap(row=>row.entries)).some(entry=>entry.sources.some(range=>range.end>=first)))clearAffected(kind);
      continue;
    }
    const history=domain.rollback?.[kind],witness=null;
    const valid=true;
    let affected=history?.operations.findIndex(op=>op.type==='generation'&&op.range.endFloor>=first)??-1;
    if(progress.lastProcessedFloor<first){if(!history||history.operations.at(-1)?.type!=='manual')continue;affected=history.operations.length;}
    if(!valid||!history||affected<0||history.boundary!==null&&history.boundary>=first){
      clearAffected(kind);
      continue;
    }
    // Include manual changes between the retained checkpoint and first removed generation.
    let start=affected;while(start>0&&history.operations[start-1].type==='manual')start--;
    const working=clone(domain);
    try{
      for(let index=history.operations.length-1;index>=start;index--){const op=history.operations[index];setContent(working,kind,undoRows(contentRows(working,kind),op.content));if(op.type==='generation'){
        undoProgress(working,kind,op.progress,witness);working.highWater??={self:null,outline:null};working.highWater[kind]=op.highWater;
        if(working.generationRecords)working.generationRecords[kind]=working.generationRecords[kind].filter(row=>row.id!==op.recordId);
      }}
      working.rollback[kind].operations.splice(start);
      materializeProgress(working,kind,witness);
      // The current latest pre-generation baseline is invalid after rewind. Reconstruct
      // only when the retained checkpoint's inverse is still proven.
      if(working.latestGeneration)working.latestGeneration[kind]=null;
      const last=working.rollback[kind].operations.at(-1);
      if(last?.type==='generation'&&working.progress[kind]){
        const base=clone(working);setContent(base,kind,undoRows(contentRows(base,kind),last.content));undoProgress(base,kind,last.progress,witness);materializeProgress(base,kind,witness);
        working.latestGeneration??={self:null,outline:null};
        const baseProgress=base.progress[kind];if(baseProgress)baseProgress.sourceSnapshot=importNarrativeSource(working,baseProgress.sourceSnapshot,base);
        working.latestGeneration[kind]={recordId:last.recordId,pairId:last.pairId,range:clone(last.range),sourceSnapshot:clone(working.progress[kind].sourceSnapshot),baseline:{entries:clone(base[kind]),progress:baseProgress}};
      }
      Object.assign(domain,working);outcomes.push({kind,status:'restored',lastProcessedFloor:domain.progress[kind]?.lastProcessedFloor??null});
    }catch{
      clearAffected(kind);
    }
  }
  const pendingInvalid=domain.pendingRun?.ranges.some(range=>range.endFloor>=first);
  if(outcomes.length||pendingInvalid){if(Object.hasOwn(domain,'pendingRun'))domain.pendingRun=null;domain.revision++;compactNarrativePool(domain);}
  return {domain,outcomes};
}
