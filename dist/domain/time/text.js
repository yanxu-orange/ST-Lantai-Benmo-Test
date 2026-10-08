// Mask markup rather than parsing/evaluating it; retain original UTF-16 offsets.
export function maskMarkup(text) {
  const blank=value=>value.replace(/[^\r\n]/g,' ');
  return text
    .replace(/<(script|style)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi,blank)
    .replace(/<!--[\s\S]*?-->/g,blank)
    .replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g,tag=>/^(?:<br\b|<\/(?:div|p|section|header|footer|title|summary|li|h[1-6])\b)/i.test(tag)?'\n'+' '.repeat(tag.length-1):' '.repeat(tag.length));
}
