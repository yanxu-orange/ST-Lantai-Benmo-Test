import { DEFAULT_THEME, normalizeTheme, resolveStyleAssets } from './styles/theme.js';
import { BASE_STYLE_ENTRIES, MEMPHIS_STYLE_ENTRIES, SNOW_ERMINE_STYLE_ENTRIES, SPRING_STYLE_ENTRIES } from './styles/style-entries.js';

// This foreground confirmation shares the existing component/theme styles, but
// owns only its compact placement. It never reads or writes memory data.
export const SOURCE_DELETION_DIALOG_CSS = `
:host { position:fixed; inset:0; z-index:10002; display:block; width:auto; height:auto; padding:0; background:transparent; pointer-events:none; }
.lt-source-deletion, .lt-source-deletion *, .lt-source-deletion *::before, .lt-source-deletion *::after { box-sizing:border-box; }
dialog.lt-source-deletion:not([open]) { display:none; }
dialog.lantai.lt-source-deletion {
  position:fixed; inset:0; display:grid; grid-template-rows:auto minmax(0,1fr) auto;
  width:min(430px,calc(100% - 2 * var(--ui-space-group))); height:auto;
  max-height:calc(100dvh - max(var(--ui-space-group),env(safe-area-inset-top)) - max(var(--ui-space-group),env(safe-area-inset-bottom)));
  margin:auto; padding:0; overflow:hidden; pointer-events:auto;
  color:var(--ui-color-text-primary); background:var(--ui-color-surface-raised);
  border:var(--ui-border-default-width) solid var(--ui-color-border-default);
  border-radius:var(--ui-shape-overlay-radius); box-shadow:var(--ui-elevation-high-shadow);
  font-family:var(--ui-type-ui-family); font-size:var(--ui-type-ui-body-size);
  font-weight:var(--ui-type-ui-body-weight); line-height:var(--ui-type-ui-body-line);
}
.lt-source-deletion::backdrop { background:var(--ui-color-scrim); pointer-events:auto; }
.lt-source-deletion :is(h2,p) { margin:0; }
.lt-source-deletion__header { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-control); padding:var(--ui-space-control) var(--ui-space-group); border-bottom:var(--ui-border-subtle-width) solid var(--ui-color-border-subtle); }
.lt-source-deletion__header h2 { min-width:0; font-size:var(--ui-type-ui-section-title-size); font-weight:var(--ui-type-ui-section-title-weight); line-height:var(--ui-type-ui-section-title-line); }
.lt-source-deletion__body { display:grid; align-content:start; gap:var(--ui-space-row); min-width:0; min-height:0; overflow:auto; overscroll-behavior:contain; padding:var(--ui-space-row) var(--ui-space-group); }
.lt-source-deletion__category { display:grid; gap:var(--ui-space-control); min-width:0; }
.lt-source-deletion .lt-source-deletion__choice { display:flex; align-items:center; gap:var(--ui-space-control); min-height:max(44px,var(--ui-interaction-target-min)); padding:0; cursor:pointer; }
.lt-source-deletion .lt-source-deletion__choice input { flex:none; width:18px; height:18px; margin:0; accent-color:var(--ui-color-selected-border); }
.lt-source-deletion__choice:has(input:disabled) { color:var(--ui-color-text-disabled); cursor:default; }
.lt-source-deletion__meta { color:var(--ui-color-text-meta); font-size:var(--ui-type-ui-meta-size); line-height:var(--ui-type-ui-meta-line); }
.lt-source-deletion__warning { color:var(--ui-color-warning-text); font-size:var(--ui-type-ui-support-size); line-height:var(--ui-type-ui-support-line); }
.lt-source-deletion__details { min-width:0; }
.lt-source-deletion__details summary { min-height:max(44px,var(--ui-interaction-target-min)); align-content:center; cursor:pointer; color:var(--ui-color-action-tertiary-text); }
.lt-source-deletion__details ul { display:grid; gap:var(--ui-space-row); margin:0; padding:var(--ui-space-control) 0 var(--ui-space-control) var(--ui-space-group); }
.lt-source-deletion__details li { padding:0; }
.lt-source-deletion__details li span { display:block; }
.lt-source-deletion :is(p,span,summary) { overflow-wrap:anywhere; }
.lt-source-deletion__footer { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--ui-space-control); padding:var(--ui-space-control) var(--ui-space-group); border-top:var(--ui-border-subtle-width) solid var(--ui-color-border-subtle); background:var(--ui-color-surface-raised); }
.lt-source-deletion__footer .ui-button { min-width:0; min-height:max(44px,var(--ui-interaction-target-min)); white-space:normal; }
.lt-source-deletion .ui-icon-button { flex:none; min-width:max(44px,var(--ui-interaction-target-min)); min-height:max(44px,var(--ui-interaction-target-min)); }
.lt-source-deletion :is(summary,input):focus-visible { outline:max(var(--ui-focus-ring-width),var(--ui-interaction-focus-width-min)) solid var(--ui-color-focus-ring); outline-offset:var(--ui-focus-ring-offset); }
@media (forced-colors:active) {
  .lt-source-deletion .lt-source-deletion__choice input { appearance:auto; accent-color:auto; }
}
`;

