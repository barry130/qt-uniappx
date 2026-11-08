// Run current production functions with synthetic storage/network/time boundaries.
// No live requests or native-runtime claims.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const noop = () => {};
const ref = value => ({ value });
const computed = get => ({ get value() { return get(); } });
const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  set(key, value) { this[key] = value; }
  getString(key) { const value = this.get(key); return value == null ? null : String(value); }
  getNumber(key) { const value = this.get(key); return value == null ? null : Number(value); }
  getBoolean(key) { const value = this.get(key); return value == null ? null : Boolean(value); }
  static keys(value) { return Object.keys(value); }
}
const toUTS = value => Array.isArray(value) ? value.map(toUTS) : value != null && typeof value === 'object'
  ? new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toUTS(item)]))) : value;
function compile(text) {
  return stripTypeScriptTypes(text.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, ''), { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
}
function load(text, names, extra = {}) {
  const context = vm.createContext({
    console, ref, computed, UTSJSONObject, parseJsonToUtso: text => toUTS(JSON.parse(text)),
    logMsgErr: noop, logWarn: noop, logErrV: noop, qtShowToast: noop,
    numAt: (object, key) => Number(object[key]) || 0, candidatesToJson: items => items,
    ...extra,
  });
  vm.runInContext(compile(text) + '\n;globalThis.api={' + names.join(',') + '};', context, { timeout: 5000 });
  return context.api;
}
function between(text, from, to) {
  const start = text.indexOf(from), end = text.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, 'source boundaries must exist: ' + from);
  return text.slice(start, end);
}
let passed = 0;
function pass(name) { passed++; console.log('PASS ' + name); }
const reply = content => ({ reply: content, songs: [], note: '', engine: 'local' });

function chatEnvironment(mode, extra = {}) {
  const timers = new Map(); let tid = 0;
  const api = load(read('composables/use-ai-chat.ts'), ['useAiChat'], {
    AI_MODE_LABEL_LOCAL: 'local', AI_MODE_LABEL_RULE: 'rule', AI_MODE_LABEL_SERVER: 'server',
    AI_MESSAGE_MAX_CHARS: 4000, AI_CANDIDATE_MAX: 30, readAiMode: () => mode, saveAiMode: noop,
    usePlayerStore: () => ({ current: null, queue: [], history: [], likedSongs: [] }),
    useSourceRegistryStore: () => ({ sources: [], ensure: async () => {} }),
    musicApi: { allSearch: async () => [] }, listLocalConversations: () => [], loadLocalMessages: () => [],
    loadPreference: async () => ({ style: null }), saveLocalConversation: () => 456,
    fetchConversations: async () => [], createConversation: async () => ({ id: 100 }),
    sendMessage: async () => ({ requestId: 200, assistantMessageId: 300 }), cancelRequest: async () => {},
    setTimeout: callback => { timers.set(++tid, callback); return tid; }, clearTimeout: id => timers.delete(id),
    ...extra,
  });
  return { chat: api.useAiChat(), timers };
}

