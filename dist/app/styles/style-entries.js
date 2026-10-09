// Consumer-owned cascade. Supplier bundles stay intact; their manifests own provenance.
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
// Separate opt-in sheet: the host retains its cache and all/not-all media switch.
export const MEMPHIS_STYLE_ENTRIES=Object.freeze([
  entry('supplier','../memphis/memphis-candidate.web.css'),
  entry('shared','../memphis/lantai-adapter.css'),
]);

// Product-owned appearance, after the complete candidate's shared component layer.
export const SNOW_ERMINE_STYLE_ENTRIES=Object.freeze([
  entry('shared','../snow-ermine/theme.css'),
]);
