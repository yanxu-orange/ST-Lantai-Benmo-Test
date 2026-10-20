// Task names are business semantics, not provider or prompt configuration.
export function aiTaskGroup(task) {
  if (typeof task !== 'string') return undefined;
  if (task.startsWith('event.summary.') || ['memory.indexes', 'memory.merge'].includes(task) || task.startsWith('cumulative.')) return 'summary';
  if (task.startsWith('narrative.')) return 'narrative';
  if (task === 'workshop.round') return 'workshop';
  if (task.startsWith('latest.') || task === 'background.round' || task === 'tracking.update') return 'latest';
  return undefined;
}
const MESSAGES = Object.freeze({
  task_preset_missing: '此任务选择的 API 方案不存在，请在任务 API 设置中重新选择。',
  task_route_unresolved: '旧总结来源不同，请先在任务 API 中明确统一选择。',
  capability: '所选方案的接口能力与任务不匹配。',
  timeout: '接口等待超时，请稍后重试。',
  mapping: '接口返回的映射或数值不完整，已放弃本次结果。',
  storage: '向量缓存未能读取或保存，请稍后重试。',
  cors_network: '网络连接失败，请检查地址、网络或浏览器跨域限制。',
  authentication: '接口认证未通过，请检查密钥和访问权限。',
  endpoint: '接口或模型未找到，请检查地址和模型。',
  rate_limit: '接口请求过于频繁，请稍后重试。',
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
  if (value?.capability && value.capability !== 'text') throw new AiProviderError('capability');
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

// Business output allowance is separate from the tiny connection probe limit.
// Model-specific context/output limits remain the selected provider's authority.
export function assertMaxOutputTokens(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new AiProviderError('request');
  return value;
}

function requestCopy({ task, messages, jsonSchema, maxOutputTokens }) {
  assertMaxOutputTokens(maxOutputTokens);
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
  const result = { task, messages: messages.map(({ role, content }) => Object.freeze({ role, content })), jsonSchema: schema, ...(maxOutputTokens === undefined ? {} : {maxOutputTokens}) };
  return result;
}

function nextNonWhitespaceIndex(text, start) {
    for (let index = start; index < text.length; index += 1) {
        if (!/\s/u.test(text[index])) return index;
    }
    return -1;
}

function isJsonValueStart(character) {
    return character === '"' || character === '{' || character === '[' || character === '-'
        || character === 't' || character === 'f' || character === 'n' || /\d/u.test(character ?? '');
}

// Some OpenAI-compatible relays advertise strict json_schema support but still
// return otherwise complete JSON with dialogue quotes left unescaped. Repair
// only quote boundaries that can be decided from the surrounding JSON grammar;
// schema and business validation still run after this syntax-only pass.
function repairStrictJsonSyntax(text) {
    const output = [];
    const stack = [];
    let inString = false;
    let stringRole = 'value';

    const completeValue = () => {
        const parent = stack.at(-1);
        if (parent) parent.expect = 'commaOrEnd';
    };
    const quoteCanClose = index => {
        const nextIndex = nextNonWhitespaceIndex(text, index + 1);
        const next = nextIndex === -1 ? null : text[nextIndex];
        if (stringRole === 'key') return next === ':';
        const parent = stack.at(-1);
        if (!parent) return next === null;
        if (parent.type === 'object') {
            if (next === '}') return true;
            if (next !== ',') return false;
            const afterComma = nextNonWhitespaceIndex(text, nextIndex + 1);
            return afterComma !== -1 && text[afterComma] === '"';
        }
        if (next === ']') return true;
        if (next !== ',') return false;
        const afterComma = nextNonWhitespaceIndex(text, nextIndex + 1);
        return afterComma !== -1 && isJsonValueStart(text[afterComma]);
    };

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (character === '\\') {
                output.push(character);
                if (index + 1 < text.length) output.push(text[index += 1]);
                continue;
            }
            if (character === '"') {
                if (!quoteCanClose(index)) {
                    output.push('\\"');
                    continue;
                }
                inString = false;
                const parent = stack.at(-1);
                if (stringRole === 'key') {
                    if (parent) parent.expect = 'colon';
                } else completeValue();
            }
            output.push(character);
            continue;
        }

        if (character === '"') {
            const parent = stack.at(-1);
            stringRole = parent?.type === 'object' && parent.expect === 'keyOrEnd' ? 'key' : 'value';
            inString = true;
            output.push(character);
            continue;
        }
        if (character === '{') stack.push({ type: 'object', expect: 'keyOrEnd' });
        else if (character === '[') stack.push({ type: 'array', expect: 'valueOrEnd' });
        else if (character === ':' && stack.at(-1)?.type === 'object') stack.at(-1).expect = 'value';
        else if (character === ',') {
            const parent = stack.at(-1);
            const nextIndex = nextNonWhitespaceIndex(text, index + 1);
            if (parent && nextIndex !== -1 && ((parent.type === 'object' && text[nextIndex] === '}') || (parent.type === 'array' && text[nextIndex] === ']'))) {
                continue;
            }
            if (parent) parent.expect = parent.type === 'object' ? 'keyOrEnd' : 'valueOrEnd';
        } else if (character === '}' || character === ']') {
            stack.pop();
            completeValue();
        }
        output.push(character);
    }
    return output.join('');
}


