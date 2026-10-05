// Consumer-owned presentation identities. Business views keep one markup tree.
export const DEFAULT_THEME = 'memphis';
export const THEMES = Object.freeze([
  Object.freeze({ id: DEFAULT_THEME, label: '孟菲斯' }),
  Object.freeze({ id: 'snow-ermine', label: '雪山白鼬' }),
]);
export const isTheme = value => THEMES.some(theme => theme.id === value);
export const normalizeTheme = value => isTheme(value) ? value : DEFAULT_THEME;

// Shadow <style> does not resolve a source stylesheet's relative assets.
// Resolve only ordinary stylesheet URLs; data, fragments and absolute URLs stay intact.
export function resolveStyleAssets(css, sourceUrl) {
  return css.replace(/url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/g, (match, quote, path) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(path)) return match;
    return `url("${new URL(path, sourceUrl).href}")`;
  });
}

export function applyTheme(root, theme) {
  const next = normalizeTheme(theme);
  for (const surface of root.querySelectorAll('.lantai')) {
    if (surface.getAttribute('data-ui-theme') !== next) surface.setAttribute('data-ui-theme', next);
  }
  return next;
}
