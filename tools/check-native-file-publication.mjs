// Confirmed seam: complete actual Android saveToPublicMedia(temp/source, options)
// resolves a path/URI whose bytes are visible to the native filesystem/provider.
// Actual embed/read byte modules are loaded too; no private save/copy helper is
// extracted, duplicated or mocked. Only native Java I/O, Android context/API and
// native UI superclass/array-bridge bootstrap dependencies are adapters.
// This VM checks public behavior, not Kotlin compilation or Android-device I/O.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { posix } from 'node:path';
import vm from 'node:vm';

const root = 'uni_modules/qt-app-native/utssdk/';
const sources = new Map(['embed-bytes.uts', 'read-embed.uts', 'app-android/index.uts']
  .map(name => [name, readFileSync(new URL(`../${root}${name}`, import.meta.url), 'utf8')]));

function load(name, adapters) {
  const source = sources.get(name);
  const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+(\w+)/gm)]
    .map(match => match[1]);
  const code = stripTypeScriptTypes(source
    .replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '')
    // UTS interface classes have an implicit Java Object base for explicit super().
    // Only add that native base where needed; keep every class/method body unchanged.
    .replace(/^class (\w+)([^\n{]*\bimplements[^\n{]*)\{([\s\S]*?)^\}/gm,
      (whole, name, header, body) => !/\bextends\b/.test(header) && /\bsuper\(/.test(body)
        ? whole.replace('class ' + name, 'class ' + name + ' extends NativeObject') : whole)
    // UTS accepts override for Java interface implementations; TS only accepts class overrides.
    .replace(/^(\s*)override\s+(?=\w)/gm, '$1'), { mode: 'strip' })
    .replace(/^export\s+(?=(?:async\s+)?(?:const|let|function|class))/gm, '');
  const context = vm.createContext({ ...adapters });
  vm.runInContext(`Array.prototype.toKotlinList = function () {
    const values = this; return { toTypedArray: () => Array.from(values) };
  };`, context);
  vm.runInContext(code + `\n;globalThis.__public = {${names.join(',')}};`, context, { filename: root + name });
  return context.__public;
}

function runtime(sdk = 28) {
  const env = { files: new Map(), dirs: new Set(['/sandbox', '/public/Music', '/public/Music/Fixture', '/custom']),
    streams: [], scans: [], logs: [], interleave: null, deletedFiles: [], failure: null,
    faultCalls: new Map(), faultSeen: false, items: new Map(), nextItem: 1, createdUris: [], deletedUris: [],
    publishedWithOpenStreams: false, dataPath: null, cursors: [], closeFailures: [], closeAlwaysThrows: false };
  const fault = name => {
    const count = (env.faultCalls.get(name) ?? 0) + 1;
    env.faultCalls.set(name, count);
    const after = name === 'read' || name === 'write' ? 2 : 1;
    const closeFailure = env.closeFailures.includes(name) && (count === 1 || env.closeAlwaysThrows);
    if ((env.failure === name && count === after) || closeFailure) {
      env.faultSeen = true;
      throw new Error('native ' + name + ' failure');
    }
  };
  const location = value => value instanceof NativeFile ? value.path : String(value);
  const interleave = path => {
    if (env.interleave != null && env.interleave.path === path) {
      const run = env.interleave.run;
      env.interleave = null;
      run();
    }
  };
  class NativeFile {
    constructor(parent, child) {
      this.path = child === undefined ? posix.normalize(location(parent)) : posix.join(location(parent), child);
    }
    getAbsolutePath() { return this.path; }
    exists() {
      const existed = env.files.has(this.path) || env.dirs.has(this.path);
      interleave(this.path); // Another native save can run after a non-atomic existence observation.
      return existed;
    }
    createNewFile() {
      interleave(this.path); // Interleave before the atomic native operation linearizes.
      if (env.files.has(this.path) || env.dirs.has(this.path)) return false;
      if (!env.dirs.has(posix.dirname(this.path))) throw new Error('native parent directory missing');
      fault('create');
      env.files.set(this.path, Buffer.alloc(0));
      return true; // The existence test and creation above are one uninterrupted native operation.
    }
    mkdirs() { env.dirs.add(this.path); return true; }
    isDirectory() { return env.dirs.has(this.path); }
    canWrite() { return true; }
    delete() { env.deletedFiles.push(this.path); return env.files.delete(this.path); }
    length() { return env.files.get(this.path)?.length ?? 0; }
  }
  class NativeInputStream {
    constructor(file) {
      fault('input-open');
      this.path = location(file);
      assert.ok(env.files.has(this.path), 'native input must exist');
      this.data = env.files.get(this.path);
      this.offset = 0;
      this.closed = false;
      this.closeKind = 'input-close';
      this.closeAttempts = 0;
      env.streams.push(this);
    }
    read(buffer) {
      assert.equal(this.closed, false);
      fault('read');
      if (this.offset === this.data.length) return -1;
      const count = Math.min(buffer.length, this.data.length - this.offset);
      buffer.set(this.data.subarray(this.offset, this.offset + count));
      this.offset += count;
      return count;
    }
    close() {
      this.closeAttempts++;
      if (this.closed) return;
      fault('input-close'); // A throwing close has not necessarily released the native handle.
      this.closed = true;
    }
  }
  class NativeOutputStream {
    constructor(file) {
      fault('output-open');
      this.path = location(file);
      if (!env.dirs.has(posix.dirname(this.path))) throw new Error('native output directory missing');
      env.files.set(this.path, Buffer.alloc(0)); // Real default FileOutputStream truncates an existing file.
      this.closed = false;
      this.closeKind = 'output-close';
      this.closeAttempts = 0;
      env.streams.push(this);
    }
    write(buffer, offset, count) {
      assert.equal(this.closed, false);
      fault('write');
      env.files.set(this.path, Buffer.concat([env.files.get(this.path), Buffer.from(buffer.subarray(offset, offset + count))]));
    }
    flush() { assert.equal(this.closed, false); fault('flush'); }
    close() {
      this.closeAttempts++;
      if (this.closed) return;
      fault('output-close');
      this.closed = true;
    }
  }
  class NativeUri {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
    static parse(value) { return new NativeUri(value); }
  }
  class NativeContentValues {
    constructor() { this.values = new Map(); }
    put(key, value) { this.values.set(key, value); }
  }
  const columns = { DISPLAY_NAME: '_display_name', MIME_TYPE: 'mime_type', RELATIVE_PATH: 'relative_path', IS_PENDING: 'is_pending' };
  class NativeProviderOutput {
    constructor(uri) {
      fault('output-open');
      this.path = uri.toString();
      this.row = env.items.get(this.path);
      assert.ok(this.row, 'native output requires the inserted provider URI');
      this.closed = false;
      this.closeKind = 'output-close';
      this.closeAttempts = 0;
      env.streams.push(this);
    }
    write(buffer, offset, count) {
      assert.equal(this.closed, false);
      fault('write');
      this.row.bytes = Buffer.concat([this.row.bytes, Buffer.from(buffer.subarray(offset, offset + count))]);
    }
    flush() { assert.equal(this.closed, false); fault('flush'); }
    close() {
      this.closeAttempts++;
      if (this.closed) return;
      fault('output-close');
      this.closed = true;
    }
  }
  const resolver = {
    insert(collection, values) {
      fault('insert');
      if (env.failure === 'insert-null') { env.faultSeen = true; return null; }
      const path = collection.toString() + '/' + env.nextItem++;
      env.items.set(path, { values: new Map(values.values), bytes: Buffer.alloc(0) });
      env.createdUris.push(path);
      return new NativeUri(path);
    },
    openOutputStream(uri) {
      if (env.failure === 'output-null') { env.faultSeen = true; return null; }
      return new NativeProviderOutput(uri);
    },
    update(uri, values) {
      fault('update');
      if (env.failure === 'update-zero') { env.faultSeen = true; return 0; }
      const row = env.items.get(uri.toString());
      if (row == null) return 0;
      env.publishedWithOpenStreams ||= env.streams.some(stream => !stream.closed);
      for (const [key, value] of values.values) row.values.set(key, value);
      return 1;
    },
    delete(uri) { env.deletedUris.push(uri.toString()); return env.items.delete(uri.toString()) ? 1 : 0; },
    query(uri) {
      fault('query');
      if (env.dataPath == null) return null; // Android may hide _data; the readable URI is then the public result.
      const row = env.items.get(uri.toString());
      assert.ok(row, 'native path queries must use a provider item');
      row.path = env.dataPath;
      const cursor = { closed: false, moveToFirst: () => true, getString: () => env.dataPath,
        close() { this.closed = true; } };
      env.cursors.push(cursor);
      return cursor;
    },
  };
  env.seedMedia = (path, bytes) => env.items.set(path, {
    values: new Map([[columns.IS_PENDING, 0], [columns.DISPLAY_NAME, 'previous public item']]), bytes: Buffer.from(bytes),
  });
  const activity = {};
  const context = { filesDir: new NativeFile('/sandbox'), getContentResolver: () => resolver };
  const adapters = {
    console: { log: (...values) => env.logs.push(values.map(String).join(' ')) },
    UTSAndroid: { getUniActivity: () => activity, getAppContext: () => context,
      checkSystemPermissionGranted: () => true,
      convert2AbsFullPath: path => path.replace(/^unifile:\/\/usr\/?/, '/sandbox/') },
    File: NativeFile, FileInputStream: NativeInputStream, FileOutputStream: NativeOutputStream,
    ByteArray: Uint8Array,
    Build: { VERSION: { SDK_INT: sdk } },
    Environment: { DIRECTORY_MUSIC: 'Music', DIRECTORY_DOWNLOADS: 'Download', DIRECTORY_PICTURES: 'Pictures',
      isExternalStorageManager: () => true,
      getExternalStoragePublicDirectory: kind => new NativeFile('/public/' + kind) },
    MediaScannerConnection: { scanFile: (_context, paths, mimes) => env.scans.push({ paths, mimes }) },
    Uri: NativeUri, ContentValues: NativeContentValues,
    MediaStore: { MediaColumns: columns,
      Audio: { Media: { EXTERNAL_CONTENT_URI: NativeUri.parse('content://media/external/audio/media') } },
      Images: { Media: { EXTERNAL_CONTENT_URI: NativeUri.parse('content://media/external/images/media') } },
      Downloads: { EXTERNAL_CONTENT_URI: NativeUri.parse('content://media/external/downloads') } },
    // Unused native WebView subclasses must exist to load the whole Android module.
    WebView: class {}, WebViewClient: class {}, NativeObject: class {},
  };
  Object.assign(adapters, load('embed-bytes.uts', adapters));
  Object.assign(adapters, load('read-embed.uts', adapters));
  const api = load('app-android/index.uts', adapters);
  env.readNative = path => {
    const row = env.items.get(path) ?? [...env.items.values()].find(item => item.path === path);
    if (row != null) {
      assert.equal(row.values.get(columns.IS_PENDING), 0, 'a returned public URI must already be published');
      return Buffer.from(row.bytes);
    }
    assert.ok(env.files.has(path), 'the caller-visible native path must exist: ' + path);
    return Buffer.from(env.files.get(path));
  };
  return { api, env };
}

const payloadA = Buffer.alloc(18000, 65);
const payloadB = Buffer.alloc(19000, 66);
const modes = [
  { name: 'legacy public Music', sdk: 28, dir: '/public/Music/Fixture', args: ['music', 'song.mp3', 'Fixture', ''] },
  { name: 'custom absolute directory', sdk: 34, dir: '/custom', args: ['music', 'song.mp3', 'ignored', '/custom'] },
];
function seedSources(env) {
  env.files.set('/sandbox/source-a.mp3', Buffer.from(payloadA));
  env.files.set('/sandbox/source-b.mp3', Buffer.from(payloadB));
}
function verifySaved(env, left, right) {
  assert.ok(left.length > 0 && right.length > 0, 'both public saves must resolve a visible path');
  assert.notEqual(left, right, 'two callers must not receive the same writable destination');
  assert.equal(env.readNative(left).equals(payloadA), true, 'the first caller must retain its own source bytes');
  assert.equal(env.readNative(right).equals(payloadB), true, 'the second caller must retain its own source bytes');
  assert.equal(env.streams.every(stream => stream.closed), true, 'successful saves close their native streams');
}
let passes = 0;
async function check(name, run) { await run(); passes++; console.log('  ✓ ' + name); }

await check('repeated and concurrent public saves preserve one hundred existing names and separate both callers', async () => {
  const failures = [];
  for (const mode of modes) {
    for (const scenario of ['one hundred existing filenames', 'native existence-to-creation interleave']) {
      try {
        const { api, env } = runtime(mode.sdk);
        seedSources(env);
        const existing = new Map();
        if (scenario === 'one hundred existing filenames') {
          for (let i = 0; i < 100; i++) {
            const name = i === 0 ? 'song.mp3' : `song(${i}).mp3`;
            const path = mode.dir + '/' + name;
            const bytes = Buffer.from('previous user file ' + i);
            existing.set(path, bytes);
            env.files.set(path, Buffer.from(bytes));
          }
        }
        let right;
        if (scenario === 'native existence-to-creation interleave') {
          env.interleave = { path: mode.dir + '/song.mp3',
            run: () => { right = api.saveToPublicMedia('/sandbox/source-b.mp3', ...mode.args); } };
        }
        const left = api.saveToPublicMedia('/sandbox/source-a.mp3', ...mode.args);
        if (scenario === 'one hundred existing filenames') right = api.saveToPublicMedia('/sandbox/source-b.mp3', ...mode.args);
        assert.ok(right != null, 'the native interleave must exercise the second real public save');
        const [leftPath, rightPath] = await Promise.all([left, right]);
        for (const [path, bytes] of existing) {
          assert.equal(env.readNative(path).equals(bytes), true, 'previous user bytes were overwritten: ' + path);
        }
        verifySaved(env, leftPath, rightPath);
        assert.equal(env.files.size, existing.size + 4, 'each public caller adds exactly one new file beside two sources');
      } catch (error) {
        failures.push(mode.name + ' / ' + scenario + ': ' + error.message);
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
await check('file creation/open/copy failures retain old files, close opened streams and roll back only the new reservation', async () => {
  const failures = [];
  for (const mode of modes) {
    for (const failure of ['create', 'input-open', 'output-open', 'read', 'write', 'flush']) {
      try {
        const { api, env } = runtime(mode.sdk);
        seedSources(env);
        const previous = new Map([
          [mode.dir + '/song.mp3', Buffer.from('previous user audio')],
          [mode.dir + '/song(1).mp3', Buffer.from('another previous user audio')],
        ]);
        for (const [path, bytes] of previous) env.files.set(path, Buffer.from(bytes));
        env.failure = failure;
        const saved = await api.saveToPublicMedia('/sandbox/source-a.mp3', ...mode.args);
        assert.equal(env.faultSeen, true, 'the real public save must reach the injected native failure');
        assert.equal(saved, '', 'native failure must resolve the existing public empty-string callback');
        for (const [path, bytes] of previous) {
          assert.equal(env.readNative(path).equals(bytes), true, 'a failed save must not delete or change earlier user bytes');
        }
        assert.equal(env.readNative('/sandbox/source-a.mp3').equals(payloadA), true, 'a failed save must retain its source');
        assert.equal(env.streams.every(stream => stream.closed), true, 'every successfully opened stream must close after native failure');
        assert.equal(env.files.size, previous.size + 2, 'a failed public save must not leave its empty or partial reservation');
        assert.equal(env.deletedFiles.every(path => !previous.has(path) && path.startsWith(mode.dir + '/')), true,
          'rollback may delete only the newly reserved destination, never existing files or sources');
        if (failure === 'create') assert.equal(env.deletedFiles.length, 0, 'failed exclusive creation owns nothing to delete');
      } catch (error) {
        failures.push(mode.name + ' / ' + failure + ': ' + error.message);
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
// Supplemental first-PASS tracer: validate the MediaStore boundary before failure injection.
await check('scoped public save publishes readable source bytes after stream closure and keeps earlier provider items', async () => {
  const { api, env } = runtime(34);
  seedSources(env);
  const oldUri = 'content://media/external/downloads/7000';
  const oldBytes = Buffer.from('earlier public user item');
  env.seedMedia(oldUri, oldBytes);
  const saved = await api.saveToPublicMedia('/sandbox/source-a.mp3', 'download', 'song.mp3', 'Fixture');
  assert.ok(saved.startsWith('content://media/external/downloads/'), 'without _data the public callback must return a native provider URI');
  assert.equal(env.readNative(saved).equals(payloadA), true, 'the URI must expose all source bytes, not a partial file');
  assert.equal(env.readNative(oldUri).equals(oldBytes), true, 'publishing a new item must retain older public bytes');
  assert.equal(env.streams.every(stream => stream.closed), true, 'a published item must have no unclosed native streams');
  assert.equal(env.publishedWithOpenStreams, false, 'pending state is cleared only after native streams close');
  assert.equal(env.items.size, 2, 'only one new URI is published');
});
await check('scoped post-insert failures and zero-row publication close streams and remove only the newly inserted URI', async () => {
  const failures = [];
  for (const sdk of [29, 34]) {
    for (const failure of ['output-open', 'input-open', 'read', 'write', 'flush', 'update', 'update-zero']) {
      try {
        const { api, env } = runtime(sdk);
        seedSources(env);
        const older = new Map([
          ['content://media/external/downloads/7000', Buffer.from('previous user download')],
          ['content://media/external/audio/media/8000', Buffer.from('previous user audio')],
        ]);
        for (const [uri, bytes] of older) env.seedMedia(uri, bytes);
        env.failure = failure;
        const saved = await api.saveToPublicMedia('file:///sandbox/source-a.mp3', 'music', 'song.mp3', 'Fixture');
        assert.equal(env.faultSeen, true, 'the real public save must reach the injected provider/input failure');
        assert.equal(saved, '', 'failed copy or zero updated rows must not publish a successful path/URI callback');
        for (const [uri, bytes] of older) {
          assert.equal(env.readNative(uri).equals(bytes), true, 'rollback must not delete or mutate older provider bytes');
        }
        assert.equal(env.readNative('/sandbox/source-a.mp3').equals(payloadA), true, 'a failed scoped save must retain its source');
        assert.equal(env.streams.every(stream => stream.closed), true, 'every opened input/output stream must close after scoped failure');
        assert.equal(env.createdUris.length, 1, 'the native provider owns one newly inserted candidate');
        assert.equal(env.items.size, older.size, 'no empty/partial/pending URI may survive the failed public save');
        assert.equal(env.deletedUris.every(uri => env.createdUris.includes(uri) && !older.has(uri)), true,
          'cleanup is confined to this operation\'s newly inserted URI');
        assert.equal(env.deletedFiles.length, 0, 'scoped rollback must not delete native source/public files');
      } catch (error) {
        failures.push('SDK ' + sdk + ' / ' + failure + ': ' + error.message);
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
// Supplemental first-PASS protections; none is presented as an independently observed RED.
await check('null/throwing insert and null output preserve old provider items and own no unrelated cleanup', async () => {
  for (const sdk of [29, 34]) {
    for (const failure of ['insert-null', 'insert', 'output-null']) {
      const { api, env } = runtime(sdk);
      seedSources(env);
      const oldUri = 'content://media/external/downloads/7000';
      const oldBytes = Buffer.from('older protected item');
      env.seedMedia(oldUri, oldBytes);
      env.failure = failure;
      assert.equal(await api.saveToPublicMedia('/sandbox/source-a.mp3', 'download', 'song.mp3'), '');
      assert.equal(env.faultSeen, true);
      assert.equal(env.readNative(oldUri).equals(oldBytes), true);
      assert.equal(env.items.size, 1, 'a nullable native boundary leaves no newly owned provider item');
      assert.equal(env.streams.every(stream => stream.closed), true);
      assert.equal(env.deletedUris.every(uri => env.createdUris.includes(uri) && uri !== oldUri), true);
      if (failure !== 'output-null') assert.equal(env.deletedUris.length, 0, 'failed insert owns no URI to delete');
    }
  }
});

await check('public source URI conversion, real extensions, native MIME and default subdirectory remain intact', async () => {
  const cases = [
    { name: 'band - song.lrc', kind: 'download', mime: 'application/octet-stream' },
    { name: 'cover.jpg', kind: 'picture', mime: 'image/jpeg' },
    { name: 'update.apk', kind: 'download', mime: 'application/vnd.android.package-archive' },
  ];
  for (const sdk of [28, 34]) {
    for (const fixture of cases) {
      const { api, env } = runtime(sdk);
      seedSources(env);
      const saved = await api.saveToPublicMedia('unifile://usr/source-a.mp3', fixture.kind, fixture.name);
      assert.equal(env.readNative(saved).equals(payloadA), true, 'the real converted source bytes are saved unchanged');
      if (sdk < 29) {
        assert.equal(posix.basename(saved), fixture.name, 'legacy must preserve the supplied real extension');
        assert.ok(saved.includes('/轻听/'), 'omitted subDir uses the existing public default');
        assert.equal(env.scans[0].mimes[0], fixture.mime, 'native registration preserves the existing MIME');
      } else {
        const values = env.items.get(saved).values;
        assert.equal(values.get('_display_name'), fixture.name, 'scoped naming must not append .mp3/.txt to known extensions');
        assert.equal(values.get('mime_type'), fixture.mime);
        assert.ok(values.get('relative_path').endsWith('/轻听/'));
      }
      assert.equal(env.deletedFiles.length + env.deletedUris.length, 0, 'successful extension handling requires no rollback');
    }
  }
});

await check('scoped public callbacks keep native real-path preference and readable URI fallback on metadata-query failure', async () => {
  for (const queryFails of [false, true]) {
    const { api, env } = runtime(34);
    seedSources(env);
    env.dataPath = '/public/Download/Fixture/song.mp3';
    if (queryFails) env.failure = 'query';
    const saved = await api.saveToPublicMedia('/sandbox/source-a.mp3', 'download', 'song.mp3', 'Fixture');
    assert.equal(queryFails ? saved.startsWith('content://') : saved === env.dataPath, true);
    assert.equal(env.readNative(saved).equals(payloadA), true, 'both callback representations expose the successfully published bytes');
    assert.equal(env.cursors.every(cursor => cursor.closed), true, 'opened native path cursors close');
    assert.equal(env.deletedUris.length, 0, 'post-publication metadata lookup failure must not roll back valid bytes');
    if (queryFails) assert.equal(env.faultSeen, true);
  }
});
await check('one hundred pre-existing names also survive an actual native-boundary interleave between both public saves', async () => {
  for (const mode of modes) {
    const { api, env } = runtime(mode.sdk);
    seedSources(env);
    const older = new Map();
    for (let i = 0; i < 100; i++) {
      const path = mode.dir + '/' + (i === 0 ? 'song.mp3' : `song(${i}).mp3`);
      const bytes = Buffer.from('preserved concurrent fixture ' + i);
      older.set(path, bytes);
      env.files.set(path, Buffer.from(bytes));
    }
    let right;
    env.interleave = { path: mode.dir + '/song.mp3',
      run: () => { right = api.saveToPublicMedia('/sandbox/source-b.mp3', ...mode.args); } };
    const left = api.saveToPublicMedia('/sandbox/source-a.mp3', ...mode.args);
    assert.ok(right != null, 'both real public saves must overlap at the native filesystem boundary');
    const [leftPath, rightPath] = await Promise.all([left, right]);
    for (const [path, bytes] of older) assert.equal(env.readNative(path).equals(bytes), true);
    verifySaved(env, leftPath, rightPath);
    assert.equal(env.files.size, older.size + 4);
  }
});
await check('file close failures never return a saved path, attempt every opened stream and roll back only the reserved file', async () => {
  const failures = [];
  for (const mode of modes) {
    for (const closeAlwaysThrows of [false, true]) {
      for (const closeFailures of [['input-close'], ['output-close'], ['input-close', 'output-close']]) {
        try {
          const { api, env } = runtime(mode.sdk);
          seedSources(env);
          const older = new Map([
            [mode.dir + '/song.mp3', Buffer.from('protected user song')],
            [mode.dir + '/song(1).mp3', Buffer.from('protected second user song')],
          ]);
          for (const [path, bytes] of older) env.files.set(path, Buffer.from(bytes));
          env.closeFailures = closeFailures;
          env.closeAlwaysThrows = closeAlwaysThrows;
          const saved = await api.saveToPublicMedia('/sandbox/source-a.mp3', ...mode.args);
          assert.equal(env.faultSeen, true, 'the actual public save must reach the native close exception');
          assert.equal(env.streams.length, 2, 'both native streams were opened before the close fault');
          assert.equal(env.streams.every(stream => stream.closeAttempts >= 1), true,
            'a throwing close cannot prevent a close attempt on another opened stream');
          for (const stream of env.streams) {
            if (closeFailures.includes(stream.closeKind)) {
              if (closeAlwaysThrows) assert.equal(stream.closed, false, 'a permanently throwing native close must not be claimed closed');
              if (stream.closed) assert.ok(stream.closeAttempts > 1, 'a transient close fault can release the handle only after a later successful close');
            } else assert.equal(stream.closed, true, 'the unaffected opened stream must really close');
          }
          assert.equal(saved, '', 'even a complete copy is not a saved file when native close fails');
          for (const [path, bytes] of older) assert.equal(env.readNative(path).equals(bytes), true);
          assert.equal(env.readNative('/sandbox/source-a.mp3').equals(payloadA), true, 'close failure preserves the source bytes');
          assert.equal(env.files.size, older.size + 2, 'the failed close must not leave its reserved file');
          assert.equal(env.deletedFiles.every(path => !older.has(path) && path.startsWith(mode.dir + '/')), true,
            'only this save\'s reserved destination can be rolled back');
          assert.equal(env.scans.length, 0, 'a close-failed file must not be registered as a successful publication');
        } catch (error) {
          failures.push(mode.name + ' / ' + (closeAlwaysThrows ? 'permanent ' : 'transient ') + closeFailures.join('+') + ': ' + error.message);
        }
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
await check('scoped close failures never publish a URI, attempt every opened stream and remove only the inserted item', async () => {
  const failures = [];
  for (const sdk of [29, 34]) {
    for (const closeAlwaysThrows of [false, true]) {
      for (const closeFailures of [['input-close'], ['output-close'], ['input-close', 'output-close']]) {
        try {
          const { api, env } = runtime(sdk);
          seedSources(env);
          const older = new Map([
            ['content://media/external/audio/media/7000', Buffer.from('protected previous audio')],
            ['content://media/external/downloads/8000', Buffer.from('protected previous download')],
          ]);
          for (const [uri, bytes] of older) env.seedMedia(uri, bytes);
          env.closeFailures = closeFailures;
          env.closeAlwaysThrows = closeAlwaysThrows;
          const saved = await api.saveToPublicMedia('file:///sandbox/source-a.mp3', 'music', 'song.mp3', 'Fixture');
          assert.equal(env.faultSeen, true, 'the actual public save must reach the scoped native close exception');
          assert.equal(env.streams.length, 2);
          assert.equal(env.streams.every(stream => stream.closeAttempts >= 1), true,
            'a failed input close must not bypass the already opened provider output close');
          for (const stream of env.streams) {
            if (closeFailures.includes(stream.closeKind)) {
              if (closeAlwaysThrows) assert.equal(stream.closed, false, 'native close that always throws is attempted, not successfully closed');
              if (stream.closed) assert.ok(stream.closeAttempts > 1, 'a transient native close requires a later successful attempt before claiming closure');
            } else assert.equal(stream.closed, true, 'the unaffected input/output must successfully close');
          }
          assert.equal(saved, '', 'native close failure must not resolve a successful MediaStore URI');
          for (const [uri, bytes] of older) assert.equal(env.readNative(uri).equals(bytes), true);
          assert.equal(env.readNative('/sandbox/source-a.mp3').equals(payloadA), true);
          assert.equal(env.items.size, older.size, 'a close-failed inserted URI must not remain pending or published');
          assert.equal(env.createdUris.length, 1);
          assert.equal(env.deletedUris.every(uri => env.createdUris.includes(uri) && !older.has(uri)), true,
            'scoped close rollback is confined to this save\'s newly inserted URI');
          assert.equal(env.faultCalls.get('update') ?? 0, 0, 'close-failed bytes must never be published by clearing IS_PENDING');
          assert.equal(env.deletedFiles.length, 0, 'scoped close rollback must not remove the source or old public files');
        } catch (error) {
          failures.push('SDK ' + sdk + ' / ' + (closeAlwaysThrows ? 'permanent ' : 'transient ') + closeFailures.join('+') + ': ' + error.message);
        }
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
console.log(`\n${passes} passed (complete actual Android module VM; not native/device measurements)`);
