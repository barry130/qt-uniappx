// Isolated download regressions. The actual DownloadsStore and Harmony native
// save function run against in-memory storage/files and synthetic HTTP responses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
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
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const noop = () => {};
const norm = (value) => JSON.parse(JSON.stringify(value));

function compile(text) {
  return stripTypeScriptTypes(
    text.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, ''),
    { mode: 'strip' },
  ).replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
}

function load(text, names, extra = {}) {
  const context = vm.createContext({
    console,
    UTSJSONObject,
    parseJsonToUtso,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...extra,
  });
  vm.runInContext(
    compile(text) + `\n;globalThis.__api={${names.join(',')}};`,
    context,
  );
  return context.__api;
}

function boundary(seed = []) {
  const storage = new Map(seed);
  const uni = {
    getStorageSync: (key) => storage.get(key) ?? '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    env: {},
    $emit: noop,
  };
  return { storage, uni };
}

const downloadsText = read('stores/downloads.ts');
const downloadsSource = downloadsText.slice(
  0,
  downloadsText.indexOf('\nconst downloads = reactive(new DownloadsStore())'),
);

function store(b, extra = {}) {
  const api = load(downloadsSource, ['DownloadsStore'], {
    uni: b.uni,
    reactive: (value) => value,
    qtDiag: noop,
    qtDiagDebug: noop,
    logWarn: noop,
    logErrV: noop,
    qtShowToast: noop,
    restoreCustomDir: noop,
    sourceDownloadQualityOf: () => '',
    isPlayUrlStale: () => false,
    isEncryptedMediaUrl: () => false,
    musicApi: {
      clampQualityFor: (_platform, quality) => quality,
      refererOf: () => '',
      actualQualityOf: () => '',
      ensureRegistry: async () => {},
    },
    deleteMediaByPath: () => ({ deleted: 0, failed: 0 }),
    saveToPublicMedia: async () => '',
    ensurePublicDirPermission: async () => false,
    embedAudioTags: async (path) => path,
    statLocalFile: () => 0,
    ...extra,
  });
  return new api.DownloadsStore();
}

function song(id = 'S', name = 'synthetic') {
  return {
    id,
    name,
    singer: 'audit',
    album: '',
    picUrl: '',
    platform: 'test',
    url: `https://media.invalid/${id}.mp3`,
  };
}

function task(value) {
  return {
    song: value,
    status: 'downloading',
    path: '',
    error: '',
    progress: 0,
    doneBytes: 0,
    totalBytes: 0,
    speed: 0,
    lastBytes: 0,
    retryCount: 0,
    retryAt: 0,
    cancelled: false,
    runId: 1,
    abortHandle: null,
  };
}

async function resumeStart(meta, callUrl, partBytes = 2) {
  const b = boundary();
  const files = new Map();
  const partPath = '/parts/test__resume-check.part';
  files.set(partPath, new Uint8Array(partBytes));
  files.set(`${partPath}.meta`, JSON.stringify(meta));
  b.uni.getFileSystemManager = () => ({
    mkdirSync: noop,
    readFileSync: (path) => files.get(path),
    writeFileSync: (path, value) => {
      files.set(path, typeof value === 'string' ? value : new Uint8Array(value));
    },
    unlinkSync: (path) => files.delete(path),
  });
  const downloads = store(b);
  downloads.partSizeOf = () => files.get(partPath)?.byteLength ?? 0;
  downloads.appendChunkToPart = async (_chunk, targetPath) => {
    const previous = files.get(targetPath) ?? new Uint8Array();
    const expected = 8 - previous.byteLength;
    const next = new Uint8Array(8);
    next.set(previous);
    files.set(targetPath, next);
    return expected;
  };
  const starts = [];
  downloads.fetchChunk = async (_url, _platform, start, end) => {
    starts.push(start);
    return {
      temp: '/resume-check-chunk', whole: false,
      rangeStart: start, rangeEnd: end, rangeTotal: 8,
      etag: '"current-v1"', lastModified: '',
    };
  };
  const current = task(song('resume-check'));
  await downloads.fetchResumable(
    callUrl,
    current.song,
    8,
    'test__resume-check__320',
    '/parts',
    current,
    1,
  );
  return { starts, files, partPath };
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + label);
}

