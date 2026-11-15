// Execute the real services, page actions and component templates. Native I/O,
// engine replies and window/lifecycle callbacks are adapters, not device proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { compile } from "@vue/compiler-dom";
import * as Vue from "vue";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const strip = source => stripTypeScriptTypes(source.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, "").replace(/^export /gm, ""), { mode: "strip" });
const between = (source, start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, "production seam exists: " + start);
  return source.slice(first, last);
};
const noop = () => {};
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await Vue.nextTick(); };
let passed = 0;
async function check(name, run) { await run(); passed++; console.log("PASS " + name); }
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return this[key] ?? null; }
  set(key, value) { this[key] = value; }
  getString(key) { return typeof this[key] === "string" ? this[key] : null; }
  getNumber(key) { return typeof this[key] === "number" ? this[key] : null; }
  static keys(value) { return Object.keys(value); }
}
function toUTS(value) {
  if (Array.isArray(value)) return value.map(toUTS);
  return value != null && typeof value === "object"
    ? new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toUTS(item)]))) : value;
}
function evaluate(source, names, context) {
  return runInNewContext(strip(source) + "\n;({" + names.join(",") + "});", { console, ...context });
}
function eventBus() {
  const handlers = new Map(), events = [];
  return { events, $on(name, fn) { const group = handlers.get(name) ?? []; group.push(fn); handlers.set(name, group); },
    $off(name, fn) { handlers.set(name, (handlers.get(name) ?? []).filter(item => item !== fn)); },
    $emit(name, value) { events.push([name, value]); for (const fn of handlers.get(name) ?? []) fn(value); } };
}
const song = (id, platform = "package_a") => ({ id, platform, name: "同一首歌", singer: "同一位歌手", album: "专辑", picUrl: "", duration: 100 });
const packageData = {
  sourcePolicyVersion: 1,
  sources: [
    { id: "package_a", name: "数据包甲音乐", short: "甲", color: "#112233", qualities: ["eco", "full"] },
    { id: "package_b", name: "数据包乙音乐", short: "乙", color: "#223344", qualities: ["eco"] },
    { id: "new_service", name: "新加入的服务", short: "新", color: "#334455", qualities: ["full"] },
  ],
  qualities: [{ id: "full", name: "包声明无损" }, { id: "eco", name: "包声明标准" }],
};
function serviceHost() {
  const uni = eventBus(), preferences = new Map(), qualityTable = new Map(), profiles = new Map();
  const enabled = new Set(packageData.sources.map(item => item.id));
  let response = () => ({ url: "https://audio.invalid/stream", actualQuality: "eco", size: 800000, line: null, stalled: false });
  const engineCalls = [];
  const context = {
    UTSJSONObject, uni, parseJsonToUtso: text => toUTS(JSON.parse(text)),
    preferredSource: value => preferences.get(value.platform + ":" + value.id) ?? null,
    sourceEnabled: id => enabled.has(id) || id === "local" || id === "podcast",
    sourcePlayQualityOf: (id, fallback) => qualityTable.get(id) ?? fallback,
    cachedQualityProfileOf: id => profiles.get(id) ?? null,
    PROFILE_MODE_OFFICIAL: "official", sourcePlayLoginActive: () => false, sourceVipTierOf: () => null,
    sourcePolicyFingerprint: () => "policy-fixture", sourcePolicyConfigured: () => false,
    qtDiag: noop, logWarn: noop, logErrV: noop,
    getPlayUrlByEngineResult: async (...args) => { engineCalls.push(args); return response(...args); },
  };
  const apiSource = read("services/music-api.ts").split("\nexport const musicApi =")[0];
  const { MusicApi } = evaluate(apiSource, ["MusicApi"], context);
  const api = new MusicApi();
  api.engineInvoke = async () => toUTS(packageData);
  api.prefetchLyric = noop; api.ensureCrossLyric = async () => {}; api.probeUrlSize = noop;
  return { api, MusicApi, context, uni, preferences, qualityTable, profiles, enabled, engineCalls,
    reply(fn) { response = fn; } };
}

