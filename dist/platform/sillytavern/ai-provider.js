import {beginGenerationRequest} from './generation-diagnostic.js';
import { AiProviderError, assertAiCurrent, freezeAiConfig, assertMaxOutputTokens } from '../../shared/ai/provider.js';
import { getSillyTavernContext } from './context.js';
export const PROXY_SOURCES = Object.freeze(['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot']);

export function mainSnapshot(context) {
  // Compare only non-secret routing/model fields; never copy the full settings.
  if (typeof context?.getLantaiMainIdentity === 'function') return context.getLantaiMainIdentity();
  const allowed = new Set(['model', 'type', 'chat_completion_source', 'custom_url', 'reverse_proxy',
    ...['openai', 'claude', 'google', 'vertexai', 'openrouter', 'ai21', 'mistralai', 'custom', 'cohere', 'perplexity', 'groq', 'siliconflow', 'minimax', 'electronhub', 'chutes', 'nanogpt', 'deepseek', 'aimlapi', 'xai', 'pollinations', 'cometapi', 'moonshot', 'fireworks', 'azure_openai', 'zai', 'workers_ai', 'generic', 'mancer', 'togetherai', 'infermaticai', 'dreamgen', 'vllm', 'aphrodite', 'ollama', 'featherless', 'tabby', 'llamacpp'].map(name => `${name}_model`)]);
  const models = settings => Object.fromEntries(Object.keys(settings ?? {})
    .filter(key => allowed.has(key)).sort().map(key => {
      const value = settings[key];
      if (value !== undefined && value !== null && typeof value !== 'string') throw new AiProviderError('unavailable');
      return [key, value];
    }));
  const mainApi = context?.mainApi;
  if (mainApi === 'openai' && typeof context.getChatCompletionModel === 'function') {
    const settings = context.chatCompletionSettings;
    const source = settings?.chat_completion_source;
    const identity = { mainApi, source,
      model: context.getChatCompletionModel(), customUrl: source === 'custom' ? settings?.custom_url : null,
      reverseProxy: PROXY_SOURCES.includes(source) ? settings?.reverse_proxy : null,
      azureBase: source === 'azure_openai' ? settings?.azure_base_url : null,
      azureDeployment: source === 'azure_openai' ? settings?.azure_deployment_name : null,
      azureVersion: source === 'azure_openai' ? settings?.azure_api_version : null,
      vertexMode: source === 'vertexai' ? settings?.vertexai_auth_mode : null,
      vertexRegion: source === 'vertexai' ? settings?.vertexai_region : null,
      vertexProject: source === 'vertexai' ? settings?.vertexai_express_project_id : null };
    if (Object.keys(identity).some(key => identity[key] !== undefined && identity[key] !== null && typeof identity[key] !== 'string')) throw new AiProviderError('unavailable');
    return JSON.stringify(identity);
  }
  return JSON.stringify({ mainApi, chat: mainApi === 'openai' ? models(context?.chatCompletionSettings) : null,
    text: mainApi === 'textgenerationwebui' ? models(context?.textCompletionSettings) : null });
}

function readAssistantText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    return '';
  }).join('');
  return '';
}

