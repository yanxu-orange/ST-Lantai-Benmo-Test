// First-paint subset of memory-host.css, memory.css and the pinned UI recipe.
// Fallbacks are the existing clear-white/base roles, not another appearance.
// Remove this sheet when the full base cascade is ready; no business page owns it.
export const MEMORY_SHELL_CSS = `
:host { position:fixed; inset:0; width:100%; height:100vh; height:100dvh; min-height:0; min-width:0; z-index:10000; display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); place-items:center; box-sizing:border-box; padding:max(var(--ui-space-group,1rem),env(safe-area-inset-top)) max(var(--ui-space-control,.5rem),env(safe-area-inset-right)) max(var(--ui-space-group,1rem),env(safe-area-inset-bottom)) max(var(--ui-space-control,.5rem),env(safe-area-inset-left)); background:var(--ui-color-canvas,#eaf0ed); }
#lt-host-content,.lt-host-page { width:100%; height:100%; min-height:0; min-width:0; display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); place-items:center; }
.lt-host-page[hidden],.lantai [hidden] { display:none; }
.lantai,.lantai * { box-sizing:border-box; }
.lantai { display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(100%,430px); height:min(100%,850px); margin:0; min-height:0; color:var(--ui-color-text-primary,#252525); background:var(--ui-color-workspace,#fff); font-family:var(--ui-type-ui-family,"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif); font-size:var(--ui-type-ui-body-size,.9375rem); font-weight:var(--ui-type-ui-body-weight,400); line-height:var(--ui-type-ui-body-line,1.6); border-radius:var(--ui-shape-overlay-radius,.75rem); overflow:hidden; }
.lt-header { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; padding:var(--ui-space-control,.5rem) var(--ui-space-group,1rem); border-bottom:1px solid var(--ui-color-border-subtle,#dde3df); gap:var(--ui-space-control,.5rem); }
.lt-header h1 { text-align:center; }
.lt-main { min-height:0; min-width:0; overflow:auto; overscroll-behavior:contain; padding:var(--ui-space-group,1rem); }
.lt-stack { display:grid; gap:var(--ui-space-row,.75rem); min-width:0; }
.lantai h1,.lantai p { margin:0; }
.ui-page-title { font-size:var(--ui-type-ui-page-title-size,1.5rem); font-weight:var(--ui-type-ui-page-title-weight,500); line-height:var(--ui-type-ui-page-title-line,1.25); }
.ui-button,.ui-icon-button { min-block-size:max(var(--ui-density-control-height,2.5rem),var(--ui-interaction-target-min,2rem)); border:1px solid var(--ui-color-border-default,#cfd5d5); border-radius:var(--ui-shape-control-radius,.375rem); color:var(--ui-color-action-secondary-text,#303432); background:var(--ui-color-action-secondary-background,#eef3f0); font-family:inherit; font-size:var(--ui-type-ui-control-size,.875rem); font-weight:var(--ui-type-ui-control-weight,500); line-height:var(--ui-type-ui-control-line,1.25); cursor:pointer; }
.ui-button { padding-inline:var(--ui-density-control-padding-inline,.875rem); }
.ui-icon-button { min-inline-size:max(var(--ui-density-control-height,2.5rem),var(--ui-interaction-target-min,2rem)); display:inline-grid; place-items:center; padding:0; }
.ui-button--tertiary { color:var(--ui-color-action-tertiary-text,#4e5955); background:transparent; border-color:transparent; }
.lt-icon { width:1.25em; height:1.25em; }
@media (pointer:coarse) { :host { --ui-interaction-target-min:2.75rem; } }
`;
