import { BOOK_THEME_STYLE_ENTRIES } from './style-entries.js';

// Register once on the owning document: @font-face inside a shadow stylesheet
// is not supported consistently. This bundled font never needs an external CDN.
const source = new URL('../book-themes/assets/PinyonScript-Regular.ttf',import.meta.url);
const pending = new WeakMap();
export function ensureBookThemeFont(document,theme) {
  if (!Object.hasOwn(BOOK_THEME_STYLE_ENTRIES,theme) || !document?.fonts?.add) return Promise.resolve(false);
  const Font = document.defaultView?.FontFace ?? globalThis.FontFace;
  if (typeof Font !== 'function') return Promise.resolve(false);
  if (!pending.has(document)) pending.set(document,Promise.resolve().then(async () => {
    const face = new Font('Lantai Pinyon Script',`url("${source.href}")`,{style:'normal',weight:'400',display:'swap'});
    await face.load();document.fonts.add(face);return true;
  }).catch(() => {
    // Font availability is decorative: keep the theme usable with its fallback,
    // and allow a subsequent opening to retry a transient asset failure.
    pending.delete(document);return false;
  }));
  return pending.get(document);
}
