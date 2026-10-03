import { AiProviderError, assertAiCurrent, freezeAiConfig, parseStrictJson } from '../../shared/ai/provider.js';
import { assertCredential } from '../../shared/settings/model.js';
import { createSillyTavernAiTransport } from './ai-provider.js';

export const API_PROBE_MARKER = 'LANTAI_API_CONNECTION_OK';
const messages = {
  configuration: '请填写 API 地址、密钥和测试所需的模型。',
  unavailable: '当前宿主接口不可用，请检查连接。',
  authentication: '密钥认证失败，请检查密钥和访问权限。',
  endpoint: '接口或模型未找到，请检查 API 地址和模型。',
  rate_limit: '请求过于频繁，请稍后再试。',
  network: '请求失败，请检查连接后重试。',
  invalid_result: '接口返回内容未通过测试校验。',
};
export class ApiSettingsOperationError extends Error {
  constructor(code) { const safe = Object.hasOwn(messages, code) ? code : 'network'; super(messages[safe]); this.name = 'ApiSettingsOperationError'; this.code = safe; }
}
export function createApiSettingsOperations({ getContext, fetchImpl = globalThis.fetch, captureMain } = {}) {
  return Object.freeze({
    async fetchModels({ endpoint, credentialId, resolveCredential, signal, isCurrent }) {
      try {
        assertAiCurrent(signal, isCurrent);
        const config = freezeAiConfig({ source: 'plugin', endpoint, model: 'models-only', credentialId, credentialEpoch: 0 });
        const key = assertCredential(resolveCredential());
        const body = JSON.stringify({ chat_completion_source: 'custom', custom_url: config.endpoint,
          secret_id: `lantai-benmo:plugin-owned:${credentialId}`, custom_include_headers: JSON.stringify({ Authorization: `Bearer ${key}` }) });
        const ctx = getContext();
        if (typeof ctx?.getRequestHeaders !== 'function' || typeof fetchImpl !== 'function') throw new ApiSettingsOperationError('unavailable');
        const headers = ctx.getRequestHeaders(); assertAiCurrent(signal, isCurrent);
        const response = await fetchImpl('/api/backends/chat-completions/status', { method: 'POST', body, headers, signal });
        assertAiCurrent(signal, isCurrent);
        if (!response?.ok) throw new ApiSettingsOperationError([401, 403].includes(response?.status) ? 'authentication' : response?.status === 404 ? 'endpoint' : response?.status === 429 ? 'rate_limit' : 'network');
        const result = await response.json(); assertAiCurrent(signal, isCurrent);
        if (result?.error || !Array.isArray(result?.data)) throw new ApiSettingsOperationError('invalid_result');
        const ids = result.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim());
        if (ids.some(id => id.includes(key))) throw new ApiSettingsOperationError('invalid_result');
        return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
      } catch (error) {
        assertAiCurrent(signal, isCurrent);
        throw new ApiSettingsOperationError(error instanceof ApiSettingsOperationError ? error.code : ['configuration', 'INVALID_SETTINGS', 'SETTINGS_CONFLICT'].includes(error?.code) ? 'configuration' : 'network');
      }
    },
    async test({ source, endpoint, model, credentialId, resolveCredential, signal, isCurrent }) {
      let mainEpoch;
      try {
        assertAiCurrent(signal, isCurrent);
        if (!['plugin', 'sillytavern'].includes(source)) throw new ApiSettingsOperationError('configuration');
        if (source === 'sillytavern') {
          if (typeof captureMain !== 'function') throw new ApiSettingsOperationError('unavailable');
          mainEpoch = captureMain();
        }
        const current = () => isCurrent() === true && (source !== 'sillytavern' || captureMain() === mainEpoch);
        const config = source === 'sillytavern' ? { source } : { source, endpoint, model, credentialId, credentialEpoch: 0 };
        const transport = createSillyTavernAiTransport({ getContext, fetchImpl, resolveCredential: () => resolveCredential() });
        const text = await transport.generate({ config, task: 'api-connection-probe', signal, isCurrent: current, maxTokens: 64,
          messages: [{ role: 'system', content: 'Return only the requested JSON object.' }, { role: 'user', content: `Reply exactly: {"probe":"${API_PROBE_MARKER}"}` }] });
        assertAiCurrent(signal, current);
        let parsed; try { parsed = parseStrictJson(text); } catch { throw new ApiSettingsOperationError('invalid_result'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.probe !== API_PROBE_MARKER) throw new ApiSettingsOperationError('invalid_result');
        return true;
      } catch (error) {
        assertAiCurrent(signal, () => isCurrent() === true && (mainEpoch === undefined || captureMain() === mainEpoch));
        throw new ApiSettingsOperationError(error instanceof ApiSettingsOperationError ? error.code : error instanceof AiProviderError && ['configuration', 'unavailable'].includes(error.code) ? error.code : 'network');
      }
    },
  });
}