// Reuse the production theme bundles, with no dependency on the plugin being
// open. Only the base tokens/components and theme mappings are needed here.
function createStyleLoader(request) {
  const cached = new Map();
  const load = entry => {
    const key = entry.url.href;
    if (!cached.has(key)) cached.set(key,Promise.resolve().then(async () => {
      const response = await request(entry.url);
      if (!response.ok) throw new Error('来源删除提醒的主题样式未能加载');
      return resolveStyleAssets(await response.text(),entry.url).replace(/:root\b/g,':host');
    }).catch(error => { cached.delete(key);throw error; }));
    return cached.get(key);
  };
  return async theme => {
    const entries = [...BASE_STYLE_ENTRIES.slice(0,2),...MEMPHIS_STYLE_ENTRIES];
    if (theme === 'snow-ermine') entries.push(...SNOW_ERMINE_STYLE_ENTRIES);
    if (theme === 'spring') entries.push(...SPRING_STYLE_ENTRIES);
    return (await Promise.all(entries.map(load))).join('\n');
  };
}

const activeDocuments = new WeakMap();
const categoryLabels = Object.freeze({
  normal: '包含该楼层的常规总结记忆',
  merged: '包含该楼层的合并总结记忆',
});

function snapshotRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    title: String(row?.title ?? ''),
    sources: (Array.isArray(row?.sources) ? row.sources : []).map(range => ({start:range.start,end:range.end})),
  }));
}
function sourceText(sources) {
  const ranges = sources.filter(range => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end >= range.start);
  return ranges.length ? `原来源：${ranges.map(range => range.start === range.end ? `第 ${range.start} 楼` : `第 ${range.start}—${range.end} 楼`).join('、')}` : '原来源范围未提供';
}
function activeElement(doc) {
  let node = doc.activeElement;
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
  return node;
}

/**
 * Optional styles(theme) supplies full shared component/theme CSS (as for other
 * shadow surfaces). proposal contains {batchCount, normal:[{id,title,sources}],
 * merged:[{id,title,sources}]}; the caller owns identity and commit validation.
 * show({proposal,signal}) resolves {normal,merged} on explicit deletion, or null
 * for keep, close, replacement, abort or disposal. Loading/mount errors reject.
 */
