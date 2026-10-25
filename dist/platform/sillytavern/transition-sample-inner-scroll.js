const PADDING = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const GUTTERS = new Set(['auto', 'stable', 'stable both-edges']);
const OVERSCROLL = new Set(['auto', 'contain', 'none']);
const camel = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
function read(style, key) { return String(style?.getPropertyValue?.(key) || style?.[camel(key)] || '').trim(); }
function padding(value) { return /^\d+(?:\.\d+)?px$/.test(value) && Number(value.slice(0, -2)) <= 4096; }

// Only the isolated sample owns these surfaces. No layout measurements or scroll writes.
export function createTransitionSampleInnerScroll({getStyle} = {}) {
  const mains = new WeakMap(), inners = new WeakMap(), restores = [];
  let disposed = false;
  function change(node, values) {
    const before = node.getAttribute('style');
    restores.push(() => { if (before === null) node.removeAttribute('style'); else node.setAttribute('style', before); });
    for (const [key, value] of Object.entries(values)) node.style.setProperty(key, value, 'important');
  }
  function apply(root) {
    if (disposed || !root?.matches?.('.lantai')) return false;
    const main = [...(root.children ?? [])].find(node => node.matches?.('main.lt-main'));
    const inner = [...(main?.children ?? [])].find(node => node.matches?.('div[data-transition-simple-main]'));
    if (!main || !inner || typeof main.style?.setProperty !== 'function' || typeof inner.style?.setProperty !== 'function') return false;
    if (inners.get(inner) === main) return true;
    let saved = mains.get(main);
    if (!saved) {
      let style;
      try { style = getStyle(main); } catch { return false; }
      const values = Object.fromEntries(PADDING.map(key => [key, read(style, key)]));
      const gutter = read(style, 'scrollbar-gutter'), x = read(style, 'overscroll-behavior-x'), y = read(style, 'overscroll-behavior-y');
      const display = read(style, 'display'), direction = read(style, 'flex-direction');
      if (!PADDING.every(key => padding(values[key])) || !GUTTERS.has(gutter) || !OVERSCROLL.has(x) || !OVERSCROLL.has(y) || !display || !direction) return false;
      saved = {...values, 'scrollbar-gutter': gutter, 'overscroll-behavior-x': x, 'overscroll-behavior-y': y};
      const outer = Object.fromEntries(PADDING.map(key => [key, '0px']));
      if (display !== 'flex') outer.display = 'flex';
      if (direction !== 'column') outer['flex-direction'] = 'column';
      change(main, outer); mains.set(main, saved);
    }
    change(inner, {...saved, display: 'block', flex: '1 1 0%', 'min-height': '0', 'min-width': '0', 'box-sizing': 'border-box', 'overflow-x': 'auto', 'overflow-y': 'auto'});
    inners.set(inner, main);
    return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const restore of restores.reverse()) restore();
    restores.length = 0;
  }
  return {apply, dispose};
}
