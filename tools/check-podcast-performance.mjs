// Production service + page script; large local feeds, no network/native claims.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const noop = () => {};
const ref = value => ({ value });
const computed = get => ({ get value() { return get(); } });
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return this[key] ?? null; }
  set(key, value) { this[key] = value; }
}
const toUTS = value => Array.isArray(value) ? value.map(toUTS) : value != null && typeof value === 'object'
  ? new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toUTS(v)]))) : value;
const compile = text => stripTypeScriptTypes(text.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, ''), { mode: 'strip' })
  .replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class))/g, '');
function load(source, names, extra) {
  const context = vm.createContext({ console, ref, shallowRef: ref, computed, UTSJSONObject,
    parseJsonToUtso: text => toUTS(JSON.parse(text)), numAt: (o, k) => Number(o[k]) || 0,
    logWarn: noop, logErrV: noop, ...extra });
  return vm.runInContext(compile(source) + '\n;({' + names + '})', context);
}
const serviceSource = read('services/podcast.ts');
const pageSource = read('pages/podcast/index.uvue');
function environment(count = 3) {
  const storage = new Map(), reads = [], timers = new Map();
  const shows = Array.from({ length: count }, (_, i) => ({ id: 's' + i, title: 'Show ' + i,
    url: 'https://example.test/' + i, author: 'Author', image: '', description: 'Show description',
    lastFetchedAt: Date.now(), episodeCount: 300 }));
  storage.set('qt-podcast-shows', JSON.stringify({ shows }));
  for (const show of shows) storage.set('qt-podcast-eps-' + show.id, JSON.stringify({ eps:
    Array.from({ length: 300 }, (_, i) => ({ id: show.id + '-' + i, showId: show.id,
      title: 'Episode ' + i, description: 'Long description '.repeat(100), audioUrl: `https://audio.test/${show.id}/${i}.mp3`,
      durationMs: 600000, publishedAt: Date.now() - i * 86400000, played: false, positionMs: 0 })) }));
  const uni = { getStorageSync(k) { reads.push(k); return storage.get(k) ?? ''; },
    setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k) };
  const service = load(serviceSource, 'listPodcastShows,listPodcastEpisodes,savePodcastProgress,removePodcastShow,PODCAST_PLATFORM', { uni });
  let mounted, unmounted, tid = 0;
  const player = { current: null, progress: 0, duration: 600, playing: false };
  function page(overrides = {}) {
    const api = load(pageSource.split('<script setup lang="ts">')[1].split('</script>')[0],
      'shows,episodes,visibleEpisodes,hasMoreEpisodes,selectedId,loadMoreEpisodes,selectShow,loadShows,trackTick,flushTracked,refreshShow,noticeMsg', {
        ...service, usePlayerStore: () => player, useThemeStore: () => ({}), useQtLayout: () => ({}),
        qtFontDual: () => '', watch: noop, onMounted: f => { mounted = f; }, onUnmounted: f => { unmounted = f; },
        setInterval: () => ++tid, clearInterval: noop,
        setTimeout(f) { timers.set(++tid, f); return tid; }, clearTimeout: id => timers.delete(id),
        refreshPodcastShow: async () => { throw Error('unexpected refresh'); }, ...overrides,
      });
    return { api, mount: () => mounted(), unmount: () => unmounted() };
  }
  function tick() { const batch = [...timers.values()]; timers.clear(); batch.forEach(f => f()); }
  return { storage, reads, timers, service, page, tick, player };
}
const episodeReads = env => env.reads.filter(k => k.startsWith('qt-podcast-eps-')).length;