await check("actual source and quality belong to the playing URL, including a preflight for another quality", async () => {
  const host = serviceHost(), current = song("a"), target = song("b", "package_b");
  await host.api.sourceRegistry();
  host.reply(() => ({ url: "https://audio.invalid/original", actualQuality: "eco", size: 800000,
    stalled: false, line: { id: "fallback", name: "包内线路", kind: "cross", targetSong: target } }));
  const oldUrl = await host.api.playUrl(current, "full");
  assert.deepEqual(plain(host.api.playbackInfoOf(current, "full", oldUrl)), { source: target, quality: "eco", size: 800000 });
  assert.equal(host.api.playSourceOf(current, "full").platform, "package_b");
  host.reply(() => ({ url: "https://audio.invalid/preflight", actualQuality: "full", size: 4000000, line: null, stalled: false }));
  await host.api.playUrl({ ...current }, "eco");
  assert.equal(host.api.playbackInfoOf(current, "eco", oldUrl).source.platform, "package_b");
  assert.equal(host.api.playbackInfoOf(current, "eco", oldUrl).quality, "eco");
  assert.equal(host.api.playbackInfoOf(current, "eco", oldUrl).size, 800000);
  assert.equal(host.api.playbackInfoOf(current, "eco", "https://audio.invalid/preflight").quality, "full");
});
await check("old packages retain the resolved quality after a preference change and emit metadata without size", async () => {
  const host = serviceHost(), current = song("a"), target = song("b", "package_b");
  await host.api.sourceRegistry();
  host.preferences.set("package_a:a", target); host.qualityTable.set("package_b", "eco");
  host.reply(() => ({ url: "https://audio.invalid/old-package", actualQuality: "", size: 0, line: null, stalled: false }));
  const url = await host.api.playUrl(current, "full");
  host.qualityTable.set("package_b", "full");
  assert.equal(host.api.playbackInfoOf(current, "full", url).quality, "eco", "settings must not relabel audio already resolved");
  assert.ok(host.uni.events.some(([name]) => name === host.MusicApi.PLAY_SOURCE_EVENT));
  host.api.invalidatePlayUrl(current, "full");
  assert.equal(host.api.playbackInfoOf(current, "full", url).size, 0);
  assert.equal(host.api.urlPlaybackInfo.size, 0, "metadata follows URL eviction");
});
await check("package aliases resolve the same actual metadata; the metadata cache stays bounded", async () => {
  const host = serviceHost(); await host.api.sourceRegistry();
  host.profiles.set("package_a", { mode: "official", qualities: [{ id: "lossless", name: "包的官方无损", min: "none" }],
    aliases: new UTSJSONObject({ full: "lossless" }) });
  host.reply(value => ({ url: "https://audio.invalid/" + value.id, actualQuality: "lossless", size: 4000000, line: null, stalled: false }));
  const current = song("first"), url = await host.api.playUrl(current, "full");
  assert.equal(host.api.actualQualityOf(current, "full"), "lossless");
  assert.equal(host.api.actualSizeOf(current, "full"), 4000000);
  assert.equal(host.api.playbackInfoOf(current, "full", url).quality, "lossless");
  for (let i = 0; i < 100; i++) await host.api.playUrl(song("cache-" + i), "full");
  assert.equal(host.api.urlPlaybackInfo.size, 80);
  host.api.clearPlayUrlCache(); assert.equal(host.api.urlPlaybackInfo.size, 0);
});

