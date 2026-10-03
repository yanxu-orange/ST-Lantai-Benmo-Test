const MESSAGES = Object.freeze({
  configuration: '请先在 API 设置中选择来源并完成配置。',
  unavailable: '当前 AI 生成接口不可用，请检查 API 设置。',
  cancelled: 'AI 任务已取消。',
  stale: '任务来源或 API 配置已变化，请重新发起。',
  request: 'AI 请求格式不正确。',
  transport: 'AI 请求失败，请检查连接后重试。',
  http: 'AI 接口返回错误，请检查连接后重试。',
  empty_output: 'AI 返回了空内容，请重试。',
  invalid_json: 'AI 返回内容不是合法 JSON，请重试。',
  schema: 'AI 返回内容未通过结构校验，请重试。',
});

// Only fixed safe codes and messages may escape the provider boundary.
export class AiProviderError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'transport';
    super(MESSAGES[safeCode]);
    this.name = 'AiProviderError';
    this.code = safeCode;
  }
}

export function assertAiCurrent(signal, isCurrent = () => true) {
  if (signal?.aborted) throw new AiProviderError('cancelled');
  let valid = false;
  try { valid = isCurrent() === true; } catch { /* Fail closed. */ }
  if (!valid) throw new AiProviderError('stale');
}

export function freezeAiConfig(value) {
  if (!value || !['sillytavern', 'plugin'].includes(value.source)) {
    throw new AiProviderError('configuration');
  }
  if (value.source === 'sillytavern') return Object.freeze({ source: value.source });
  if (![value.endpoint, value.model, value.credentialId].every(item => typeof item === 'string' && item.trim())
    || !Number.isSafeInteger(value.credentialEpoch) || value.credentialEpoch < 0) {
    throw new AiProviderError('configuration');
  }
  let endpoint;
  try {
    endpoint = new URL(value.endpoint.trim());
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) throw new Error();
  } catch { throw new AiProviderError('configuration'); }
  return Object.freeze({ source: value.source, endpoint: endpoint.toString().replace(/\/$/, ''),
    model: value.model.trim(), credentialId: value.credentialId.trim(), credentialEpoch: value.credentialEpoch });
}

function requestCopy({ task, messages, jsonSchema }) {
  if (typeof task !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(task)
    || !Array.isArray(messages) || !messages.length
    || messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string')) throw new AiProviderError('request');
  let schema = null;
  try { if (jsonSchema != null) schema = JSON.parse(JSON.stringify(jsonSchema)); }
  catch { throw new AiProviderError('request'); }
  if (schema !== null && (typeof schema !== 'object' || Array.isArray(schema)
    || !schema.value || typeof schema.value !== 'object' || Array.isArray(schema.value)
    || typeof schema.name !== 'string' || !schema.name.trim())) throw new AiProviderError('request');
  const result = { task, messages: messages.map(({ role, content }) => Object.freeze({ role, content })), jsonSchema: schema };
  return result;
}

export function parseStrictJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AiProviderError('empty_output');
  const normalized = text.trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*$/i.exec(normalized);
  try { return JSON.parse(fence ? fence[1] : normalized); }
  catch { throw new AiProviderError('invalid_json'); }
}

// Settings owns getConfig; this gateway neither discovers nor stores settings.
export function createAiProvider({ getConfig, transport } = {}) {
  if (typeof getConfig !== 'function' || typeof transport?.generate !== 'function') {
    throw new AiProviderError('configuration');
  }
  function readConfig() {
    try { return freezeAiConfig(getConfig()); }
    catch { throw new AiProviderError('configuration'); }
  }
  return Object.freeze({
    async generateJson({ task, messages, jsonSchema = null, signal, isCurrent, validate } = {}) {
      if (typeof validate !== 'function' || typeof isCurrent !== 'function') throw new AiProviderError('request');
      assertAiCurrent(signal, isCurrent);
      const config = readConfig();
      const fingerprint = JSON.stringify(config);
      const request = requestCopy({ task, messages, jsonSchema });
      const current = () => {
        try { return isCurrent() === true && JSON.stringify(readConfig()) === fingerprint; }
        catch { return false; }
      };
      try {
        assertAiCurrent(signal, current);
        const text = await transport.generate({ ...request, config, signal, isCurrent: current });
        assertAiCurrent(signal, current);
        const data = parseStrictJson(text);
        try { if (validate(data) !== true) throw new Error(); }
        catch { throw new AiProviderError('schema'); }
        assertAiCurrent(signal, current);
        return { data, provider: Object.freeze({ source: config.source }) };
      } catch (error) {
        assertAiCurrent(signal, current);
        // Reconstruct even known errors to prevent mutated messages from leaking.
        throw new AiProviderError(error instanceof AiProviderError ? error.code : 'transport');
      }
    },
  });
}