{
  const e = environment(); const { api, mount, unmount } = e.page();
  mount();
  assert.equal(e.reads.length, 0, 'mount must let the navigation frame render before storage work');
  e.tick();
  assert.equal(episodeReads(e), 1, 'cold entry reads only the selected show, not all 900 episodes');
  assert.equal(api.episodes.value.length, 300);
  assert.equal(api.visibleEpisodes.value.length, 24, 'first native render is bounded');
  const ids = new Set(api.visibleEpisodes.value.map(ep => ep.id));
  while (api.hasMoreEpisodes.value) {
    api.loadMoreEpisodes();
    api.visibleEpisodes.value.forEach(ep => ids.add(ep.id));
  }
  assert.equal(ids.size, 300, 'all episodes remain accessible');
  api.selectShow('s1');
  assert.equal(api.visibleEpisodes.value.length, 24, 'new show resets batch');
  unmount();
  const again = e.page(); again.mount(); e.tick();
  assert.equal(episodeReads(e), 2, 're-entry reuses decoded storage');
  again.unmount();
  assert.equal(e.timers.size, 0);
  assert.match(pageSource, /v-for="ep in visibleEpisodes"[^>]*:key="ep.id"/);
  console.log('PASS navigation: 900 stored episodes, one cold read, 24 initial rows, cached re-entry');
}
{
  const e = environment();
  const first = e.service.listPodcastEpisodes('s0'); first[0].positionMs = 99999;
  assert.equal(e.service.listPodcastEpisodes('s0')[0].positionMs, 0, 'callers cannot mutate cached snapshot');
  e.service.savePodcastProgress('s0', 's0-0', 42000, false);
  assert.equal(e.service.listPodcastEpisodes('s0')[0].positionMs, 42000);
  assert.equal(JSON.parse(e.storage.get('qt-podcast-eps-s0')).eps[0].positionMs, 42000);
  const { api, mount, unmount } = e.page(); mount(); e.tick();
  api.selectShow('s1');
  e.player.current = { platform: 'podcast', id: 'https://audio.test/s2/0.mp3', album: 'Show 2' };
  e.player.progress = 57; api.trackTick(); api.flushTracked(true);
  assert.equal(e.service.listPodcastEpisodes('s2')[0].positionMs, 57000, 'list B still saves playing C');
  assert.equal(e.service.listPodcastEpisodes('s1')[0].positionMs, 0);
  e.service.removePodcastShow('s2');
  api.loadShows(); api.flushTracked(true);
  assert.equal(e.service.listPodcastEpisodes('s2').length, 0, 'removed cache cannot resurrect a show');
  unmount();
  console.log('PASS progress: cache isolation, persisted writes, cross-show lazy lookup, remove invalidation');
}
{
  const e = environment(6);
  for (let i = 0; i < 6; i++) e.service.listPodcastEpisodes('s' + i);
  e.service.listPodcastEpisodes('s5'); assert.equal(episodeReads(e), 6);
  e.service.listPodcastEpisodes('s0'); assert.equal(episodeReads(e), 7, 'old entries evicted from bounded cache');
  console.log('PASS memory: only four recent decoded subscription lists retained');
}
{
  const e = environment(); let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { api, mount, unmount } = e.page({ refreshPodcastShow: () => response });
  mount(); e.tick();
  const pending = api.refreshShow('s0'); api.selectShow('s1');
  finish({ title: 'Updated A', episodeCount: 300 }); await pending;
  assert.equal(api.selectedId.value, 's1', 'late refresh cannot steal selection');
  unmount();
  const cancelled = e.page(); cancelled.mount(); cancelled.unmount();
  assert.equal(e.timers.size, 0, 'quick navigation cancels deferred load/refresh');
  console.log('PASS lifecycle: refresh respects latest selection; fast exit cancels deferred work');
}
{
  const e = environment(); let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const page = e.page({ refreshPodcastShow: () => response });
  page.mount(); e.tick();
  const pending = page.api.refreshShow('s0'); page.unmount();
  const reads = e.reads.length;
  finish({ title: 'Late result', episodeCount: 300 }); await pending;
  assert.equal(e.reads.length, reads, 'disposed page must not reload lists after request completion');
  assert.equal(page.api.noticeMsg.value, '');
  assert.equal(e.timers.size, 0);
  console.log('PASS disposed refresh: service may persist, detached page does not create more UI work');
}
