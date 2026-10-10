// Consumer-owned cascade. Pinned supplier and extracted shared layers retain provenance.
// Both ends share themes, components, host geometry and pointer/forced-color semantics.
const entry=(layer,path)=>Object.freeze({layer,url:new URL(path,import.meta.url)});
export const BASE_STYLE_ENTRIES=Object.freeze([
  entry('supplier','../../vendor/plugin-ui-system/web.css'),
  entry('shared','../lantai-theme.css'),
  entry('shared','../tag-palette.css'),
  entry('shared','../memory.css'),
  // The existing PC rule was the final memory.css rule. Keep this cascade slot.
  entry('mobile','./mobile.css'),
  entry('pc','./pc.css'),
  entry('shared','../api-settings.css'),
  entry('shared','../settings-root-view.css'),
  entry('shared','../summary-view.css'),
  entry('shared','../summary-settings.css'),
  entry('shared','../recall-view.css'),
  entry('shared','../time-view.css'),
  entry('shared','../workshop-view.css'),
  entry('shared','../benmo-view.css'),
  entry('shared','../../platform/sillytavern/memory-host.css'),
]);
// Shared candidate components and touch calibration, after the base cascade.
export const SHARED_STYLE_ENTRIES=Object.freeze([
  entry('shared','../shared-ui/candidate.web.css'),
]);

// Shared product appearance grammar, deliberately after each theme base mapping.
// Supplier/candidate provenance stays frozen; future themes may opt in explicitly.
export const APPEARANCE_FORMAT_STYLE_ENTRIES=Object.freeze([
  entry('shared','../shared-ui/appearance-format.css'),
]);

// Product-owned appearance, after the preserved shared component layer.
export const SNOW_ERMINE_STYLE_ENTRIES=Object.freeze([
  entry('shared','../snow-ermine/appearance-tokens.css'),
  entry('shared','../snow-ermine/memory-tokens.css'),
  entry('shared','../snow-ermine/switch-tokens.css'),
  entry('shared','../snow-ermine/segment-tokens.css'),
  entry('shared','../snow-ermine/theme.css'),
  ...APPEARANCE_FORMAT_STYLE_ENTRIES,
  entry('shared','../snow-ermine/memory.css'),
  entry('shared','../snow-ermine/page-tokens.css'),
  entry('shared','../snow-ermine/time.css'),
  entry('shared','../snow-ermine/benmo.css'),
  entry('shared','../snow-ermine/secondary.css'),
  // Transparent Snow material reuses the Snow grammar and stored identity.
  // Both the main host and independent native dialogs load this same chain.
  entry('shared','../panoramic-snow/material.css'),
  entry('shared','../panoramic-snow/selection.css'),
  entry('shared','../panoramic-snow/memory.css'),
  entry('shared','../panoramic-snow/time-benmo.css'),
  entry('shared','../panoramic-snow/workshop-settings.css'),
  entry('shared','../panoramic-snow/source-deletion.css'),
]);

// Spring keeps common mapping and each approved page grammar independently scoped.
export const SPRING_STYLE_ENTRIES=Object.freeze([
  entry('shared','../spring/appearance-tokens.css'),
  entry('shared','../spring/memory-tokens.css'),
  entry('shared','../spring/switch-tokens.css'),
  entry('shared','../spring/segment-tokens.css'),
  entry('shared','../spring/theme.css'),
  ...APPEARANCE_FORMAT_STYLE_ENTRIES,
  entry('shared','../spring/memory.css'),
  entry('shared','../spring/page-tokens.css'),
  entry('shared','../spring/time.css'),
  entry('shared','../spring/benmo.css'),
  entry('shared','../spring/workshop.css'),
  entry('shared','../spring/settings.css'),
]);
