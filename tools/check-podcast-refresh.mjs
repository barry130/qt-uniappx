// 播客刷新回归：xml 请求的 dataType 声明、进入页面时的静默自动补拉、
// 刷新合并语义（新单集进、旧单集出、played/positionMs 保留）。
// 真实 services/podcast.ts + 假 uni/存储/网络；不发生产请求。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const podcastSource = read('services/podcast.ts');
const pageSource = read('pages/podcast/index.uvue');

// ---------- 静态断言 ----------
// 1. fetchFeedText 必须显式 dataType:"text"（XML 不是 JSON；http.ts 同款先例）
{
  const start = podcastSource.indexOf('function fetchFeedText');
  const end = podcastSource.indexOf('async function fetchParsedFeed');
  assert.ok(start > 0 && end > start, 'fetchFeedText missing');
  const fn = podcastSource.slice(start, end);
  assert.ok(fn.includes('dataType: "text"'), 'fetchFeedText must declare dataType:"text"');
}
// 2. 页面必须有静默自动补拉，且挂在 selectShow 上（进入页面/切换订阅都会走到）
{
  assert.ok(pageSource.includes('AUTO_REFRESH_MIN_INTERVAL_MS'), 'page must throttle auto-refresh');
  assert.ok(pageSource.includes('function autoRefreshIfStale'), 'page must define autoRefreshIfStale');
  const start = pageSource.indexOf('function selectShow');
  const end = pageSource.indexOf('function loadShows');
  assert.ok(start > 0 && end > start, 'selectShow missing');
  assert.ok(pageSource.slice(start, end).includes('autoRefreshIfStale'), 'selectShow must trigger auto-refresh');
  // 自动补拉必须带 silent 标志，失败不能打断用户
  assert.ok(pageSource.includes('refreshShow(showId, true)'), 'auto path must use silent mode');
}

// ---------- 行为回归：真实 podcast.ts ----------
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  set(key, value) { this[key] = value; }
}
const toUtso = (value) => {
  if (Array.isArray(value)) return value.map(toUtso);
  if (value != null && typeof value === 'object') {
    return new UTSJSONObject(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toUtso(item)]),
    ));
  }
  return value;
};
const parseJsonToUtso = (text) => toUtso(JSON.parse(text));
const numAt = (obj, key) => {
  const value = obj[key];
  return typeof value == 'number' ? value : 0;
};
const logs = [];