await check('DL-01：v2 对象台账保留含 || 的合法歌名和精确侧车路径', async () => {
  const b = boundary();
  const downloads = store(b);
  downloads.items = [{
    song: song('pipe', 'A || B'),
    path: '/downloads/A.mp3',
    time: 123,
    size: 456,
    sidecars: ['/downloads/A.jpg'],
  }];
  downloads.save();
  const persisted = JSON.parse(b.storage.get('qt-downloads'));
  assert.equal(persisted.version, 2);
  downloads.items = [];
  downloads.restore();
  assert.equal(downloads.items.length, 1);
  assert.equal(downloads.items[0].song.name, 'A || B');
  assert.deepEqual(norm(downloads.items[0].sidecars), ['/downloads/A.jpg']);
});

await check('DL-01：单条损坏记录被跳过，前后健康下载记录保留', async () => {
  const b = boundary();
  const downloads = store(b);
  const first = {
    song: song('one'), path: '/downloads/one.mp3', time: 1, size: 1, sidecars: [],
  };
  const second = {
    song: song('two'), path: '/downloads/two.mp3', time: 2, size: 2, sidecars: [],
  };
  b.storage.set('qt-downloads', JSON.stringify({
    version: 2,
    items: [first, 7, second],
  }));
  downloads.restore();
  assert.deepEqual(norm(downloads.items.map((item) => item.song.id)), ['one', 'two']);
});

await check('DL-01：老格式迁移能识别 JSON 边界中的 ||，其余损坏行不影响健康行', async () => {
  const b = boundary();
  const downloads = store(b);
  const legacySong = JSON.stringify(song('legacy', 'A || B'));
  b.storage.set('qt-downloads', JSON.stringify([
    `${legacySong}||/downloads/legacy.mp3||99`,
    7,
    `${JSON.stringify(song('healthy'))}||/downloads/healthy.mp3`,
  ]));
  downloads.restore();
  assert.deepEqual(norm(downloads.items.map((item) => item.song.id)), ['legacy', 'healthy']);
  assert.equal(downloads.items[0].song.name, 'A || B');
  assert.equal(downloads.items[0].size, 99);
});

await check('DL-01：任务队列使用结构化记录，逐条隔离损坏行', async () => {
  const b = boundary();
  const downloads = store(b);
  const failed = task(song('failed', 'A || B'));
  failed.status = 'failed';
  failed.error = 'temporary || server error';
  downloads.tasks = [failed, task(song('paused'))];
  downloads.saveTasks();
  const persisted = JSON.parse(b.storage.get('qt-download-tasks'));
  persisted.tasks.splice(1, 0, 7);
  b.storage.set('qt-download-tasks', JSON.stringify(persisted));
  downloads.tasks = [];
  downloads.restoreTasks();
  assert.deepEqual(norm(downloads.tasks.map((item) => item.song.id)), ['failed', 'paused']);
  assert.equal(downloads.tasks[0].status, 'failed');
  assert.equal(downloads.tasks[0].error, 'temporary || server error');
  assert.equal(downloads.tasks[1].status, 'paused');
});

await check('DL-02：最后一次 stat 等待期间取消，不提交完成且只清理本次发布路径', async () => {
  const b = boundary();
  const deleted = [];
  const downloads = store(b, {
    deleteMediaByPath: (paths) => {
      deleted.push(...paths);
      return { deleted: paths.length, failed: 0 };
    },
  });
  const value = song('cancel');
  const current = task(value);
  downloads.tasks = [current];
  downloads.fetchToTemp = async () => '/temp/cancel.mp3';
  downloads.saveToDisk = async () => ({
    path: '/downloads/cancel.mp3',
    sidecars: ['/downloads/cancel.jpg'],
  });
  downloads.fileSizeOf = async () => {
    downloads.removeTask(value);
    return 123;
  };
  await downloads.runTaskInner(current, 1);
  assert.equal(current.cancelled, true);
  assert.equal(downloads.tasks.length, 0);
  assert.equal(downloads.items.length, 0);
  assert.notEqual(current.status, 'done');
  assert.deepEqual(deleted, ['/downloads/cancel.mp3', '/downloads/cancel.jpg']);
});

