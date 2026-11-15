// Execute production lifecycle owners with controllable native replies, promises,
// nextTick and timers. Retained native references deliberately throw after teardown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { tvScriptFixture } from './tv-script-fixture.mjs';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const ref = value => ({ value });
const computed = fn => ({ get value() { return fn(); } });
const noop = () => {};
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function runtime() {
  let nextId = 0, now = 0;
  const timers = new Map(), queued = new Map(), ticks = [];
  const hooks = { before: [], unload: [], mounted: [], unmount: [] };
  const scope = {
    ref, computed, watch: () => noop,
    nextTick: fn => ticks.push(fn),
    onBeforeUnmount: fn => hooks.before.push(fn),
    onUnmounted: fn => hooks.unmount.push(fn),
    onUnload: fn => hooks.unload.push(fn),
    onMounted: fn => hooks.mounted.push(fn),
    setTimeout: (fn, delay) => {
      const id = ++nextId, task = { fn, at: now + delay };
      timers.set(id, task); queued.set(id, task);
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => {
      const id = scope.setTimeout(fn, delay);
      timers.get(id).repeat = delay;
      return id;
    },
    clearInterval: id => timers.delete(id),
  };
  function fire(id, canceled = false) {
    const task = (canceled ? queued : timers).get(id);
    if (task == null) return;
    now = Math.max(now, task.at);
    if (task.repeat && timers.has(id)) task.at = now + task.repeat;
    else timers.delete(id);
    task.fn();
  }
  return {
    scope, hooks, timers, queued, fire,
    mount() { hooks.mounted.forEach(fn => fn()); },
    close() { hooks.unload.forEach(fn => fn()); hooks.before.forEach(fn => fn()); hooks.unmount.forEach(fn => fn()); },
    flushTicks() { ticks.splice(0).forEach(fn => fn()); },
    async advance(ms) {
      const until = now + ms;
      for (let i = 0; i < 200; i++) {
        const next = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = until; await drain(); return; }
        fire(next[0]); await drain();
      }
      throw new Error('timer loop did not settle');
    },
  };
}

// Select complete production declarations/functions, plus their real teardown
// registrations. Keep application/network boundaries explicit in each fixture.
function load(file, names, scope, extra = () => false) {
  const raw = read(file);
  const source = raw.includes('<script') ? raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1] : raw;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = new Set(names), found = new Set();
  const nodes = ast.statements.filter(node => {
    if (ts.isVariableStatement(node)) {
      const matches = node.declarationList.declarations.filter(item => wanted.has(item.name.getText(ast)));
      matches.forEach(item => found.add(item.name.getText(ast)));
      if (matches.length) return true;
    }
    if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) {
      found.add(node.name.text); return true;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (['onBeforeUnmount', 'onUnload', 'onUnmounted'].includes(call.expression.getText(ast))) return true;
    }
    return extra(node.getText(ast), node);
  });
  names.forEach(name => assert.ok(found.has(name), `${file}: actual ${name} declaration exists`));
  const code = ts.transpileModule(nodes.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code + '\n;({' + names.map(name => `get ${name}(){return ${name}}`).join(',') + '})',
    { ...scope, exports: {} }, { filename: file });
}

let passed = 0;
async function check(label, fn) { await fn(); console.log('PASS ' + label); passed++; }

await check('reveal cancellation invalidates work still waiting in nextTick and already queued timers', async () => {
  const h = runtime();
  const api = load('uni_modules/qt-ui/composables/use-qt-reveal.ts',
    ['QT_REVEAL_DURATION_MS', 'QT_REVEAL_STEP_MS', 'QT_REVEAL_LEAD_MS', 'QT_REVEAL_ALL', 'QT_REVEAL_GUARD_MS', 'useQtReveal'], h.scope).useQtReveal();
  let done = 0;
  api.startReveal(2, () => done++);
  api.finishReveal();
  h.flushTicks();
  assert.equal(h.timers.size, 0, 'finish before nextTick must not re-arm the reveal');
  api.startReveal(2, () => done++);
  h.flushTicks();
  const old = [...h.timers.keys()];
  await h.advance(32);
  api.resetReveal();
  old.forEach(id => h.fire(id, true));
  assert.equal(api.revealedCount.value, 0);
  assert.equal(done, 0);
  api.startReveal(2, () => done++);
  h.close();
  h.flushTicks();
  assert.equal(h.timers.size, 0);
  assert.equal(done, 0);
});

