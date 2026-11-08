import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as Vue from 'vue';
import { parse as parseSfc, compileScript } from '@vue/compiler-sfc';

// Lead-confirmed public seam: complete production SFC + QtIcon, actual Qt
// stores/layout/font/chrome/navigation/reveal -> mounted native nodes + click.
// Only SDK window/navigation/storage/time, native element operations and the
// element rectangles and scroll-top/clamp are host boundaries. The generic
// column/px/flex host consumes actual styles; it contains no copied nav formula.
// Row rectangles are source-derived host geometry, NOT Native Yoga, text/SVG
// paint, actual touch, screenshot or device measurements.
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const navPath = 'uni_modules/qt-ui/components/qt-side-nav/qt-side-nav.uvue';
const iconPath = 'uni_modules/qt-ui/components/qt-icon/qt-icon.uvue';
const source = read(navPath);
function android(text) {
  const states = [true];
  return text.split('\n').filter((line) => {
    const begin = line.match(/^\s*\/\/\s*#(ifdef|ifndef)\s+(.+)$/);
    if (begin) {
      let enabled = begin[2].split(/\|\|/).some((flag) => ['APP', 'APP-ANDROID'].includes(flag.trim()));
      if (begin[1] === 'ifndef') enabled = !enabled;
      states.push(states.at(-1) && enabled); return false;
    }
    if (/^\s*\/\/\s*#endif\b/.test(line)) { states.pop(); return false; }
    return states.at(-1);
  }).join('\n');
}
function runnable(text) {
  return stripTypeScriptTypes(android(text).replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm, ''), { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
}
function module(text, scope) {
  const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map((m) => m[1]);
  return vm.runInNewContext(runnable(text) + '\n;({' + names.join(',') + '})', { ...scope });
}
function component(text, filename, scope) {
  const { descriptor, errors } = parseSfc(text, { filename,
    templateParseOptions: { isCustomElement: (tag) => ['view', 'text', 'image', 'scroll-view'].includes(tag) },
  });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, { id: filename, inlineTemplate: true,
    templateOptions: { compilerOptions: { isCustomElement: (tag) => ['view', 'text', 'image', 'scroll-view'].includes(tag) } },
  }).content;
  code = code.replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/g, (_full, imports) => {
    for (const item of imports.split(',')) {
      const [original, alias = original] = item.trim().split(/\s+as\s+/);
      scope[alias] = Vue[original];
    }
    return '';
  }).replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm, '')
    .replace('export default', 'const __component =');
  return vm.runInNewContext(stripTypeScriptTypes(code, { mode: 'strip' }) + '\n;__component;', { ...scope }, { filename });
}
function cssValues(value) {
  const style = Vue.normalizeStyle(value);
  if (typeof style !== 'string') return Object.fromEntries(Object.entries(style ?? {}).map(([key, val]) =>
    [key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()), String(val)]));
  return Object.fromEntries(style.split(';').filter((part) => part.includes(':')).map((part) => {
    const at = part.indexOf(':'); return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }));
}
function nativeHost(scope, viewport) {
  const rules = [source, read(iconPath)].flatMap((text) => parseSfc(text).descriptor.styles.flatMap((style) =>
    [...style.content.matchAll(/\.([\w-]+)\s*\{([^}]+)\}/g)].map((match) => ({ name: match[1], values: cssValues(match[2]) }))));
  const node = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null, offset: 0, pendingTop: null,
    getBoundingClientRect() { return this.box ?? { top: 0, bottom: 0, height: 0 }; },
    querySelector(selector) {
      return descendants(this).find((item) => selector.startsWith('#') ? item.props.id === selector.slice(1) : classes(item).includes(selector.slice(1))) ?? null;
    },
  });
  const detach = (child) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = null;
  };
  const renderer = Vue.createRenderer({
    createElement: (tag) => node(tag), createText: (text) => node('#text', text), createComment: (text) => node('#comment', text),
    setText: (child, text) => { child.text = text; },
    setElementText: (child, text) => { child.text = text; child.children = []; },
    insert(child, parent, before = null) {
      detach(child); const at = before ? parent.children.indexOf(before) : -1;
      if (at < 0) parent.children.push(child); else parent.children.splice(at, 0, child);
      child.parent = parent;
    },
    remove: detach, parentNode: (child) => child.parent,
    nextSibling: (child) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
    patchProp(child, key, previous, value) {
      child.props[key] = value;
      if (key === 'scroll-top' && value !== previous) child.pendingTop = value;
    },
  });
  const classes = (child) => String(child.props.class ?? '').split(/\s+/);
  const styleOf = (child) => {
    const values = {};
    for (const rule of rules) if (classes(child).includes(rule.name)) Object.assign(values, rule.values);
    return Object.assign(values, cssValues(child.props.style));
  };
  const pixels = (value, fallback = 0) => {
    if (value == null) return fallback;
    const match = String(value).match(/^(-?\d+(?:\.\d+)?)(px|rpx)?$/);
    assert.ok(match, `native host supports one actual numeric length, got ${value}`);
    return match[2] === 'rpx' ? scope.qtRpx(Number(match[1])) : Number(match[1]);
  };
  const edges = (style, kind) => {
    const parts = String(style[kind] ?? '0').trim().split(/\s+/).map((value) => pixels(value));
    const [top, right = top, bottom = top, left = right] = parts;
    return ['top', 'right', 'bottom', 'left'].map((side, i) => pixels(style[kind + '-' + side], [top, right, bottom, left][i]));
  };
  const flow = (child) => child.children.filter((item) => !item.tag.startsWith('#') && !['absolute', 'fixed'].includes(styleOf(item).position));
  const intrinsic = (child) => {
    if (child.tag.startsWith('#')) return 0;
    const style = styleOf(child), padding = edges(style, 'padding');
    if (style.height != null) return pixels(style.height);
    if (child.tag === 'text') return pixels(style['line-height'], pixels(style['font-size'], 16) * 1.2);
    return padding[0] + padding[2] + flow(child).reduce((sum, item) => {
      const margin = edges(styleOf(item), 'margin'); return sum + margin[0] + intrinsic(item) + margin[2];
    }, 0);
  };
  function place(child, top, width, height = intrinsic(child)) {
    const style = styleOf(child), padding = edges(style, 'padding');
    child.box = { top, height, bottom: top + height, width };
    const children = flow(child), available = Math.max(0, height - padding[0] - padding[2]);
    const flexOf = (item) => Number(styleOf(item)['flex-grow'] ?? styleOf(item).flex ?? 0);
    const flexTotal = children.reduce((sum, item) => sum + flexOf(item), 0);
    const fixedTotal = children.reduce((sum, item) => {
      const margin = edges(styleOf(item), 'margin');
      return sum + margin[0] + (flexOf(item) > 0 ? 0 : intrinsic(item)) + margin[2];
    }, 0);
    const remaining = Math.max(0, available - fixedTotal);
    const heights = children.map((item) => flexOf(item) > 0 ? remaining * flexOf(item) / flexTotal : intrinsic(item));
    if (child.tag === 'scroll-view') {
      child.contentHeight = fixedTotal;
      child.maxOffset = Math.max(0, child.contentHeight - available);
      child.offset = Math.max(0, Math.min(child.offset, child.maxOffset));
    }
    let cursor = top + padding[0] - (child.tag === 'scroll-view' ? child.offset : 0);
    if (style['justify-content'] === 'center' && flexTotal === 0) cursor += Math.max(0, available - fixedTotal) / 2;
    children.forEach((item, index) => {
      const margin = edges(styleOf(item), 'margin'); cursor += margin[0];
      place(item, cursor, pixels(styleOf(item).width, Math.max(0, width - padding[1] - padding[3])), heights[index]);
      cursor += heights[index] + margin[2];
    });
  }
  const descendants = (parent) => parent.children.flatMap((child) => [child, ...descendants(child)]);
  function layout(root) {
    const draw = () => {
      for (const child of root.children.filter((item) => !item.tag.startsWith('#'))) {
        const style = styleOf(child);
        // Fixed/docked native frame bounds; explicit source height wins.
        place(child, pixels(style.top), pixels(style.width, viewport.windowWidth), pixels(style.height, viewport.windowHeight));
      }
    };
    draw();
    for (const scroll of descendants(root).filter((item) => item.tag === 'scroll-view' && item.pendingTop != null)) {
      scroll.offset = Math.max(0, Math.min(scroll.pendingTop, scroll.maxOffset));
      scroll.pendingTop = null;
      scroll.props.onScroll?.({ detail: { scrollTop: scroll.offset } });
    }
    draw();
  }
  const fullyVisible = (child) => {
    if (!child?.box || child.box.top < 0 || child.box.bottom > viewport.windowHeight) return false;
    for (let parent = child.parent; parent; parent = parent.parent) {
      if (parent.tag === 'scroll-view' && (child.box.top < parent.box.top || child.box.bottom > parent.box.bottom)) return false;
    }
    return true;
  };
  return { node, renderer, styleOf, classes, descendants, layout, fullyVisible };
}
function harness() {
  let time = 100000, timerId = 0;
  let firstMount = true;
  const timers = new Map(), storage = new Map(), views = new Set(), navigation = [], showHooks = [];
  const viewport = { windowWidth: 1098, windowHeight: 686, statusBarHeight: 24, safeAreaInsets: { bottom: 0 }, theme: 'light' };
  let pages = [{ route: 'pages/chart/index' }];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const schedule = (fn, ms, repeat = 0) => { const id = ++timerId; timers.set(id, { fn, at: time + ms, repeat }); return id; };
  const navigate = (kind, options) => {
    navigation.push({ kind, url: options.url, delta: options.delta, animationType: options.animationType });
    if (kind === 'navigateBack') pages = pages.slice(0, Math.max(1, pages.length - (options.delta ?? 1)));
    else if (kind === 'navigateTo') pages.push({ route: options.url.replace(/^\//, '') });
    else pages = [{ route: options.url.replace(/^\//, '') }];
    for (const view of views) view.props.current = '/' + pages.at(-1).route;
    options.success?.({});
  };
  const scope = { ...Vue, console, Date: Clock,
    onShow(fn) { showHooks.push(fn); Vue.onUnmounted(() => showHooks.splice(showHooks.indexOf(fn), 1)); },
    getCurrentPages: () => pages,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: (id) => timers.delete(id),
    uni: {
      getStorageSync: (key) => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value),
      getSystemInfoSync: () => viewport, getWindowInfo: () => viewport,
      $on() {}, $off() {}, onThemeChange() {},
      switchTab: (options) => navigate('switchTab', options), reLaunch: (options) => navigate('reLaunch', options),
      navigateTo: (options) => navigate('navigateTo', options), navigateBack: (options = {}) => navigate('navigateBack', options),
    },
    SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed', SOURCE_AUTH_CHANGED_EVENT: 'qt-source-auth-changed',
    logWarn() {}, // Native logging boundary; no playback/quality operation is invoked by the rail.
  };
  for (const path of ['stores/source.ts', 'stores/source-registry.ts', 'uni_modules/qt-ui/stores/theme.ts',
    'uni_modules/qt-ui/composables/use-qt-layout.ts', 'uni_modules/qt-ui/stores/font-scale.ts',
    'uni_modules/qt-ui/composables/qt-page-chrome.ts', 'uni_modules/qt-ui/composables/qt-wide-workspace.ts',
    'uni_modules/qt-ui/composables/qt-nav.ts', 'uni_modules/qt-ui/composables/selection.ts',
    'uni_modules/qt-ui/composables/use-qt-nav-scroll.ts',
    'uni_modules/qt-ui/services/icons.ts']) Object.assign(scope, module(read(path), scope));
  scope.QtIcon = component(read(iconPath), iconPath, scope);
  const SideNav = component(source, navPath, scope);
  const host = nativeHost(scope, viewport);
  async function flush() {
    await Vue.nextTick(); for (let i = 0; i < 12; i++) await Promise.resolve(); await Vue.nextTick();
    for (const view of views) host.layout(view.root);
  }
  async function advance(ms) {
    await flush(); const target = time + ms;
    for (let turn = 0; turn < 1000; turn++) {
      const entry = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) { time = target; await flush(); return; }
      time = entry[1].at; timers.delete(entry[0]);
      if (entry[1].repeat) timers.set(entry[0], { ...entry[1], at: time + entry[1].repeat });
      entry[1].fn(); await flush();
    }
    throw new Error('fixture timer loop did not settle');
  }
  function mount(current = '/pages/chart/index', options = {}) {
    if (firstMount) { pages = [{ route: current.replace(/^\//, '') }]; firstMount = false; }
    if (views.size === 0) scope.resumeQtLayoutWatcher();
    const props = Vue.reactive({ current, dots: [], docked: false, ...options });
    const root = host.node('native-frame');
    const app = host.renderer.createApp({ setup() {
      // Public parent-frame props follow actual workspace state/native route receipts.
      Vue.watch(() => scope.qtWideToolRoute(), (route) => { props.current = route || scope.qtTopRoute(); });
      return () => Vue.h(SideNav, props);
    } });
    const find = (className) => host.descendants(root).filter((item) => host.classes(item).includes(className));
    const labelOf = (item) => host.descendants(item).filter((child) => host.classes(child).includes('qsn-label')).map((child) => child.text).join('');
    const view = { props, root, find, host,
      entry(label) { return find('qsn-item').find((item) => labelOf(item) === label); },
      active() { return find('qsn-item').find((item) => host.styleOf(item)['background-color'] === scope.useThemeStore().skin.accentSoft); },
      scroll() { return host.descendants(root).find((item) => item.tag === 'scroll-view'); },
      render() {
        return { scrollIntoView: this.scroll()?.props['scroll-into-view'] ?? '',
          items: find('qsn-item').map((item) => ({ id: item.props.id ?? '', label: labelOf(item), style: item.props.style, node: item })) };
      },
      scrollTo(offset) {
        const scroll = this.scroll(); scroll.offset = Math.max(0, Math.min(offset, scroll.maxOffset)); host.layout(root);
        scroll.props.onScroll?.({ detail: { scrollTop: scroll.offset } });
      },
      route(current) { nativeStack([current]); },
      click(label) { const item = this.entry(label); assert.ok(item && host.fullyVisible(item), `actual ${label} entry must be visible to click`); item.props.onClick(); },
      unmount() {
        app.unmount(); views.delete(view);
        // The synthetic App window closes when its last rail fixture closes.
        // Actual App onHide cleanup stops its global 1000ms layout watcher.
        if (views.size === 0) scope.pauseQtLayoutWatcher();
      },
    };
    views.add(view); app.mount(root); host.layout(root); return view;
  }
  async function pollWindow(windowWidth, windowHeight) {
    Object.assign(viewport, { windowWidth, windowHeight });
    const poll = [...timers.values()].find((timer) => timer.repeat === 1000);
    assert.ok(poll, 'actual Qt App layout watcher is running');
    await advance(poll.at - time); // Stop at the real poll, before its new 32ms reveal.
  }
  function nativeStack(routes) {
    pages = routes.map((route) => ({ route: route.replace(/^\//, '') }));
    for (const view of views) view.props.current = '/' + pages.at(-1).route;
  }
  return { layout: scope.qtLayout(), viewport, scope, mount, flush, advance, pollWindow, nativeStack,
    show() { showHooks.forEach((hook) => hook()); },
    timers, navigation, registry: scope.useSourceRegistryStore() };
}
const routeLabels = { '/pages/chart/index': '排行榜', '/pages/search/index': '搜索', '/pages/home/index': '发现', '/pages/profile/index': '我的' };
function pinnedChrome(view) {
  const rows = view.find('qsn-item');
  const primaries = rows.filter((row) => row.props.id && !view.host.descendants(view.scroll()).includes(row));
  const footer = view.find('qsn-footer')[0];
  assert.equal(primaries.length, 2, 'the two public primary entries are outside the actual scroll subtree');
  for (const row of primaries) assert.ok(view.host.fullyVisible(row), 'fixed primary row remains fully visible');
  assert.ok(footer && view.host.fullyVisible(footer), 'fixed settings footer remains fully visible');
  return { primaries, footer };
}
function selectedEntry(view, route) {
  const entry = view.entry(routeLabels[route]) ?? view.active();
  assert.ok(entry, 'requested navigation entry is actually present in the mounted template');
  assert.ok(entry.props.id.length > 0, 'the native target item has a concrete instance-scoped ID');
  assert.ok(view.host.fullyVisible(entry), 'the current tool is fully visible after nearest-edge reveal');
  assert.equal(view.render().scrollIntoView, '', 'navigation never aligns a visible entry to the top');
  return { id: entry.props.id, label: view.host.descendants(entry).filter((item) => view.host.classes(item).includes('qsn-label')).map((item) => item.text).join(''), node: entry };
}
// Intentional correction of the old primary anchor=id expectation: a fixed
// primary must remain visible/active, keep its concrete scoped ID, and must NOT
// be the tool scroll target. Tool assertions above remain unchanged.
function primaryEntry(view, label) {
  const entry = view.entry(label);
  assert.ok(entry && entry.props.id.length > 0, 'the actual primary entry keeps an instance-scoped ID');
  assert.equal(view.active(), entry, 'the requested primary/profile-family route stays highlighted');
  assert.ok(view.host.fullyVisible(view.entry('发现')) && view.host.fullyVisible(view.entry('我的')),
    'both primary entries stay fully visible');
  assert.equal(view.render().scrollIntoView, '', 'fixed primary navigation never targets the tool scroll viewport');
  return { id: entry.props.id, label, node: entry };
}
{
  const h = harness();
  const page = h.mount();
  await h.advance(40);
  // Actual 1920x1200/1098x686 device screenshot independently showed only the
  // chart-entry background sliver; the icon/label lay below the rail viewport.
  assert.ok(page.scroll().offset > 0, '1098x686 current chart entry must be revealed, not clipped below settings');
  assert.equal(selectedEntry(page, '/pages/chart/index').label, '排行榜');
  page.unmount();
  console.log('side nav: mounted actual current chart entry is revealed at the nearest edge');
}
// Supplementary live-input coverage of the already-green public capability.
{
  const h = harness();
  h.registry.sources = [{ id: 'wyy', name: '网易云音乐', charts: false, playlists: false, latest: false }];
  const page = h.mount();
  await h.advance(40);
  assert.equal(page.render().scrollIntoView, '', 'a route absent from the actual capability-gated menu has no target');
  h.registry.sources = [{ id: 'wyy', name: '网易云音乐', charts: true, playlists: true, latest: true }];
  await h.advance(40);
  selectedEntry(page, '/pages/chart/index');
  const toolOffset = page.scroll().offset;
  page.route('/pages/home/index'); await h.advance(40);
  assert.equal(primaryEntry(page, '发现').label, '发现');
  assert.equal(page.scroll().offset, toolOffset, 'home changes no tool scroll position');
  page.route('/pages/collection/index'); await h.advance(40);
  assert.equal(primaryEntry(page, '我的').label, '我的');
  assert.equal(page.scroll().offset, toolOffset, 'profile-family changes no tool scroll position');
  page.route('/pages/theme/index'); await h.advance(40);
  assert.equal(page.render().scrollIntoView, '', 'settings family highlights the fixed footer, not a scrollable menu entry');
  assert.ok(page.host.fullyVisible(page.entry('设置')), 'settings remains outside the scrollable menu');
  page.unmount();
  console.log('side nav: real source capability arrival, top/profile routes and fixed settings footer');
}
{
  const h = harness();
  const page = h.mount();
  await h.advance(40);
  const windows = [
    { windowWidth: 1098, windowHeight: 686, sizeClass: 'wide', isWide: true },
    { windowWidth: 1098, windowHeight: 360, sizeClass: 'wide', isWide: true },
    { windowWidth: 686, windowHeight: 390, sizeClass: 'medium', isWide: true },
    { windowWidth: 390, windowHeight: 686, sizeClass: 'compact', isWide: false },
  ];
  const mountedId = page.render().items[0].id;
  let vectors = 0;
  for (const window of windows) {
    await h.pollWindow(window.windowWidth, window.windowHeight);
    assert.equal(h.layout.windowWidth, window.windowWidth);
    assert.equal(h.layout.windowHeight, window.windowHeight);
    assert.equal(h.layout.sizeClass, window.sizeClass);
    assert.equal(h.layout.isWide, window.isWide, 'the actual shared layout computes the viewport breakpoint');
    for (const tier of h.scope.QT_FONT_TIERS) {
      h.scope.useFontScaleStore().setTier(tier.id);
      await Vue.nextTick();
      assert.equal(page.render().scrollIntoView, '', 'native layout/font change first clears any previous scroll target');
      await h.advance(40);
      assert.equal(page.render().items[0].id, mountedId, 'window/font changes exercise one retained real SFC instance');
      if (window.isWide) {
        const selected = selectedEntry(page, '/pages/chart/index');
        assert.ok(page.host.fullyVisible(selected.node), 'the actual current tool row is visible after Native align-top/clamp');
        pinnedChrome(page);
        const footerTop = page.find('qsn-footer')[0].box.top;
        page.scrollTo(0); pinnedChrome(page);
        page.scrollTo(page.scroll().maxOffset); pinnedChrome(page);
        assert.equal(page.find('qsn-footer')[0].box.top, footerTop, 'tool scrolling cannot move fixed settings');
      } else assert.equal(page.render().scrollIntoView, '', 'compact isWide=false reveal guard never requests native scrolling');
      vectors++;
    }
  }
  assert.equal(vectors, 20, 'all four original windows × all five actual font tiers were mounted');
  page.unmount();
  assert.equal(h.timers.size, 0);
  console.log('side nav: 20 live SDK-poll window/font vectors, active tool and pinned chrome without remount');
}
{
  const h = harness();
  const a = h.mount(), b = h.mount();
  await h.advance(40);
  const first = selectedEntry(a, '/pages/chart/index');
  const second = selectedEntry(b, '/pages/chart/index');
  assert.notEqual(first.id, second.id, 'retained instances do not address one another\'s native menu');
  h.nativeStack(['/pages/search/index']);
  await h.flush();
  const pending = [...h.timers].filter(([, timer]) => timer.repeat === 0).map(([id]) => id);
  assert.ok(pending.length > 0, 'actual route change has a pending native delay before unmount');
  a.unmount();
  assert.ok(pending.some((id) => !h.timers.has(id)), 'unmount cancels its pending delay immediately, leaving the other rail independent');
  b.route('/pages/home/index');
  await h.advance(100);
  assert.equal(a.render().scrollIntoView, '', 'unload cancels both render-flush and delayed native scroll callbacks');
  primaryEntry(b, '发现');
  b.route('/pages/search/index');
  b.unmount(); // Also cover disposal before the Vue render-flush/nextTick completes.
  await h.advance(100);
  assert.equal(h.timers.size, 0, 'disposed rail instances leave no timers');
  console.log('side nav: native IDs are instance-scoped and pending navigation is cancelled on unmount');
}
// One new vertical slice before any production change. Both primary entries are
// visible before an actual mounted click; Native align-top must not remove Home.
{
  const h = harness();
  h.scope.useFontScaleStore().setTier('huge');
  const page = h.mount('/pages/home/index');
  await h.advance(40);
  assert.ok(page.host.fullyVisible(page.entry('发现')) && page.host.fullyVisible(page.entry('我的')),
    'both primary entries are fully visible before the click');
  const before = page.scroll().offset;
  page.click('我的');
  await h.advance(40);
  assert.equal(h.navigation.at(-1).kind, 'switchTab', 'actual Qt rail click reaches the Android native tab boundary');
  assert.equal(page.props.current, '/pages/profile/index');
  console.log('primary click host observation:', JSON.stringify({ before, after: page.scroll().offset,
    home: page.entry('发现').box, mine: page.entry('我的').box, viewport: page.scroll().box }));
  assert.ok(page.host.fullyVisible(page.entry('发现')), 'clicking already-visible My must not scroll Home out of the native viewport');
  assert.ok(page.host.fullyVisible(page.entry('我的')));
  assert.equal(page.scroll().offset, before, 'primary navigation must not change the tool scroll position');
  page.unmount();
  console.log('side nav: actual visible My click retains both primary entries and tool scroll offset');
}
// Supplemental public behavior after the first RED -> minimal GREEN slice.
{
  const h = harness();
  const page = h.mount('/pages/home/index');
  await h.advance(40);
  page.scrollTo(page.scroll().maxOffset); // Native user scroll before clicking the last tool.
  pinnedChrome(page);
  page.click('排行榜');
  await h.advance(40);
  assert.equal(h.scope.qtWideToolRoute(), '/pages/chart/index', 'actual Qt navigation hosts the tool in the current tab');
  assert.equal(h.navigation.length, 0, 'hosted tool does not create a native page');
  const chart = selectedEntry(page, '/pages/chart/index');
  assert.ok(page.host.fullyVisible(chart.node));
  pinnedChrome(page);
  const offset = page.scroll().offset, footerTop = page.find('qsn-footer')[0].box.top;
  const openSeq = h.scope.qtWideWorkspace().openSeq;
  page.click('排行榜'); await h.advance(40);
  assert.equal(h.scope.qtWideWorkspace().openSeq, openSeq, 'clicking the current tool is a no-op');
  assert.equal(page.scroll().offset, offset);
  page.click('我的'); await h.advance(40);
  assert.equal(h.scope.qtWideToolRoute(), '', 'actual primary click closes the hosted tool');
  assert.equal(h.scope.qtTopRoute(), '/pages/profile/index');
  assert.equal(h.navigation.at(-1).kind, 'switchTab');
  assert.equal(h.navigation.at(-1).animationType, undefined, 'tab switching keeps the existing default-animation contract');
  primaryEntry(page, '我的');
  assert.equal(page.scroll().offset, offset, 'closing a hosted tool for My cannot scroll the tools');
  assert.equal(page.find('qsn-footer')[0].box.top, footerTop);
  const calls = h.navigation.length;
  page.click('我的'); await h.advance(340);
  assert.equal(h.navigation.length, calls, 'current primary without a hosted tool is a no-op');
  assert.equal(page.scroll().offset, offset);
  page.click('发现'); await h.advance(40);
  primaryEntry(page, '发现');
  assert.equal(page.scroll().offset, offset);
  page.click('排行榜'); await h.advance(40);
  // Public host-current props can stay on Home while a wide tool is active.
  // Such a current-primary click must still close the tool, not hit the no-op.
  page.props.current = '/pages/home/index'; await h.advance(40);
  const beforeClose = h.navigation.length;
  page.click('发现'); await h.advance(40);
  assert.equal(h.scope.qtWideToolRoute(), '', 'current host primary still closes an active hosted tool');
  assert.equal(h.navigation.length, beforeClose, 'closing into the current native host needs no new tab navigation');
  primaryEntry(page, '发现');
  assert.equal(page.scroll().offset, offset);
  page.unmount();
  assert.equal(h.timers.size, 0);
  console.log('side nav: actual tool/primary clicks, hosted close, current-route no-ops and unchanged tool offset');
}
{
  const h = harness();
  h.registry.sources = [{ id: 'wyy', name: '网易云音乐', charts: false, latest: false, playlists: false }];
  const page = h.mount();
  await h.advance(40);
  const primaryIds = pinnedChrome(page).primaries.map((item) => item.props.id);
  assert.equal(page.render().scrollIntoView, '');
  h.scope.setTimeout(() => {
    h.registry.sources = [
      { id: 'wyy', name: '网易云音乐', charts: false, latest: true, playlists: false },
      { id: 'qq', name: 'QQ音乐', charts: true, latest: false, playlists: false },
    ];
  }, 5);
  await h.advance(5);
  assert.equal(page.render().scrollIntoView, '', 'async capability arrival cancels before the Native delay');
  assert.ok(page.entry('每日新歌'));
  assert.ok(page.entry('排行榜'), 'charts remains available when another actual source supports it');
  await h.advance(35);
  const firstId = selectedEntry(page, '/pages/chart/index').id;
  assert.ok(page.host.fullyVisible(page.entry('排行榜')));
  h.scope.useSourceStore().setSource('qq');
  await h.flush();
  assert.equal(page.entry('每日新歌'), undefined, 'latest is gated by the actual current source');
  assert.equal(page.render().scrollIntoView, '', 'source-driven tool removal clears the old index');
  await h.advance(40);
  assert.notEqual(selectedEntry(page, '/pages/chart/index').id, firstId, 'real list reindexing targets the new chart node, not a stale ID');
  h.registry.sources = [{ id: 'qq', name: 'QQ音乐', charts: false, latest: false, playlists: false }];
  await h.advance(40);
  assert.equal(page.entry('排行榜'), undefined);
  assert.equal(page.render().scrollIntoView, '', 'removal of the actual selected tool leaves no target');
  assert.equal(page.active(), undefined, 'unavailable current tool does not select a replacement');
  h.registry.sources = [{ id: 'wyy', name: '网易云音乐', charts: true, latest: true, playlists: true }];
  h.scope.useSourceStore().setSource('wyy');
  await h.advance(40);
  assert.ok(page.entry('歌单广场') && page.entry('每日新歌'));
  selectedEntry(page, '/pages/chart/index');
  assert.deepEqual(pinnedChrome(page).primaries.map((item) => item.props.id), primaryIds, 'async additions/removals never rebind the fixed primaries');
  assert.equal(h.navigation.length, 0);
  page.unmount(); assert.equal(h.timers.size, 0);
  console.log('side nav: async actual capabilities, source switch, list reindex, removal and later arrival');
}
{
  const h = harness();
  const regular = h.mount('/pages/home/index');
  const docked = h.mount('/pages/profile/index', { docked: true });
  await h.advance(40);
  const regularRoot = regular.find('qsn')[0], dockedRoot = docked.find('qsn')[0];
  assert.equal(regular.host.styleOf(regularRoot).position, 'fixed');
  assert.equal(regular.host.styleOf(regularRoot).height, '686px', 'fixed Native rail keeps its explicit window height');
  assert.equal(docked.host.styleOf(dockedRoot).position, 'absolute', 'docked Native rail must not nest fixed positioning');
  assert.equal(docked.host.styleOf(dockedRoot).height, undefined, 'docked rail derives height from parent top/bottom bounds');
  assert.equal(dockedRoot.box.height, 686);
  assert.equal(regularRoot.box.height, 686);
  assert.notEqual(regular.entry('发现').props.id, docked.entry('发现').props.id, 'fresh home/profile mounts remain instance-isolated');
  for (const page of [regular, docked]) {
    pinnedChrome(page);
    page.route('/pages/chart/index'); await h.advance(40);
    assert.ok(page.host.fullyVisible(selectedEntry(page, '/pages/chart/index').node));
    page.scrollTo(page.scroll().maxOffset);
    const offset = page.scroll().offset, footerTop = page.find('qsn-footer')[0].box.top;
    page.route('/pages/not-found/index'); await h.advance(40);
    assert.equal(page.render().scrollIntoView, '', 'invalid current route means no tool target');
    assert.equal(page.active(), undefined, 'invalid route means no selection');
    page.route('/pages/theme/index'); await h.advance(40);
    assert.equal(page.render().scrollIntoView, '');
    assert.equal(page.active(), page.entry('设置'), 'actual settings family highlights the fixed footer');
    page.route('/pages/collection/index'); await h.advance(40);
    primaryEntry(page, '我的');
    assert.equal(page.scroll().offset, offset);
    assert.equal(page.find('qsn-footer')[0].box.top, footerTop);
    page.props.dots = ['/pages/profile/index']; await h.flush();
    assert.equal(page.find('qsn-dot').length, 1, 'existing profile notification dot remains rendered');
    page.route('/pages/settings/index'); await h.advance(40);
    const calls = h.navigation.length;
    page.click('设置'); await h.advance(40);
    assert.equal(h.navigation.length, calls, 'clicking the current settings route is a no-op');
    assert.equal(page.scroll().offset, offset);
    pinnedChrome(page);
  }
  regular.unmount(); docked.unmount();
  assert.equal(h.timers.size, 0);
  console.log('side nav: fixed/docked fresh mounts, actual route families, invalid route, footer and dots');
}
{
  const h = harness();
  const page = h.mount('/pages/collection/index');
  h.nativeStack(['/pages/home/index', '/pages/chart/index', '/pages/collection/index']);
  await h.advance(40);
  page.click('我的'); await h.advance(40);
  assert.deepEqual(h.navigation.map((item) => item.kind), ['switchTab']);
  assert.equal(h.navigation[0].url, '/pages/profile/index', 'native tab switching targets My directly without exposing Home');
  assert.equal(h.scope.qtTopRoute(), '/pages/profile/index');
  primaryEntry(page, '我的');
  page.click('设置'); await h.advance(40);
  assert.equal(h.scope.qtWideToolRoute(), '/pages/settings/index');
  assert.equal(h.navigation.length, 1, 'settings opens through the actual same-host route path');
  assert.equal(page.render().scrollIntoView, '');
  pinnedChrome(page);
  page.click('发现'); await h.advance(340);
  assert.equal(h.scope.qtWideToolRoute(), '');
  assert.equal(h.scope.qtTopRoute(), '/pages/home/index');
  primaryEntry(page, '发现');
  page.unmount(); assert.equal(h.timers.size, 0);
  console.log('side nav: direct native tab switch, settings hosting, primary close and timer cleanup');
}
{
  const h = harness();
  let page = h.mount('/pages/home/index');
  await h.pollWindow(1098, 617); await h.advance(40);
  const fmTop = page.entry('私人 FM').box.top;
  for (let round = 0; round < 3; round++) {
    page.click('私人 FM'); await h.flush(); page.unmount();
    page = h.mount('/pages/radio/index', { docked: true }); await h.advance(40);
    assert.equal(page.scroll().offset, 0, 'opening visible FM does not scroll it to the top');
    assert.equal(page.entry('私人 FM').box.top, fmTop, 'FM retains the same screen position across rail ownership changes');
    page.click('发现'); await h.flush(); page.unmount();
    page = h.mount('/pages/home/index'); await h.advance(40);
    assert.equal(page.entry('私人 FM').box.top, fmTop, 'returning home does not move FM back down');
  }
  const commandBeforeDrag = page.scroll().props['scroll-top'];
  page.scrollTo(63); await h.flush();
  assert.equal(page.scroll().props['scroll-top'], commandBeforeDrag, 'scroll receipts do not feed commands back into an active native gesture');
  const manualOffset = page.scroll().offset;
  page.click('私人 FM'); await h.flush(); page.unmount();
  page = h.mount('/pages/radio/index', { docked: true }); await h.advance(40);
  assert.equal(page.scroll().offset, manualOffset, 'manual scroll survives fixed-to-docked remount');
  page.click('发现'); await h.flush(); page.unmount();
  page = h.mount('/pages/home/index'); await h.advance(40);
  assert.equal(page.scroll().offset, manualOffset, 'manual scroll survives returning to a fresh home rail');
  page.scrollTo(0); await h.flush();
  const chartBottom = page.entry('排行榜').box.bottom - page.scroll().box.top;
  const nearest = chartBottom - page.scroll().box.height;
  assert.ok(nearest > 0, 'chart starts offscreen in the actual short viewport');
  h.scope.qtOpenWideTool('/pages/chart/index'); await h.flush(); page.unmount();
  page = h.mount('/pages/chart/index', { docked: true }); await h.advance(40);
  assert.equal(page.scroll().offset, nearest, 'offscreen chart moves only far enough to expose its bottom edge');
  assert.ok(page.host.fullyVisible(page.entry('排行榜')));
  page.scrollTo(0); await h.advance(100);
  assert.equal(page.scroll().offset, 0, 'manual scrolling away from the active tool stays under user control');
  page.unmount(); assert.equal(h.timers.size, 0);
  console.log('side nav: repeated Home/FM remounts keep position, manual offset survives and offscreen reveal is minimal');
}
{
  const h = harness();
  const home = h.mount('/pages/home/index');
  await h.pollWindow(1098, 617); await h.advance(40);
  home.scrollTo(62); await h.flush();
  const retained = home.scroll().offset;
  home.click('我的'); await h.advance(40);
  // Real tab pages retain their own route prop even while hidden.
  home.props.current = '/pages/home/index'; await h.flush();
  const profile = h.mount('/pages/profile/index'); await h.advance(40);
  assert.equal(profile.scroll().offset, retained, 'new tab restores the last visible rail position');
  profile.scrollTo(81); await h.flush();
  const next = profile.scroll().offset;
  home.scroll().props.onScroll({ detail: { scrollTop: 0 } });
  profile.unmount();
  h.nativeStack(['/pages/home/index']); h.show(); await h.advance(40);
  assert.equal(home.scroll().offset, next, 'hidden rail receipts cannot overwrite the session; onShow restores retained rail');
  home.unmount(); assert.equal(h.timers.size, 0);
  console.log('side nav: retained tab onShow restores the shared offset and ignores hidden native receipts');
}
console.log('11 passed; 20 live window/font vectors (complete production SFC/native-host boundary, not device measurements)');