export function parseStrictJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AiProviderError('empty_output');
  const normalized = text.trim().replace(/^\uFEFF/, '').trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*$/i.exec(normalized);
  const json = fence ? fence[1] : normalized;
  try { return JSON.parse(json); }
  catch {
    try { return JSON.parse(repairStrictJsonSyntax(json)); }
    catch { throw new AiProviderError('invalid_json'); }
  }
}

// Settings owns getConfig; this gateway neither discovers nor stores settings.
export function createAiProvider({ getConfig, transport } = {}) {
  if (typeof getConfig !== 'function' || typeof transport?.generate !== 'function') {
    throw new AiProviderError('configuration');
  }
  function readConfig(taskGroup) {
    try { return freezeAiConfig(getConfig(taskGroup)); }
    catch (error) { throw new AiProviderError(error?.code === 'TASK_PRESET_MISSING' || error?.code === 'task_preset_missing' ? 'task_preset_missing' : error?.code === 'TASK_ROUTE_UNRESOLVED' ? 'task_route_unresolved' : error?.code === 'TASK_CAPABILITY_MISMATCH' ? 'capability' : 'configuration'); }
  }
  return Object.freeze({
    async generateText({ task, messages, signal, isCurrent, maxOutputTokens } = {}) {
      if (typeof isCurrent !== 'function') throw new AiProviderError('request');
      assertAiCurrent(signal, isCurrent);
      const taskGroup = aiTaskGroup(task);
      const config = readConfig(taskGroup), fingerprint = JSON.stringify(config);
      const request = requestCopy({ task, messages, maxOutputTokens });
      const current = () => {
        try { return isCurrent() === true && JSON.stringify(readConfig(taskGroup)) === fingerprint; }
        catch { return false; }
      };
      try {
        assertAiCurrent(signal, current);
        const text = await transport.generate({ ...request, ...(taskGroup ? {taskGroup} : {}), config, signal, isCurrent: current });
        assertAiCurrent(signal, current);
        if (typeof text !== 'string' || !text.trim()) throw new AiProviderError('empty_output');
        return { text: text.trim(), provider: Object.freeze({ source: config.source }) };
      } catch (error) {
        assertAiCurrent(signal, current);
        throw new AiProviderError(error instanceof AiProviderError ? error.code : 'transport');
      }
    },
    async generateJson({ task, messages, jsonSchema = null, signal, isCurrent, validate, maxOutputTokens } = {}) {
      if (typeof validate !== 'function' || typeof isCurrent !== 'function') throw new AiProviderError('request');
      assertAiCurrent(signal, isCurrent);
      const taskGroup = aiTaskGroup(task);
      const config = readConfig(taskGroup);
      const fingerprint = JSON.stringify(config);
      const request = requestCopy({ task, messages, jsonSchema, maxOutputTokens });
      const current = () => {
        try { return isCurrent() === true && JSON.stringify(readConfig(taskGroup)) === fingerprint; }
        catch { return false; }
      };
      try {
        assertAiCurrent(signal, current);
        const text = await transport.generate({ ...request, ...(taskGroup ? {taskGroup} : {}), config, signal, isCurrent: current });
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