await check('replacement reveal completes only the latest request while live items still become visible', async () => {
  const h = runtime();
  const api = load('uni_modules/qt-ui/composables/use-qt-reveal.ts',
    ['QT_REVEAL_DURATION_MS', 'QT_REVEAL_STEP_MS', 'QT_REVEAL_LEAD_MS', 'QT_REVEAL_ALL', 'QT_REVEAL_GUARD_MS', 'useQtReveal'], h.scope).useQtReveal();
  let old = 0, current = 0;
  api.startReveal(8, () => old++);
  api.startReveal(2, () => current++);
  h.flushTicks();
  await h.advance(1500);
  assert.equal(api.revealing.value, false);
  assert.ok(api.revealedCount.value > 2);
  assert.deepEqual([old, current], [0, 1]);
  h.close();
});

await check('closing a hosted tool before 30ms prevents mounting its delayed content', async () => {
  const file = 'uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue';
  for (const closeEarly of [true, false]) {
    const h = runtime();
    const tv = tvScriptFixture({ uni: { getStorageSync: () => '', setStorageSync: noop } }, {
      ownerModules: true, getCurrentPages: () => [{ route: 'pages/home/index' }],
      vueOverrides: { inject: () => null, onUnmounted: h.scope.onUnmounted },
    });
    const api = load(file, ['hostedContentReady', 'hostedContentDisposed', 'hostedContentTimer',
      'capPageShown', 'capHostRoute', 'tvFrameActive', 'disposeTvFrame'], {
      ...tv, ...h.scope, hostedRoute: '/pages/search/index', currentRoute: ref('/pages/search/index'), frameElement: ref(null),
      frameAlive: true, chipMeasureGeneration: 0, chipMeasureTimer: 0,
      paneCapToken: ref(0), qtClearContentWidthCap: noop,
    }, text => text.startsWith('if (hostedRoute.length > 0)'));
    const id = [...h.timers.keys()][0];
    if (closeEarly) { h.close(); h.fire(id, true); }
    else await h.advance(30);
    assert.equal(api.hostedContentReady.value, !closeEarly);
    h.close();
    assert.equal(h.timers.size, 0);
  }
});

await check('skeleton retries cannot measure or restart a native animation after hide/unmount', async () => {
  const h = runtime(), props = { visible: true, duration: 1500 };
  let dead = false, measurements = 0, animations = 0, cancels = 0, width = 0;
  const api = load('uni_modules/qt-ui/components/qt-skeleton-shine/qt-skeleton-shine.uvue',
    ['wrapRef', 'trackRef', 'anim', 'retryTimer', 'disposed', 'sweepGeneration', 'retryLeft', 'BAND_RATIO', 'periodMs', 'startSweep', 'stopSweep', 'scheduleSweep'],
    { ...h.scope, props, uni: { getWindowInfo: () => ({ pixelRatio: 1 }), getSystemInfoSync: () => ({ pixelRatio: 1 }) } });
  api.wrapRef.value = { getBoundingClientRect() { assert.equal(dead, false); measurements++; return { width, height: 100 }; } };
  api.trackRef.value = { animate() { assert.equal(dead, false); animations++; return { cancel() { cancels++; } }; } };
  api.scheduleSweep(); h.flushTicks();
  assert.equal(measurements, 1);
  const retry = [...h.timers.keys()][0];
  props.visible = false; api.scheduleSweep(); h.fire(retry, true);
  assert.equal(measurements, 1);
  props.visible = true; width = 200;
  api.scheduleSweep(); h.flushTicks();
  assert.equal(animations, 1);
  api.scheduleSweep();
  h.close(); dead = true; h.flushTicks(); h.fire(retry, true);
  assert.equal(animations, 1);
  assert.equal(cancels, 1);
  assert.equal(h.timers.size, 0);
});

for (const kind of ['loading', 'notice-bar']) {
  await check(`${kind}: deferred animation startup ignores a destroyed native element`, async () => {
    const h = runtime();
    let dead = false, animations = 0;
    const element = {
      getBoundingClientRect() { assert.equal(dead, false); return { left: animations ? 100 : 0 }; },
      animate() { assert.equal(dead, false); animations++; return { cancel: noop }; },
    };
    const names = kind == 'loading'
      ? ['imgRef', 'anim', 'disposed', 'startSpin']
      : ['viewportRef', 'trackRef', 'copyRef', 'anim', 'disposed', 'startMarquee', 'stopMarquee'];
    const api = load(`uni_modules/qt-ui/components/qt-${kind}/qt-${kind}.uvue`, names,
      { ...h.scope, props: { visible: true }, marquee: ref(true), logMsgErr: error => { throw error; } },
      text => text.startsWith('onMounted('));
    for (const name of names.filter(name => name.endsWith('Ref'))) api[name].value = element;
    h.mount(); h.close(); dead = true; h.flushTicks();
    assert.equal(animations, 0);
  });
}

