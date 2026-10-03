export function getSillyTavernContext(host = globalThis.SillyTavern) {
  if (!host || typeof host.getContext !== 'function') return null;
  try {
    return host.getContext() ?? null;
  } catch {
    return null;
  }
}

export function detectCapabilities(context) {
  const available = (value) => typeof value === 'function';
  return {
    context: Boolean(context),
    events: Boolean(context?.eventSource && available(context.eventSource.on)),
    eventDispose: Boolean(context?.eventSource
      && (available(context.eventSource.removeListener)
        || available(context.eventSource.off))),
    chatIdentity: Boolean(context
      && (available(context.getCurrentChatId) || context.chatId != null)),
    globalSettings: Boolean(context?.extensionSettings
      && available(context.saveSettingsDebounced)),
    chatMetadata: Boolean(context?.chatMetadata
      && (available(context.saveMetadata) || available(context.saveMetadataDebounced))),
    promptInjection: available(context?.setExtensionPrompt),
    backgroundGeneration: available(context?.generateQuietPrompt),
    secrets: Boolean(context?.secretState
      || available(context?.writeSecret)
      || available(context?.getSecrets)),
  };
}