await check('DL-03：删除只使用台账登记路径，不猜同名用户文件并尊重共享引用', async () => {
  const b = boundary();
  const files = new Set([
    '/user/a.mp3',
    '/user/a.jpg',
    '/owned/a.jpg',
    '/shared/a.lrc',
  ]);
  const downloads = store(b, {
    deleteMediaByPath: (paths) => {
      let deleted = 0;
      for (const path of paths) {
        if (files.delete(path)) deleted++;
      }
      return { deleted, failed: paths.length - deleted };
    },
  });
  const target = song('sidecar');
  downloads.items = [
    {
      song: target,
      path: '/user/a.mp3',
      time: 1,
      size: 1,
      sidecars: ['/owned/a.jpg', '/shared/a.lrc'],
    },
    {
      song: song('keep', 'keep'),
      path: '/user/keep.mp3',
      time: 2,
      size: 2,
      sidecars: ['/shared/a.lrc'],
    },
  ];
  downloads.removeMany([target], true);
  assert.equal(files.has('/user/a.mp3'), false);
  assert.equal(files.has('/owned/a.jpg'), false);
  assert.equal(files.has('/user/a.jpg'), true, 'unowned sidecar must not be guessed/deleted');
  assert.equal(files.has('/shared/a.lrc'), true, 'shared sidecar remains while referenced');
});

await check('DL-04：旧 total 与响应 Content-Range 冲突时丢弃旧前缀并按新总长重下', async () => {
  const b = boundary();
  const files = new Map();
  const ranges = [];
  const ifRanges = [];
  const chunkSizes = new Map([['/chunk-old', 2], ['/chunk-new', 8]]);
  const partPath = '/parts/test__resume.part';
  files.set(partPath, new Uint8Array(2));
  files.set(`${partPath}.meta`, JSON.stringify({
    url: 'https://media.invalid/media?token=old',
    total: 4,
    resourceKey: 'test__resume__320',
    etag: '"old-v1"',
  }));
  b.uni.getFileSystemManager = () => ({
    mkdirSync: noop,
    readFileSync: (path) => files.get(path),
    writeFileSync: (path, value) => {
      if (typeof value === 'string') {
        files.set(path, value);
      } else {
        files.set(path, new Uint8Array(value));
      }
    },
    unlinkSync: (path) => files.delete(path),
  });
  b.uni.downloadFile = (options) => {
    ranges.push(options.header.get('Range'));
    ifRanges.push(options.header.get('If-Range'));
    if (ranges.length === 1) {
      options.success({
        statusCode: 206,
        tempFilePath: '/chunk-old',
        header: { 'Content-Range': 'bytes 2-3/8', ETag: '"new-v1"' },
      });
    } else {
      options.success({
        statusCode: 206,
        tempFilePath: '/chunk-new',
        header: { 'Content-Range': 'bytes 0-7/8', ETag: '"new-v1"' },
      });
    }
    return null;
  };
  const downloads = store(b);
  downloads.partSizeOf = () => files.get(partPath).byteLength;
  downloads.appendChunkToPart = async (chunkPath, targetPath) => {
    const previous = files.get(targetPath) ?? new Uint8Array();
    const next = new Uint8Array(previous.byteLength + chunkSizes.get(chunkPath));
    next.set(previous);
    next.set(
      new Uint8Array(chunkSizes.get(chunkPath)).fill(1),
      previous.byteLength,
    );
    files.set(targetPath, next);
    return chunkSizes.get(chunkPath);
  };
  const current = task(song('resume'));
  const completed = await downloads.fetchResumable(
    'https://media.invalid/media?token=new',
    current.song,
    4,
    'test__resume__320',
    '/parts',
    current,
    1,
  );
  assert.deepEqual(ranges, ['bytes=2-3', 'bytes=0-7']);
  assert.deepEqual(ifRanges, ['"old-v1"', '"new-v1"']);
  assert.equal(files.get(completed).byteLength, 8);
  const meta = JSON.parse(files.get(`${partPath}.meta`));
  assert.equal(meta.total, 8);
  assert.equal(meta.resourceKey, 'test__resume__320');
  assert.equal(meta.etag, '"new-v1"');
});

