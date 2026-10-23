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

// Current shared geometry is deliberately last, after historical theme detail.
export const SURFACE_STABILITY_STYLE_ENTRIES=Object.freeze([entry('shared','../shared-ui/surface-stability.css')]);

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
  ...SURFACE_STABILITY_STYLE_ENTRIES,

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
  ...SURFACE_STABILITY_STYLE_ENTRIES,
]);

// Book themes share attribute-scoped tokens/components, never an existing theme's
// palette. Keep named entries so each identity participates in the same loaders.
export const PAPER_LETTER_STYLE_ENTRIES=Object.freeze([
  entry('shared','../book-themes/tokens.css'),
  ...APPEARANCE_FORMAT_STYLE_ENTRIES,
  entry('shared','../book-themes/components.css'),
  entry('shared','../book-themes/pages.css'),
  entry('shared','../book-themes/memory.css'),
  entry('shared','../book-themes/time-details.css'),
  ...SURFACE_STABILITY_STYLE_ENTRIES,
]);
export const PURPLE_GLOW_STYLE_ENTRIES=Object.freeze([...PAPER_LETTER_STYLE_ENTRIES]);
export const BOOK_THEME_STYLE_ENTRIES=Object.freeze({
  'paper-letter':PAPER_LETTER_STYLE_ENTRIES,
  'purple-glow':PURPLE_GLOW_STYLE_ENTRIES,
});
