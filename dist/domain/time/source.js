// Literal source selection. No HTML evaluation, regex input, or host access.
export function recognitionSettings(input = {}) {
  const lookback = input.lookback ?? 20;
  if (!Number.isSafeInteger(lookback) || lookback < 1) throw new RangeError('识别消息数须为正整数');
  const scope = input.scope ?? 'all';
  if (!['all', 'tags'].includes(scope)) throw new Error('识别范围无效');
  const groups = input.groups ?? [{start:'<scene>', end:'</scene>'}];
  if (!Array.isArray(groups)) throw new Error('标签组无效');
  const normalized = Array.from(groups, group => {
    if (!group || typeof group.start !== 'string' || typeof group.end !== 'string' || scope === 'tags' && (!group.start || !group.end)) throw new Error('请填写完整的起止标签');
    return {start:group.start,end:group.end};
  });
  if (scope === 'tags' && !normalized.length) throw new Error('请至少填写一组标签');
  return {lookback, scope, users:input.users !== false, assistant:input.assistant !== false, groups:normalized};
}
export function textSegments(text, input = {}) {
  if (typeof text !== 'string') throw new TypeError('消息正文须为文本');
  const settings = recognitionSettings(input);
  if (settings.scope === 'all') return [{text,start:0,end:text.length}];
  const found = new Map();
  for (const group of settings.groups) {
    let cursor = 0;
    while (cursor < text.length) {
      const begin = text.indexOf(group.start,cursor);
      if (begin < 0) break;
      const start = begin + group.start.length, end = text.indexOf(group.end,start);
      if (end < 0) break;
      found.set(`${start}:${end}`,{text:text.slice(start,end),start,end});
      cursor = end + group.end.length;
    }
  }
  return [...found.values()].sort((a,b)=>a.start-b.start || a.end-b.end);
}
export function selectRecognitionSources(messages, input = {}) {
  if (!Array.isArray(messages)) throw new TypeError('消息列表无效');
  const settings = recognitionSettings(input), result = [];
  // N is the raw message window; role filtering happens afterwards.
  for (let index = Math.max(0,messages.length-settings.lookback); index < messages.length; index++) {
    const message = messages[index];
    if (!message || !['user','assistant'].includes(message.role)) continue;
    if (message.role === 'user' && !settings.users || message.role === 'assistant' && !settings.assistant) continue;
    for (const segment of textSegments(message.text ?? message.content ?? '', settings)) {
      result.push({messageIndex:index,role:message.role,...segment});
    }
  }
  return result;
}