await check('DL-04：total 相同但 ETag 变化时仍丢弃旧前缀并重新校验身份', async () => {
  const b = boundary();
  const files = new Map();
  const partPath = '/parts/test__same-total.part';
  files.set(partPath, new Uint8Array(2));
  files.set(`${partPath}.meta`, JSON.stringify({
    url: 'https://media.invalid/current',
    total: 8,
    resourceKey: 'test__same-total__320',
    etag: '"old-v1"',
  }));
  b.uni.getFileSystemManager = () => ({
    mkdirSync: noop,
    readFileSync: (path) => files.get(path),
    writeFileSync: (path, value) => {
      files.set(path, typeof value === 'string' ? value : new Uint8Array(value));
    },
    unlinkSync: (path) => files.delete(path),
  });
  const downloads = store(b);
  downloads.partSizeOf = () => files.get(partPath).byteLength;
  downloads.appendChunkToPart = async (chunkPath, targetPath) => {
    const previous = files.get(targetPath) ?? new Uint8Array();
    const size = chunkPath === '/old-chunk' ? 2 : 8;
    const next = new Uint8Array(previous.byteLength + size);
    next.set(previous);
    files.set(targetPath, next);
    return size;
  };
  const ifRanges = [];
  downloads.fetchChunk = async (_url, _platform, start, end, _total, _done, _task, _run, ifRange) => {
    ifRanges.push(ifRange);
    const changed = ifRange === '"old-v1"';
    return changed
      ? {
          temp: '/old-chunk', whole: false,
          rangeStart: start, rangeEnd: end, rangeTotal: 8,
          etag: '"new-v1"', lastModified: '',
        }
      : {
          temp: '/new-chunk', whole: false,
          rangeStart: 0, rangeEnd: 7, rangeTotal: 8,
          etag: '"new-v1"', lastModified: '',
        };
  };
  const current = task(song('same-total'));
  const completed = await downloads.fetchResumable(
    'https://media.invalid/current',
    current.song,
    8,
    'test__same-total__320',
    '/parts',
    current,
    1,
  );
  assert.deepEqual(ifRanges, ['"old-v1"', '"new-v1"']);
  assert.equal(files.get(completed).byteLength, 8);
});

await check('DL-04：旧 meta 缺强验证器时保守丢弃已下载前缀', async () => {
  const result = await resumeStart({
    url: 'https://media.invalid/media?token=old',
    total: 8,
    resourceKey: 'test__resume-check__320',
  }, 'https://media.invalid/media?token=new');
  assert.deepEqual(result.starts, [0]);
  assert.equal(result.files.get(result.partPath).byteLength, 8);
});

await check('DL-04：URL endpoint 变化时即使有强 ETag 也从头下载', async () => {
  const result = await resumeStart({
    url: 'https://media.invalid/old-endpoint?token=old',
    total: 8,
    resourceKey: 'test__resume-check__320',
    etag: '"old-v1"',
  }, 'https://media.invalid/new-endpoint?token=new');
  assert.deepEqual(result.starts, [0]);
});

await check('DL-04：已完整的旧 part 即使有 ETag 也不直接跳过校验', async () => {
  const result = await resumeStart({
    url: 'https://media.invalid/media?token=old',
    total: 8,
    resourceKey: 'test__resume-check__320',
    etag: '"old-v1"',
  }, 'https://media.invalid/media?token=new', 8);
  assert.deepEqual(result.starts, [0]);
  assert.equal(result.files.get(result.partPath).byteLength, 8);
});

