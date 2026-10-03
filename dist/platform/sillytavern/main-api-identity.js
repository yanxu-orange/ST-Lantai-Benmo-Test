// Only documented non-secret identity fields are read from already loaded ST
// modules. No status/request function, settings clone or credential is used.
export async function createMainApiIdentity({ getContext, loadModule = name => import(`/scripts/${name}.js`) } = {}) {
  const names = ['textgen-settings', 'nai-settings', 'kai-settings', 'horde'];
  const results = await Promise.allSettled(names.map(name => loadModule(name)));
  const modules = Object.fromEntries(names.map((name, i) => [name, results[i].status === 'fulfilled' ? results[i].value : null]));
  const textServers = { ooba: 'textgenerationwebui', vllm: 'vllm', aphrodite: 'aphrodite', tabby: 'tabby', koboldcpp: 'koboldcpp', llamacpp: 'llamacpp', ollama: 'ollama', huggingface: 'huggingface', generic: 'generic' };
  const textModels = { mancer: 'mancer_model', togetherai: 'model_togetherai_select', infermaticai: 'model_infermaticai_select', dreamgen: 'model_dreamgen_select', ollama: 'ollama_model', openrouter: 'openrouter_model', vllm: 'vllm_model', aphrodite: 'aphrodite_model', tabby: 'tabby_model', llamacpp: 'llamacpp_model', generic: 'generic_model_select', featherless: 'featherless_model' };
  return Object.freeze({
    snapshot() {
      const ctx = getContext(), api = ctx?.mainApi;
      if (api === 'openai') return null;
      if (api === 'textgenerationwebui') {
        const host = modules['textgen-settings'], type = host?.textgenerationwebui_settings?.type;
        if (typeof host?.getTextGenModel !== 'function' || typeof host?.getTextGenServer !== 'function' || typeof type !== 'string') throw new Error();
        if (type === 'ollama' && !host.textgenerationwebui_settings.ollama_model) throw new Error();
        const model = host.getTextGenModel(), server = host.getTextGenServer();
        if ((model !== undefined && typeof model !== 'string') || typeof server !== 'string') throw new Error();
        return { api, type, model: model ?? ctx.onlineStatus, server };
      }
      if (api === 'novel') {
        const model = modules['nai-settings']?.nai_settings?.model_novel;
        if (typeof model !== 'string' || !model) throw new Error();
        return { api, model };
      }
      if (api === 'kobold') {
        const server = modules['kai-settings']?.kai_settings?.api_server;
        if (typeof server !== 'string' || !server) throw new Error();
        return { api, server, model: ctx.onlineStatus };
      }
      if (api === 'koboldhorde') {
        const models = modules.horde?.horde_settings?.models;
        if (!Array.isArray(models) || !models.length || models.some(value => typeof value !== 'string' || !value)) throw new Error();
        return { api, models: [...models].sort() };
      }
      throw new Error();
    },
    relevant(id) {
      const ctx = getContext(), api = ctx?.mainApi;
      if (id === 'main_api') return true;
      if (api === 'novel') return ['model_novel_select', 'settings_preset_novel'].includes(id);
      if (api === 'kobold') return ['api_button', 'settings_preset'].includes(id);
      if (api === 'koboldhorde') return id === 'horde_model';
      if (api === 'textgenerationwebui') {
        const type = modules['textgen-settings']?.textgenerationwebui_settings?.type;
        return ['textgen_type', 'settings_preset_textgenerationwebui', textModels[type],
          type === 'featherless' ? 'api_button_textgenerationwebui' : null,
          type === 'ooba' ? 'custom_model_textgenerationwebui' : type === 'generic' ? 'generic_model_textgenerationwebui' : null,
          textServers[type] && `${textServers[type]}_api_url_text`].includes(id);
      }
      if (api !== 'openai') return false;
      const source = ctx.chatCompletionSettings?.chat_completion_source;
      const modelSource = { makersuite: 'google', azure_openai: 'azure_openai_model' }[source] ?? source;
      return ['chat_completion_source', 'settings_preset_openai'].includes(id)
        || PROXY_SOURCES.includes(source) && ['openai_reverse_proxy', 'openai_proxy_preset', 'save_proxy', 'delete_proxy'].includes(id)
        || source === 'azure_openai' && ['azure_base_url', 'azure_deployment_name', 'azure_api_version'].includes(id)
        || source === 'vertexai' && ['vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id'].includes(id)
        || source === 'custom' && ['custom_api_url_text', 'custom_model_id'].includes(id)
        || id === `model_${modelSource}_select` || id === modelSource;
    },
  });
}
import { PROXY_SOURCES } from './ai-provider.js';
