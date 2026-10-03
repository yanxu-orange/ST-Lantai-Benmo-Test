import {sameTarget} from '../domain/memory/repository.js';
import {normalizeCleaningRule,BUILTIN_SUMMARY_CLEANING_SHORTCUTS} from '../domain/summary/cleaning.js';

const copy=value=>structuredClone(value);
export function createRecallController({repository,settings,runtime,onBack=()=>{},onClose=()=>{}}={}) {
  let disposed=false,ticket=0,previewTicket=0,baseline=null;
  const listeners=new Set();
  let state={route:'monitor',tab:'preview',status:'loading',draft:null,preview:null,actual:{status:'empty'},error:'',saved:0,ruleDraft:null,quick:false,scroll:{},opened:{},more:false};
  const notify=()=>{if(!disposed)for(const fn of [...listeners])fn();};
  const current=(target,serial)=>!disposed&&serial===ticket&&sameTarget(target,repository.captureTarget());
  const unsubscribe=runtime.subscribe(()=>{state.actual=runtime.inspect();notify();});
  async function read() {
    const target=repository.captureTarget(),serial=++ticket;previewTicket++;state.status='loading';state.error='';notify();
    try {await settings.read();if(!current(target,serial))return false;baseline=settings.captureRecall();state.draft=copy(baseline.recall);state.status='ready';state.actual=runtime.inspect();notify();await preview();return true;}
    catch {if(current(target,serial)){state.status='failed';state.error='召回设置读取失败，请重新读取。';notify();}return false;}
  }
  async function preview() {
    const target=repository.captureTarget(),serial=ticket,request=++previewTicket;
    try{const value=await runtime.preview();if(current(target,serial)&&request===previewTicket){state.preview=value;state.error='';notify();return true;}}
    catch{if(current(target,serial)&&request===previewTicket){state.preview=null;state.error='本回预览未能构造，请重新读取。';notify();}}return false;
  }
  async function save(next=state.draft) {
    if(!baseline||state.status!=='ready')return false;
    const target=repository.captureTarget(),serial=ticket,value=copy(next),epoch=baseline.epoch;
    state.status='saving';state.error='';notify();
    try {
      const receipt=await settings.saveRecall(value,{expectedEpoch:epoch,isCurrent:()=>current(target,serial)});
      if(!current(target,serial))return false;
      if(receipt.status!=='committed'){state.status=receipt.status==='unconfirmed'?'unconfirmed':'failed';state.error=receipt.status==='unconfirmed'?'保存尚未确认，请重新读取恢复。':'设置已变化，请重新读取。';notify();return false;}
      baseline=settings.captureRecall();state.draft=copy(baseline.recall);state.status='ready';state.saved++;state.error='';notify();void preview();return true;
    }catch(error) {if(current(target,serial)){
      if(error?.code==='SETTINGS_COMMIT_UNCONFIRMED'){state.status='unconfirmed';state.error='设置保存尚未确认，可能已经保存；请重新读取恢复，不要重复提交。';}
      else if(error?.code==='SETTINGS_CONFLICT'){state.status='failed';state.error='设置已发生变化，请重新读取后保存。';}
      else {state.status='ready';state.error='设置未保存，请检查输入或重新读取。';}
      notify();}return false;}
  }
  function ruleSave(){try{const value=normalizeCleaningRule(state.ruleDraft),next=copy(state.draft),index=next.recallCleaning.rules.findIndex(rule=>rule.id===value.id);if(index<0)next.recallCleaning.rules.push(value);else next.recallCleaning.rules[index]=value;return save(next).then(ok=>{if(ok){state.route='cleaning';state.ruleDraft=null;notify();}return ok;});}catch{state.error='清洗规则格式无效，请检查正则与分组。';notify();return Promise.resolve(false);}}
  return {
    read,preview,save,inspect:()=>copy(state),subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    route(value){state.route=value;state.error='';notify();},tab(value){state.tab=value;state.actual=runtime.inspect();notify();if(value==='preview')void preview();},
    edit(field,value){if(state.draft&&state.status==='ready')state.draft[field]=value;},
    addTerm(value){const word=value.trim();if(!word||state.draft.excludedTerms.includes(word))return;const next=copy(state.draft);next.excludedTerms.push(word);void save(next);},
    removeTerm(index){const next=copy(state.draft);next.excludedTerms.splice(index,1);void save(next);},
    quick(){state.quick=!state.quick;notify();},
    newRule(id){const found=state.draft.recallCleaning.rules.find(rule=>rule.id===id);state.ruleDraft=copy(found??{id:globalThis.crypto.randomUUID(),name:'',enabled:true,action:'exclude',pattern:'',captureGroup:0,replacement:''});state.route='rule';notify();},
    editRule(field,value){if(state.ruleDraft)state.ruleDraft[field]=value;},ruleSave,
    shortcut(index){const rule=BUILTIN_SUMMARY_CLEANING_SHORTCUTS[index];if(!rule)return;const next=copy(state.draft);next.recallCleaning.rules.push({...rule,id:globalThis.crypto.randomUUID(),enabled:true});void save(next);},
    changeRule(id,kind){const next=copy(state.draft),index=next.recallCleaning.rules.findIndex(rule=>rule.id===id);if(index<0)return;const rule=next.recallCleaning.rules[index];if(kind==='delete')next.recallCleaning.rules.splice(index,1);else if(kind==='toggle')rule.enabled=!rule.enabled;else if(kind==='cycle')rule.action=rule.action==='extract'?'exclude':'extract';void save(next);},
    moveRule(id,before){const next=copy(state.draft),index=next.recallCleaning.rules.findIndex(rule=>rule.id===id);if(index<0||id===before)return;const [rule]=next.recallCleaning.rules.splice(index,1),position=next.recallCleaning.rules.findIndex(rule=>rule.id===before);next.recallCleaning.rules.splice(position<0?next.recallCleaning.rules.length:position,0,rule);void save(next);},
    more(){state.more=!state.more;notify();},setScroll(route,value){state.scroll[route]=value;},setOpen(id,value){state.opened[id]=value;},
    back(){if(state.route==='rule'){state.ruleDraft=null;state.route='cleaning';notify();}else if(state.route==='cleaning'){state.route='settings';notify();}else if(state.route==='settings'){state.route='monitor';notify();}else onBack();},close:onClose,
    dispose(){disposed=true;ticket++;unsubscribe();listeners.clear();}
  };
}