for (const page of ['daily', 'daily-recommend', 'playlist']) {
  await check(`${page}: late first/nested measurement replies cannot query or write a removed page`, async () => {
    for (const afterFirst of [false, true]) {
      const h = runtime(), replies = [];
      const api = load(`pages/${page}/index.uvue`,
        ['headAlive', 'headTimers', 'headOffset', 'clearHeadTimers', 'disposeHeadMeasure', 'retryMeasureHead', 'measureHeadOffset',
          ...(page === 'daily-recommend' ? ['alive', 'loadSeq', 'running', 'displayContext', 'displayIdentity', 'disposeRecommendationPage'] : [])], {
          ...h.scope, layout: { isWide: false }, loading: ref(false), songs: ref([{}]), tracks: ref([{}]),
          uni: { $off: noop, createSelectorQuery: () => ({
            select() { return this; }, boundingClientRect(fn) { replies.push(fn); return this; }, exec: noop,
          }) },
          SOURCE_PACKS_CHANGED_EVENT: '', SOURCE_POLICY_CHANGED_EVENT: '', PLAYLIST_FOLLOW_CHANGED: '',
          SOURCE_AUTH_CHANGED_EVENT: 'qt-source-auth-changed', RECOMMENDATION_SOURCE_CHANGED_EVENT: 'qt-recommendation-source-changed',
          onPacksChanged: noop, onSourcePolicyChanged: noop, onFollowChanged: noop,
          onSourceAuthChanged: noop, onRecommendationSourceChanged: noop,
          followSheetVisible: ref(false), loadSeq: 0, alive: true,
        });
      api.measureHeadOffset(0);
      assert.equal(replies.length, 1);
      if (afterFirst) { replies[0]({ top: 10 }); assert.equal(replies.length, 2); }
      h.close();
      replies.at(-1)({ top: 110, height: 30 });
      assert.equal(replies.length, afterFirst ? 2 : 1);
      assert.equal(api.headOffset.value, -1);
      assert.equal(h.timers.size, 0);
    }
  });
}

await check('desktop lyrics: all four late track replies neither write geometry nor restart retries', async () => {
  const functions = ['measureSizeTrack', 'measureWidthTrack', 'measureStrokeTrack', 'measureBgOpTrack'];
  for (const rect of [null, { left: 20, width: 200 }]) {
    const h = runtime(), replies = [], widths = [ref(0), ref(0), ref(0), ref(0)];
    const api = load('pages/desktop-lyric/index.uvue',
      ['measureAlive', 'measureRetryTimers', 'disposeMeasurements', ...functions], {
        ...h.scope, sizeWidth: widths[0], widthWidth: widths[1], strokeWidth: widths[2], bgOpWidth: widths[3],
        sizeLeft: 0, widthLeft: 0, strokeLeft: 0, bgOpLeft: 0,
        uni: { createSelectorQuery: () => ({
          select() { return this; }, boundingClientRect(fn) { replies.push(fn); return this; }, exec: noop,
        }) },
      });
    functions.forEach(name => api[name](0));
    assert.equal(replies.length, 4);
    h.close(); replies.forEach(fn => fn(rect));
    assert.deepEqual(widths.map(value => value.value), [0, 0, 0, 0]);
    assert.equal(h.timers.size, 0);
  }
});

await check('playlist plaza: removed viewport and category panel cannot schedule or measure again', async () => {
  const h = runtime(), replies = [];
  const height = ref(0);
  let panelMeasures = 0;
  const api = load('pages/playlists/index.uvue',
    ['viewportAlive', 'viewportTimers', 'disposeViewport', 'measureViewport', 'measureCategoryPanel'], {
      ...h.scope, viewportHeight: height, measureFailReported: false, qtTrackError: noop,
      catPanelVisible: ref(true), pageHeight: ref(0), toolbarHeight: ref(0),
      pageElement: ref({ getBoundingClientRect() { panelMeasures++; return { top: 0, height: 10 }; }, querySelector: () => null }),
      uni: { $off: noop, createSelectorQuery: () => ({
        select() { return this; }, boundingClientRect(fn) { replies.push(fn); return this; }, exec: noop,
      }) },
      SOURCE_PACKS_CHANGED_EVENT: '', SOURCE_POLICY_CHANGED_EVENT: '', onPacksChanged: noop,
    });
  api.measureViewport(); api.measureCategoryPanel();
  assert.equal(panelMeasures, 1);
  h.close();
  replies[0](null); replies[0]({ height: 300 }); api.measureCategoryPanel();
  assert.equal(height.value, 0); assert.equal(panelMeasures, 1); assert.equal(h.timers.size, 0);
});

