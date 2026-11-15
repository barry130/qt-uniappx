// Approved seam: render the actual SourceSwitcher; public clicks exercise the real
// SourceStore, SourceRegistryStore, platformLabel, source-sheet and action-sheet.
// Only SDK storage/events and the package-engine registry/quality-profile response
// are owned adapters. No private handler is called, no label policy is reimplemented.
import assert from 'node:assert/strict';
import * as Vue from 'vue';
import { readProduction, loadProduction, deferred, drain } from './check-account-radio.mjs';
import { tvSettingsFixture } from './check-tv-settings.mjs';
import { sourcePolicyFixture } from './source-policy-fixture.mjs';

const COMPONENT = 'uni_modules/qt-ui/components/qt-source-switcher/qt-source-switcher.uvue';
const textOf = node => node.text + node.children.map(textOf).join('');
const pack = sources => ({ sources, qualities: [], sourcePolicyVersion: 1 });
const source = (id, name, short) => ({ id, name, short, color: '#1688cc' });

async function fixture({ current = 'wyy' } = {}) {
  const host = { storage: new Map([['qt-source', current]]), writes: [], toastCalls: [] };
  const uni = {
    $on: () => {}, $off: () => {}, $emit: () => {},
    getStorageSync: key => host.storage.get(key) ?? '',
    setStorageSync: (key, value) => { host.storage.set(key, value); host.writes.push([key, value]); },
  };
  const source = Vue.reactive(loadProduction(readProduction('stores/source.ts'), ['useSourceStore'], {
    reactive: Vue.reactive, logWarn: () => {}, uni,
  }, 'stores/source.ts').useSourceStore());
  source.restore();
  const response = deferred();
  // Real registry store: package engine + quality-profile refresh are the owned
  // boundaries; everything else (policy, validation, applyPolicy, label) is production.
  const registry = loadProduction(readProduction('stores/source-registry.ts'), ['useSourceRegistryStore'], {
    reactive: Vue.reactive, uni,
    musicApi: {
      sourceRegistry: () => response.promise,
      playConfigEpoch: () => 0,
      highestQualityOf: () => '128',
    },
    ensureDataEngine: async () => true,
    sourceMetaRevision: () => 'owned-package',
    sourceMetaCurrent: rev => rev === 'owned-package',
    SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed',
    SOURCE_AUTH_CHANGED_EVENT: 'qt-source-auth-changed',
    ...sourcePolicyFixture(uni),
    sourcePlayLoginActive: () => false, sourceVipTierOf: () => 'none',
    cachedQualityProfileOf: () => null, clearQualityProfiles: () => {},
    fetchSourceQualityProfile: async () => null, PROFILE_MODE_OFFICIAL: 'official',
    setSourceDownloadQualityForNetwork: () => {}, setSourcePlayQualityForNetwork: () => {},
    sourceDownloadQualityForNetwork: () => '320', sourcePlayQualityForNetwork: () => '320',
    storeQualityProfile: () => {},
    NETWORK_KIND_WIFI: 'wifi', NETWORK_KIND_CELLULAR: 'cellular',
    usePlayerStore: () => ({ restore: () => {} }),
    useDownloadsStore: () => ({ downloadQuality: '320' }),
    useSourceStore: () => source,
  }, 'stores/source-registry.ts').useSourceRegistryStore();
  const b = await tvSettingsFixture({ boundaryOverrides: {
    'stores/source': { useSourceStore: () => source },
    'stores/source-registry': { useSourceRegistryStore: () => registry },
    'services/platform': undefined,
    'services/source-sheet': undefined,
    'services/toast': { qtShowToast: value => host.toastCalls.push(value) },
  } });
  await b.mount(COMPONENT, {}, true);
  return {
    b, source, registry, host, uni,
    respond: async result => { response.resolve(result); await drain(); await b.flush(); },
    label: () => textOf(b.byClass('switcher-text')[0]),
  };
}

await (async () => {
  const b = await fixture();
  try {
    assert.equal(b.label(), '选择音源', 'startup default wyy must show an actionable prompt before the registry arrives');
    await b.respond(pack([source('wyy', '网易云', '网易')]));
    assert.equal(b.label(), '网易云', 'real registry readiness reactively replaces the prompt with the package label');
    await b.b.dispatch(b.b.byClass('switcher')[0]);
    assert.deepEqual(b.b.plain(b.b.action.qtActionSheetState().items.value), ['网易云']);
    assert.equal(b.b.action.qtActionSheetState().selectedIndex.value, 0, 'current platform is preselected');
    await b.b.dispatch(b.b.option('网易云'));
    await drain();
    assert.equal(b.host.writes.length, 0, 'reselecting the current source neither re-persists nor re-emits');
  } finally { await b.b.close(); }
})();
console.log('PASS source switcher startup prompt and reactive registry label');

await (async () => {
  const b = await fixture({ current: 'retired-source' });
  try {
    assert.equal(b.label(), '选择音源', 'a stored source missing from the catalog is a prompt, not an unknown platform');
    await b.respond(pack([source('kg', '酷狗', '酷狗')]));
    assert.equal(b.source.current, 'kg', 'real registry validation corrects the stale stored source');
    assert.equal(b.label(), '酷狗');
    assert.deepEqual(b.host.writes, [['qt-source', 'kg']], 'validation persists exactly once');
    await b.b.dispatch(b.b.byClass('switcher')[0]);
    assert.equal(b.b.action.qtActionSheetState().selectedIndex.value, 0);
    await b.b.dispatch(b.b.option('酷狗'));
    await drain();
    assert.equal(b.host.writes.length, 1, 'picking the already-validated source adds no second write');
  } finally { await b.b.close(); }
})();
console.log('PASS source switcher stale stored source and single validation write');

await (async () => {
  const b = await fixture({ current: 'local' });
  try {
    assert.equal(b.label(), '本地', 'local playback keeps its name even with no data package');
    await b.respond(null);
    await b.b.dispatch(b.b.byClass('switcher')[0]);
    await drain();
    assert.equal(b.host.toastCalls.length, 1, 'empty registry click keeps the existing data-pack guidance');
    assert.equal(b.label(), '本地', 'guidance does not erase the active local identity');
    assert.equal(b.host.writes.length, 0, 'no-pack guidance never mutates stored identity');
  } finally { await b.b.close(); }
})();
console.log('PASS source switcher local identity and empty pack guidance');

console.log('Source switcher: 3 full-production rendered behavior groups passed');
