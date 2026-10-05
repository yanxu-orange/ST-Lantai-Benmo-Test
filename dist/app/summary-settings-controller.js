import { frozenSettingsCopy, SettingsError } from '../shared/settings/model.js';
import { createDefaultEventWords } from '../shared/settings/default-event-words.js';
import { SUMMARY_PROMPT_KEYS, summaryPromptDefault } from '../shared/settings/summary-prompts.js';
import { normalizeCleaningRule, BUILTIN_SUMMARY_CLEANING_SHORTCUTS } from '../domain/summary/cleaning.js';

const copy = value => structuredClone(value);
const message = error => error?.code === 'SETTINGS_COMMIT_UNCONFIRMED'
  ? '保存结果尚未确认，请重新读取，不要重复提交。'
  : error?.code === 'SETTINGS_CONFLICT' ? '设置已变化，请重新读取后编辑。' : '设置无法保存，请检查内容或重新读取。';

// One host-owned instance. A view may unmount without discarding this session.
export function createSummarySettingsController({ settings, exclusions, isCurrent = () => true,
  onBack = () => {}, onClose = () => {}, uuid = () => globalThis.crypto.randomUUID() } = {}) {
  if (!settings?.captureEventGeneration || !settings?.saveEventGeneration) throw new TypeError('总结设置接口不可用');
  const listeners = new Set();
  let disposed = false, busy = false, baseline = null, checking = false, externalPending = false;
  let state = { status: 'loading', route: 'settings', draft: null, excludedFloors: [], promptDrafts: {}, customDrafts: {},
    libraryDraft: null, libraryOpen: null, librarySelection: [], libraryMulti: false, ruleDraft: null, ruleId: null,
    quickOpen: false, opened: {}, scroll: {}, message: '', error: null };
  const inspect = () => frozenSettingsCopy(state);
  const notify = () => { if(!listeners.size)return;const snapshot=inspect();for (const listener of [...listeners]) { try { listener(snapshot); } catch { /* Isolated views. */ } } };
  const current = () => { if (disposed) return false; try { return isCurrent() === true && !disposed; } catch { return false; } };
  const editable = () => !disposed && !busy && !!baseline && state.status === 'ready' && current() && validateBaseline();
  const fail = error => { state.status = error?.code === 'SETTINGS_COMMIT_UNCONFIRMED' ? 'unconfirmed' : 'error'; state.error = error?.code ?? 'INVALID_SETTINGS'; state.message = message(error); };
  function validateBaseline() {
    if(checking)return false;
    checking=true;
    try {
      const valid=settings.matchesEventGeneration?settings.matchesEventGeneration(baseline):settings.captureEventGeneration().epoch===baseline.epoch;
      if(!valid)throw new SettingsError('SETTINGS_CONFLICT');
      return true;
    }catch { fail(new SettingsError('SETTINGS_CONFLICT'));notify();return false; }
    finally { checking=false; }
  }
  const unsubscribeSettings=settings.subscribe?.(authority=>{
    if(disposed||busy||!baseline)return;
    if(!current()){externalPending=false;fail(new SettingsError('SETTINGS_CONFLICT'));notify();return;}
    if(authority?.confirmed===false&&state.status==='ready'){
      externalPending=true;fail(new SettingsError('SETTINGS_CONFLICT'));notify();
    }else if(authority?.confirmed===true&&externalPending){
      externalPending=false;
      // An unrelated domain save can temporarily remove global confirmation.
      // Re-enable this unchanged draft only after server-confirmed authority returns.
      if(validateBaseline()){state.status='ready';state.error=null;state.message='';notify();}
    }else if(state.status==='ready')validateBaseline();
  });
  function afterAwait() {
    if (disposed) return false;
    if (current()) return true;
    if (disposed) return false;
    // A target may become available again after this operation has finished.
    // Keep the old draft, but require an explicit read before further edits.
    externalPending=false;fail(new SettingsError('SETTINGS_CONFLICT'));
    return false;
  }
  function edit(work) { if (!editable()) return false; work(); state.message = ''; state.error = null; notify(); return true; }
  async function commit(work, adopted = () => {}) {
    if (!editable()) return false;
    const draft = copy(baseline.generation), epoch = baseline.epoch;
    try { work(draft); } catch { state.message = '请检查填写内容。'; state.error = 'INVALID_SETTINGS'; notify(); return false; }
    busy = true; state.status = 'saving'; state.message = ''; state.error = null; notify();
    try {
      // Confirm unrelated AI changes without replacing this event draft. The
      // domain epoch below still rejects event changes, including A-B-A.
      await settings.read();
      if (!afterAwait()) return false;
      await settings.saveEventGeneration(draft, { expectedEpoch: epoch, isCurrent: current });
      if (!afterAwait()) return false;
      baseline = settings.captureEventGeneration(); state.draft = copy(baseline.generation);
      adopted(); state.status = 'ready'; state.message = '已保存。'; return true;
    } catch (error) {
      if (!disposed) {
        if (error?.code === 'INVALID_SETTINGS') { state.status = 'ready'; state.error = error.code; state.message = '请检查填写内容。'; }
        else fail(error);
      }
      return false;
    }
    finally { busy = false; if (!disposed) notify(); }
  }
  async function load(useConfirmed=false) {
    if (disposed || busy) return false;
    busy = true; state.status = state.status === 'unconfirmed' ? 'unconfirmed' : 'loading'; notify();
    try {
      let captured=null;
      if(useConfirmed){try{captured=settings.captureEventGeneration();}catch{/* No reliable snapshot: read server authority. */}}
      if(!captured)await settings.read();
      if (!afterAwait()) return false;
      const floors = exclusions?.read ? await exclusions.read() : [];
      if (!afterAwait()) return false;
      if (!Array.isArray(floors)) throw new SettingsError();
      if(captured&&settings.matchesEventGeneration&&!settings.matchesEventGeneration(captured))throw new SettingsError('SETTINGS_CONFLICT');
      captured??=settings.captureEventGeneration();
      externalPending=false;baseline = captured; state = { ...state, status: 'ready', draft: copy(captured.generation), excludedFloors: copy(floors),
        promptDrafts: {}, customDrafts: {}, libraryDraft: state.route === 'library' ? copy(captured.generation.eventWords) : null,
        librarySelection: [], libraryOpen: null, ruleDraft: null, ruleId: null, route: state.route === 'rule' ? 'cleaning' : state.route, error: null, message: '' };
      return true;
    } catch (error) { if (!disposed) fail(error); return false; }
    finally { busy = false; if (!disposed) notify(); }
  }
  // Explicit recovery always reads persisted authority; normal opens only reuse confirmed domains.
  const read=()=>load(false);
  async function init() {
    if(disposed||busy)return false;
    if(baseline){
      if(state.status!=='ready')return false;
      if(!afterAwait()){notify();return false;}
      return validateBaseline();
    }
    return load(true);
  }
  async function floor(action, value) {
    if (!editable() || typeof exclusions?.[action] !== 'function') return false;
    const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
    if (!Number.isSafeInteger(n) || n < 0) { state.message = '请输入大于或等于 0 的整数楼层。'; state.error = 'INVALID_FLOOR'; notify(); return false; }
    busy = true; state.status = 'saving'; notify();
    try {
      await exclusions[action](n);
      if (!afterAwait()) return false;
      const floors = await exclusions.read();
      if (!afterAwait()) return false;
      if (!Array.isArray(floors)) throw new SettingsError();
      if (!validateBaseline()) return false;
      state.excludedFloors = copy(floors); state.status = 'ready'; state.message = '已保存。'; state.error = null; return true;
    } catch (error) { if (!disposed) fail(error); return false; }
    finally { busy = false; if (!disposed) notify(); }
  }
  function custom(id) { return state.customDrafts[id] ?? state.draft?.customPrompts.find(item => item.id === id); }
  function rule(id) { return baseline?.generation.summaryCleaning.rules.find(item => item.id === id); }
  return Object.freeze({
    inspect, read, init,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setScroll(route, value) { if (!disposed && Number.isFinite(value) && value >= 0) state.scroll[route] = value; },
    setOpen(key, value) { if (!disposed) state.opened[key] = !!value; },
    setMode(mode) { if (!['fast', 'quality', 'enhanced'].includes(mode)) return Promise.resolve(false); return commit(draft => { draft.generationMode = mode; }); },
    editPrompt(key, text) { if (!SUMMARY_PROMPT_KEYS.includes(key) || typeof text !== 'string') return false; return edit(() => { state.promptDrafts[key] = text; }); },
    restorePrompt(key) { return this.editPrompt(key, summaryPromptDefault(key)); },
    cancelPrompt(key) { return edit(() => { delete state.promptDrafts[key]; state.opened[key] = false; }); },
    savePrompt(key) {
      if (!SUMMARY_PROMPT_KEYS.includes(key) || !Object.hasOwn(state.promptDrafts, key)) return Promise.resolve(false);
      const text = state.promptDrafts[key];
      return commit(draft => { draft.promptOverrides[key] = text; }, () => { delete state.promptDrafts[key]; state.opened[key] = false; });
    },
    newCustom() { let id = null; edit(() => { id = uuid(); state.customDrafts[id] = { id, name: '', content: '', position: 'before' }; state.opened[`custom:${id}`] = true; }); return id; },
    editCustom(id, field, value) {
      if (!['name', 'content', 'position'].includes(field) || typeof value !== 'string' || !custom(id)) return false;
      return edit(() => { state.customDrafts[id] = { ...copy(custom(id)), [field]: value }; });
    },
    cancelCustom(id) { return edit(() => { delete state.customDrafts[id]; state.opened[`custom:${id}`] = false; }); },
    saveCustom(id) {
      const item = custom(id); if (!item) return Promise.resolve(false);
      const next = { ...copy(item), name: item.name.trim() };
      return commit(draft => { const i = draft.customPrompts.findIndex(item => item.id === id); if (i < 0) draft.customPrompts.push(next); else draft.customPrompts[i] = next; },
        () => { delete state.customDrafts[id]; state.opened[`custom:${id}`] = false; });
    },
    deleteCustom(id) {
      if (!state.draft?.customPrompts.some(item => item.id === id)) return Promise.resolve(this.cancelCustom(id));
      return commit(draft => { draft.customPrompts = draft.customPrompts.filter(item => item.id !== id); }, () => { delete state.customDrafts[id]; });
    },
    navigate(route) {
      if (!['settings', 'library', 'cleaning'].includes(route)) return false;
      return edit(() => { state.route = route; state.ruleDraft = null; state.ruleId = null;
        if (route === 'library') { state.libraryDraft = copy(baseline.generation.eventWords); state.librarySelection = []; state.libraryMulti = false; }
        else { state.libraryDraft = null; state.libraryOpen = null; } });
    },
    openWord(id) { return edit(() => { state.libraryOpen = state.libraryOpen === id ? null : id; }); },
    editWord(id, field, value) {
      if (!['name', 'definition', 'enabled'].includes(field) || !state.libraryDraft?.some(word => word.id === id)) return false;
      return edit(() => { const word = state.libraryDraft.find(word => word.id === id); word[field] = value; });
    },
    newWord() { let id = null; edit(() => { if (!state.libraryDraft) return; id = uuid(); state.libraryDraft.push({ id, name: '', definition: '', enabled: true }); state.libraryOpen = id; }); return id; },
    moveWord(id, offset) { return edit(() => { const list = state.libraryDraft, from = list?.findIndex(word => word.id === id), to = from + offset; if (from < 0 || to < 0 || to >= list.length) return; [list[from], list[to]] = [list[to], list[from]]; }); },
    deleteWords(ids) { return edit(() => { state.libraryDraft = state.libraryDraft.filter(word => !ids.includes(word.id)); state.librarySelection = state.librarySelection.filter(id => !ids.includes(id)); }); },
    toggleWordMulti() { return edit(() => { state.libraryMulti = !state.libraryMulti; state.librarySelection = []; }); },
    selectWord(id, selected) { return edit(() => { state.librarySelection = state.librarySelection.filter(value => value !== id); if (selected && state.libraryDraft.some(word => word.id === id)) state.librarySelection.push(id); }); },
    toggleSelectedWords(enabled) { return edit(() => { state.libraryDraft.forEach(word => { if (state.librarySelection.includes(word.id)) word.enabled = enabled; }); }); },
    restoreWords() { return edit(() => { state.libraryDraft = createDefaultEventWords(); state.librarySelection = []; state.libraryOpen = null; }); },
    saveLibrary() {
      if (!state.libraryDraft) return Promise.resolve(false);
      const words = copy(state.libraryDraft).map(word => ({ ...word, name: word.name.trim() }));
      return commit(draft => { draft.eventWords = words; }, () => { state.libraryDraft = copy(words); });
    },
    toggleQuick() { return edit(() => { state.quickOpen = !state.quickOpen; }); },
    addShortcut(index) {
      const source = BUILTIN_SUMMARY_CLEANING_SHORTCUTS[index]; if (!source) return Promise.resolve(false);
      const item = { id: uuid(), ...copy(source) };
      return commit(draft => { draft.summaryCleaning.rules.push(item); });
    },
    beginRule(id = null) {
      if (id !== null && !rule(id)) return false;
      return edit(() => { state.ruleId = id; state.ruleDraft = id ? copy(rule(id)) : { id: uuid(), name: '', enabled: true, action: 'exclude', pattern: '', captureGroup: 0, replacement: '' }; state.route = 'rule'; });
    },
    editRule(field, value) {
      if (!state.ruleDraft || !['name', 'action', 'pattern', 'captureGroup', 'replacement'].includes(field)) return false;
      return edit(() => { state.ruleDraft[field] = field === 'captureGroup' ? (value === '' ? NaN : Number(value)) : value; });
    },
    cancelRule() { return edit(() => { state.ruleDraft = null; state.ruleId = null; state.route = 'cleaning'; }); },
    saveRule() {
      if (!state.ruleDraft) return Promise.resolve(false);
      let next; try { next = normalizeCleaningRule({ ...state.ruleDraft, name: state.ruleDraft.name.trim(), enabled: state.ruleId ? rule(state.ruleId).enabled : state.ruleDraft.enabled }); }
      catch { state.message = '请检查规则名称、正则表达式和分组。'; state.error = 'INVALID_SETTINGS'; notify(); return Promise.resolve(false); }
      return commit(draft => { const i = draft.summaryCleaning.rules.findIndex(item => item.id === next.id); if (i < 0) draft.summaryCleaning.rules.push(next); else draft.summaryCleaning.rules[i] = next; },
        () => { state.ruleDraft = null; state.ruleId = null; state.route = 'cleaning'; });
    },
    toggleRule(id) { return commit(draft => { const item = draft.summaryCleaning.rules.find(item => item.id === id); if (!item) throw new Error(); item.enabled = !item.enabled; }); },
    cycleRule(id) { return commit(draft => { const item = draft.summaryCleaning.rules.find(item => item.id === id); if (!item || item.action === 'replace') throw new Error(); item.action = item.action === 'exclude' ? 'extract' : 'exclude'; }); },
    deleteRule(id) { return commit(draft => { draft.summaryCleaning.rules = draft.summaryCleaning.rules.filter(item => item.id !== id); }); },
    reorderRules(ids) { return commit(draft => { const rules = draft.summaryCleaning.rules; if (ids.length !== rules.length || new Set(ids).size !== ids.length || ids.some(id => !rules.some(rule => rule.id === id))) throw new Error(); draft.summaryCleaning.rules = ids.map(id => rules.find(rule => rule.id === id)); }); },
    addFloor: value => floor('add', value), removeFloor: value => floor('remove', value),
    back() {
      if (state.route === 'rule') return this.cancelRule();
      if (state.route !== 'settings') return this.navigate('settings');
      if (busy && state.status !== 'loading') return false;
      state.promptDrafts = {}; state.customDrafts = {}; onBack(); return true;
    },
    close() { if (!disposed) { onClose(); return true; } return false; },
    dispose() { if (disposed) return; disposed = true; unsubscribeSettings?.(); state.status = 'disposed'; state.error = null; state.message = ''; listeners.clear(); },
  });
}