await check('listening stats: page teardown invalidates pending cover-height measurements', async () => {
  const h = runtime(), replies = [];
  const api = load('pages/stats/index.uvue',
    ['heroMeasureAlive', 'heroMeasureSeq', 'heroBgHeight', 'disposeHeroMeasure', 'measureHeroHeight'], {
      ...h.scope, heroCover: ref('cover'),
      uni: { createSelectorQuery: () => ({
        select() { return this; }, boundingClientRect(fn) { replies.push(fn); return this; }, exec: noop,
      }) },
    });
  api.measureHeroHeight();
  assert.equal(replies.length, 1);
  h.close(); replies[0]({ height: 300 }); api.measureHeroHeight();
  assert.equal(api.heroBgHeight.value, 0); assert.equal(replies.length, 1);
});

await check('player teardown cancels sheet/cover entry and rejects pending progress-track measurements', async () => {
  const h = runtime(), replies = [];
  const tvUi = tvScriptFixture({ uni: { getStorageSync: () => '', setStorageSync: noop } }, {
    vueOverrides: { inject: () => null, onUnmounted: h.scope.onUnmounted },
  });
  const api = load('pages/player/index.uvue', [
    'pageAlive', 'coverShown', 'sheetIn', 'sheetEnterTimer', 'coverEnterTimer', 'armSheet',
    'progTrackTimer', 'measureProgTrackRetry', 'disposePlayer', 'queueScrollSeq', 'queueOpeningIndex',
    'tvSeekEditing', 'tvSeekTrackKey', 'tvSeekPresentationKey', 'tvSeekMoveAt', 'cancelTvSeek', 'onTvSeekRemote', 'disposeTvSeekRemote',
    'tvLyricBrowsing', 'tvLyricSongKey', 'tvLyricDataGeneration', 'tvLyricRevealSeq', 'endTvLyricBrowsing', 'onTvLyricRemote', 'disposeTvLyricRemote',
    'pitchSheetVisible', 'pitchListenersActive', 'stopPitchListeners',
  ], {
    ...tvUi, ...h.scope, tv: tvUi.useQtTv(), player: { current: { id: 'live' } }, refreshProgFallback: noop,
    uni: { createSelectorQuery: () => ({
      select() { return this; }, boundingClientRect(fn) { replies.push(fn); return this; }, exec: noop,
    }) },
    pageVisible: ref(true), progWidth: ref(0), progLeft: 0,
    qualityRequestSeq: 0, lyricLoadGeneration: 0, lyricMeasureSeq: 0, offsetTrackSeq: 0, queueMeasureSeq: 0,
    queueMeasureTimer: null, lyricMeasureTimer: null, lyricCenterTimer: null, lyricOpacityTimer: null,
    lyricTimesTimer: null, offsetTrackTimer: null,
    removePlaybackMetadataListeners: noop, stopBitrateSettle: noop, stopDiscSpin: noop, stopKaraokeRaf: noop,
    watch: (_read, fn) => fn('next', 'old'),
  }, text => text.startsWith('watch((): string => (player.current == null'));
  api.armSheet();
  api.measureProgTrackRetry(0);
  const timers = [...h.timers.keys()];
  assert.equal(timers.length, 2);
  h.close();
  timers.forEach(id => h.fire(id, true));
  replies[0](null);
  assert.equal(api.pageAlive, false);
  assert.equal(api.coverShown.value, false);
  assert.equal(api.sheetIn.value, false);
  assert.equal(api.queueScrollSeq, 1, 'teardown invalidates delayed queue scroll commands');
  assert.equal(api.queueOpeningIndex, -1, 'teardown discards an unmeasured queue-open intent');
  assert.equal(h.timers.size, 0);
});