// AI-01: old success/failure cannot overwrite another conversation or release its busy flag.
for (const outcome of ['success', 'failure']) {
  for (const newCompletesFirst of [false, true]) {
    const oldTurn = defer(), newTurn = defer(), writes = [];
    const { chat } = chatEnvironment('local', {
      runAssistantTurn: input => input.text === 'old-A' ? oldTurn.promise : newTurn.promise,
      saveLocalConversation: (id, title, messages) => { writes.push({ id, title, contents: messages.map(m => m.content) }); return 456; },
    });
    const oldSend = chat.send('old-A'); await drain();
    chat.newConversation();
    const newSend = chat.send('new-B'); await drain();
    if (newCompletesFirst) { newTurn.resolve(reply('reply-B')); await newSend; }
    if (outcome === 'success') oldTurn.resolve(reply('reply-A')); else oldTurn.reject(new Error('old failure'));
    await oldSend;
    assert.equal(chat.sending.value, !newCompletesFirst);
    assert.equal(chat.error.value, '');
    assert.equal(chat.messages.value[1].content, newCompletesFirst ? 'reply-B' : '');
    if (!newCompletesFirst) { newTurn.resolve(reply('reply-B')); await newSend; }
    assert.equal(writes.length, 1);
    assert.equal(writes[0].title, 'new-B');
    assert.deepEqual(Array.from(writes[0].contents), ['new-B', 'reply-B']);
    pass(`AI stale ${outcome}, new completes first=${newCompletesFirst}`);
  }
}
for (const change of ['open', 'mode', 'dispose']) {
  const pending = defer(); let writes = 0;
  const { chat } = chatEnvironment('local', {
    runAssistantTurn: () => pending.promise, saveLocalConversation: () => { writes++; return 456; },
  });
  const sending = chat.send('A'); await drain();
  if (change === 'open') await chat.openConversation(44);
  if (change === 'mode') chat.setEngineMode('rule');
  if (change === 'dispose') chat.dispose();
  pending.resolve(reply('late')); await sending;
  assert.equal(writes, 0); assert.equal(chat.error.value, '');
  pass('AI stale turn after ' + change);
}
{
  const candidate = defer(); let creates = 0, sends = 0;
  const { chat } = chatEnvironment('server', {
    musicApi: { allSearch: () => candidate.promise },
    createConversation: async () => { creates++; return { id: 100 }; },
    sendMessage: async () => { sends++; return { requestId: 200, assistantMessageId: 300 }; },
  });
  chat.agent.value = { agentCode: 'test' };
  const pending = chat.send('A'); await drain(); chat.newConversation();
  candidate.resolve([]); await pending;
  assert.equal(creates, 0); assert.equal(sends, 0); assert.equal(chat.messages.value.length, 0);
  pass('AI server candidate preparation cannot submit after conversation change');
}
// AI-02: late rejected/successful poll and already-dequeued timers all remain cancelled.
for (const outcome of ['success', 'failure', 'queued']) {
  const pending = defer(); let requests = 0;
  const { chat, timers } = chatEnvironment('server', { fetchEvents: () => { requests++; return pending.promise; } });
  chat.agent.value = { agentCode: 'test' }; chat.activeConversationId.value = 100;
  await chat.send('A'); await drain();
  let queued;
  if (outcome === 'queued') {
    pending.resolve({ nextSequence: 0, events: [], terminal: false }); await drain();
    queued = timers.values().next().value;
  }
  await chat.stop();
  if (outcome === 'failure') pending.reject(new Error('late failure'));
  if (outcome === 'success') pending.resolve({ nextSequence: 2, events: [], terminal: true, status: 'COMPLETED' });
  if (queued) queued();
  await drain();
  assert.equal(requests, 1); assert.equal(timers.size, 0); assert.equal(chat.error.value, '');
  assert.equal(chat.messages.value[1].status, 'CANCELLED');
  pass('AI stopped poll ' + outcome);
}
{
  const readback = defer();
  const { chat } = chatEnvironment('server', {
    fetchEvents: async () => ({ nextSequence: 1, events: [], terminal: true, status: 'SUCCEEDED' }),
    fetchMessages: () => readback.promise,
  });
  chat.agent.value = { agentCode: 'test' }; chat.activeConversationId.value = 100;
  await chat.send('A'); await drain(); chat.newConversation();
  chat.messages.value = [{ id: 300, role: 'ASSISTANT', content: 'new context' }];
  readback.resolve({ items: [{ id: 300, content: 'old saved reply', blocks: [], citations: [] }] }); await drain();
  assert.equal(chat.messages.value[0].content, 'new context');
  pass('AI terminal readback cannot patch a new conversation');
}

