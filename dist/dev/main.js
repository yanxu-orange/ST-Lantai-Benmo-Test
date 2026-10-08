import { createMemoryHost } from '../platform/sillytavern/memory-host.js';
import { createPreviewFixture } from './preview-fixture.js';

// Production views, layout, host isolation, themes and settings; fake data only.
const fixture = createPreviewFixture({ assetFetch: globalThis.fetch.bind(globalThis), timeConfigured: new URLSearchParams(location.search).get('time') !== 'empty' });
const host = createMemoryHost({ document, getContext: () => fixture.ctx, fetch: fixture.request,
  runtimeOptions: fixture.runtimeOptions, appearanceOptions: fixture.appearanceOptions });
document.querySelector('#preview-chat').addEventListener('change', event => fixture.switchChat(event.target.value));
document.querySelector('#preview-reset').addEventListener('click', () => location.reload());
globalThis.LantaiPreview = { host, fixture };
globalThis.addEventListener('beforeunload', () => host.dispose(), { once: true });
await host.open();