function registryHost(host = serviceHost()) {
  const browse = { current: "package_a", setSource(id) { this.current = id; } };
  const state = { order: ["new_service", "package_b", "package_a"], fetch: () => Promise.reject(Error("old package")) };
  const context = { ...host.context, musicApi: host.api, reactive: Vue.reactive,
    ensureDataEngine: async () => true, sourceMetaRevision: () => "fixture-meta", sourceMetaCurrent: revision => revision === "fixture-meta",
    SOURCE_PACKS_CHANGED_EVENT: "pack-change", SOURCE_POLICY_CHANGED_EVENT: "policy-change", SOURCE_AUTH_CHANGED_EVENT: "auth-change",
    orderedSourceIds: ids => state.order.filter(id => ids.includes(id) && host.enabled.has(id)),
    clearQualityProfiles: () => host.profiles.clear(),
    fetchSourceQualityProfile: (...args) => state.fetch(...args),
    storeQualityProfile: (id, value) => host.profiles.set(id, value),
    sourceDownloadQualityOf: (_id, fallback) => fallback, setSourceDownloadQuality: noop, setSourcePlayQuality: noop, NETWORK_KIND_WIFI: 'wifi', NETWORK_KIND_CELLULAR: 'cellular', sourcePlayQualityForNetwork: (_id, fallback) => fallback, sourceDownloadQualityForNetwork: (_id, fallback) => fallback, setSourcePlayQualityForNetwork: noop, setSourceDownloadQualityForNetwork: noop,
    usePlayerStore: () => ({ quality: "full" }), useDownloadsStore: () => ({ downloadQuality: "full" }), useSourceStore: () => browse,
    setTimeout, clearTimeout,
  };
  const { useSourceRegistryStore } = evaluate(read("stores/source-registry.ts"), ["useSourceRegistryStore"], context);
  return { ...host, registry: useSourceRegistryStore(), browse, state };
}
function component(source, names, context, props) {
  const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
  const values = evaluate(script, ["props", ...names], { ...context, computed: Vue.computed, ref: Vue.ref,
    defineProps: () => props, withDefaults: (value, defaults) => Object.assign(value, { ...defaults, ...value }),
    defineEmits: () => context.emit });
  const render = new Function("Vue", compile(source.match(/<template>([\s\S]*?)<\/template>/)[1],
    { mode: "function", prefixIdentifiers: true, isCustomElement: () => true }).code)(Vue);
  const proxy = new Proxy({ ...context, ...props, ...values }, { get(target, key) {
    if (key in props) return props[key];
    const value = target[key]; return Vue.isRef(value) ? value.value : value;
  } });
  return { ...values, nodes: () => descendants(render(proxy, [])) };
}
function descendants(node) {
  if (node == null || typeof node !== "object") return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(descendants) : [])];
}
function styleValue(node, property) {
  const style = Vue.normalizeStyle(node.props?.style);
  if (typeof style === "string") {
    const entry = style.split(";").find(item => item.slice(0, item.indexOf(":")).trim() === property);
    return entry?.slice(entry.indexOf(":") + 1).trim();
  }
  return style?.[property] ?? style?.[property.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
}
const sheetSource = read("uni_modules/qt-ui/components/qt-playback-source-sheet/qt-playback-source-sheet.uvue");
const trackSource = read("uni_modules/qt-ui/components/qt-playing-track/qt-playing-track.uvue");
const metricSource = read("uni_modules/qt-ui/composables/playing-track-metrics.ts");
const metrics = evaluate(metricSource, ["playingTrackMetrics", "playbackSourceViewport"], {});
const optionNodes = component => component.nodes().filter(node => node.type === "QtOption");
const theme = { dark: false, skin: { text: "#222222", textMuted: "#777777", textSubtle: "#888888",
  danger: "#dd3344", divider: "#dddddd", surfaceMuted: "#eeeeee", border: "#dddddd" } };
function sheetHost(registry, width = 360, height = 640, wide = false, windowWidth = width) {
  const layout = Vue.reactive({ paneWidth: width, paneHeight: height, windowWidth, isWide: wide, isShort: height < 520, safeBottomPx: 24, sizeEpoch: 1 });
  const fonts = Vue.reactive({ scale: 1.15 }), props = Vue.reactive({ visible: true, source: "package_b", quality: "eco",
    local: false, podcast: false, section: "source", fileText: "" });
  const events = [], mounts = [], disposes = [], timers = new Map(); let timerId = 0;
  const base = { ...metrics, useQtLayout: () => layout, useFontScaleStore: () => fonts, fontScale: fonts,
    useThemeStore: () => theme, qtFontDual: () => "", qtSheetWidth: () => Math.min(layout.paneWidth, 420),
    useSourceRegistryStore: () => registry, emit: (...args) => events.push(args),
    onMounted: fn => mounts.push(fn), onUnmounted: fn => disposes.push(fn),
    watch: Vue.watch, nextTick: Vue.nextTick,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    ref: Vue.ref,
  };
  Object.assign(base, evaluate(read("uni_modules/qt-ui/composables/use-qt-selection-reveal.ts"), ["useQtSelectionReveal"],
    { ...base, computed: Vue.computed }));
  const sheet = component(sheetSource, ["emit", "layout", "theme", "registry", "sources", "specialCount", "qualities", "reveal", "qualityReveal", "viewportPx", "listPx", "headingPx", "columnWidthPx", "close", "pickSource", "pickQuality", "tvNoteLine"], base, props);
  mounts.forEach(fn => fn());
  return { sheet, props, layout, fonts, events, disposes, async flush() {
    await drain();
    const callbacks = [...timers.values()]; timers.clear();
    for (const fn of callbacks) fn();
    await Vue.nextTick();
  } };
}
await check("both columns centre their heading and option labels inside the column width", async () => {
  const host = registryHost(); await host.registry.ensure(); await drain();
  const sheet = sheetHost(host.registry); await sheet.flush();
  const headings = sheet.sheet.nodes().filter(node => (node.props?.class ?? "").split(" ").includes("pso-heading"));
  assert.equal(headings.length, 2, "one heading per column");
  assert.deepEqual(headings.map(node => node.children), ["播放来源", "音质"]);
  const rule = sheetSource.slice(sheetSource.indexOf(".pso-heading {"));
  assert.ok(rule.slice(0, rule.indexOf("}")).includes("text-align: center"), "heading text is centred by its own class");
  const options = optionNodes(sheet.sheet);
  assert.ok(options.length > 0);
  assert.ok(options.every(node => node.props["label-align"] === "center"), "every column row centres its label");
  const local = sheetHost(host.registry);
  local.props.local = true; await local.flush();
  assert.ok(optionNodes(local.sheet).every(node => node.props["label-align"] === "center"), "the local-file row stays centred");
});
await check("source sheet uses enabled package names/order, reacts to new platforms and reveals the selection", async () => {
  const host = registryHost(); await host.registry.ensure(); await drain();
  const sheet = sheetHost(host.registry); await sheet.flush();
  assert.deepEqual(optionNodes(sheet.sheet).slice(0, 3).map(node => node.props.label), ["新加入的服务", "数据包乙音乐", "数据包甲音乐"]);
  assert.equal(optionNodes(sheet.sheet).find(node => node.props.selected).props.label, "数据包乙音乐");
  assert.ok(sheet.sheet.reveal.anchor.value.endsWith("-1"));
  host.enabled.delete("package_b"); host.registry.applyPolicy(); await sheet.flush();
  assert.ok(optionNodes(sheet.sheet).every(node => node.props.label !== "数据包乙音乐"));
  assert.equal(sheet.sheet.reveal.anchor.value, "", "disabled/unknown source has no falsely selected row");
  host.registry.catalog.push({ id: "another", name: "来自新包的名称", short: "另", color: "#445566", qualities: ["eco"] });
  host.state.order.unshift("another"); host.enabled.add("another"); host.registry.applyPolicy();
  assert.equal(optionNodes(sheet.sheet)[0].props.label, "来自新包的名称");
  assert.equal(host.browse.current, "package_a", "opening/rendering the playback sheet never changes the browsing source");
});
await check("quality profiles update the open sheet; superseded profile replies cannot overwrite a new generation", async () => {
  const host = registryHost(); await host.registry.ensure(); await drain();
  const pending = deferred(), sheet = sheetHost(host.registry);
  host.state.fetch = id => id === "package_b" ? pending.promise : Promise.reject(Error("old"));
  host.uni.$emit("policy-change");
  const fresh = { mode: "official", qualities: [{ id: "studio", name: "包提供的录音室档", min: "none" }], aliases: new UTSJSONObject({ full: "studio" }) };
  host.state.fetch = async id => id === "package_b" ? fresh : Promise.reject(Error("old"));
  host.uni.$emit("policy-change"); await drain();
  pending.resolve({ mode: "official", qualities: [{ id: "outdated", name: "过期清单", min: "none" }], aliases: new UTSJSONObject() });
  await drain();
  assert.ok(optionNodes(sheet.sheet).some(node => node.props.label === "包提供的录音室档"));
  assert.ok(optionNodes(sheet.sheet).every(node => node.props.label !== "过期清单"));
  sheet.props.quality = "studio"; sheet.props.section = "quality"; await sheet.flush();
  const selected = optionNodes(sheet.sheet).filter(node => node.props.selected);
  assert.ok(selected.some(node => node.props.label === "包提供的录音室档"));
  assert.ok(sheet.sheet.qualityReveal.anchor.value.endsWith("-0"), "quality selection reveals its actual row in the right column");
});
await check("local files/podcasts and invalid IDs cannot dispatch unsupported selections; each supported click emits once", async () => {
  const host = registryHost(); await host.registry.ensure(); await drain();
  const sheet = sheetHost(host.registry);
  optionNodes(sheet.sheet)[0].props.onSelect();
  assert.deepEqual(sheet.events.slice(-2), [["update:visible", false], ["source", "new_service"]]);
  sheet.events.length = 0; sheet.props.visible = false;
  sheet.sheet.pickQuality("eco"); sheet.sheet.pickSource("new_service"); assert.equal(sheet.events.length, 0);
  sheet.props.visible = true; sheet.props.local = true;
  const localOptions = optionNodes(sheet.sheet);
  assert.equal(localOptions[0].props.label, "本地文件");
  assert.equal(localOptions[0].props.selected, true);
  assert.ok(localOptions.slice(1).every(node => node.props.disabled));
  sheet.sheet.pickQuality("eco"); sheet.sheet.pickSource("new_service"); assert.equal(sheet.events.length, 0);
  sheet.props.local = false; sheet.props.podcast = true;
  assert.deepEqual(optionNodes(sheet.sheet).map(node => node.props.label), ["播客音频"]);
  sheet.props.podcast = false; sheet.props.source = "removed"; sheet.props.quality = "removed";
  assert.ok(optionNodes(sheet.sheet).every(node => !node.props.selected));
  sheet.sheet.pickSource("removed"); sheet.sheet.pickQuality("removed"); assert.equal(sheet.events.length, 0);
});
await check("compact/wide/fold-pane templates reserve touch targets, text and bounded sheet viewports at five font sizes", async () => {
  const host = registryHost(); await host.registry.ensure(); await drain();
  for (const [width, height, wide, windowWidth] of [[320, 568, false, 320], [390, 844, false, 390],
    [340, 480, false, 700], [600, 360, true, 600], [900, 700, true, 900], [1600, 900, true, 1600]]) {
    const sheet = sheetHost(host.registry, width, height, wide, windowWidth);
    for (const scale of [0.85, 1, 1.15, 1.3, 1.5]) {
      sheet.fonts.scale = scale;
      const events = [];
      const props = Vue.reactive({ name: "这是一首很长的歌名，需要保持两行和独立的收藏按钮", artist: "歌手", sourceLabel: "包提供的很长的平台名称 · 包提供的音质",
        liked: false, active: true, widthPx: width - (wide ? 48 : 32), ink: "#222222", muted: "#777777", rail: "#eeeeee" });
      const track = component(trackSource, ["emit", "layout", "theme", "metrics", "titleWidthPx", "hitStyle", "sourceStyle"], {
        ...metrics, useQtLayout: () => sheet.layout, useFontScaleStore: () => sheet.fonts, useThemeStore: () => theme,
        qtFontDual: () => "", emit: (...args) => events.push(args),
      }, props);
      const nodes = track.nodes(), withClass = value => nodes.find(node => (node.props?.class ?? "").split(" ").includes(value));
      // 2026-11-14 用户裁定：歌名两行换行改单行跑马灯（QtMarquee），行框高度预算不变。
      assert.equal(withClass("pt-title").props.text, props.name);
      assert.equal(withClass("pt-title").props.active, true);
      assert.equal(styleValue(withClass("pt-like"), "width"), "44px");
      assert.equal(styleValue(withClass("pt-like"), "height"), "44px");
      assert.ok(track.metrics.value.artistWidthPx >= 0 && track.metrics.value.sourceWidthPx <= props.widthPx);
      assert.ok(track.metrics.value.sourceWidthPx >= 44 && track.metrics.value.metaRowPx >= 36);
      withClass("pt-source-hit").props.onClick({ stopPropagation: noop });
      withClass("pt-like").props.onClick({ stopPropagation: noop });
      assert.deepEqual(events.map(item => item[0]), ["source", "collect"]);
      const height = sheet.sheet.viewportPx.value;
      assert.ok(height >= 0 && height < sheet.layout.paneHeight * 0.86 - sheet.layout.safeBottomPx);
      assert.ok(optionNodes(sheet.sheet).every(node => node.props["row-min-height-px"] === 44), "touch height belongs to the native option root");
    }
  }
});
await check("the source is plain text pinned to the row's right edge over a tightened track block", async () => {
  // 用户 2026-11-13 二次裁定：来源保持无胶囊普通文字，但位置回到行尾最右（歌手 flex:1）；
  // 三行间距收紧——行间 margin 4→2、歌手/词作行触控底 44→36。总高度预算与 portraitPlayerMetrics 同源。
  const grouped = metrics.playingTrackMetrics(342, 390, false, false, 1, "网易·母带24bit", false, "自由的你", "邓紫棋");
  assert.equal(grouped.stacked, false, "an ordinary artist and source share one meta row");
  assert.ok(grouped.artistWidthPx < 80, "the artist keeps its natural text width instead of stretching");
  assert.ok(grouped.artistWidthPx + grouped.gapPx + grouped.sourceWidthPx <= 342, "artist, gap and source stay inside the block width");
  assert.ok(grouped.sourceWidthPx >= 44 && grouped.metaRowPx >= 36, "the source keeps a 44px-wide tap over a 36px-tall row");
  assert.ok(grouped.metaRowPx < 44, "the tightened meta row no longer reserves the old 44px floor");
  const overflow = metrics.playingTrackMetrics(200, 320, false, false, 1, "网易·母带24bit", false, "自由的你", "一二三四五六七八九十十一十二十三十四");
  assert.equal(overflow.stacked, true, "no room drops the source below the artist row");
  assert.equal(overflow.metaHeightPx, overflow.metaRowPx * 2 + 2, "stacking still reserves both rows with the tightened 2px gap");
  assert.ok(overflow.artistWidthPx <= 200 - 24 * 320 / 750 - 4 + 0.001, "the stacked artist keeps the full row minus its arrow");
  assert.ok(!/\.pt-source \{[^}]*background/.test(trackSource) && !/\.pt-source \{[^}]*border/.test(trackSource), "the pill background and border are gone");
  assert.ok(!trackSource.includes("pt-source\" :style=\"'width:' + metrics.sourceWidthPx + 'px;background-color:'"), "no inline pill color remains on the source");
  assert.ok(trackSource.includes("props.artist"), "the component feeds its real artist width to the metrics");
  assert.ok(/\.pt-artist \{[^}]*\bmin-width: 0;[^}]*flex: 1;[^}]*flex-direction: row;/.test(trackSource), "the artist stretches the meta row so the source pins to the far right");
  assert.ok(/\.pt-meta \{[^}]*margin-top: 2px/.test(trackSource), "the row spacing above the meta line is tightened to 2px");
  assert.match(read("uni_modules/qt-ui/composables/player-presentation.ts"), /playingTrackMetrics\(trackWidthPx, windowWidth, false, false, scale, sourceLabel, false, name, artist\)/, "the portrait budget receives the same artist");
  assert.match(read("pages/player/index.uvue"), /const result = portraitPlayerMetrics\([\s\S]*?tv\.enabled && tvCoverShown\.value \? "gallery" : playingStyle\.style, name\(\), artistText\(\)\);/, "the page passes its artist text to the portrait budget");
});