function compile(text) {
  const withoutImports = text
    .replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*/gm, '');
  return stripTypeScriptTypes(withoutImports, { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
}

function makeEnv(replies) {
  const env = {
    storage: new Map(), requests: [], replies: replies.slice(),
  };
  const uni = {
    getStorageSync: (key) => (env.storage.has(key) ? env.storage.get(key) : ''),
    setStorageSync: (key, value) => { env.storage.set(key, value); },
    removeStorageSync: (key) => { env.storage.delete(key); },
    request: (options) => {
      env.requests.push(options);
      const reply = env.replies.shift();
      assert.ok(reply, 'unexpected request: ' + options.url);
      queueMicrotask(() => {
        if (reply.fail) { options.fail({ errMsg: 'request:fail offline' }); return; }
        options.success({ statusCode: reply.status ?? 200, data: reply.data });
      });
    },
  };
  return { env, uni };
}

function loadPodcast(env, uni) {
  const context = vm.createContext({
    console: { log: () => {}, warn: (...a) => logs.push(a.join(' ')), error: () => {} },
    uni, UTSJSONObject, parseJsonToUtso, numAt,
    Date, Error, Math, JSON, Promise, String, Number, Array, Object, Record: Object,
  });
  vm.runInContext(
    compile(podcastSource) + '\n;globalThis.__api={addPodcastShow,refreshPodcastShow,listPodcastShows,listPodcastEpisodes,savePodcastProgress,PODCAST_MAX_EPISODES};',
    context,
  );
  return context.__api;
}

const feed = (items) => {
  const body = items.map(([title, pub, secs, hash]) =>
    `<item><title><![CDATA[${title}]]></title><pubDate>${pub}</pubDate>` +
    `<itunes:duration>${secs}</itunes:duration>` +
    `<enclosure type="audio/mpeg" length="123" url="https://cdn.example/${hash}.mp3?track=${hash}" /></item>`
  ).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>测试台</title><itunes:author>作者</itunes:author>` +
    `<description>简介</description><itunes:image href="https://img.example/cover.jpg" />${body}</channel></rss>`;
};

let pass = 0;
async function check(label, fn) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pending: ' + label)), 2000); }),
    ]);
    pass++;
    console.log('  ✓ ' + label);
  } finally {
    clearTimeout(timer);
  }
}

await check('订阅：解析并落存储', async () => {
  const { env, uni } = makeEnv([{ data: feed([['旧一集', 'Mon, 03 Aug 2026 08:00:00 GMT', '07:24', 'a1'], ['旧二集', 'Tue, 04 Aug 2026 08:00:00 GMT', '05:00', 'a2']]) }]);
  const api = loadPodcast(env, uni);
  const show = await api.addPodcastShow('https://pod.example/feed.xml');
  assert.equal(show.episodeCount, 2);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].dataType, 'text', '订阅请求必须 dataType:text');
  const eps = api.listPodcastEpisodes(show.id);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].title, '旧二集', '列表按发布时间倒序');
  assert.ok(env.storage.has('qt-podcast-shows'));
});

await check('刷新：新单集进、旧单集出、进度保留', async () => {
  const { env, uni } = makeEnv([
    { data: feed([['旧一集', 'Mon, 03 Aug 2026 08:00:00 GMT', '07:24', 'a1'], ['旧二集', 'Tue, 04 Aug 2026 08:00:00 GMT', '05:00', 'a2']]) },
    { data: feed([['新一集', 'Wed, 05 Nov 2026 00:33:00 GMT', '02:26', 'n9'], ['旧二集', 'Tue, 04 Aug 2026 08:00:00 GMT', '05:00', 'a2']]) },
  ]);
  const api = loadPodcast(env, uni);
  const show = await api.addPodcastShow('https://pod.example/feed.xml');
  // 用户听完旧二集的一半
  api.savePodcastProgress(show.id, show.episodeCount === 2 ? api.listPodcastEpisodes(show.id)[0].id : '', 60000, false);
  const next = await api.refreshPodcastShow(show.id);
  assert.equal(next.episodeCount, 2);
  assert.equal(env.requests.length, 2);
  assert.equal(env.requests[1].dataType, 'text', '刷新请求必须 dataType:text');
  const eps = api.listPodcastEpisodes(show.id);
  assert.equal(eps[0].title, '新一集', '最新一集排最前');
  assert.ok(!eps.some((ep) => ep.title === '旧一集'), 'feed 里不再出现的单集被清出');
  const survived = eps.find((ep) => ep.title === '旧二集');
  assert.ok(survived, '仍在 feed 里的单集保留');
  assert.equal(survived.positionMs, 60000, '进度不因刷新丢失');
  assert.ok(next.lastFetchedAt > 0);
});

await check('刷新：源拉取失败时原列表原样保留且报错', async () => {
  const { env, uni } = makeEnv([
    { data: feed([['旧一集', 'Mon, 03 Aug 2026 08:00:00 GMT', '07:24', 'a1']]) },
    { fail: true },
  ]);
  const api = loadPodcast(env, uni);
  const show = await api.addPodcastShow('https://pod.example/feed.xml');
  await assert.rejects(() => api.refreshPodcastShow(show.id), /订阅源拉取失败/);
  const eps = api.listPodcastEpisodes(show.id);
  assert.equal(eps.length, 1, '失败的刷新不能清掉原有单集');
  assert.equal(api.listPodcastShows()[0].episodeCount, 1);
});

console.log(`\n${pass} passed`);