// The same pure preparation can drive a prompt preview and actual sending.
// mainApi=null denotes the plugin chat transport; no credentials are included.
export function prepareSillyTavernAiRequest({ task, messages, jsonSchema = null, mainApi = null }) {
  if (typeof task !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(task)
    || !Array.isArray(messages) || !messages.length
    || messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string')) throw new AiProviderError('request');
  const prepared = [{ role: 'system', content: `[LANTAI_BACKGROUND_TASK:${task}]\nReturn only the requested result.` },
    ...messages.map(({ role, content }) => ({ role, content }))];
  const chatApi = mainApi === null || mainApi === 'openai';
  if (!chatApi && jsonSchema) prepared.unshift({ role: 'system',
    content: `Return strict JSON matching this schema: ${JSON.stringify(jsonSchema.value)}` });
  return { messages: prepared, prompt: chatApi ? prepared
    : prepared.map(({ role, content }) => `[${role}]\n${content}`).join('\n\n'),
  jsonSchema: chatApi && jsonSchema ? { ...jsonSchema, ...(mainApi === 'openai' ? { returnInvalid: true } : {}) } : null };
}

// Host calls and private backend routes live only in this platform adapter.
export function createSillyTavernAiTransport({ getContext = getSillyTavernContext, fetchImpl = globalThis.fetch, resolveCredential, captureCredential } = {}) {
    async function generate({ config: configured, task, taskGroup, messages, jsonSchema = null, signal, isCurrent = () => true, maxTokens, maxOutputTokens }, execution=null) {
      if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128)) throw new AiProviderError('request');
      assertMaxOutputTokens(maxOutputTokens);
      if (maxTokens !== undefined && maxOutputTokens !== undefined) throw new AiProviderError('request');
      const outputLimit = maxOutputTokens ?? maxTokens;
      const config = freezeAiConfig(configured);
      assertAiCurrent(signal, isCurrent);
      let context;
      try { context = getContext(); } catch { throw new AiProviderError('unavailable'); }
      const main = config.source === 'sillytavern';
      if (!context || (main && (typeof context.generateRaw !== 'function'
        || !['openai', 'kobold', 'koboldhorde', 'novel', 'textgenerationwebui'].includes(context.mainApi)
        || !context.onlineStatus || context.onlineStatus === 'no_connection'))
        || (!main && (typeof fetchImpl !== 'function' || typeof context.getRequestHeaders !== 'function' || typeof resolveCredential !== 'function'))) {
        throw new AiProviderError('unavailable');
      }
      const snapshot = main ? mainSnapshot(context) : null;
      if(execution&&main&&snapshot!==execution.mainIdentity)throw new AiProviderError('stale');
      const credentialCurrent=()=>{try{return !execution?.credential||typeof execution.credential.resolve()==='string';}catch{return false;}};
      const current = () => {
        if (isCurrent() !== true) return false;
        if (!credentialCurrent())return false;
        if (!main) return true;
        const latest = getContext();
        return Boolean(latest?.onlineStatus && latest.onlineStatus !== 'no_connection' && mainSnapshot(latest) === snapshot);
      };
      const finishDiagnostic=beginGenerationRequest(main?'raw':'independent',taskGroup);
      let diagnosticStatus='failed';
      try {
        assertAiCurrent(signal, current);
        const prepared = prepareSillyTavernAiRequest({ task, messages, jsonSchema, mainApi: main ? context.mainApi : null });
        let text;
        if (main) {
          // generateRaw has no per-call abort option. Ignore late responses;
          // do not stop the user's independent foreground generation.
          // Current ST silently produces {} for non-chat schema extraction;
          // use the raw text path there. Chat invalid text must survive intact
          // rather than being replaced with {} by host extraction.
          text = await context.generateRaw({ prompt: prepared.prompt, api: context.mainApi, jsonSchema: prepared.jsonSchema,
            trimNames: false, quietToLoud: false, instructOverride: false, ...(outputLimit === undefined ? {} : { responseLength: outputLimit }) });
        } else {
          let key;
          try { key = execution?.credential?execution.credential.resolve():resolveCredential(config, { taskGroup }); } catch { throw new AiProviderError('configuration'); }
          if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(key)) throw new AiProviderError('configuration');
          const authorization = JSON.stringify({ Authorization: `Bearer ${key}` });
          key = null;
          const body = JSON.stringify({ chat_completion_source: 'custom', custom_url: config.endpoint,
            model: config.model, secret_id: `lantai-benmo:plugin-owned:${config.credentialId}`, custom_include_headers: authorization,
            messages: prepared.messages, json_schema: jsonSchema ?? undefined, stream: false, n: 1, ...(outputLimit === undefined ? {} : { max_tokens: outputLimit }) });
          const headers = context.getRequestHeaders();
          assertAiCurrent(signal, current);
          const response = await fetchImpl('/api/backends/chat-completions/generate', {
            method: 'POST', headers, signal, body,
          });
          assertAiCurrent(signal, current);
          if (!response?.ok) throw new AiProviderError('http');
          const result = await response.json();
          assertAiCurrent(signal, current);
          if (result?.error) throw new AiProviderError('http');
          text = readAssistantText(result);
        }
        assertAiCurrent(signal, current);
        if (typeof text !== 'string' || !text.trim()) throw new AiProviderError('empty_output');
        diagnosticStatus='success';
        return text;
      } catch (error) {
        if(signal?.aborted)diagnosticStatus='cancelled';
        assertAiCurrent(signal, current);
        throw new AiProviderError(error instanceof AiProviderError ? error.code : 'transport');
      } finally {
        try{finishDiagnostic(diagnosticStatus);}catch{/* Diagnostics cannot affect generation. */}
      }
    }
  return Object.freeze({generate,
    captureSession(configured,{taskGroup}={}) {
      const config=freezeAiConfig(configured),main=config.source==='sillytavern';
      let active=true;
      const execution=main?{mainIdentity:mainSnapshot(getContext())}:{credential:captureCredential?.(config,{taskGroup})};
      if(!main&&typeof execution.credential?.resolve!=='function')throw new AiProviderError('capability');
      if(!main)execution.credential.resolve();
      // Keep the original route for every stage. Native ST settings are checked
      // at stage boundaries and during requests; only Lantai configuration is frozen.
      return Object.freeze({generate:args=>{if(!active)throw new AiProviderError('stale');return generate({...args,config,isCurrent:()=>active&&args.isCurrent()},execution);},dispose(){active=false;execution.credential?.dispose?.();}});
    },
  });
}
