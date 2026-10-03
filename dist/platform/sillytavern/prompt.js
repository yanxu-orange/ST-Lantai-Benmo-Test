const PROMPT_KEY = 'lantai_benmo_runtime_probe';

export function createPromptProbe(getContext) {
  let active = false;
  return {
    setTemporary(marker = '[Lantai runtime probe]') {
      const context = getContext();
      if (typeof context?.setExtensionPrompt !== 'function') return { status: 'unavailable' };
      context.setExtensionPrompt(PROMPT_KEY, marker, 1, 0);
      active = true;
      return { status: 'set' };
    },
    clear() {
      const context = getContext();
      if (typeof context?.setExtensionPrompt !== 'function') {
        return { status: active ? 'clear-unavailable' : 'unavailable' };
      }
      context.setExtensionPrompt(PROMPT_KEY, '', 1, 0);
      active = false;
      return { status: 'cleared' };
    },
  };
}
