import { assertAiSettings, assertCredential } from '../shared/settings/model.js';

const messages = {
  INVALID_SETTINGS: '请检查方案名称、API 地址和密钥。',
  SETTINGS_CONFLICT: '配置或密钥已变化，请重新读取后保存。',
  SETTINGS_COMMIT_UNCONFIRMED: '保存结果待确认，可能已经保存。请重新读取，不要重复提交。',
  SETTINGS_UNAVAILABLE: '当前无法安全读取或确认配置。',
};
const copy = value => structuredClone(value);

export function createApiSettingsSession({ repository, operations, uuid = () => crypto.randomUUID(), onExit = () => {},connectionsOnly=false }) {
  let state = { status: 'loading', draft: null, message: '', error: null }, baseline = null, busy = false, closed = false;
  // The connection editor may focus a dedicated plan without assigning it as
  // the retained legacy text default. Existing text selection remains compatible.
  let editingPresetId = null;
  const listeners = new Set();
  const passwords = new Map();
  const copies = new Map();
  let draftEpoch = 0, pending = null, models = [], operation = { status: 'idle', message: '', error: false }, keyVisible = false, deleteConfirm = false;
  const snapshot = () => copy({ ...state, draft:state.draft?{...state.draft,activePresetId:editingPresetId}:null,editingPresetId, models, operation, keyVisible, deleteConfirm, credentialPresetIds: [...new Set([...(baseline?.credentialPresetIds ?? []), ...copies.keys(), ...[...passwords].filter(([, value]) => value.trim()).map(([id]) => id)])] });
  const notify = () => { for (const listener of [...listeners]) { try { listener(snapshot()); } catch { /* View isolation. */ } } };
  function failure(error) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'SETTINGS_UNAVAILABLE';
    state.error = code; state.message = messages[code];
    state.status = code === 'SETTINGS_COMMIT_UNCONFIRMED' ? 'unconfirmed' : 'error';
  }
  function editable() { return !busy && !closed && !!state.draft && !['unconfirmed', 'loading'].includes(state.status); }
  function invalidate({ mask = false, preserveModels = false } = {}) {
    const keep = preserveModels && !pending;
    draftEpoch++; pending?.abort(); pending = null; if (!keep) models = [];
    operation = { status: 'idle', message: '', error: false }; deleteConfirm = false;
    if (mask) keyVisible = false;
  }
  function currentCredential(id) {
    const entered = passwords.get(id) ?? '';
    if (/[\u0000-\u001f\u007f-\u009f]/.test(entered)) assertCredential(entered);
    if (entered.trim()) return assertCredential(entered);
    if (copies.has(id)) return copies.get(id);
    return repository.resolvePresetCredential({ presetId: id, expectedEpoch: baseline.epoch });
  }
  function edit(work, options) {
    if (!editable()) return false;
    invalidate(options); work(state.draft); state.status = 'ready'; state.error = null; state.message = ''; notify(); return true;
  }
  async function load(preferConfirmed = false) {
    if (busy || closed) return false;
    busy = true; invalidate({ mask: true }); passwords.clear(); copies.clear(); state.status = state.status === 'unconfirmed' ? 'unconfirmed' : 'loading'; notify();
    try {
      // Entry reuses confirmed authority through the repository's write queue.
      // Explicit rereads and save reconciliation still fetch fresh server data.
      if (preferConfirmed) await repository.ensure();
      else await repository.read();
      const current = repository.captureAi();
      if (closed) return false;
      passwords.clear(); baseline = current; editingPresetId=current.ai.activePresetId; state = { status: 'ready', draft: copy(current.ai), error: null, message: '' };
      return true;
    } catch (error) { if (!closed) failure(error); return false; }
    finally { busy = false; if (!closed) notify(); }
  }
  async function run(kind) {
    if (!editable() || pending || typeof operations?.[kind] !== 'function') return false;
    const preset = copy(state.draft.presets.find(item => item.id === editingPresetId) ?? null);
    const source = connectionsOnly?(preset?'plugin':null):(preset?.capability??'text')==='text'?state.draft.source:'plugin';
    if (!source || kind === 'fetchModels' && (source !== 'plugin' || !preset)) return false;
    invalidate({ preserveModels: kind === 'test' }); const version = draftEpoch, controller = new AbortController(); pending = controller;
    const current = () => !closed && pending === controller && draftEpoch === version && !controller.signal.aborted
      && repository.captureAi().epoch === baseline.epoch;
    operation = { status: kind === 'fetchModels' ? 'fetching' : 'testing', message: kind === 'fetchModels' ? '正在获取模型…' : '正在测试当前配置…', error: false }; notify();
    try {
      const result = await operations[kind]({ source, endpoint: preset?.endpoint.trim(), model: preset?.model.trim(), credentialId: preset?.id,
        resolveCredential: () => currentCredential(preset.id), signal: controller.signal, isCurrent: current, capability:preset?.capability??'text',...(preset?.protocol?{protocol:preset.protocol}:{}) });
      if (!current()) return false;
      if (kind === 'fetchModels') {
        models = result;
        operation = { status: 'success', message: models.length ? '已获取可用模型。' : '接口未返回可用模型，可手动填写模型。', error: false };
      } else operation = { status: 'success', message: '当前配置测试成功。', error: false };
      return true;
    } catch (error) {
      if (closed || pending !== controller || draftEpoch !== version) return false;
      const safe = { configuration: '请检查地址、模型和密钥。', unavailable: '当前宿主接口不可用。', authentication: '密钥认证失败，请检查密钥和访问权限。',
        endpoint: '接口或模型未找到，请检查地址和模型。', rate_limit: '请求过于频繁，请稍后再试。', invalid_result: '接口返回内容未通过校验。',
        cors_network:'网络连接失败，请检查地址、网络或浏览器跨域限制。',timeout:'专用接口等待超时，请稍后重试。' };
      operation = { status: 'error', message: Object.hasOwn(safe, error?.code) ? safe[error.code] : (['stale', 'cancelled', 'SETTINGS_CONFLICT'].includes(error?.code) ? '配置已变化，请重新发起。' : '请求失败，请检查连接后重试。'), error: true };
      return false;
    } finally { if (pending === controller) { pending = null; if (!closed) notify(); } }
  }
  const unsubscribeRepository = repository.subscribe(() => {
    if (closed || !baseline) return;
    let changed = false;
    try { changed = repository.captureAi().epoch !== baseline.epoch; } catch { changed = true; }
    if (changed && (pending || models.length || operation.status === 'success')) { invalidate(); notify(); }
  });
  function cloneCurrent(){
    if(!editable())return false;const preset=copy(state.draft.presets.find(item=>item.id===editingPresetId)??null);if(!preset)return false;
    let key=null;try{if((passwords.get(preset.id)??'').trim()||copies.has(preset.id)||baseline.credentialPresetIds.includes(preset.id))key=currentCredential(preset.id);}catch(error){failure(error);notify();return false;}
    return edit(draft=>{
      const saved=baseline.ai.presets.find(item=>item.id===preset.id);if(saved){draft.presets=draft.presets.map(item=>item.id===preset.id?copy(saved):item);passwords.delete(preset.id);copies.delete(preset.id);}
      const id=uuid();let name=preset.name+' 副本',number=2;while(draft.presets.some(item=>item.name===name))name=preset.name+' 副本 '+number++;
      draft.presets.push({...preset,id,name});editingPresetId=id;if(!connectionsOnly&&(preset.capability??'text')==='text')draft.activePresetId=id;
      if(key)copies.set(id,key);keyVisible=false;
    });
  }
  return Object.freeze({
    inspect: snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize: () => load(true),
    read: () => load(),
    // Narrow view-only access to unsaved password entry; inspect/notifications
    // never expose it and saved credentials are never returned or backfilled.
    passwordDraft: id => closed ? '' : passwords.get(id) ?? '',
    fetchModels: () => run('fetchModels'),
    test: () => run('test'),
    toggleKey() { if (!editable()) return false; keyVisible = !keyVisible; notify(); return true; },
    requestDelete() { if (!editable() || !editingPresetId) return false; invalidate(); deleteConfirm = true; notify(); return true; },
    cancelDelete() { deleteConfirm = false; if (!closed) notify(); },
    saveAs:cloneCurrent,
    setSource(source) { return [null, 'sillytavern', 'plugin'].includes(source) && edit(draft => { draft.source = source; keyVisible = false; }); },
    selectPreset(id) { return edit(draft => { const preset=draft.presets.find(item=>item.id===id);if(id===null||preset){editingPresetId=id;if(!connectionsOnly&&(!preset||(preset.capability??'text')==='text'))draft.activePresetId=id;}keyVisible = false; }); },
    addPreset(capability) { if(capability===undefined&&editingPresetId)return cloneCurrent();capability??='text';if(!['text','embedding','rerank'].includes(capability))return false; return edit(draft => {
      const id = uuid(); let name = '新方案', number = 2;
      while (draft.presets.some(item => item.name === name)) name = `新方案 ${number++}`;
      draft.presets.push({ id, name, endpoint: '', model: '', secretId: '', ...(capability==='text'?{}:{capability}) });editingPresetId=id;if(!connectionsOnly&&capability==='text')draft.activePresetId = id; keyVisible = false;
    }); },
    deletePreset() { return edit(draft => { passwords.delete(editingPresetId); copies.delete(editingPresetId); draft.presets = draft.presets.filter(item => item.id !== editingPresetId);if(draft.activePresetId===editingPresetId)draft.activePresetId = null;editingPresetId=null; keyVisible = false; }); },
    setField(field, value) {
      if (!editable()) return false;
      if (field === 'key' && typeof value === 'string') {
        return edit(() => { if (editingPresetId) passwords.set(editingPresetId, value); });
      }
      if (!['name', 'endpoint', 'model','capability','protocol'].includes(field) || typeof value !== 'string'||field==='capability'&&!['text','embedding','rerank'].includes(value)||field==='protocol'&&!['openai','voyage'].includes(value)) return false;
      return edit(draft => { const preset = draft.presets.find(item => item.id === editingPresetId); if (preset){preset[field] = value;if(field==='capability'&&value!=='embedding')delete preset.protocol;} }, { preserveModels: ['name', 'model'].includes(field) });
    },
    async save() {
      if (!editable()) return false;
      busy = true; invalidate(); state.status = 'saving'; state.error = null; state.message = ''; notify();
      try {
        const draft = assertAiSettings({ ...state.draft,
          presets: state.draft.presets.map(item => ({
          id: item.id, name: item.name.trim(), endpoint: item.endpoint.trim(), model: item.model.trim(), secretId: item.secretId,
          ...(Object.hasOwn(item,'capability')?{capability:item.capability}:{}),
          ...(Object.hasOwn(item,'protocol')?{protocol:item.protocol}:{}),
        })) });
        const credentials = [...new Set([...passwords.keys(), ...copies.keys()])].flatMap(presetId => {
          const value = passwords.get(presetId) ?? '';
          if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) assertCredential(value);
          return value.trim() ? [{ presetId, value: assertCredential(value) }] : copies.has(presetId) ? [{ presetId, value: copies.get(presetId) }] : [];
        });
        let current;
        try { current = repository.captureAi(); }
        catch (error) {
          if (error?.code !== 'SETTINGS_COMMIT_UNCONFIRMED') throw error;
          // The queued save reconciles lost authority with its own fresh
          // read, still checking this draft's original epoch before writing.
        }
        if (current && current.epoch !== baseline.epoch) throw { code: 'SETTINGS_CONFLICT' };
        // Confirmed current-window authority skips the pre-save network read;
        // actual writes still require the repository's final server confirmation.
        const result = await repository.saveAi(draft, { expectedEpoch: baseline.epoch, credentials });
        if (result?.status !== 'committed') throw { code: 'SETTINGS_COMMIT_UNCONFIRMED' };
        if (closed) return true;
        passwords.clear(); copies.clear(); keyVisible = false; baseline = repository.captureAi();
        state = { status: 'saved', draft: copy(baseline.ai), error: null, message: '已保存' };
        return true;
      } catch (error) { if (!closed) failure(error); return false; }
      finally { busy = false; if (!closed) notify(); }
    },
    exit(reason = 'back') {
      if (closed) return;
      closed = true; invalidate({ mask: true }); passwords.clear(); copies.clear(); baseline = null; editingPresetId=null;state.draft = null; state.status = 'closed'; unsubscribeRepository(); listeners.clear(); onExit(reason);
    },
  });
}