export function createSourceDeletionDialog({ document:doc = globalThis.document, styles, getTheme = () => DEFAULT_THEME, fetch:request = globalThis.fetch } = {}) {
  const loadStyles = styles ?? createStyleLoader(request);
  let disposed = false, current = null;

  function show({proposal, signal} = {}) {
    if (disposed || signal?.aborted) return Promise.resolve(null);
    const categories = {normal:snapshotRows(proposal?.normal),merged:snapshotRows(proposal?.merged)};
    const count = categories.normal.length + categories.merged.length;
    if (!count) return Promise.resolve(null);
    if (!Number.isInteger(proposal?.batchCount) || proposal.batchCount < 1) return Promise.reject(new TypeError('Source deletion proposal requires an affected batch count'));
    const batchCount = proposal.batchCount;
    activeDocuments.get(doc)?.cancel();

    return new Promise((resolve,reject) => {
      let host = null, shadow = null, dialog = null, settled = false;
      const previousFocus = activeElement(doc);
      const removers = [];
      const listen = (node,type,handler) => { node.addEventListener(type,handler);removers.push(() => node.removeEventListener(type,handler)); };
      const finish = (selection, {error,restoreFocus = false} = {}) => {
        if (settled) return;
        settled = true;
        const ownedFocus = doc.activeElement === host || shadow?.contains?.(activeElement(doc));
        for (const remove of removers) remove();
        // Removing the top-layer owner also dismisses a native dialog. Avoid
        // close()'s focus restoration during chat changes or supersession.
        host?.remove();
        if (current === record) current = null;
        if (activeDocuments.get(doc) === record) activeDocuments.delete(doc);
        if (restoreFocus && ownedFocus && previousFocus?.isConnected && !previousFocus.disabled && !previousFocus.closest?.('[hidden],[inert]')) previousFocus.focus?.({preventScroll:true});
        if (error) reject(error);else resolve(selection);
      };
      const record = {cancel:() => finish(null)};
      current = record;activeDocuments.set(doc,record);
      if (signal) listen(signal,'abort',record.cancel);
      if (signal?.aborted) { record.cancel();return; }

      let theme;
      Promise.resolve().then(() => { if (settled) return null;theme = normalizeTheme(getTheme());return loadStyles(theme); }).then(css => {
        if (settled || disposed || signal?.aborted) return;
        if (typeof css !== 'string' || !css.trim()) throw new Error('来源删除提醒的主题样式未能加载');
        const make = (tag,className,text) => {
          const node = doc.createElement(tag);
          if (className) node.className = className;
          if (text !== undefined) node.textContent = text;
          return node;
        };
        host = make('lantai-benmo-source-deletion');
        host.setAttribute('data-ui-theme',theme);
        shadow = host.attachShadow({mode:'open'});
        const style = make('style');style.textContent = `${css}\n${SOURCE_DELETION_DIALOG_CSS}`;
        dialog = make('dialog','lantai ui-dialog lt-source-deletion');
        dialog.setAttribute('data-ui-theme',theme);
        dialog.setAttribute('aria-labelledby','lt-source-deletion-title');
        dialog.setAttribute('aria-describedby','lt-source-deletion-description');
        const header = make('header','lt-source-deletion__header');
        const title = make('h2','ui-section-title','来源楼层已删除');title.id = 'lt-source-deletion-title';
        const close = make('button','ui-icon-button ui-button--tertiary','×');close.type = 'button';close.setAttribute('aria-label','关闭并保留记忆');
        header.append(title,close);
        const body = make('div','lt-source-deletion__body');
        const description = make('p','',`本次删除影响 ${batchCount} 个总结批次，共 ${count} 条活动记忆。`);description.id = 'lt-source-deletion-description';
        body.append(description,make('p','lt-source-deletion__meta','按总结批次判断影响，同批记忆共享来源范围。确认前全部保留。'));
        const inputs = {};
        for (const key of ['normal','merged']) {
          const rows = categories[key];
          const section = make('section','lt-source-deletion__category');
          const label = make('label','ui-choice ui-choice--control-only lt-source-deletion__choice');
          const input = make('input');input.type = 'checkbox';input.name = key;input.checked = false;input.disabled = rows.length === 0;inputs[key] = input;
          label.append(input,make('span','',`${categoryLabels[key]}（${rows.length} 条）`));section.append(label);
          if (key === 'merged' && rows.length) {
            const warning = make('p','lt-source-deletion__warning','合并记忆可能还包含其他未删除楼层的信息，删除后这些信息也会一并移除。');
            warning.id = 'lt-source-deletion-merged-warning';input.setAttribute('aria-describedby',warning.id);section.append(warning);
          }
          if (rows.length) {
            const details = make('details','lt-source-deletion__details ui-disclosure');
            details.append(make('summary','',`查看标题与来源（${rows.length} 条）`));
            const list = make('ul');
            rows.forEach((row,index) => {
              const item = make('li');
              item.append(make('span','',row.title.trim() || `未命名记忆 ${index+1}`),make('span','lt-source-deletion__meta',sourceText(row.sources)));
              list.append(item);
            });
            details.append(list);section.append(details);
          }
          body.append(section);
        }
        const footer = make('footer','lt-source-deletion__footer');
        const keep = make('button','ui-button ui-button--secondary','保留记忆');keep.type = 'button';keep.autofocus = true;
        const remove = make('button','ui-button ui-button--danger','删除所选');remove.type = 'button';remove.disabled = true;
        footer.append(keep,remove);dialog.append(header,body,footer);shadow.append(style,dialog);
        const selection = () => ({normal:!inputs.normal.disabled && inputs.normal.checked,merged:!inputs.merged.disabled && inputs.merged.checked});
        const changed = () => { const value = selection();remove.disabled = !value.normal && !value.merged; };
        for (const input of Object.values(inputs)) listen(input,'change',changed);
        const keepAll = () => finish(null,{restoreFocus:true});
        listen(keep,'click',keepAll);listen(close,'click',keepAll);
        listen(remove,'click',() => { const value = selection();if (value.normal || value.merged) finish(value,{restoreFocus:true}); });
        listen(dialog,'cancel',event => { event.preventDefault();event.stopPropagation();keepAll(); });
        listen(dialog,'close',keepAll);
        // Stop the host's Escape shortcut before it closes an underlying plugin
        // page. Native dialog modality supplies tab containment and inertness.
        listen(dialog,'keydown',event => { if (event.key === 'Escape') { event.preventDefault();event.stopPropagation();keepAll(); } });
        doc.body.append(host);
        // ::backdrop does not inherit tokens in all supported host engines.
        // Resolve the current semantic scrim rather than hard-coding a skin.
        const scrim = doc.defaultView?.getComputedStyle?.(dialog).getPropertyValue('--ui-color-scrim').trim();
        if (scrim) { const backdrop = make('style');backdrop.textContent = `.lt-source-deletion::backdrop { background:${scrim}; }`;shadow.append(backdrop); }
        dialog.showModal();
        keep.focus({preventScroll:true});
      }).catch(error => finish(null,{error}));
    });
  }

  return Object.freeze({show,dispose() { disposed = true;current?.cancel(); }});
}