const formCases = [
  { path: 'pages/feedback/submit.uvue', fn: 'doSubmit', timer: 'submitNavTimer',
    refs: { submitting: false, title: 'Feedback', content: 'Details', contact: '', type: 0 },
    network: 'submitFeedback' },
  { path: 'pages/forget-password/index.uvue', fn: 'submit', timer: 'navBackTimer',
    refs: { email: 'test@example.invalid', code: '123456', password: 'abcdef', confirmPw: 'abcdef', loading: false },
    api: 'changePassword', functions: ['isEmail'], vars: ['timer'] },
  { path: 'pages/profile/edit/index.uvue', fn: 'submit', timer: 'editReloadTimer',
    refs: { nickname: 'Tester', email: 'test@example.invalid', password: '', avatar: '', loading: false },
    api: 'updateProfile', functions: ['isEmail'] },
  { path: 'pages/login/index.uvue', fn: 'submit', timer: 'loginNavTimer',
    refs: { mode: 'login', account: 'tester', password: 'abcdef', regUsername: '', regEmail: '', confirmPw: '', loading: false },
    api: 'login', functions: ['isEmail'] },
];
for (const form of formCases) {
  await check(`${form.path}: late success/error cannot create a timer or navigate after teardown`, async () => {
    for (const timing of ['late-success', 'late-error', 'queued', 'live']) {
      const h = runtime(), request = deferred();
      let navigation = 0, toasts = 0, calls = 0;
      const service = () => { calls++; return request.promise; };
      const user = { get: key => ({ id: 'fixture-user', nickname: 'Tester' })[key] ?? null };
      const api = load(form.path, ['formAlive', form.timer, 'disposeForm', form.fn, ...(form.functions ?? []), ...(form.vars ?? [])], {
        ...h.scope, ...Object.fromEntries(Object.entries(form.refs).map(([key, value]) => [key, ref(value)])),
        accountApi: { [form.api]: service }, [form.network ?? '_unused']: service,
        qtShowToast: () => toasts++,
        uni: { navigateBack: () => navigation++, reLaunch: () => navigation++, setStorageSync: noop, removeStorageSync: noop },
        getCurrentPages: () => [{}, {}], getCachedAvatar: () => '', DEFAULT_AVATAR: '',
        clearTokens: noop, clearCachedMe: noop, parseTokenResponse: () => ({ accessToken: 'fixture-token' }),
        getUserId: () => 'fixture-user', recoverPlaylistFollow: noop, prepareCollectionStorage: noop,
        adoptGuestCollections: noop, saveUserId: noop, saveTokens: noop, cacheUserAvatar: noop,
        persistUserRoles: noop, refreshMe: noop,
        usePlayerStore: () => ({ persistNow: noop, clearLocalLikeData: noop, syncLikedFromServerInBackground: noop }),
      });
      const running = api[form.fn]();
      assert.equal(calls, 1, 'fixture reaches the actual asynchronous request');
      if (timing.startsWith('late')) h.close();
      if (timing == 'late-error') request.reject(new Error('offline'));
      else request.resolve({ get: key => key == 'user' ? user : null });
      await running;
      if (timing.startsWith('late')) {
        assert.equal(h.timers.size, 0); assert.equal(toasts, 0); assert.equal(navigation, 0);
      } else {
        assert.equal(h.timers.size, 1); assert.equal(toasts, 1);
        const id = [...h.timers.keys()][0];
        if (timing == 'queued') { h.close(); h.fire(id, true); assert.equal(navigation, 0); }
        else { await h.advance(1000); assert.equal(navigation, 1); h.close(); }
      }
    }
  });
}

await check('password-reset email completion cannot start an interval after the form was removed', async () => {
  const h = runtime(), request = deferred();
  let calls = 0;
  const api = load('pages/forget-password/index.uvue',
    ['formAlive', 'timer', 'navBackTimer', 'disposeForm', 'sendCode', 'isEmail'], {
      ...h.scope, sending: ref(false), countdown: ref(0), email: ref('test@example.invalid'),
      accountApi: { sendEmail: () => { calls++; return request.promise; } }, qtShowToast: noop,
    });
  api.sendCode(); assert.equal(calls, 1);
  h.close(); request.resolve(); await drain();
  assert.equal(h.timers.size, 0);
});

await check('cache clearing completes its operation without scheduling a stale login redirect', async () => {
  const h = runtime(), request = deferred();
  let operations = 0, ui = 0;
  const api = load('pages/cache/index.uvue', ['pageAlive', 'clearDataTimer', 'clearSelected', 'disposeCachePage'], {
    ...h.scope, busy: ref(false), clearItem: () => { operations++; return request.promise; },
    refreshSizes: () => ui++, qtShowToast: () => ui++, uni: { reLaunch: () => ui++ },
  });
  const running = api.clearSelected(['account']);
  assert.equal(operations, 1); h.close(); request.resolve(true); await running;
  assert.equal(ui, 0); assert.equal(h.timers.size, 0);
});

