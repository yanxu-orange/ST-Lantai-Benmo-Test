import {taskRoutingView} from '../shared/settings/model.js';
const copy = value => structuredClone(value);
export const TASK_API_GROUPS = Object.freeze([
  ['summary', '总结'], ['narrative', '自述与大纲'], ['latest', '摘要与追踪'], ['workshop', '工坊'], ['embedding', '向量'], ['rerank', '重排'],
]);
const messages = {
  INVALID_SETTINGS: '请检查任务 API 选择。',
  SETTINGS_CONFLICT: '配置或密钥已变化，请重新读取后保存。',
  SETTINGS_COMMIT_UNCONFIRMED: '保存结果待确认，可能已经保存。请重新读取，不要重复提交。',
  SETTINGS_UNAVAILABLE: '当前无法安全读取或确认配置。',
  TASK_ROUTE_UNRESOLVED: '旧两种总结配置不同，请明确选择统一的总结方案。',
  TASK_CAPABILITY_MISMATCH: '所选方案的接口能力与任务不匹配。',
};
const capability=group=>['embedding','rerank'].includes(group)?group:'text';
export function createTaskApiSettingsSession({repository, operations, onExit = () => {}}) {
  let state = {status:'loading', draft:null, presets:[], models:{}, operations:{}, message:'', error:null};
  let baseline = null, busy = false, closed = false;
  const listeners = new Set(), pending = new Map();
  const snapshot = () => copy(state);
  const notify = () => { for (const listener of listeners) { try { listener(snapshot()); } catch { /* View isolation. */ } } };
  const editable = () => !closed && !busy && !!state.draft && !['loading','unconfirmed'].includes(state.status);
  function invalidate(group) {
    for (const [key, controller] of pending) if (!group || key === group) { controller.abort(); pending.delete(key); }
    if (group) { delete state.models[group]; delete state.operations[group]; }
    else { state.models = {}; state.operations = {}; }
  }
  function failure(error) {
    const code = Object.hasOwn(messages,error?.code) ? error.code : 'SETTINGS_UNAVAILABLE';
    state.error = code; state.message = messages[code]; state.status = code === 'SETTINGS_COMMIT_UNCONFIRMED' ? 'unconfirmed' : 'error';
  }
  function adopt() {
    baseline = repository.captureAi();
    const projection=taskRoutingView(baseline.ai);
    state = {status:'ready', draft:copy(projection.routes), unresolvedSummary:projection.unresolvedSummary,legacySummaryRoutes:copy(projection.legacySummaryRoutes),presets:copy(baseline.ai.presets), models:{}, operations:{}, message:'', error:null};
  }
  async function load(cached) {
    if (busy || closed) return false;
    busy = true; invalidate(); state.status = 'loading'; notify();
    try { await (cached ? repository.ensure() : repository.read()); if (closed) return false; adopt(); return true; }
    catch (error) { if (!closed) failure(error); return false; }
    finally { busy = false; if (!closed) notify(); }
  }
  const off = repository.subscribe(() => {
    if (closed || !baseline) return;
    let stale = false;
    try { stale = repository.captureAi().epoch !== baseline.epoch; } catch { stale = true; }
    if (stale) { invalidate(); notify(); }
  });
  return Object.freeze({
    inspect:snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize:() => load(true), read:() => load(false),
    selectSource(group,value) {
      if (!editable() || !Object.hasOwn(state.draft,group)) return false;
      const preset = value.startsWith('preset:') ? value.slice(7) : null;
      if (!['none',...(['embedding','rerank'].includes(group)?[]:['sillytavern'])].includes(value) && !state.presets.some(item => item.id === preset)) return false;
      if(state.draft[group]?.source===(preset?'plugin':value)&&state.draft[group]?.presetId===preset)return true;
      invalidate(group);
      state.draft[group] = {source:preset ? 'plugin' : value, presetId:preset, model:'',...(preset?{modelSource:'task'}:{})};
      if(group==='summary')state.unresolvedSummary=false;
      state.status = 'ready'; state.error = null; state.message = ''; notify(); return true;
    },
    selectModel(group,model) {
      if (!editable() || state.draft[group]?.source !== 'plugin' || typeof model !== 'string') return false;
      state.draft[group].model = model;state.draft[group].modelSource='task'; state.status = 'ready'; state.error = null; state.message = ''; notify(); return true;
    },
    async fetchModels(group) {
      if (!editable() || pending.has(group) || !operations?.fetchModels) return false;
      const route = state.draft[group], preset = state.presets.find(item => item.id === route?.presetId);
      if (route?.source !== 'plugin' || !preset) return false;
      const controller = new AbortController(); pending.set(group,controller);
      const current = () => { try { return !closed && !controller.signal.aborted && pending.get(group) === controller && repository.captureAi().epoch === baseline.epoch; } catch { return false; } };
      state.operations[group] = {status:'loading', message:'正在获取模型…'}; notify();
      try {
        const models = await operations.fetchModels({source:'plugin',endpoint:preset.endpoint,credentialId:preset.id,
          resolveCredential:() => repository.resolvePresetCredential({presetId:preset.id,expectedEpoch:baseline.epoch}),signal:controller.signal,isCurrent:current,capability:capability(group),...(preset.protocol?{protocol:preset.protocol}:{})});
        if (!current()) return false;
        state.models[group] = models; state.operations[group] = {status:'success',message:models.length ? '已获取可用模型。' : '接口未返回可用模型。'}; return true;
      } catch (error) {
        if (pending.get(group) !== controller || closed) return false;
        const safe={authentication:'接口认证未通过，请检查密钥和访问权限。',endpoint:'接口或模型未找到，请检查地址和模型。',rate_limit:'请求过于频繁，请稍后重试。',invalid_result:'模型目录返回内容未通过校验。',cors_network:'网络连接失败，请检查地址、网络或浏览器跨域限制。',timeout:'专用接口等待超时，请稍后重试。'};
        state.operations[group] = {status:'error',message:safe[error?.code]??(['SETTINGS_CONFLICT','stale'].includes(error?.code) ? '配置已变化，请重新读取。' : '获取模型失败，请检查该方案的地址和密钥。')}; return false;
      } finally { if (pending.get(group) === controller) { pending.delete(group); if (!closed) notify(); } }
    },
    async save() {
      if (!editable()) return false;
      if(!state.draft.summary){failure({code:'TASK_ROUTE_UNRESOLVED'});notify();return false;}
      if (Object.values(state.draft).some(route => route.source === 'plugin' && !state.presets.some(preset => preset.id === route.presetId))) {
        state.status = 'error'; state.error = 'INVALID_SETTINGS'; state.message = '所选方案已不存在，请重新选择后保存。'; notify(); return false;
      }
      busy = true; invalidate(); state.status = 'saving'; state.error = null; state.message = ''; notify();
      try {
        const result = await repository.saveTaskRouting(Object.fromEntries(Object.entries(state.draft).map(([group,route]) => [group,{...route,model:route.model.trim()}])),{expectedEpoch:baseline.epoch});
        if (result?.status !== 'committed') throw {code:'SETTINGS_COMMIT_UNCONFIRMED'};
        if (closed) return true;
        adopt(); state.status = 'saved'; state.message = '已保存'; return true;
      } catch (error) { if (!closed) failure(error); return false; }
      finally { busy = false; if (!closed) notify(); }
    },
    exit(reason = 'back') {
      if (closed) return;
      closed = true; invalidate(); baseline = null; state.draft = null; state.presets = []; state.status = 'closed'; off(); listeners.clear(); onExit(reason);
    },
  });
}