function podcastEnvironment() {
  const storage = new Map(), requests = [];
  let delayed = false;
  const feed = title => '<rss><channel><title>' + title + '</title><item><title>episode</title><enclosure url="https://audio.invalid/ep.mp3" type="audio/mpeg" /></item></channel></rss>';
  const api = load(read('services/podcast.ts'), ['addPodcastShow', 'refreshPodcastShow', 'removePodcastShow', 'listPodcastShows', 'listPodcastEpisodes', 'savePodcastProgress'], {
    uni: {
      getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key), request: options => {
        if (delayed) requests.push(options); else options.success({ statusCode: 200, data: feed(options.url) });
      },
    },
  });
  return { ...api, delay: value => { delayed = value; }, respond: (index, title) => requests[index].success({ statusCode: 200, data: feed(title) }) };
}
{
  const pod = podcastEnvironment();
  const a = await pod.addPodcastShow('https://feeds.invalid/A.xml');
  const b = await pod.addPodcastShow('https://feeds.invalid/B.xml');
  pod.delay(true); const pending = pod.refreshPodcastShow(a.id); pod.delay(false);
  pod.removePodcastShow(a.id);
  const c = await pod.addPodcastShow('https://feeds.invalid/C.xml');
  pod.respond(0, 'late-A'); await assert.rejects(pending, /订阅已经不在/);
  assert.deepEqual(Array.from(pod.listPodcastShows(), show => show.id), [c.id, b.id]);
  assert.equal(pod.listPodcastEpisodes(a.id).length, 0);
  pass('Podcast refresh cannot resurrect a removed subscription or lose a new one');
}
{
  const pod = podcastEnvironment();
  const a = await pod.addPodcastShow('https://feeds.invalid/A.xml');
  pod.delay(true); const pending = pod.refreshPodcastShow(a.id); pod.delay(false);
  pod.removePodcastShow(a.id); await pod.addPodcastShow(a.url);
  pod.respond(0, 'late-A'); await assert.rejects(pending, /订阅已变更/);
  assert.equal(pod.listPodcastShows()[0].title, a.url);
  pass('Podcast delete/re-add rejects the old subscription generation');
}
{
  const pod = podcastEnvironment(); const a = await pod.addPodcastShow('https://feeds.invalid/A.xml');
  pod.delay(true); const first = pod.refreshPodcastShow(a.id), latest = pod.refreshPodcastShow(a.id); pod.delay(false);
  const c = await pod.addPodcastShow('https://feeds.invalid/C.xml');
  const ep = pod.listPodcastEpisodes(a.id)[0]; pod.savePodcastProgress(a.id, ep.id, 32100, true);
  pod.respond(1, 'newest'); await latest; pod.respond(0, 'stale'); await assert.rejects(first, /订阅已变更/);
  assert.deepEqual(Array.from(pod.listPodcastShows(), show => show.id), [c.id, a.id]);
  assert.equal(pod.listPodcastShows()[1].title, 'newest');
  assert.equal(pod.listPodcastEpisodes(a.id)[0].positionMs, 32100); assert.equal(pod.listPodcastEpisodes(a.id)[0].played, true);
  pass('Podcast concurrent refresh preserves latest metadata, directory additions and progress');
}

// UI-01: exercise the actual retry callback after its real initial failing load.
{
  let calls = 0, fail = true;
  const home = load(between(read('pages/home/index.uvue'), 'const loading = ref(true);', 'function onMetaGuideDismiss()'),
    ['ensureLoadNow', 'retryLoad', 'loadFailed'], {
      sourceStore: { current: 'wyy' }, packsFingerprint: () => 'pack', ensureLocalStateRestored: async () => {},
      pickFeatured: noop, songs: ref([]), playlists: ref([]), charts: ref([]),
      musicApi: { latest: async () => [], charts: async () => [], recommendations: async () => { calls++; if (fail) throw new Error('offline'); return []; } },
    });
  home.ensureLoadNow(); await drain(); assert.equal(home.loadFailed.value, true);
  fail = false; home.retryLoad(); await drain();
  assert.equal(calls, 2); assert.equal(home.loadFailed.value, false);
  home.ensureLoadNow(); await drain(); assert.equal(calls, 2);
  pass('Home retry performs a fresh request while successful loading remains cached');
}
{
  const oldRecommendations = defer(), oldCharts = defer(), latestCalls = [];
  const sourceStore = { current: 'old' };
  const home = load(between(read('pages/home/index.uvue'), 'const loading = ref(true);', 'function onMetaGuideDismiss()'),
    ['ensureLoadNow'], {
      sourceStore, packsFingerprint: () => 'pack', ensureLocalStateRestored: async () => {},
      pickFeatured: noop, songs: ref([]), playlists: ref([]), charts: ref([]),
      musicApi: {
        recommendations: source => source === 'old' ? oldRecommendations.promise : Promise.resolve([]),
        charts: source => source === 'old' ? oldCharts.promise : Promise.resolve([]),
        latest: async source => { latestCalls.push(source); return []; },
      },
    });
  home.ensureLoadNow(); sourceStore.current = 'new'; home.ensureLoadNow(); await drain();
  oldRecommendations.resolve([]); oldCharts.resolve([]); await drain();
  assert.deepEqual(latestCalls, ['new']);
  pass('Home source change skips superseded heavy latest request');
}