function transferFixture(replies, options = {}) {
  const fixtureBoundary = boundary();
  fixtureBoundary.uni.env.USER_DATA_PATH = '/private';
  const files = new Map();
  const requests = [];
  const logs = [];
  const base = '/private/qt-download-parts';
  const sample = song('headers');
  const current = task(sample);
  const partPath = base + '/test__headers.part';
  const metaPath = partPath + '.meta';
  if (options.resume) {
    files.set(partPath, Uint8Array.from([7, 7]));
    files.set(metaPath, JSON.stringify({
      url: sample.url, total: 8, resourceKey: 'test__headers__320', etag: '"v1"',
    }));
  }
  fixtureBoundary.uni.getFileSystemManager = () => ({
    mkdirSync: noop,
    readFileSync: (filePath) => files.get(filePath),
    writeFileSync: (filePath, value) => files.set(filePath, typeof value === 'string' ? value : new Uint8Array(value)),
    unlinkSync: (filePath) => files.delete(filePath),
    statSync: (filePath) => files.has(filePath) ? [{ stats: { size: files.get(filePath).byteLength ?? 0 } }] : [],
    readFile: ({ filePath, success }) => success({ data: files.get(filePath) }),
    appendFile: ({ filePath, data, success }) => {
      const previous = files.get(filePath);
      const joined = new Uint8Array(previous.byteLength + data.byteLength);
      joined.set(previous);
      joined.set(data, previous.byteLength);
      files.set(filePath, joined);
      success({});
    },
  });
  fixtureBoundary.uni.downloadFile = (request) => {
    requests.push(request);
    const reply = replies[requests.length - 1];
    assert.ok(reply, 'unexpected extra download request');
    let progressCallback = noop;
    const handle = {
      abort: () => request.fail({ errMsg: 'downloadFile:fail abort' }),
      onProgressUpdate: (callback) => { progressCallback = callback; },
    };
    if (reply.manual) return handle;
    queueMicrotask(() => {
      if (reply.before) reply.before(current);
      if (reply.fail) { request.fail(reply.fail); return; }
      const data = Uint8Array.from(reply.bytes ?? [1, 2, 3, 4, 5, 6, 7, 8]);
      files.set(reply.tempFilePath, data);
      progressCallback({ progress: 100, totalBytesWritten: data.byteLength, totalBytesExpectedToWrite: data.byteLength });
      request.success(reply);
    });
    return handle;
  };
  const downloads = store(fixtureBoundary, { qtDiagDebug: (message) => logs.push(message), ...options.runtime });
  downloads.tasks = [current];
  return { downloads, current, base, files, requests, partPath, metaPath, logs };
}

