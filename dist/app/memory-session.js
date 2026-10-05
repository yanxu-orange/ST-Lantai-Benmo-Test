import { blankEvent, splitWords } from '../domain/memory/model.js';
import { sameTarget } from '../domain/memory/repository.js';
export function createMemorySession(repository) {
  let token = 0, version = 0, saving = null;
  const state = { route: 'list', target: null, root: null, draft: null, error: '', pending: false };
  return {
    state,
    async load() {
      const ticket = ++token; state.target = null; state.root = null; state.draft = null; state.route = 'list'; state.error = '';
      try { const target = repository.captureTarget(); state.target=target; const root=await repository.read(target); if(ticket===token)state.root=root; }
      catch(error) { if(ticket===token)state.error=error.message; }
    },
    async rebind() {
      // A host reload of identical authority is not a product page change.
      // Refresh its epoch while preserving the current unsaved editor.
      const ticket = ++token;
      try {
        const target = repository.captureTarget(), root = await repository.read(target);
        if (ticket !== token) return;
        if (state.root && state.root.rootId !== root.rootId) throw new Error('聊天目标已变化，请返回列表重新进入');
        state.target = target; state.root = root; state.error = '';
      } catch (error) { if (ticket === token) state.error = error.message; }
    },
    edit(id) { token++; version++; state.route = 'editor'; state.error = ''; state.draft = id ? structuredClone(state.root.events.find(event => event.id === id)) : blankEvent(); if (!state.draft) throw new Error('记忆不存在'); },
    change(mutator) { if (!state.draft) return; mutator(state.draft); version++; state.error = ''; },
    leave() { token++; version++; state.route = 'list'; state.draft = null; state.error = ''; },
    close() { this.leave(); state.route = 'closed'; },
    setModeMany(ids, mode) {
      if (saving) return saving;
      const ticket=token, target=structuredClone(state.target), selected=[...ids];
      state.error='';state.pending=true;
      saving=Promise.resolve().then(()=>repository.setModeMany(target,selected,mode)).then(result=>{
        const applied=ticket===token&&state.route==='list'&&sameTarget(target,state.target)&&sameTarget(target,repository.captureTarget());
        if(applied&&(!state.root||state.root.revision<=result.root.revision))state.root=result.root;
        return {...result,applied};
      }).catch(error=>{if(ticket===token)state.error=error.message;throw error;}).finally(()=>{saving=null;state.pending=false;});
      return saving;
    },
    removeMany(ids, frozenTarget) {
      if(saving)return saving;
      const ticket=token,target=structuredClone(frozenTarget),selected=[...ids];state.error='';state.pending=true;
      saving=Promise.resolve().then(()=>repository.removeMany(target,selected)).then(result=>{
        const applied=ticket===token&&state.route!=='closed'&&sameTarget(target,state.target)&&sameTarget(target,repository.captureTarget());
        if(applied&&(!state.root||state.root.revision<=result.root.revision))state.root=result.root;
        return {...result,applied};
      }).catch(error=>{if(ticket===token)state.error=error.message;throw error;}).finally(()=>{saving=null;state.pending=false;});return saving;
    },
    save() {
      if (saving) return saving;
      const ticket=token, editVersion=version, target=structuredClone(state.target), snapshot=structuredClone(state.draft);
      snapshot.sources=snapshot.sources.filter(range=>!(range.start===''&&range.end===''));
      state.error='';state.pending=true;
      saving=Promise.resolve().then(()=>repository.save(target,snapshot)).then(result=>{
        if(sameTarget(target,repository.captureTarget())) {
          if(state.route==='list'&&sameTarget(target,state.target)&&(!state.root||state.root.revision<=result.root.revision))state.root=result.root;
          if(ticket===token){state.root=result.root;if(editVersion===version)state.draft=result.event;}
        }
        return {...result,draftApplied:ticket===token&&editVersion===version};
      }).catch(error=>{if(ticket===token)state.error=error.message;throw error;}).finally(()=>{saving=null;state.pending=false;});
      return saving;
    }
  };
}
export { splitWords };