// UI-02: All preview and dedicated tabs must share pagination geometry.
for (const kind of ['playlist', 'artist', 'album']) {
  const calls = [], collections = { playlists: ref([]), artists: ref([]), albums: ref([]) };
  const api = { search: async () => [] };
  for (const [type, method] of [['playlist', 'searchPlaylists'], ['artist', 'searchArtists'], ['album', 'searchAlbums']]) {
    api[method] = async (_word, _source, page, size) => {
      if (type === kind) calls.push({ page, size });
      return Array.from({ length: size }, (_, i) => ({ id: String((page - 1) * size + i + 1), platform: 'wyy' }));
    };
  }
  const search = load('let searchSeq=1; let songsAggLoaded=false; let allLoaded=false; let lastMergeFull=true; const aggSeenKeys=new Set();\n' +
    between(read('pages/search/index.uvue'), 'async function fetchPlaylists(', 'async function play(song:'),
    ['runAllSections', 'switchType', 'loadMoreResults'], {
      ...collections, songs: ref([]), type: ref('all'), types: ref(['all', 'song', 'playlist', 'artist', 'album']),
      sourceStore: { current: 'wyy' }, keyword: ref('test'), searched: ref(true), searching: ref(false),
      searchFailed: ref(false), allReady: ref(false), aggregateMode: ref(false), resultsLoadingMore: ref(false),
      resultsPage: { song: 1, playlist: 1, artist: 1, album: 1 }, resultsHasMore: { song: true, playlist: true, artist: true, album: true },
      scrollTop: ref(0), showBackToTop: ref(false), songPageSize: () => 30, musicApi: api, setTimeout,
    });
  await search.runAllSections('test', 1); search.switchType(['all', 'song', 'playlist', 'artist', 'album'].indexOf(kind));
  await search.loadMoreResults();
  assert.deepEqual(calls, [{ page: 1, size: 30 }, { page: 2, size: 30 }]);
  assert.deepEqual(Array.from(collections[kind + 's'].value, item => Number(item.id)), Array.from({ length: 60 }, (_, i) => i + 1));
  // Returning through All can replace shared arrays with page 1; it must reset the cursor too.
  await search.runAllSections('test', 1); await search.loadMoreResults();
  assert.deepEqual(calls.slice(-2), [{ page: 1, size: 30 }, { page: 2, size: 30 }]);
  assert.deepEqual(Array.from(collections[kind + 's'].value, item => Number(item.id)), Array.from({ length: 60 }, (_, i) => i + 1));
  pass('Search All to ' + kind + ' has no pagination gap');
}

const paging = load(read('services/paged-all.ts'), ['startPagedAllJob', 'clearPagedAllJob']);
const waitJob = job => new Promise(resolve => job.subscribe(state => { if (state.finished) resolve(state); }));
const options = fetchPage => ({ pageSize: 1, concurrency: 2, maxPages: 6, keyOf: song => song.id, fetchPage });
const page = (id, hasMore) => ({ songs: id == null ? [] : [{ id: String(id) }], meta: '', hasMore });
for (const sparse of ['empty', 'duplicate']) {
  const calls = [];
  const job = paging.startPagedAllJob(sparse, options(async number => {
    calls.push(number); return page(number === 2 ? (sparse === 'empty' ? null : 1) : number, number < 3);
  }));
  const state = await waitJob(job);
  assert.deepEqual(Array.from(state.items, item => item.id), ['1', '3']);
  assert.equal(state.status, 'complete'); assert.ok(calls.includes(3));
  pass('Pagination respects authoritative hasMore on ' + sparse + ' middle page');
}
{
  const calls = []; let fail = true;
  const job = paging.startPagedAllJob('retry', options(async number => {
    calls.push(number); if (number === 3 && fail) throw new Error('offline'); return page(number, number < 4);
  }));
  const partial = await waitJob(job);
  assert.equal(partial.status, 'error'); assert.deepEqual(Array.from(partial.failedPages), [3]);
  assert.deepEqual(Array.from(partial.items, item => item.id), ['1', '2', '4']);
  fail = false; job.retry(); const complete = await waitJob(job);
  assert.equal(complete.status, 'complete'); assert.deepEqual(Array.from(complete.items, item => item.id), ['1', '2', '3', '4']);
  assert.deepEqual(calls, [1, 2, 3, 4, 3]);
  pass('Pagination reports partial failure and retries only the failed page');
}
{
  let failedOnce = false;
  const job = paging.startPagedAllJob('first-failure', options(async number => {
    if (!failedOnce) { failedOnce = true; throw new Error('first page offline'); }
    return page(number, false);
  }));
  assert.equal((await waitJob(job)).status, 'error');
  job.retry(); assert.equal((await waitJob(job)).status, 'complete');
  pass('Pagination first-page failure can retry to complete');
}
{
  const job = paging.startPagedAllJob('limit', { ...options(async () => page(1, true)), maxPages: 3 });
  const state = await waitJob(job); assert.equal(state.status, 'limit'); assert.ok(state.error.length > 0);
  pass('Pagination safety limit never claims complete');
}
{
  const pending = defer();
  const job = paging.startPagedAllJob('cancel', options(() => pending.promise));
  paging.clearPagedAllJob('cancel'); pending.resolve(page(1, false)); await drain();
  assert.equal(job.state.status, 'cancelled'); assert.equal(job.state.items.length, 0);
  pass('Cancelled pagination ignores its late successful page');
}