await check("a targeted source search cannot lose the selected platform in aggregate results or cache stale configuration", async () => {
  const bus = eventBus(), calls = [], pending = deferred(); let epoch = 1;
  const all = [song("wrong", "package_a"), { ...song("b", "package_b") }, { ...song("b", "package_b") }, { ...song("different", "package_b"), name: "完全不同" }];
  const musicApi = { playConfigEpoch: () => epoch, search: async (...args) => { calls.push(args); return pending.promise; }, allSearch: () => { throw Error("targeted search must not aggregate"); } };
  const api = evaluate(read("services/source-switch.ts"), ["findSourceCandidates", "peekSourceCandidates", "requests"], {
    musicApi, uni: bus, SOURCE_POLICY_CHANGED_EVENT: "policy-change", assertSourceEnabled: id => { if (id === "disabled") throw Error("disabled"); },
  });
  const job = api.findSourceCandidates(song("a"), 1, 5, false, "package_b");
  assert.equal(calls[0][1], "package_b"); pending.resolve(all);
  assert.deepEqual(plain(await job).map(item => item.id), ["b"]);
  assert.equal(api.requests.size, 0, "completed search guards are released");
  await api.findSourceCandidates(song("a"), 1, 5, false, "package_b"); assert.equal(calls.length, 1);
  assert.equal(api.peekSourceCandidates(song("a")), null, "targeted results do not pollute aggregate cache");
  const late = deferred(); musicApi.search = async () => late.promise;
  const stale = api.findSourceCandidates(song("new"), 1, 5, true, "package_b");
  epoch++; late.resolve(all); await assert.rejects(stale, /设置|候选/);
  assert.equal(api.peekSourceCandidates(song("new"), "package_b"), null);
  assert.equal(api.requests.size, 0, "rejected configuration guards are released");
  await assert.rejects(api.findSourceCandidates(song("a"), 1, 5, false, "disabled"), /disabled/);
  musicApi.search = async () => { throw Error("offline"); };
  await assert.rejects(api.findSourceCandidates(song("network"), 1, 5, true, "package_b"), /offline/);
  assert.equal(api.requests.size, 0, "failed searches do not leak guards");
});
await check("overlapping targeted searches cannot reuse a settled request guard or overwrite newer candidates", async () => {
  const replies = [deferred(), deferred(), deferred()], bus = eventBus();
  let next = 0;
  const api = evaluate(read("services/source-switch.ts"), ["findSourceCandidates", "peekSourceCandidates", "requests", "sourceSwitchCacheStat"], {
    musicApi: { playConfigEpoch: () => 1, search: () => replies[next++].promise },
    uni: bus, SOURCE_POLICY_CHANGED_EVENT: "policy-change", assertSourceEnabled: noop,
  });
  const current = song("a");
  const old = api.findSourceCandidates(current, 1, 5, true, "package_b");
  const newer = api.findSourceCandidates(current, 1, 5, true, "package_b");
  replies[1].resolve([song("newer", "package_b")]); await newer;
  const latest = api.findSourceCandidates(current, 1, 5, true, "package_b");
  replies[0].resolve([song("old", "package_b")]); await old;
  assert.equal(api.peekSourceCandidates(current, "package_b")[0].id, "newer");
  assert.equal(api.requests.size, 1, "the older reply cannot delete the latest in-flight guard");
  replies[2].resolve([song("latest", "package_b")]); await latest;
  assert.equal(api.peekSourceCandidates(current, "package_b")[0].id, "latest");
  assert.deepEqual(plain(api.sourceSwitchCacheStat()), { groups: 1, songs: 1 });
  assert.equal(api.requests.size, 0);
});

