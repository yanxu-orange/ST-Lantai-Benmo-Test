import { createFakeSettingsAdapter } from '../../src/platform/fake/settings-adapter.js';
import { createSettingsRepository } from '../../src/shared/settings/repository.js';
import { createApiSettingsSession } from '../../src/app/api-settings-session.js';
import { mountApiSettingsView } from '../../src/app/api-settings-view.js';
import { createApiSettingsOperations, API_PROBE_MARKER } from '../../src/platform/sillytavern/api-settings-operations.js';
const saved = localStorage.getItem('lantai-api-settings-fake');
let failFromSave = null;
const adapter = createFakeSettingsAdapter({ namespace: saved ? JSON.parse(saved) : undefined,
  read: state => { if (failFromSave !== null && state.saves >= failFromSave) throw Error('Fake readback unavailable'); return structuredClone(state.disk); },
  save: async state => { state.disk = structuredClone(state.context.extensionSettings.lantai_benmo); localStorage.setItem('lantai-api-settings-fake', JSON.stringify(state.disk)); } });
const repository = createSettingsRepository(adapter);
const operations = createApiSettingsOperations({
  getContext: () => ({ getRequestHeaders: () => ({}), mainApi: 'openai', onlineStatus: 'fake-connected', generateRaw: async () => JSON.stringify({ probe: API_PROBE_MARKER }) }),
  captureMain: () => 0,
  fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('/status') ? { data: [{ id: 'fake-model-z' }, { id: 'fake-model-a' }] }
    : { choices: [{ message: { content: JSON.stringify({ probe: API_PROBE_MARKER }) } }] } }),
});
let view, session;
function open() {
  session = createApiSettingsSession({ repository, operations, onExit: reason => {
    view.dispose(); document.querySelector('#app').innerHTML = '<section class="lantai"><main class="lt-main"><p>已返回原页面，原工作流保持。</p><button class="ui-button ui-button--secondary" id="reopen">重新打开 API 设置</button></main></section>';
    document.querySelector('#reopen').onclick = open; globalThis.LantaiApiCandidate.exitReason = reason;
  } });
  view = mountApiSettingsView(document.querySelector('#app'), session);
  globalThis.LantaiApiCandidate = { repository, adapter, get session() { return session; },
    failNextSaveConfirmation: () => { failFromSave = adapter.state.saves + 1; }, recover: () => { failFromSave = null; } };
  void session.read();
}
open();