// UI-04/05: run artist's real context creation and listener, with the real paging job.
{
  const artistText = read('pages/artist/index.uvue');
  let fingerprint = 'pack-A', pageSize = 1;
  const requests = [], pendingFirst = defer(), sourceStore = { current: 'wyy' };
  const refs = { songs: ref([]), loading: ref(true), finished: ref(false), loadError: ref(''), loadStatus: ref('running'), avatarUrl: ref('') };
  const artist = load(`let cacheKey=''; let loadedSource=''; let loadedPackFp=''; let loadedPageSize=0; let job=null; let onJobState=null; let pageDisposed=false; const ARTIST_PAGE_SIZE=30;\n` +
    between(artistText, 'async function fetchPage(', 'async function play(song:'), ['ensureLoad', 'detach', 'retry'], {
      ...refs, sourceStore, artist: ref('Test Artist'), artistId: ref('artist-id'),
      packsFingerprint: () => fingerprint, readAvatar: () => '', rememberAvatar: noop, resolveArtistId: async () => 'artist-id',
      startPagedAllJob: paging.startPagedAllJob, clearPagedAllJob: paging.clearPagedAllJob,
      musicApi: { ensureRegistry: async () => {}, clampSearchPageSize: () => pageSize, artistSongs: async (name, source, number, size, id) => {
        requests.push({ name, source, number, size, id });
        if (number === 1) return pendingFirst.promise;
        return { songs: [{ id: source + '-' + number, platform: source }], picUrl: '', hasMore: number < 3 };
      } },
    });
  artist.ensureLoad(); await drain(); artist.detach(); sourceStore.current = 'qq'; pageSize = 9;
  pendingFirst.resolve({ songs: [{ id: 'wyy-1', platform: 'wyy' }], picUrl: '', hasMore: true }); await drain();
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(request => request.source === 'wyy' && request.size === 1 && request.id === 'artist-id'));
  assert.match(artistText, /loadError\.value = state\.error/);
  assert.match(artistText, /loadStatus == 'complete'/);
  assert.match(artistText, /action-text="重试加载"/);
  pass('Detached artist job keeps captured source, artist and page size; UI distinguishes completion');
}
{
  let fingerprint = 'old'; const pending = defer(); const cleared = [];
  const artist = load(between(read('pages/artist/index.uvue'), 'async function fetchPage(', '/** 退订当前任务'), ['fetchPage'], {
    packsFingerprint: () => fingerprint, clearPagedAllJob: key => cleared.push(key), resolveArtistId: async () => 'id',
    musicApi: { artistSongs: () => pending.promise },
  });
  const context = { source: 'wyy', artist: 'A', artistId: 'id', pageSize: 30, packFingerprint: 'old', key: 'artist-old' };
  const request = artist.fetchPage(1, context); fingerprint = 'new';
  pending.resolve({ songs: [], picUrl: '', hasMore: false }); await assert.rejects(request, /音源包已变更/);
  assert.deepEqual(cleared, ['artist-old']);
  pass('Artist package replacement invalidates the old job before response commit');
}

console.log(`AI/podcast/UI regressions: ${passed} passed`);