await check('search waiting for load-more stops when its page is removed and releases the pending wait', async () => {
  for (const removed of [true, false]) {
    const h = runtime(), loading = ref(true);
    let requests = 0;
    const api = load('pages/search/index.uvue', ['searchAlive', 'searchSeq', 'hotSeq', 'searchCurrent', 'disposeSearch'], {
      ...h.scope, resultsLoadingMore: loading, keyword: ref('music'), type: ref('song'), searched: ref(true),
      allLoaded: false, runAllSections: async () => requests++, runSearch: async () => requests++,
      qtShowToast: noop, uni: { $off: noop }, onPacksChanged: noop, onAggSourcesChanged: noop,
      SOURCE_PACKS_CHANGED_EVENT: '', SOURCE_POLICY_CHANGED_EVENT: '', AGGREGATE_SOURCES_CHANGED_EVENT: '',
    });
    const pending = api.searchCurrent('song');
    assert.equal(h.timers.size, 1);
    if (removed) h.close();
    loading.value = false;
    await h.advance(200); await pending;
    assert.equal(requests, removed ? 0 : 1);
    assert.equal(h.timers.size, 0);
    h.close();
  }
});

await check('share-card teardown settles capture once and a queued callback cannot reuse the native element', async () => {
  const h = runtime();
  let captures = 0, finished = 0;
  const api = load('pages/share-card/index.uvue',
    ['disposed', 'snapDelay', 'snapTimeout', 'cancelSnapshot', 'loadingToken', 'clearExportLoading', 'snapshotCard', 'disposeShareCard'], {
      ...h.scope, coverReady: ref(true), scrollInto: ref(''), working: ref(true), shareCard: { song: {} },
      uni: { getElementById: () => ({ takeSnapshot() { captures++; } }) },
      beginLoading: () => 1, finishLoading: () => finished++, qtShowToast: noop, logError: noop,
    });
  const pending = api.snapshotCard();
  const ids = [...h.timers.keys()];
  assert.equal(ids.length, 2);
  h.close(); ids.forEach(id => h.fire(id, true));
  assert.equal(await pending, null);
  assert.equal(captures, 0); assert.equal(finished, 1); assert.equal(h.timers.size, 0);
});

await check('upgrade download callbacks cannot revive an unmounted popup or schedule its delayed close', async () => {
  for (const phase of ['resolve-url', 'download', 'live']) {
    const h = runtime(), url = deferred(), download = deferred();
    let downloads = 0, emitCount = 0, reportProgress = noop;
    const api = load('uni_modules/qt-ui/components/qt-upgrade-popup/qt-upgrade-popup.uvue',
      ['UPDATE_SUB_DIR', 'UPDATE_FILE_PREFIX', 'popupAlive', 'closeTimer', 'probing', 'downloading', 'progress', 'escapeAllowed', 'closeSelf', 'update'], {
        ...h.scope, props: { info: { downloadUrl: 'fixture.apk', versionName: 'test', isForce: false } },
        resolveDownloadUrl: () => url.promise,
        downloadApk: (_url, fn) => { downloads++; reportProgress = fn; return download.promise; },
        ensurePublicDirPermission: async () => false, saveToPublicMedia: async () => '',
        installApk: () => true, logMsg: noop, logMsgErr: noop, qtShowToast: noop, emit: () => emitCount++,
      });
    const pending = api.update();
    if (phase == 'resolve-url') h.close();
    url.resolve('fixture.apk'); await drain();
    if (phase == 'resolve-url') { await pending; assert.equal(downloads, 0); }
    else {
      assert.equal(downloads, 1);
      reportProgress(10, 100, 10);
      if (phase == 'download') h.close();
      reportProgress(80, 100, 80);
      download.resolve('fixture-path'); await pending;
      if (phase == 'download') assert.equal(api.progress.value, 10);
      else { assert.equal(api.progress.value, 100); await h.advance(600); assert.equal(emitCount, 2); h.close(); }
    }
    assert.equal(h.timers.size, 0);
    if (phase != 'live') assert.equal(emitCount, 0);
  }
});

console.log(`UI lifecycle: ${passed} checks passed`);