await check('DL-06：真实 downloadFile 无响应头的 206 自动整下，旧断点和分块不会拼进成品', async () => {
  const fixture = transferFixture([
    { statusCode: 206, tempFilePath: '/chunk-no-headers', bytes: [9, 9, 9, 9, 9, 9] },
    { statusCode: 200, tempFilePath: '/whole' },
  ], { resume: true });
  const completed = await fixture.downloads.fetchResumable(
    fixture.current.song.url, fixture.current.song, 8, 'test__headers__320', fixture.base, fixture.current, 1,
  );
  assert.equal(completed, '/whole');
  assert.deepEqual(Array.from(fixture.files.get(completed)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(fixture.requests[0].header.get('Range'), 'bytes=2-7');
  assert.equal(fixture.requests[1].header.get('Range'), null);
  assert.equal(fixture.requests[1].header.get('If-Range'), null);
  assert.equal(fixture.files.has('/chunk-no-headers'), false);
  assert.equal(fixture.files.has(fixture.partPath), false);
  assert.equal(fixture.files.has(fixture.metaPath), false);
  assert.equal(fixture.current.retryCount, 0);
});

await check('DL-06：异常 Content-Range 同样降级，整下响应不能把 206 当作成品', async () => {
  const fixture = transferFixture([
    { statusCode: 206, tempFilePath: '/chunk-malformed', header: { 'Content-Range': 'bytes 0-7/*' } },
    { statusCode: 206, tempFilePath: '/still-partial' },
  ]);
  await assert.rejects(fixture.downloads.fetchResumable(
    fixture.current.song.url, fixture.current.song, 8, 'test__headers__320', fixture.base, fixture.current, 1,
  ), /不完整/);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.files.has('/chunk-malformed'), false);
  assert.equal(fixture.files.has('/still-partial'), false);
});

await check('DL-06：当前下载器无响应头时，后续任务跳过无效的长度探测和分块', async () => {
  const fixture = transferFixture([
    { statusCode: 206, tempFilePath: '/first-chunk' },
    { statusCode: 200, tempFilePath: '/first-whole' },
    { statusCode: 200, tempFilePath: '/second-whole' },
  ]);
  await fixture.downloads.fetchResumable(
    fixture.current.song.url, fixture.current.song, 8, 'test__headers__320', fixture.base, fixture.current, 1,
  );
  const next = task(song('next'));
  fixture.downloads.tasks = [next];
  fixture.downloads.headTotal = async () => assert.fail('native transport without headers must not probe again');
  fixture.downloads.saveToDisk = async (temporary) => {
    assert.equal(temporary, '/second-whole');
    return { path: '/downloads/next.mp3', sidecars: [] };
  };
  fixture.downloads.fileSizeOf = async () => 8;
  await fixture.downloads.runTaskInner(next, 1);
  assert.equal(next.status, 'done');
  assert.equal(fixture.downloads.items.length, 1);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests[2].header.get('Range'), null);
});

await check('DL-06：完整下载失败走原错误，暂停后返回的整文件只清理不提交', async () => {
  const failed = transferFixture([
    { statusCode: 206, tempFilePath: '/invalid' },
    { fail: { errMsg: 'downloadFile:fail timeout' } },
  ]);
  await assert.rejects(failed.downloads.fetchResumable(
    failed.current.song.url, failed.current.song, 8, 'test__headers__320', failed.base, failed.current, 1,
  ), /网络超时/);
  assert.equal(failed.requests.length, 2);
  const paused = transferFixture([
    { statusCode: 206, tempFilePath: '/invalid' },
    { statusCode: 200, tempFilePath: '/late-whole', before: (current) => { current.cancelled = true; current.runId++; } },
  ]);
  const completed = await paused.downloads.fetchResumable(
    paused.current.song.url, paused.current.song, 8, 'test__headers__320', paused.base, paused.current, 1,
  );
  assert.equal(completed, null);
  assert.equal(paused.files.has('/late-whole'), false);
  assert.equal(paused.downloads.items.length, 0);
});

await check('DL-06：带有效范围和验证器的下载继续正常续传，容忍响应头首尾空白', async () => {
  const fixture = transferFixture([
    { statusCode: 206, tempFilePath: '/valid', bytes: [3, 4, 5, 6, 7, 8], header: { 'content-range': ' bytes 2-7/8\t', etag: '"v1"' } },
  ], { resume: true });
  assert.equal(fixture.downloads.readPartTotal(fixture.current.song, 'test__headers__320', fixture.current.song.url), 8);
  assert.equal(fixture.downloads.readPartTotal(fixture.current.song, 'test__headers__320', 'https://media.invalid/other'), 0);
  const completed = await fixture.downloads.fetchResumable(
    fixture.current.song.url, fixture.current.song, 8, 'test__headers__320', fixture.base, fixture.current, 1,
  );
  assert.equal(completed, fixture.partPath);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(Array.from(fixture.files.get(completed)), [7, 7, 3, 4, 5, 6, 7, 8]);
});

await check('DL-06：长度探测主动取消后不报网络失败，迟到的临时文件会清理', async () => {
  const fixture = transferFixture([{ statusCode: 200, tempFilePath: '/probe', bytes: new Uint8Array(65536) }]);
  assert.equal(await fixture.downloads.headTotal(fixture.current.song.url, 'test'), 65536);
  assert.equal(fixture.logs.some((line) => line.includes('失败')), false);
  assert.equal(fixture.files.has('/probe'), false);
});