const pageSource = read("pages/player/index.uvue");
await check("wide control templates use native margins that agree with the transport and tool width budgets", () => {
  const { widePlayerMetrics } = evaluate(read("uni_modules/qt-ui/composables/player-presentation.ts"), ["widePlayerMetrics"], metrics);
  const centerTemplate = between(pageSource, '<view class="control-center-wide"', '\n            <view class="control-wing control-wing-right"');
  const toolsTemplate = between(pageSource, '<view class="control-tools-wide">', '\n            </view>');
  const render = template => new Function("Vue", compile(template,
    { mode: "function", prefixIdentifiers: true, isCustomElement: () => true }).code)(Vue);
  for (const short of [false, true]) for (const count of [0, 3, 5, 8]) {
    const wideMetrics = widePlayerMetrics(short ? 600 : 1440, short ? 360 : 900, 24, 24, short, count + 1, 1.15);
    const barTools = Array.from({ length: count }, (_item, index) => ({ id: "tool-" + index, icon: "music" }));
    const actions = [];
    const context = { wideMetrics, wideShort: short, wideTransportStyle: "height:" + wideMetrics.controlsRowPx + "px;",
      playerMuted: "#777777", playerControl: "#222222", playerControlInk: "#ffffff", barTools,
      cycleMode: () => actions.push("mode"), modeIconName: () => "repeat", openQueue: () => actions.push("queue"),
      player: { playing: false, previous: () => actions.push("previous"), toggle: () => actions.push("toggle"), next: () => actions.push("next") },
      onBarTool: id => actions.push(id), barIconColor: () => "#777777", openBarSheet: () => actions.push("more") };
    const center = render(centerTemplate)(context, []);
    const controls = center.children;
    assert.equal(controls.length, 5);
    const margins = controls.map(node => Number.parseFloat(styleValue(node, "margin-left") ?? "0"));
    assert.deepEqual(margins, [0, wideMetrics.controlGapPx, wideMetrics.controlGapPx, wideMetrics.controlGapPx, wideMetrics.controlGapPx]);
    assert.equal(44 * 4 + wideMetrics.mainSizePx + margins.reduce((sum, value) => sum + value, 0), Number.parseFloat(styleValue(center, "width")));
    controls.forEach(node => node.props.onClick());
    assert.deepEqual(actions, ["mode", "previous", "toggle", "next", "queue"]);
    const tools = descendants(render(toolsTemplate)(context, [])).filter(node => (node.props?.class ?? "").split(" ").includes("tool-btn"));
    assert.equal(tools.length, count + 1);
    const toolMargin = tools.reduce((sum, node) => sum + Number.parseFloat(styleValue(node, "margin-left") ?? "0"), 0);
    assert.equal(tools.length * 44 + toolMargin, wideMetrics.toolsWidthPx);
    assert.equal(styleValue(center, "gap"), undefined);
  }
  assert.doesNotMatch(pageSource, /\bgap\s*:/, "Vapor warned that CSS gap is unsupported; do not reintroduce it");
});
await check("source candidates keep complete versions, separate metadata and reject stale picks", () => {
  let revision = 1, configEpoch = 1, opened = null;
  const original = song("original"), selected = [];
  const candidate = { ...song("live", "package_b"), name: "사랑을 했다 (LOVE SCENARIO) (iKON JAPAN TOUR 2018)",
    singer: "iKON", album: "iKON JAPAN TOUR 2018", duration: 241, version: "Live" };
  const page = evaluate(between(pageSource, "function showSourceCandidates(", "function showSourceCandidateDetail("),
    ["showSourceCandidates", "sourceCandidateDescription"], {
      player: { current: original, playbackRevision: () => revision }, musicApi: { playConfigEpoch: () => configEpoch },
      sourceRegistry: { has: platform => platform === "package_b" }, pageAlive: true, pageVisible: { value: true },
      samePlaybackSong: (a, b) => a.id === b.id && a.platform === b.platform,
      platformLabel: () => "数据包乙音乐", format: seconds => Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0"),
      openActionSheet: (title, actions, pick) => { opened = { title, actions, pick }; },
      showSourceCandidateDetail: (...args) => selected.push(args),
    });
  page.showSourceCandidates(original, [candidate]);
  assert.equal(opened.actions[0].name, candidate.name);
  assert.equal(opened.actions[0].description, "iKON · 数据包乙音乐 · 4:01\niKON JAPAN TOUR 2018 · Live");
  opened.pick(opened.actions[0], 0);
  assert.equal(selected.length, 1);
  assert.equal(selected[0][1], candidate);
  revision++;
  opened.pick(opened.actions[0], 0);
  assert.equal(selected.length, 1, "a later playback action invalidates the displayed candidates");
  page.showSourceCandidates(original, [candidate]); configEpoch++;
  opened.pick(opened.actions[0], 0);
  assert.equal(selected.length, 1, "a package/config change invalidates the displayed candidates");
  assert.doesNotMatch(page.sourceCandidateDescription({ ...candidate, duration: undefined, album: "", version: "" }), /\n|undefined|NaN/);
});
function actionHost(audioSource = null) {
  const events = [], qualities = new Map(), pending = deferred(); let epoch = 1, revision = 1;
  const current = song("a"), player = Vue.reactive({ current, queue: [current], progress: 37, playing: false, radioActive: true,
    playbackRevision: () => revision, effQualityOf: value => qualities.get(value.platform) ?? "full", resolvedUrlOf: value => value.url ?? "",
    currentIndex: () => 0, setSourceQuality(id, platform) { qualities.set(platform, id); events.push(["quality", id, platform]); return true; },
    play(...args) { events.push(["play", ...args]); this.current = args[0]; this.queue = args[1]; this.playing = args[5]; revision++; },
    pause() { throw Error("replacement must not start then pause"); } });
  const musicApi = { playUrl: (...args) => { events.push(["preflight", ...args]); return pending.promise; }, playConfigEpoch: () => epoch,
    playbackInfoOf: value => ({ source: audioSource ?? value, quality: "full", size: 0 }), playSourceOf: value => value, actualQualityOf: () => "eco",
    invalidatePlayUrl: noop, invalidatePreferredSource: noop };
  const page = evaluate(between(pageSource, "let qualityRequestSeq", "\nfunction onDiscTap()") +
    between(pageSource, "function applySourceCandidate(", "\n/** Paint-only"), ["openPlaybackSource", "onPlaybackSourcePicked", "onPlaybackQualityPicked", "applyPlaybackQuality", "applySourceCandidate"], {
    player, musicApi, sourceRegistry: { has: () => true, sourceQualities: () => [{ id: "eco", name: "标准" }, { id: "full", name: "无损" }] },
    pageAlive: true, pageVisible: Vue.ref(true), playingLocalFile: Vue.ref(false), playingPodcast: Vue.ref(false),
    playbackInfo: Vue.computed(() => ({ source: audioSource ?? player.current })), playbackRequestedQuality: Vue.computed(() => player.effQualityOf(player.current)),
    playbackSourceOpen: Vue.ref(false), playbackSourceSection: Vue.ref("source"), playbackMetadataTick: Vue.ref(0),
    beginLoading: () => 1, finishLoading: noop, refreshBitrateSettled: noop, playbackQualityLabel: (_source, id) => id,
    savePreferredSource: (...args) => events.push(["preferred", ...args]), qtShowToast: noop,
    openSourceSwitch: (...args) => events.push(["search", ...args]),
    showSourceCandidateDetail: (...args) => events.push(["detail", ...args]),
  });
  return { page, player, events, pending, settingsChanged() { epoch++; }, selectionChanged() { revision++; } };
}
await check("quality/source replacement preserves pause, queue identity, radio and progress", async () => {
  const host = actionHost();
  const job = host.page.applyPlaybackQuality("eco");
  assert.equal(host.events[0][0], "preflight", "test actually reaches the asynchronous engine boundary");
  host.pending.resolve("https://audio.invalid/new"); await job;
  const play = host.events.find(item => item[0] === "play");
  assert.equal(play[1].id, "a"); assert.equal(play[1].platform, "package_a");
  assert.deepEqual(play.slice(3), [true, false, true, false], "restore position, radio active, start paused");
  assert.equal(host.player.progress, 37); assert.equal(host.player.playing, false);
  host.events.length = 0;
  host.page.applySourceCandidate(song("b", "package_b"));
  const sourcePlay = host.events.find(item => item[0] === "play");
  assert.equal(sourcePlay[1].platform, "package_a"); assert.equal(sourcePlay[1].id, "a");
  assert.equal(sourcePlay.at(-1), false); assert.equal(host.player.progress, 37);
});
for (const reason of ["song", "settings", "pause", "quality"]) await check("stale quality reply never commits after " + reason + " changes", async () => {
  const host = actionHost(), job = host.page.applyPlaybackQuality("eco");
  if (reason === "song") { host.player.current = song("new"); host.selectionChanged(); }
  if (reason === "settings") host.settingsChanged();
  if (reason === "pause") host.selectionChanged();
  if (reason === "quality") host.player.setSourceQuality("another", "package_a");
  const count = host.events.length;
  host.pending.resolve("https://audio.invalid/stale"); await job;
  assert.equal(host.events.length, count, "late result cannot save preferences/quality or start playback");
});
await check("source panel rejects a selection made for a prior playback action", () => {
  const host = actionHost(); host.page.openPlaybackSource("quality"); host.selectionChanged();
  host.page.onPlaybackQualityPicked("eco"); assert.equal(host.events.length, 0);
});
await check("returning from a fallback source keeps the original song available even when search excludes it", () => {
  const host = actionHost(song("fallback", "package_b"));
  host.player.current.url = "https://audio.invalid/fallback";
  host.page.openPlaybackSource();
  host.page.onPlaybackSourcePicked("package_a");
  assert.equal(host.events.length, 1);
  const detail = host.events[0];
  assert.equal(detail[0], "detail", "the original song must not depend on a search that excludes its ID");
  assert.equal(detail[1].id, "a"); assert.equal(detail[1].platform, "package_a");
  assert.equal(detail[2].id, "a"); assert.equal(detail[2].platform, "package_a");
  assert.equal(detail[2].url, "", "a fallback URL cannot be checked as the original source");
  assert.equal(host.player.current.url, "https://audio.invalid/fallback");
  assert.equal(host.player.progress, 37); assert.equal(host.player.playing, false);
  host.events.length = 0;
  host.page.openPlaybackSource();
  host.page.onPlaybackSourcePicked("new_service");
  assert.deepEqual(host.events, [["search", false, "new_service"]]);
  host.events.length = 0;
  host.page.openPlaybackSource(); host.selectionChanged();
  host.page.onPlaybackSourcePicked("package_a"); assert.equal(host.events.length, 0);
});

