const AREAS = ['workshop', 'benmo'];
const ROLES = ['surface', 'header', 'main', 'footer'];
const RECT = ['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'];
const METRICS = ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollTop'];
const VIEWPORT = ['innerWidth', 'innerHeight', 'devicePixelRatio', 'width', 'height', 'offsetLeft', 'offsetTop', 'scale'];
const PROPERTY = 'grid-template-rows';
const clone = value => JSON.parse(JSON.stringify(value));

// Diagnostic-only: no scheduling, DOM discovery, data access or geometry reads.
export function createTransitionGridProbe({ getStyle, onChange = () => {} }) {
  let mode = 'original', invalid = false, reason = null, pages = new Map();
  function inspect() {
    return { mode, ready: AREAS.every(area => pages.has(area)), invalid, reason,
      pages: AREAS.filter(area => pages.has(area)).map(area => {
        const page = pages.get(area);
        return { area, middlePxToken: page.middlePxToken, baseline: clone(page.baseline), viewport: clone(page.viewport), verification: clone(page.verification), originalVerification: clone(page.originalVerification) };
      }),
      pending: mode === 'fixed' ? AREAS.filter(area => !pages.get(area)?.verification) : [] };
  }
  let previous = JSON.stringify(inspect());
  function publish() {
    const state = inspect(), key = JSON.stringify(state);
    if (key !== previous) { previous = key; onChange(state); }
    return state;
  }
  function fail(value) { invalid = true; reason ??= value; }
  function layoutSnapshot(layout) {
    if (!Array.isArray(layout)) return null;
    const output = [];
    for (const role of ROLES) {
      const matches = layout.filter(row => row?.role === role);
      if (matches.length !== 1) return null;
      const row = matches[0], result = { role, rect: {} };
      for (const key of RECT) {
        if (!Number.isFinite(row.rect?.[key])) return null;
        result.rect[key] = row.rect[key];
      }
      for (const key of METRICS) {
        if (!Number.isFinite(row[key])) return null;
        result[key] = row[key];
      }
      output.push(result);
    }
    return output;
  }
  function restore() {
    for (const page of pages.values()) {
      if (!page.overridden) continue;
      if (page.originalValue) page.node.style.setProperty(PROPERTY, page.originalValue, page.originalPriority);
      else page.node.style.removeProperty(PROPERTY);
      page.overridden = false;
    }
  }
  function observe(area, surface, layout, { ready = false, viewport = null } = {}) {
    if (!AREAS.includes(area)) return inspect();
    const page = pages.get(area);
    if (page && page.node !== surface) { fail('node-replaced'); return publish(); }
    const visible = layout?.find(row => row?.role === 'surface')?.rect;
    if (!visible || visible.width <= 0 || visible.height <= 0) return inspect();
    if (!page && (!ready || mode !== 'original' || invalid)) return inspect();
    const snapshot = layoutSnapshot(layout);
    const viewportSnapshot = Object.fromEntries(VIEWPORT.map(key => [key, Number.isFinite(viewport?.[key]) ? viewport[key] : null]));
    if (!snapshot) { fail('incomplete-geometry'); return publish(); }
    if (VIEWPORT.some(key => viewportSnapshot[key] === null)) { fail('incomplete-viewport'); return publish(); }
    if (!page) {
      let tokens;
      try { tokens = getStyle(surface).gridTemplateRows.trim().split(/\s+/); } catch { tokens = []; }
      if (tokens.length !== 3 || !tokens.every(token => /^\d+(?:\.\d+)?px$/.test(token) && Number.isFinite(Number(token.slice(0, -2))))) {
        fail('unsupported-grid-rows'); return publish();
      }
      pages.set(area, { node: surface, middlePxToken: tokens[1], baseline: snapshot, viewport: viewportSnapshot, verification: null, originalVerification: null,
        originalValue: surface.style.getPropertyValue(PROPERTY), originalPriority: surface.style.getPropertyPriority(PROPERTY), overridden: false });
    } else {
      let maxDifference = 0;
      for (let i = 0; i < snapshot.length; i++) {
        for (const key of RECT) maxDifference = Math.max(maxDifference, Math.abs(snapshot[i].rect[key] - page.baseline[i].rect[key]));
        for (const key of METRICS) maxDifference = Math.max(maxDifference, Math.abs(snapshot[i][key] - page.baseline[i][key]));
      }
      const overrideLost = mode === 'fixed' && (surface.style.getPropertyValue(PROPERTY) !== `auto ${page.middlePxToken} auto` || surface.style.getPropertyPriority(PROPERTY) !== 'important');
      const viewportChanged = VIEWPORT.some(key => viewportSnapshot[key] !== page.viewport[key]);
      if (overrideLost) fail('override-lost');
      if (viewportChanged) fail('viewport-drift');
      if (maxDifference !== 0) fail('geometry-drift');
      // Preserve a failure even if a later observation happens to match again.
      const resultKey = mode === 'fixed' ? 'verification' : 'originalVerification';
      if (!page[resultKey] || page[resultKey].match === 'exact') {
        page[resultKey] = { match: maxDifference === 0 && !viewportChanged && !overrideLost ? 'exact' : 'mismatch', maxDifference,
          reason: overrideLost ? 'override-lost' : viewportChanged ? 'viewport-drift' : maxDifference === 0 ? null : 'geometry-drift', layout: snapshot, viewport: viewportSnapshot };
      }
    }
    return publish();
  }
  function setMode(next) {
    if (next !== 'original' && next !== 'fixed') return inspect();
    if (next === mode) return inspect();
    if (next === 'fixed') {
      if (invalid || !AREAS.every(area => pages.has(area))) return inspect();
      for (const page of pages.values()) {
        page.node.style.setProperty(PROPERTY, `auto ${page.middlePxToken} auto`, 'important');
        page.overridden = true;
        page.verification = null;
      }
    } else restore();
    mode = next;
    return publish();
  }
  function reset() {
    restore(); mode = 'original'; invalid = false; reason = null; pages = new Map();
    return publish();
  }
  return { inspect, observe, setMode, reset };
}