await check('DL-06：服务器忽略 Range 返回 200 时直接使用整文件，不重复下载', async () => {
  const fixture = transferFixture([{ statusCode: 200, tempFilePath: '/range-ignored' }], { resume: true });
  const completed = await fixture.downloads.fetchResumable(
    fixture.current.song.url, fixture.current.song, 8, 'test__headers__320', fixture.base, fixture.current, 1,
  );
  assert.equal(completed, '/range-ignored');
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(Array.from(fixture.files.get(completed)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(fixture.files.has(fixture.partPath), false);
  assert.equal(fixture.files.has(fixture.metaPath), false);
});

await check('DL-06：单个音源范围头异常不禁用其他支持范围校验的下载', async () => {
  const fixture = transferFixture([
    { statusCode: 206, tempFilePath: '/bad-range', header: { 'Content-Range': 'invalid' } },
    { statusCode: 200, tempFilePath: '/bad-range-whole' },
    { statusCode: 206, tempFilePath: '/next-range', header: { 'Content-Range': 'bytes 0-7/8', etag: '"v2"' } },
  ]);
  await fixture.downloads.fetchResumable(
    fixture.current.song.url, fixture.current.song, 8, 'test__headers__320', fixture.base, fixture.current, 1,
  );
  const next = task(song('supported'));
  fixture.downloads.tasks = [next];
  let probes = 0;
  fixture.downloads.headTotal = async () => { probes++; return 8; };
  fixture.downloads.saveToDisk = async (path) => {
    assert.equal(path, fixture.base + '/test__supported.part');
    return { path: '/downloads/supported.mp3', sidecars: [] };
  };
  fixture.downloads.fileSizeOf = async () => 8;
  await fixture.downloads.runTaskInner(next, 1);
  assert.equal(next.status, 'done');
  assert.equal(probes, 1);
  assert.equal(fixture.requests[2].header.get('Range'), 'bytes=0-7');
});

await check('DL-06：整下或分块超时后的迟到响应只清临时文件，不清新代次断点与句柄', async () => {
  for (const whole of [true, false]) {
    const timers = new Map();
    let nextTimer = 1;
    const runtime = {
      setTimeout: (callback, ms) => {
        const id = nextTimer++;
        timers.set(id, { callback, ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    };
    const fixture = transferFixture(whole
      ? [{ statusCode: 206, tempFilePath: '/fallback' }, { manual: true }]
      : [{ manual: true }], { runtime });
    const pending = fixture.downloads.fetchResumable(
      fixture.current.song.url, fixture.current.song, 8, 'test__headers__320', fixture.base, fixture.current, 1,
    );
    const rejected = assert.rejects(pending, /网络超时/);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const clock = [...timers.values()].find((entry) => entry.ms === (whole ? 300000 : 90000));
    assert.ok(clock, 'active transfer must have a timeout');
    clock.callback();
    await rejected;
    const newestHandle = { abort: noop };
    fixture.current.runId++;
    fixture.current.abortHandle = newestHandle;
    fixture.files.set(fixture.partPath, Uint8Array.from([4, 2]));
    fixture.files.set(fixture.metaPath, 'new generation');
    fixture.files.set('/late', Uint8Array.from([9, 9]));
    fixture.requests.at(-1).success({ statusCode: whole ? 200 : 206, tempFilePath: '/late' });
    assert.equal(fixture.files.has('/late'), false);
    assert.deepEqual(Array.from(fixture.files.get(fixture.partPath)), [4, 2]);
    assert.equal(fixture.files.get(fixture.metaPath), 'new generation');
    assert.equal(fixture.current.abortHandle, newestHandle);
  }
});

function harmonyApi(copy) {
  const source = read('uni_modules/qt-app-native/utssdk/app-harmony/index.uts');
  const start = source.indexOf('/** 公共目录同名文件不覆盖');
  const end = source.indexOf('\n/**\n * 往用户选定的目录 URI', start);
  assert.ok(start >= 0 && end > start);
  const text = `let customDirUri='';\nconst DEFAULT_PUBLIC_SUB_DIR='QtDownload/Music';\n` +
    source.slice(start, end);
  const files = new Set(['/public/QtDownload/Music/same.mp3']);
  const api = load(text, ['saveToPublicMedia'], {
    ensurePublicDirPermission: async () => true,
    Environment: { getUserDownloadDir: () => '/public' },
    fileIo: {
      accessSync: (path) => files.has(path),
      mkdirSync: (path) => files.add(path),
      unlinkSync: (path) => files.delete(path),
      copyFileSync: (src, dest) => {
        if (copy === 'fail') throw new Error('synthetic disk full');
        files.add(dest);
      },
    },
  });
  return { api, files };
}

await check('DL-07：同时下载数只有 1/2 两档、默认 1，旧存量 3~6 回默认且 setter 钳制', async () => {
  const b = boundary();
  const downloads = store(b);
  assert.equal(downloads.concurrency, 1, 'new default concurrency is 1');
  downloads.setConcurrency(2);
  assert.equal(downloads.concurrency, 2);
  assert.equal(b.storage.get('qt-download-concurrency'), '2');
  downloads.setConcurrency(6);
  assert.equal(downloads.concurrency, 2, 'setConcurrency clamps to the 1~2 band');
  downloads.setConcurrency(0);
  assert.equal(downloads.concurrency, 1, 'setConcurrency clamps at the minimum');
  for (const stale of ['3', '4', '6']) {
    const legacy = boundary([['qt-download-concurrency', stale]]);
    const migrated = store(legacy);
    migrated.restore();
    assert.equal(migrated.concurrency, 1, `legacy stored value ${stale} falls back to the new default`);
  }
  assert.equal(downloads.concurrencyText(), '1 个');
  // 下载设置页与档位口径一致：只列 1/2，不再有「（较高）」与偏高确认。
  const page = read('pages/download-settings/index.uvue');
  assert.equal((page.match(/DOWNLOAD_CONCURRENCY_WARN_ABOVE/g) ?? []).length, 0, 'the warn threshold no longer exists');
  assert.equal((page.match(/较高|仍然使用/g) ?? []).length, 0, 'no high-concurrency confirm copy remains');
  const concurrencySection = page.slice(page.indexOf('function showDownloadConcurrency'), page.indexOf('function applyDownloadConcurrency'));
  assert.ok(concurrencySection.includes('for (let n = DOWNLOAD_CONCURRENCY_MIN; n <= DOWNLOAD_CONCURRENCY_MAX; n++)'), 'options are generated from the 1~2 band');
  assert.ok(!concurrencySection.includes('qtConfirm'), 'picking 1 or 2 never needs a confirmation dialog');
});

await check('DL-05：Harmony 同名目标复制失败不删除既有文件', async () => {
  const { api, files } = harmonyApi('fail');
  const saved = await api.saveToPublicMedia(
    '/synthetic/temp',
    'music',
    'same.mp3',
    'QtDownload/Music',
    '',
  );
  assert.equal(saved, '');
  assert.equal(files.has('/public/QtDownload/Music/same.mp3'), true);
});

await check('DL-05：Harmony 成功发布使用去重文件名，不覆盖既有文件', async () => {
  const { api, files } = harmonyApi('success');
  const saved = await api.saveToPublicMedia(
    '/synthetic/temp',
    'music',
    'same.mp3',
    'QtDownload/Music',
    '',
  );
  assert.equal(saved, '/public/QtDownload/Music/same(1).mp3');
  assert.equal(files.has('/public/QtDownload/Music/same.mp3'), true);
  assert.equal(files.has('/public/QtDownload/Music/same(1).mp3'), true);
});

console.log(`[check-downloads] ${passed} 条下载/文件用例通过`);