await check("native timeline receives a paused intent directly, without a transient resume", async () => {
  const source = read("stores/player.ts"), calls = [];
  const { PlayerStore } = evaluate(between(source, "class PlayerStore {", "\nconst player = reactive(new PlayerStore())"), ["PlayerStore"], {
    useDislikesStore: () => ({ filterQueue: value => value, hasRules: () => false }),
    audioPlayer: { pause: () => calls.push("pause"), setPlaylist: (...args) => calls.push(args), setRepeatMode: noop },
    desktopLyric: { notifySongChanged: noop }, qtDiag: noop,
  });
  const host = Object.create(PlayerStore.prototype), current = song("a");
  Object.assign(host, { current, queue: [current], playing: false, progress: 37, playSeq: 1, radioActive: true,
    stalledMap: new Map(), policyBlockedMap: new Map(), localPathByMid: new Map(), resolvedUrlMap: new Map(), history: [], lockedNextMid: "", mode: "repeat",
    listenSession: { start: noop }, startProgressClock: noop, persist: noop, syncSongExtras: noop, preloadNextUrl: noop,
    refreshLocalPathIndex: noop, adoptLocalPathIfIndexed: noop, buildTimelineItem: value => ({ mediaId: value.platform + ":" + value.id, uri: "fixture" }),
    markProgress(value) { this.progress = value; } });
  const next = { ...current, url: "https://audio.invalid/new" };
  await host.play(next, [next], true, false, true, false);
  assert.equal(host.playing, false); assert.equal(host.progress, 37);
  assert.equal(calls.length, 1); assert.equal(calls[0][2], false); assert.equal(calls[0][3], 37);
  assert.ok(host.pauseIntentAt > 0);
});

console.log("Playback source/player UI: " + passed + " production regressions passed");
