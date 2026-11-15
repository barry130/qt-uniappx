// Agreed seam: execute the complete production source-control UVue script,
// real recommendation choice/strict registry capability and global action-sheet service.
// Only owned Vue lifecycle, source identity/package/engine and storage/event boundaries
// are synthetic. Static QtOption/host assertions supplement, never replace these tests.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readProduction, loadProduction, ownedHost, choiceFixture, environmentFixture, plain, deferred, drain, noop, track } from './check-account-radio.mjs';
import { accountRecommendationFixture, drain as drainNative } from './check-account-recommendations.mjs';

const CONTROL = 'uni_modules/qt-ui/components/qt-recommendation-source-control/qt-recommendation-source-control.uvue';
const ref = value => ({ value });
const computed = getter => ({ get value() { return getter(); } });
export function controlFixture({ kind = 'daily' } = {}) {
  const host = ownedHost(), choices = choiceFixture(host), env = environmentFixture(host);
  const hooks = { mounted: [], unmounted: [], unload: [] }, watchers = [], receipts = [], toasts = [], routes = [], shown = [];
  const props = { kind };
  for (const source of env.registry.catalog) Object.assign(source, { name: ({ wyy: '网易云', kg: '酷狗', qq: 'QQ音乐' })[source.id] });
  const selection = loadProduction(readProduction('uni_modules/qt-ui/composables/selection.ts'), ['qtSelectionIndex'], {}, 'composables/selection.ts');
  const sheet = loadProduction(readProduction('services/action-sheet.ts'), [
    'qtShowActionSheet', 'qtActionSheetState', 'qtActionSheetPick', 'qtActionSheetCancel',
  ], { ref, ...selection }, 'services/action-sheet.ts');
  const platform = loadProduction(readProduction('services/platform.ts'), ['platformLabel'], {
    useSourceRegistryStore: () => env.registry, PODCAST_PLATFORM: 'owned-podcast',
  }, 'services/platform.ts');
  host.uni.navigateTo = options => routes.push(options.url);
  const vue = {
    ref, computed, watch: (get, fn) => watchers.push({ get, fn, previous: get() }),
    defineProps: () => props, defineEmits: () => (...args) => receipts.push(args),
    onMounted: fn => hooks.mounted.push(fn), onBeforeUnmount: fn => hooks.unmounted.push(fn), onUnload: fn => hooks.unload.push(fn),
  };
  const control = loadProduction(readProduction(CONTROL), ['open', 'refresh', 'dispose', 'sourceLabel', 'sourceHint'], {
    ...vue, ...choices, ...platform, uni: host.uni, useSourceRegistryStore: () => env.registry,
    useQtLayout: () => ({ isWide: false }), useThemeStore: () => ({ skin: { iconMuted: '#666' } }),
    readSourceAuthEntries: () => env.state.loggedIn ? ['wyy', 'kg'].map(source => ({ source, account: { user: { id: env.state.accountId, nickname: env.state.nickname } } })) : [],
    readSourceAuthTogglesFor: () => ({ useMeta: env.state.useMeta, usePlay: env.state.usePlay }),
    SOURCE_AUTH_CHANGED_EVENT: 'qt-source-auth-changed', SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed', SOURCE_POLICY_CHANGED_EVENT: 'qt-source-policy-changed',
    qtActionSheetState: sheet.qtActionSheetState, qtActionSheetCancel: sheet.qtActionSheetCancel,
    qtShowActionSheet: options => { shown.push(plain(options)); return sheet.qtShowActionSheet(options); },
    qtShowToast: options => toasts.push(options),
  }, CONTROL);
  for (const mount of hooks.mounted) mount();
  const flushWatch = () => { for (const watcher of watchers) { const next = watcher.get(); if (next !== watcher.previous) { const previous = watcher.previous; watcher.previous = next; watcher.fn(next, previous); } } };
  return { ...host, ...env, choices, control, props, sheet, hooks, shown, receipts, toasts, routes, flushWatch,
    select: async index => { sheet.qtActionSheetPick(index); await drain(); },
    dispose: () => { for (const fn of hooks.unmounted) fn(); },
  };
}
// Additional seam: the COMPLETE daily-recommend page script. Its cache/generator
// API may be delayed at the boundary, while real core auth/context, registry,
// source-engine and Pinia choice lifetimes execute behind the page guards.
async function dailyPageFixture() {
  const core = accountRecommendationFixture(); await core.ready(); await core.saveAccount();
  core.choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' });
  const host = ownedHost(), hooks = { mounted: [], dispose: [] }, cache = [], generated = [], toasts = [];
  const layout = { isWide: false };
  const page = loadProduction(readProduction('pages/daily-recommend/index.uvue'), [
    'load', 'generate', 'result', 'loading', 'errorText', 'progressText', 'songs', 'disposeRecommendationPage',
  ], {
    ...host.timers, ...core.choice, ...core.service, ...core.auth, ref, computed, watch: noop, uni: core.uni,
    SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed', SOURCE_POLICY_CHANGED_EVENT: core.policy.SOURCE_POLICY_CHANGED_EVENT,
    onMounted: fn => hooks.mounted.push(fn), onBeforeUnmount: fn => hooks.dispose.push(fn), onUnmounted: fn => hooks.dispose.push(fn), onUnload: fn => hooks.dispose.push(fn),
    usePlayerStore: () => ({ history: [], likedSongs: [], localPlaylists: [], savedPlaylists: [], pickerPlaylists: () => [], play: noop, playSingle: noop }),
    useThemeStore: () => ({ skin: {} }), useQtLayout: () => layout, qtContentWidth: () => 360,
    detailLayoutMetrics: () => ({ split: false, asideWidthPx: 0, listWidthPx: 360, coverSizePx: 112 }), qtRpx: value => value / 2,
    fontScale: { scale: 1 }, qtFontPx: () => '', qtFontDual: () => '', platformShort: source => source, platformColor: () => '#000', isQtAdmin: () => false,
    useSongSheet: () => ({ sheetVisible: ref(false), sheetActions: ref([]), openSheet: noop, onSheetSelect: noop, sheetTitle: ref('') }),
    useTrackSearch: get => ({ query: ref(''), visible: computed(get), filtering: ref(false), onInput: noop, clear: noop }),
    useBatchSelect: () => ({ selecting: ref(false), count: ref(0), enter: noop, exit: noop, isSelected: () => false, toggle: noop, toggleAll: noop, keys: ref([]) }),
    useBatchActions: () => ({}), qtSongKey: song => `${song.platform}:${song.id}`,
    DAILY_HISTORY_DAYS: 30, DAILY_MODE_LABEL: { rule: '规则' }, DAILY_STYLE_SEED_MAX: 3, DAILY_TASTE_LABEL: { heart: '心动' }, DAILY_TASTE_ORDER: ['heart'],
    readMode: () => 'rule', readTaste: () => 'heart', saveMode: noop, saveTaste: noop, saveStyleSeeds: noop, clearTodayResult: async () => {},
    loadTodayResult: () => { const d = deferred(); cache.push(d); return d.promise; },
    generateDailyRecommend: options => { const d = deferred(); generated.push({ options, ...d }); return d.promise; },
    qtShowToast: value => toasts.push(value),
  }, 'pages/daily-recommend/index.uvue');
  for (const mount of hooks.mounted) mount(); await drainNative(); assert.equal(cache.length, 1, 'the actual mounted page must request its initial cache');
  const resultFor = (ids, notice = '') => ({ date: '2026-11-12', origin: 'account', sourceId: 'wyy', accountId: 'A', accountNickname: '用户A',
    generatedAt: core.state.now, title: 'Owned official fixture', summary: '', profileText: '', mode: 'rule', requested: 'local', notice,
    items: ids.map(id => ({ song: track(id), reason: 'Owned official fixture' })), styleOptions: [], styleLanes: [] });
  async function mutate(type) {
    if (type === 'choice-ABA') { core.choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'kg' }); core.choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' }); }
    else if (type === 'relogin') await core.saveAccount('wyy', 'A');
    else if (type === 'meta-ABA') await Promise.all([core.auth.setSourceAuthToggle('wyy', 'meta', false), core.auth.setSourceAuthToggle('wyy', 'meta', true)]);
    else if (type === 'silent-context') core.state.pack = { ...core.state.pack, updatedAt: core.state.pack.updatedAt + 1 };
    else throw new Error(`unknown page mutation ${type}`);
    await drainNative();
  }
  return { core, page, cache, generated, toasts, resultFor, mutate, ids: () => Array.from(page.songs.value, song => song.id),
    resolveCache: async (index, ids) => { cache[index].resolve(resultFor(ids)); await drainNative(); },
    dispose: () => { for (const fn of hooks.dispose) fn(); } };
}
let groups = 0;
const failures = [];
async function check(label, run) {
  try { await run(); groups++; console.log('PASS ' + label); }
  catch (error) { failures.push({ label, error }); console.error('RED ' + label + ': ' + error.message); }
}
async function open(b) { const pending = b.control.open(); await drain(); assert.equal(b.shown.length > 0, true); return { pending }; }
export async function runSourceControlChecks() {
  await check('SC-01 daily defaults app, advertises strict WYY/KG daily and excludes unsupported sources', async () => {
    const b = controlFixture(); const { pending } = await open(b);
    assert.deepEqual(b.shown[0].itemList, ['应用算法', '网易云 · Fixture A', '酷狗 · Fixture A', '音源平台管理']);
    assert.equal(b.shown[0].selectedIndex, 0); assert.equal(b.shown[0].title, '每日推荐来源');
    b.sheet.qtActionSheetCancel(); await pending; assert.equal(b.writes.length, 0); b.dispose();
  });
  await check('SC-02 FM advertises every source whose package declares fm, mirroring the desktop four-source map', async () => {
    const b = controlFixture({ kind: 'fm' }); const { pending } = await open(b);
    assert.deepEqual(b.shown[0].itemList, ['应用算法', '网易云 · Fixture A', '酷狗 · Fixture A', '音源平台管理']);
    assert.equal(b.shown[0].selectedIndex, 0); b.sheet.qtActionSheetCancel(); await pending; b.dispose();
  });
  await check('SC-03 daily/fm choices are isolated and choosing a snapshot does not enable auth', async () => {
    const b = controlFixture(); b.state.useMeta = false; b.state.usePlay = false;
    const { pending } = await open(b); await b.select(2); await pending;
    assert.deepEqual(plain(b.choices.readRecommendationChoice('daily')), { origin: 'account', sourceId: 'kg' });
    assert.deepEqual(plain(b.choices.readRecommendationChoice('fm')), { origin: 'app', sourceId: '' });
    assert.equal(b.state.useMeta, false); assert.equal(b.state.usePlay, false); assert.equal(b.calls.length, 0);
    assert.deepEqual(b.receipts, [['change', 'daily']]); assert.equal(b.writes.length, 1); b.dispose();
  });
  await check('SC-04 unknown stored ID is unselected (-1), never silently mapped to app/first account', async () => {
    const b = controlFixture(); b.choices.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'unknown' });
    const { pending } = await open(b); assert.equal(b.shown[0].selectedIndex, -1);
    b.sheet.qtActionSheetCancel(); await pending; assert.equal(b.receipts.length, 0); b.dispose();
  });
  for (const index of [-1, 0]) await check(`SC-05 cancel/current index=${index} is no write/no change/no navigation`, async () => {
    const b = controlFixture(); const { pending } = await open(b); await b.select(index); await pending;
    assert.equal(b.writes.length, 0); assert.equal(b.receipts.length, 0); assert.equal(b.routes.length, 0); b.dispose();
  });
  await check('SC-06 capabilities are strict booleans and fail closed for stale/old/disabled packages', async () => {
    const b = controlFixture(); b.registry.catalog = b.registry.sources = [
      { id: 'numeric', name: 'Numeric', accountRecommendations: { daily: 1, fm: 1 } },
      { id: 'string', name: 'String', accountRecommendations: { daily: 'true', fm: 'true' } },
      { id: 'old', name: 'Old' }, { id: 'wyy', name: '网易云', accountRecommendations: { daily: true, fm: true } },
    ];
    b.policy.toggleSource('wyy', ['numeric', 'string', 'old', 'wyy']);
    const { pending } = await open(b); assert.deepEqual(b.shown[0].itemList, ['应用算法', '音源平台管理']);
    b.sheet.qtActionSheetCancel(); await pending; b.dispose();
  });
  for (const mutation of ['account', 'logout', 'relogin', 'meta', 'pack', 'policy', 'choice']) await check(`SC-07 ${mutation} while open cancels old snapshot and cannot write/navigate`, async () => {
    const b = controlFixture(); const { pending } = await open(b); const writes = b.writes.length;
    if (mutation === 'choice') b.choices.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' });
    else b.change(mutation);
    await drain(); assert.equal(b.sheet.qtActionSheetState().visible.value, false, 'stale owned sheet must close');
    await b.select(1); await pending; assert.equal(b.receipts.length, 0); assert.equal(b.routes.length, 0);
    assert.equal(b.writes.length, writes + (mutation === 'choice' || mutation === 'policy' ? 1 : 0)); b.dispose();
  });
  await check('SC-08 source registry generation or feature changes while open cancel the snapshot', async () => {
    const b = controlFixture(); const { pending } = await open(b); b.registry.generation++; b.flushWatch();
    await pending; assert.equal(b.sheet.qtActionSheetState().visible.value, false); assert.equal(b.writes.length, 0);
    const again = b.control.open(); await drain(); b.props.kind = 'fm'; b.flushWatch(); await again;
    assert.equal(b.receipts.length, 0); assert.equal(b.routes.length, 0); b.dispose();
  });
  for (const index of [1, 3]) await check(`SC-09 unmount after pick but before continuation blocks late ${index === 1 ? 'write' : 'navigation'}`, async () => {
    const b = controlFixture(); const { pending } = await open(b); b.sheet.qtActionSheetPick(index); b.dispose(); await pending;
    assert.equal(b.writes.length, 0); assert.equal(b.receipts.length, 0); assert.equal(b.routes.length, 0);
    assert.equal([...b.listeners.values()].reduce((sum, fns) => sum + fns.size, 0), 0);
  });
  await check('SC-10 disposing an old control cannot close a newer global sheet owned by another feature', async () => {
    const b = controlFixture(); const { pending } = await open(b);
    const foreign = b.sheet.qtShowActionSheet({ title: 'Other feature', itemList: ['Other'], selectedIndex: -1 });
    b.dispose(); await pending;
    assert.equal(b.sheet.qtActionSheetState().visible.value, true); assert.equal(b.sheet.qtActionSheetState().title.value, 'Other feature');
    assert.equal(b.writes.length, 0); b.sheet.qtActionSheetCancel(); await foreign;
  });
  for (const index of [1, 3]) await check(`SC-11 a global owner replacing an already picked request blocks late ${index === 1 ? 'write' : 'navigation'}`, async () => {
    const b = controlFixture(); const { pending } = await open(b); b.sheet.qtActionSheetPick(index);
    const foreign = b.sheet.qtShowActionSheet({ title: 'Other feature', itemList: ['Other'] }); await pending;
    assert.equal(b.writes.length, 0, 'a superseded global request cannot save a late pick');
    assert.equal(b.routes.length, 0, 'a superseded global request cannot navigate');
    assert.equal(b.sheet.qtActionSheetState().visible.value, true); b.dispose(); b.sheet.qtActionSheetCancel(); await foreign;
  });
  await check('SC-12 unmount during registry ensure cannot open a late sheet', async () => {
    const b = controlFixture(), gate = deferred(); b.registry.ensure = () => gate.promise;
    const pending = b.control.open(); b.dispose(); gate.resolve(); await pending;
    assert.equal(b.shown.length, 0); assert.equal(b.writes.length, 0); assert.equal(b.routes.length, 0);
  });
  await check('SC-13 account environment changing during registry ensure cannot reopen stale UI', async () => {
    const b = controlFixture(), gate = deferred(); b.registry.ensure = () => gate.promise;
    const pending = b.control.open(); b.change('logout'); gate.resolve(); await drain();
    assert.equal(b.shown.length, 0, 'an account change invalidates the pending open even before it owns a sheet');
    b.sheet.qtActionSheetCancel(); await pending; b.dispose();
  });
  await check('SC-14 source labels/hints expose app, missing capability, login and disabled meta without enabling anything', async () => {
    const b = controlFixture(); assert.match(b.control.sourceLabel.value, /应用算法/);
    b.choices.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' }); assert.match(b.control.sourceHint.value, /官方/);
    b.state.useMeta = false; b.control.refresh(); assert.match(b.control.sourceHint.value, /授权已关闭/);
    b.state.loggedIn = false; b.control.refresh(); assert.match(b.control.sourceHint.value, /先登录/);
    b.choices.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'unknown' }); assert.match(b.control.sourceHint.value, /不支持/);
    assert.equal(b.calls.length, 0); b.dispose();
  });
  await check('SC-15 QtOption business trigger and the existing global sheet, not a copied sheet shell (supplementary)', () => {
    const source = readProduction(CONTROL), template = source.match(/<template>([\s\S]*?)<\/template>/)[1];
    assert.match(template, /<QtOption\b[^>]*@select="open"/); assert.doesNotMatch(source, /<QtSheet\b|<qt-sheet\b|<QtActionSheetHost\b|<qt-action-sheet-host\b/);
    assert.match(source, /from "@\/services\/action-sheet"/);
  });
  for (const kind of ['daily-recommend', 'radio']) await check(`SC-16 ${kind} page keeps a source trigger outside loading/error/empty branches (supplementary)`, () => {
    const source = readProduction(`pages/${kind}/index.uvue`);
    const template = source.slice(0, source.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '');
    const stack = [], controls = [];
    for (const match of template.matchAll(/<\/?([A-Za-z][\w-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/g)) {
      const tag = match[0], name = match[1];
      if (tag.startsWith('</')) { const index = stack.map(item => item.name).lastIndexOf(name); if (index >= 0) stack.splice(index); continue; }
      if (name === 'QtRecommendationSourceControl') controls.push({ tag, ancestors: stack.slice() });
      if (!tag.endsWith('/>')) stack.push({ name, tag });
    }
    assert.ok(controls.length > 0, 'page must use the shared source control');
    // Paired compact/wide placements are valid: prove one is available in each
    // layout, while every other conditional (loading/error/empty/auth) stays forbidden.
    const visibleInLayout = (control, detailSplit) => [control.tag, ...control.ancestors.map(item => item.tag)].every(tag => {
      if (/\bv-(?:else-if|else)(?:\s|=|>)/.test(tag)) return false;
      return [...tag.matchAll(/\bv-(?:if|show)="([^"]*)"/g)].every(([, condition]) => condition.trim() === 'detailSplit' ? detailSplit : condition.trim() === '!detailSplit' ? !detailSplit : false);
    });
    for (const detailSplit of [false, true]) assert.ok(controls.some(control => visibleInLayout(control, detailSplit)),
      `a trigger must remain mounted for detailSplit=${detailSplit}, independent of loading/error/empty/auth state`);
    assert.ok(controls.every(control => control.tag.includes(`kind="${kind === 'radio' ? 'fm' : 'daily'}"`)));
  });
  await check('SC-17 first registry arrival while ensure waits keeps a valid first-open intent', async () => {
    const b = controlFixture(), gate = deferred(); b.registry.ensure = () => gate.promise;
    const pending = b.control.open(); b.registry.generation++; b.flushWatch(); gate.resolve(); await drain();
    assert.equal(b.shown.length, 1); assert.equal(b.sheet.qtActionSheetState().visible.value, true);
    b.sheet.qtActionSheetCancel(); await pending; assert.equal(b.writes.length, 0); b.dispose();
  });
  await check('SC-18 current account selection is no-write, while managing accounts navigates once without changing selection', async () => {
    const b = controlFixture(); b.choices.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' }); const before = b.writes.length;
    const { pending } = await open(b); assert.equal(b.shown[0].selectedIndex, 1); await b.select(1); await pending;
    assert.equal(b.writes.length, before); assert.equal(b.receipts.length, 0);
    const manage = b.control.open(); await drain(); await b.select(3); await manage;
    assert.deepEqual(b.routes, ['/pages/source-auth/index']); assert.equal(b.writes.length, before); b.dispose();
  });
  await check('SC-19 repeat open invalidates its old promise without canceling or unlocking the new request', async () => {
    const b = controlFixture(); const first = b.control.open(); await drain(); const second = b.control.open(); await drain(); await first;
    assert.equal(b.shown.length, 2); assert.equal(b.sheet.qtActionSheetState().visible.value, true); assert.equal(b.writes.length, 0);
    await b.select(1); await second; assert.equal(b.writes.length, 1); assert.deepEqual(b.receipts, [['change', 'daily']]); b.dispose();
  });
  for (const mutation of ['choice', 'meta']) await check(`SC-20 ${mutation} during registry ensure invalidates the pending open, including ABA`, async () => {
    const b = controlFixture(), gate = deferred(); b.registry.ensure = () => gate.promise; const pending = b.control.open();
    if (mutation === 'choice') { b.choices.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' }); b.choices.writeRecommendationChoice('daily', { origin: 'app', sourceId: '' }); }
    else { b.change('meta'); b.change('meta'); }
    gate.resolve(); await pending; assert.equal(b.shown.length, 0); assert.equal(b.receipts.length, 0); assert.equal(b.routes.length, 0); b.dispose();
  });
  const beforePage = groups;
  await check('PG-01 complete page script publishes a current official cache in original order', async () => {
    const b = await dailyPageFixture(); await b.resolveCache(0, ['z', 'a', 'z']);
    assert.deepEqual(b.ids(), ['z', 'a', 'z']); assert.equal(b.page.loading.value, false); assert.equal(b.generated.length, 0); b.dispose();
  });
  for (const mutation of ['choice-ABA', 'relogin', 'meta-ABA']) await check(`PG-02 pending cache ${mutation} cannot publish old data or unlock the newer load`, async () => {
    const b = await dailyPageFixture(); await b.mutate(mutation); assert.ok(b.cache.length >= 2, 'a fresh authorized cache load actually starts');
    await b.resolveCache(0, ['stale']); assert.deepEqual(b.ids(), []); assert.equal(b.page.result.value, null); assert.equal(b.page.loading.value, true);
    await b.resolveCache(b.cache.length - 1, ['fresh']); assert.deepEqual(b.ids(), ['fresh']); assert.equal(b.page.loading.value, false); b.dispose();
  });
  await check('PG-03 silent context invalidation while cache awaits drops items and shows a safe error', async () => {
    const b = await dailyPageFixture(); await b.mutate('silent-context'); await b.resolveCache(0, ['stale']);
    assert.deepEqual(b.ids(), []); assert.equal(b.page.result.value, null); assert.equal(b.page.loading.value, false); assert.notEqual(b.page.errorText.value, ''); b.dispose();
  });
  await check('PG-04 generator progress and reply cannot publish after silent context invalidation', async () => {
    const b = await dailyPageFixture(); await b.resolveCache(0, ['seed']); const pending = b.page.generate(true, null); await drainNative();
    assert.equal(b.generated.length, 1); const request = b.generated[0]; request.options.onProgress('current progress');
    assert.equal(b.page.progressText.value, 'current progress'); await b.mutate('silent-context'); request.options.onProgress('stale progress');
    assert.notEqual(b.page.progressText.value, 'stale progress'); request.resolve(b.resultFor(['stale'], 'late toast')); await pending;
    assert.deepEqual(b.ids(), []); assert.equal(b.page.result.value, null); assert.notEqual(b.page.errorText.value, ''); assert.equal(b.toasts.length, 0); b.dispose();
  });
  await check('PG-05 play-only toggles and FM-only choices never reload or clear a daily account snapshot', async () => {
    const b = await dailyPageFixture(); const before = b.cache.length;
    await b.core.auth.setSourceAuthToggle('wyy', 'play', true); await b.core.auth.setSourceAuthToggle('wyy', 'play', false);
    b.core.choice.writeRecommendationChoice('fm', { origin: 'account', sourceId: 'wyy' }); b.core.choice.writeRecommendationChoice('fm', { origin: 'app', sourceId: '' }); await drainNative();
    assert.equal(b.cache.length, before); await b.resolveCache(0, ['current']); assert.deepEqual(b.ids(), ['current']);
    assert.equal(b.generated.length, 0); assert.equal(b.page.errorText.value, ''); b.dispose();
  });
  await check('PG-06 unmount invalidates a pending cache and unsubscribes the page without late publication', async () => {
    const b = await dailyPageFixture(); b.dispose(); await b.resolveCache(0, ['stale']);
    assert.equal(b.page.result.value, null); assert.deepEqual(b.ids(), []); const before = b.cache.length;
    await b.core.saveAccount('wyy', 'A'); assert.equal(b.cache.length, before); assert.equal(b.generated.length, 0);
  });
  await check('PG-07 choice ABA during generation cannot overwrite the new cache, progress or loading state', async () => {
    const b = await dailyPageFixture(); await b.resolveCache(0, ['seed']); const pending = b.page.generate(true, null); await drainNative();
    const request = b.generated[0]; await b.mutate('choice-ABA'); request.options.onProgress('late progress'); request.resolve(b.resultFor(['stale'])); await pending;
    assert.equal(b.page.result.value, null); assert.notEqual(b.page.progressText.value, 'late progress'); assert.equal(b.page.loading.value, true);
    await b.resolveCache(b.cache.length - 1, ['fresh']); assert.deepEqual(b.ids(), ['fresh']); b.dispose();
  });
  await check('PG-08 unmount during generation blocks the late reply, progress and toast', async () => {
    const b = await dailyPageFixture(); await b.resolveCache(0, ['seed']); const pending = b.page.generate(true, null); await drainNative();
    const request = b.generated[0]; b.dispose(); request.options.onProgress('late progress'); request.resolve(b.resultFor(['stale'], 'late toast')); await pending;
    assert.equal(b.page.result.value, null); assert.deepEqual(b.ids(), []); assert.notEqual(b.page.progressText.value, 'late progress'); assert.equal(b.toasts.length, 0);
  });
  console.log(`recommendation source control: ${groups} groups passed, ${failures.length} failed (${groups - beforePage} complete daily-page groups; actual script/global service; Native/render NOT RUN)`);
  if (failures.length) throw new AggregateError(failures.map(({ label, error }) => new Error(label, { cause: error })), 'Production source-control gates failed');
  return groups;
}
if (process.argv[1] && fileURLToPath(import.meta.url).replaceAll('\\', '/').toLowerCase() === process.argv[1].replaceAll('\\', '/').toLowerCase()) await runSourceControlChecks();
