// task-26 approved seam: complete compiled production history/download pages and QtUI
// -> public click/remote -> real Player/Downloads/selection/action-sheet/confirm services.
// Reuse the sibling's renderer+module-loader READ-ONLY; only native SDK/network/files
// and lifecycle boundaries vary here. No copied business function/private page export.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { toRaw } from 'vue';
import { listFixture } from './check-tv-list-hosts.mjs';

const noop = () => {};
const walk = node => node == null ? [] : [node, ...(node.children ?? []).flatMap(walk)];
const hasClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name);
const text = node => node.text + (node.children ?? []).map(text).join('');
const plain = value => JSON.parse(JSON.stringify(value));
const song = (id, name = id) => ({ id, platform:'local', name, singer:'验证歌手', album:'验证专辑', picUrl:'', url:'file:///fixture/' + id + '.mp3', duration:180 });
const nativeId = node => 'tv:fixture:page:custom:' + (node.props['data-qt-tv-id'] ?? node.props.id ?? node.fixtureId);

async function libraryFixture(options = {}) {
  let b;
  const nativeCalls = [], pendingNetwork = [];
  let files = new Map(Object.entries(options.files ?? {}));
  const sizeOf = path => {
    if (!files.has(path)) return -1;
    const value = files.get(path);
    return typeof value === 'number' ? value : value?.byteLength ?? Buffer.byteLength(String(value));
  };
  const sdk = {
    publicDataDir:() => '', dataDir:() => '/owned-fixture', queryPermissionStates:() => [],
    statLocalFile:sizeOf,
    readEmbeddedTags:() => null,
    readTextFile:(_path, reply) => reply(false, '', 'fixture file absent'),
    exists:(_path, reply) => reply(true, '0', ''), start:() => false, isRunning:() => false, isHealthy:() => false,
    restoreCustomDir:noop,
    async ensurePublicDirPermission() { nativeCalls.push({ name:'permission' }); return options.permission !== false; },
    async saveToPublicMedia(temp, _type, fileName) {
      const path = '/public/' + fileName;
      nativeCalls.push({ name:'publish', temp, path });
      files.set(path, files.get(temp)); return path;
    },
    deleteMediaByPath(paths) { nativeCalls.push({ name:'deleteMediaByPath', paths:plain(paths) }); for (const path of paths) files.delete(path); return { deleted:paths.length, pending:0, failed:0 }; },
  };
  const collect = root => {
    const nodes = walk(toRaw(root)).filter(node => !hasClass(node, 'qt-tv-skip') &&
      (node.props['data-qt-tv-id'] || node.props.id || typeof node.props.onClick === 'function' || typeof node.props.onLongpress === 'function'));
    return nodes.map((node, index) => {
      node.fixtureId ??= 'sdk-' + index;
      let list = node.parent; while (list && list.tag !== 'list-view' && list.tag !== 'scroll-view') list = list.parent;
      return { id:nativeId(node), left:30 + (index % 4) * 96, top:50 + Math.floor(index / 4) * 76,
        width:56, height:56, visible:true, enabled:true, input:false,
        longPress:typeof node.props.onLongpress === 'function', scrollGroup:list ? 'library-list' : '' };
    });
  };
  const tvPlatform = {
    tvReadDevice:() => ({ television:false, nativeAvailable:false, leanback:false }),
    tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop, tvHighlight:noop, tvPresent:noop, tvBack:noop,
    tvCollect:collect, tvScroll:() => false,
    tvActivate(id, longPress) {
      const target = walk(b.root).find(node => nativeId(node) === id);
      assert.ok(target, 'native public focus target still exists');
      return b.dispatch(target, longPress ? 'longpress' : 'click');
    },
  };
  b = await listFixture({ ...options, realFrame:true, boundaryOverrides:{
    'uni_modules/qt-js-engine':sdk, 'uni_modules/qt-app-native':sdk,
    'services/tv-platform':tvPlatform,
    'services/music-api':undefined,
    'services/diag':{ qtDiag:noop, qtDiagDebug:noop },
    ...(options.boundaryOverrides ?? {}),
  } });
  files = b.fileData;
  const baseFs = b.uni.getFileSystemManager();
  b.setSdk({ getFileSystemManager:() => ({ ...baseFs,
    statSync(path) { if (sizeOf(path) < 0) throw new Error('owned stat missing'); return [{ stats:{ size:sizeOf(path) } }]; },
    saveFile({ tempFilePath, success }) {
      const path = '/private/' + tempFilePath.split('/').at(-1);
      files.set(path, files.get(tempFilePath)); files.delete(tempFilePath);
      nativeCalls.push({ name:'privateSave', temp:tempFilePath, path }); success?.({ savedFilePath:path });
    },
    getFileInfo({ filePath, success, fail }) {
      const size = sizeOf(filePath);
      if (size >= 0 && options.failUniStat !== true) success?.({ size });
      else fail?.({ errMsg:'fixture SDK stat missing' });
    },
  }),
    downloadFile(request) {
      let onProgress = noop;
      const pending = { request, aborted:false,
        progress(done, total) { onProgress({ progress:Math.round(done / total * 100), totalBytesWritten:done, totalBytesExpectedToWrite:total }); },
        success(bytes = 131072) {
          const temp = '/network/temp-' + pendingNetwork.length + '.mp3'; files.set(temp, new Uint8Array(bytes));
          request.success?.({ statusCode:200, tempFilePath:temp, header:{ ETag:'fixture-etag' } });
        },
        fail(errMsg = 'fixture network abort') { request.fail?.({ errMsg }); },
      };
      pendingNetwork.push(pending);
      return { abort() { pending.aborted = true; pending.fail(); }, onProgressUpdate(fn) { onProgress = fn; } };
    },
  });
  return { ...b, files, ownedNativeCalls:nativeCalls, pendingNetwork,
    downloads:b.load('stores/downloads.ts').useDownloadsStore(),
    remote:async (key, repeat = 0) => { b.tv.qtTvDispatchRemote({ key, action:'down', repeat }); await b.flush(); },
  };
}

async function historyCase() {
  const b = await libraryFixture({ width:1920, height:1080 });
  try {
    const duplicate = song('duplicate', '同曲两次出现');
    b.player.history = [duplicate, duplicate, song('third', '第三首')];
    b.audio.audioPlayer.setGapless(false);
    await b.mount('pages/history/index.uvue');
    const hosts = b.byClass('row-item');
    assert.equal(hosts.length, 2, 'wide history retains one native list with one pair per host');
    for (const host of hosts) {
      assert.equal(b.css(host).height, '76px', 'TV history native host reserves the rendered FullSongRow height');
      const rows = walk(host).filter(node => hasClass(node, 'row') && node.props['data-qt-tv-id']);
      for (const row of rows) assert.equal(b.css(row).height, '76px', 'real FullSongRow renders the shared TV geometry');
    }
    const rows = hosts.flatMap(host => walk(host).filter(node => hasClass(node, 'row') && node.props['data-qt-tv-id']));
    assert.deepEqual(rows.map(row => row.props['data-qt-tv-id']), ['history:local:duplicate:left', 'history:local:duplicate:right', 'history:local:third:left'], 'history focus identifies occurrences rather than Song keys');
    const before = b.player.playbackRevision();
    await b.dispatch(rows[2]);
    assert.equal(b.player.current.id, 'third');
    assert.equal(b.player.playbackRevision(), before + 1, 'one real FullSongRow public click plays exactly once');
    assert.ok(b.nativeCalls.some(call => call.name === 'audioSetPlaylist'), 'history play reaches real audio service');
  } finally { await b.close(); }
}

async function historyActionsCase() {
  const b = await libraryFixture({ width:1920, height:1080 });
  try {
    b.player.history = [song('one', '历史第一首'), song('two', '历史第二首')];
    await b.mount('pages/history/index.uvue');
    const manage = b.byClass('act-link').find(node => text(node) === '管理');
    assert.equal(b.css(manage).height, '56px', 'TV history header actions reserve a visible 56px target');
    const before = b.player.playbackRevision();
    await b.dispatch(manage);
    assert.equal(b.byClass('actions').length, 0, 'batch management hides FullSongRow single-song actions');
    const row = b.byClass('row-item').flatMap(host => walk(host)).find(node => node.props['data-qt-tv-id'] === 'history:local:one:right');
    const check = walk(row).find(node => hasClass(node, 'qt-checkbox'));
    await b.dispatch(check);
    assert.equal(b.player.playbackRevision(), before, 'one actual checkbox change selects rather than playing');
    assert.match(b.text(), /已选 1 首/);
    const remove = b.byClass('danger-btn')[0];
    assert.equal(b.css(remove).height, '56px', 'TV selected-history removal retains the same target size');
    await b.dispatch(remove);
    assert.equal(b.player.history.length, 2, 'destructive history edit waits for the real confirmation host');
    const cancel = b.byClass('qc-btn').find(node => text(node) === '取消');
    await b.dispatch(cancel);
    assert.equal(b.player.history.length, 2, 'confirmation cancel keeps history and selection');
    await b.dispatch(b.byClass('danger-btn')[0]);
    const confirm = b.byClass('qc-btn').find(node => text(node) === '移除');
    await b.dispatch(confirm);
    assert.deepEqual(plain(b.player.history.map(item => item.id)), ['one'], 'one public confirmation reaches the actual history removal service');
    assert.ok(b.storageWrites.some(([key]) => key === 'qt-player-state'), 'actual history mutation persists player state');
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'deleteMediaByPath').length, 0, 'history removal does not delete local audio files');
  } finally { await b.close(); }
}

const downloaded = (id, name = id) => ({ song:song(id, name), path:'/fixture/' + id + '.mp3', size:1024 * 1024, time:1, sidecars:[] });
async function downloadFixture(items = [downloaded('first', '下载第一首'), downloaded('second', '下载第二首')], options = {}) {
  return libraryFixture({ width:1920, height:1080, ...options,
    initialStorage:{ 'qt-downloads':JSON.stringify({ version:2, items }), ...(options.initialStorage ?? {}) } });
}
async function downloadDensityCase() {
  const b = await downloadFixture();
  try {
    await b.mount('pages/download/index.uvue');
    assert.equal(b.downloads.items.length, 2, 'complete page restore uses the real downloads ledger');
    const rows = b.byClass('row').filter(node => node.tag === 'list-item');
    assert.equal(rows.length, 2, 'download native list renders real stored items');
    for (const row of rows) {
      assert.equal(b.css(row).height, '92px', 'TV download native host budgets one 76px card plus the original 16px gap');
      assert.equal(b.css(walk(row).find(node => hasClass(node, 'row-card'))).height, '76px', 'TV download item card explicitly reserves shared title/meta geometry');
      for (const hit of walk(row).filter(node => hasClass(node, 'row-hit'))) {
        assert.equal(b.css(hit).height, '56px', 'each download row action exposes a 56px TV target');
        assert.equal(b.css(hit).width, '56px', 'narrow action icons retain a full 56px target width');
      }
    }
    assert.equal(b.css(b.byClass('ops-line')[0]).height, '56px', 'TV download header holds full remote targets');
    assert.equal(b.css(b.byClass('hit')[0]).height, '56px', 'TV manage entry fills header geometry');
    const before = b.player.playbackRevision();
    b.audio.audioPlayer.setGapless(false);
    await b.dispatch(b.byClass('main')[1]);
    assert.equal(b.player.current.id, 'second', 'complete downloaded-row click reaches real playback');
    assert.equal(b.player.current.url, '/fixture/second.mp3', 'download page plays the original local-file path');
    assert.equal(b.player.playbackRevision(), before + 1, 'one downloaded-row click issues one playback request');
  } finally { await b.close(); }
}

async function downloadMoreCase() {
  const b = await downloadFixture();
  try {
    await b.mount('pages/download/index.uvue');
    const more = b.byClass('download-tv-more')[1];
    assert.ok(more, 'TV downloaded rows expose a visible More control rather than only touch deletion');
    assert.equal(b.css(more).width, '56px'); assert.equal(b.css(more).height, '56px');
    const before = b.player.playbackRevision();
    await b.dispatch(more);
    assert.equal(b.player.playbackRevision(), before, 'visible More does not bubble into local playback');
    assert.deepEqual(b.byClass('qo-label').map(text).filter(label => ['播放', '删除下载'].includes(label)), ['播放', '删除下载'], 'download More uses the real QtUI action-sheet');
    await b.dispatch(b.option('播放'));
    assert.equal(b.player.current.id, 'second');
    assert.equal(b.player.current.url, '/fixture/second.mp3');
    assert.equal(b.player.playbackRevision(), before + 1, 'one public menu Play calls the existing real Player path once');
    await b.dispatch(b.byClass('download-tv-more')[0]);
    await b.dispatch(b.option('删除下载'));
    assert.equal(b.downloads.items.length, 2, 'menu deletion still waits for the existing confirmation service');
    await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消'));
    assert.equal(b.downloads.items.length, 2, 'cancel preserves the download ledger');
  } finally { await b.close(); }
}

async function downloadRemoteCase() {
  const b = await downloadFixture();
  try {
    await b.mount('pages/download/index.uvue');
    const target = b.byClass('main')[1];
    b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocus(nativeId(target)), true, 'the existing full page owns the downloaded-row focus');
    const before = b.player.playbackRevision();
    await b.remote('menu');
    assert.ok(b.option('播放'), 'remote Menu on the focused downloaded row opens its original-action QtUI menu');
    assert.equal(b.player.playbackRevision(), before, 'Menu alone does not activate playback');
    await b.remote('back');
    assert.equal(b.option('播放'), undefined, 'remote Back cancels the real modal instead of leaving the page');
    assert.equal(b.tv.qtTvFocusedId(), nativeId(target), 'closing the modal restores the original occurrence focus');
    await b.remote('menu');
    const play = b.option('播放');
    b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocus(nativeId(play)), true, 'actual second modal Play target is collected by native focus refresh');
    await b.remote('ok', 1);
    assert.equal(b.player.playbackRevision(), before, 'repeat OK does not duplicate the public modal action');
    await b.remote('ok');
    assert.equal(b.player.current.id, 'second');
    assert.equal(b.player.playbackRevision(), before + 1);
  } finally { await b.close(); }
}

async function downloadSelectionCase() {
  const items = [downloaded('first'), downloaded('second')];
  const b = await downloadFixture(items, { files:{ '/fixture/first.mp3':2048, '/fixture/second.mp3':4096 } });
  try {
    await b.mount('pages/download/index.uvue');
    const before = b.player.playbackRevision();
    await b.dispatch(b.byClass('hit').find(node => text(node) === '管理'));
    assert.equal(b.byClass('download-tv-more').length, 0, 'download management hides single-item menus');
    const remove = b.byClass('manage-btn')[0];
    assert.equal(b.css(remove).height, '56px', 'TV batch-delete remains a full visible header target');
    await b.dispatch(remove);
    assert.equal(b.byClass('qc-panel').length, 0, 'no selected items retains the original delete guard');
    await b.dispatch(b.byClass('qt-checkbox')[1]);
    assert.match(b.text(), /已选 1 首/);
    assert.equal(b.player.playbackRevision(), before, 'QtCheckbox stop propagation selects once without playing');
    await b.dispatch(b.byClass('main')[1], 'longpress');
    assert.equal(b.option('播放'), undefined, 'management guard prevents remote Menu from opening item actions');
    await b.dispatch(b.byClass('manage-btn')[0]);
    assert.equal(b.downloads.items.length, 2);
    await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消'));
    assert.match(b.text(), /已选 1 首/);
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'deleteMediaByPath').length, 0);
    await b.dispatch(b.byClass('manage-btn')[0]);
    await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '删除'));
    assert.deepEqual(plain(b.downloads.items.map(item => item.song.id)), ['first']);
    assert.deepEqual(b.ownedNativeCalls.filter(call => call.name === 'deleteMediaByPath').map(call => call.paths), [['/fixture/second.mp3']], 'real removeMany deletes precisely the selected owned path');
    assert.equal(b.files.has('/fixture/first.mp3'), true); assert.equal(b.files.has('/fixture/second.mp3'), false);
    assert.deepEqual(JSON.parse(b.storage.get('qt-downloads')).items.map(item => item.song.id), ['first']);
    assert.equal(b.byClass('qt-checkbox').length, 0, 'successful batch remove leaves management mode');
  } finally { await b.close(); }
}

const podcastTaskSong = (name = '恢复中的下载') => ({ id:'https://owned.invalid/audio.mp3', platform:'podcast', name, singer:'验证歌手', album:'验证专辑', picUrl:'', url:'https://owned.invalid/audio.mp3', duration:180 });
async function downloadTaskActionsCase() {
  const current = podcastTaskSong();
  const b = await downloadFixture([], { initialStorage:{ 'qt-download-tasks':JSON.stringify({ version:2, tasks:[{ song:current, status:'paused', error:'' }] }) } });
  try {
    await b.mount('pages/download/index.uvue');
    await b.dispatch(b.option('暂停'));
    assert.equal(b.downloads.tasks[0].status, 'paused', 'complete page restores real paused task without starting a request');
    assert.equal(b.pendingNetwork.length, 0);
    const more = b.byClass('download-tv-task-more')[0];
    assert.ok(more, 'TV task rows expose visible More in addition to their original direct action icons');
    await b.dispatch(more);
    assert.ok(b.option('继续下载'), 'task More delegates to real action-sheet options');
    await b.dispatch(b.option('继续下载'));
    assert.equal(b.downloads.tasks[0].status, 'downloading', 'public task More invokes the unchanged real resume service');
    assert.equal(b.pendingNetwork.length, 1, 'actual resume reaches native download SDK');
    b.pendingNetwork[0].success(); await b.flush();
    assert.equal(b.pendingNetwork.length, 2, 'SDK probe without progress falls back to the existing whole-file download');
    await b.dispatch(b.option('下载中'));
    const info = b.byClass('row-card').flatMap(node => walk(node)).find(node => hasClass(node, 'info'));
    b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocus(nativeId(info)), true, 'task information exposes a native remote Menu focus target');
    await b.remote('menu');
    assert.ok(b.option('暂停下载'), 'focused task remote Menu selects the live in-flight operation');
    await b.dispatch(b.option('暂停下载'));
    assert.equal(b.downloads.tasks[0].status, 'paused');
    assert.equal(b.pendingNetwork[1].aborted, true, 'real pause reaches its existing best-effort native abort');
    await b.dispatch(b.option('暂停'));
    await b.dispatch(b.byClass('download-tv-task-more')[0]);
    await b.dispatch(b.option('取消任务'));
    assert.equal(b.downloads.tasks.length, 0, 'menu task cancellation keeps original removeTask semantics');
    assert.deepEqual(JSON.parse(b.storage.get('qt-download-tasks')).tasks, []);
    assert.equal(b.downloads.items.length, 0, 'cancelled task is never published as completed audio');
  } finally { await b.close(); }
}

async function downloadTaskGeometryCase() {
  const current = podcastTaskSong('进度与剩余时间在实际字号下完整占一行');
  const b = await downloadFixture([], { initialStorage:{ 'qt-download-tasks':JSON.stringify({ version:2, tasks:[{ song:current, status:'paused', error:'' }] }) } });
  try {
    await b.mount('pages/download/index.uvue');
    await b.dispatch(b.option('暂停'));
    await b.dispatch(b.byClass('download-tv-task-more')[0]); await b.dispatch(b.option('继续下载'));
    b.pendingNetwork[0].success(); await b.flush();
    b.pendingNetwork[1].progress(32768, 131072); await b.flush();
    await b.dispatch(b.option('下载中'));
    const host = b.byClass('row').find(node => node.tag === 'list-item');
    const card = walk(host).find(node => hasClass(node, 'row-card'));
    const name = walk(card).find(node => hasClass(node, 'name'));
    const meta = walk(card).find(node => hasClass(node, 'meta'));
    assert.equal(b.css(name)['line-height'], '29px', 'TV task title explicitly occupies the real 22.08px font line');
    assert.equal(b.css(meta)['line-height'], '26px', 'TV task footer explicitly occupies the 20px minimum font line');
    assert.equal(b.css(card).height, '96px', 'download progress card budgets its title, progress, footer and gaps rather than squeezing into a two-line SongRow');
    assert.equal(b.css(host).height, '112px', 'native task virtual host reserves exactly the full card and original 16px gap');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(name)['line-height'], '38px');
    assert.equal(b.css(meta)['line-height'], '33px');
    assert.equal(b.css(card).height, '109px', 'huge TV task footer stays visible without reduced font or clipping');
    assert.equal(b.css(host).height, '125px');
    for (const hit of walk(card).filter(node => hasClass(node, 'row-hit'))) assert.equal(b.css(hit).height, '56px');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(host).height, undefined, 'same mounted native host returns to original phone/wide CSS in touch mode');
    assert.equal(b.css(card).height, undefined);
    assert.equal(b.css(name)['line-height'], undefined, 'touch text retains its original CSS line geometry');
    assert.equal(b.byClass('download-tv-task-more').length, 0, 'touch does not acquire an extra TV task action');
  } finally { await b.close(); }
}

async function downloadItemGeometryCase() {
  const b = await downloadFixture([downloaded('first', '下载标题按共享字体实际占据一行')]);
  try {
    await b.mount('pages/download/index.uvue');
    const host = b.byClass('row').find(node => node.tag === 'list-item');
    const card = walk(host).find(node => hasClass(node, 'row-card'));
    const name = walk(card).find(node => hasClass(node, 'name'));
    const meta = walk(card).find(node => hasClass(node, 'meta'));
    assert.equal(b.css(name)['line-height'], '29px', 'TV completed download title has an explicit actual font line');
    assert.equal(b.css(meta)['line-height'], '26px', 'TV completed download subtitle has an explicit actual font line');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(name)['line-height'], '38px'); assert.equal(b.css(meta)['line-height'], '33px');
    assert.equal(b.css(card).height, '91px', 'completed download remains a shared huge two-line song row');
    assert.equal(b.css(host).height, '107px', 'completed native host follows the shared huge row and original gap');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(host).height, undefined); assert.equal(b.css(card).height, undefined);
    assert.equal(b.css(name)['line-height'], undefined); assert.equal(b.css(meta)['line-height'], undefined);
    assert.equal(b.byClass('download-tv-more').length, 0, 'existing touch downloaded row does not acquire a TV More action');
  } finally { await b.close(); }
}

async function historyRemoteRestoreCase() {
  const b = await libraryFixture({ width:1920, height:1080 });
  try {
    b.player.history = [song('one', '历史第一首'), song('two', '历史第二首'), song('three', '历史第三首')];
    await b.mount('pages/history/index.uvue');
    const visible = () => b.byClass('row-item').flatMap(host => walk(host).filter(node => hasClass(node, 'row') && node.props['data-qt-tv-id']));
    const row = visible()[0]; b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocus(nativeId(row)), true);
    await b.remote('menu');
    assert.ok(b.option('从最近播放移除'), 'actual history FullSongRow Menu exposes original history-specific action');
    await b.remote('back');
    assert.equal(b.tv.useQtTv().focusedId, nativeId(row), 'closing actual history menu restores occurrence focus');
    const more = walk(row).find(node => String(node.props['data-qt-tv-id'] ?? '').endsWith(':more'));
    await b.dispatch(more); await b.dispatch(b.option('从最近播放移除'));
    assert.deepEqual(plain(b.player.history.map(item => item.id)), ['two', 'three'], 'visible More invokes unchanged real history service');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const host of b.byClass('row-item')) assert.equal(b.css(host).height, '91px');
    for (const songRow of visible()) assert.equal(b.css(songRow).height, '91px');
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const host of b.byClass('row-item')) assert.equal(b.css(host).height, undefined, 'touch returns native history host to original CSS');
    for (const songRow of visible()) assert.equal(b.css(songRow).height, undefined);
    b.setWindow({ windowWidth:390, windowHeight:844 }); await b.clock.runTimers(1000);
    assert.equal(b.byClass('row-item').length, 2, 'actual responsive watcher restores phone single-column host count');
    assert.equal(b.byClass('cell-right').length, 0);
    const clear = () => b.byClass('act-link').find(node => text(node) === '清空记录');
    await b.dispatch(clear());
    assert.equal(b.player.history.length, 2, 'existing clear history remains confirmation-gated');
    await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消'));
    assert.equal(b.player.history.length, 2);
    await b.dispatch(clear()); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '清空'));
    assert.equal(b.player.history.length, 0); assert.ok(b.text().includes('还没有播放过歌曲'));
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'deleteMediaByPath').length, 0);
  } finally { await b.close(); }
}

async function downloadDeletePolicyCase() {
  for (const keep of [false, true]) {
    const items = [downloaded('first'), downloaded('second'), downloaded('missing')];
    items[0].sidecars = ['/fixture/first.lrc'];
    const b = await downloadFixture(items, { failUniStat:true, files:{ '/fixture/first.mp3':2048, '/fixture/second.mp3':4096, '/fixture/first.lrc':300 },
      initialStorage:{ 'qt-download-delete-file':keep ? '0' : '1' } });
    try {
      await b.mount('pages/download/index.uvue');
      const descriptions = b.byClass('main').map(node => text(walk(node).find(child => hasClass(child, 'meta'))));
      assert.equal(descriptions[0].includes('文件缺失'), false, 'failed uni stat falls back to authoritative native numeric size');
      assert.equal(descriptions[1].includes('文件缺失'), false);
      assert.equal(descriptions[2].includes('文件缺失'), true, 'only native -1 marks downloaded audio missing');
      await b.dispatch(b.byClass('download-tv-more')[0]); await b.dispatch(b.option('删除下载'));
      assert.ok(b.text().includes(keep ? '音频文件会保留' : '并删除手机里对应的音频文件'), 'real confirmation follows the original delete-files setting');
      await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消'));
      assert.equal(b.downloads.items.length, 3); assert.equal(b.files.has('/fixture/first.mp3'), true);
      assert.equal(b.ownedNativeCalls.filter(call => call.name === 'deleteMediaByPath').length, 0);
      await b.dispatch(b.byClass('download-tv-more')[0]); await b.dispatch(b.option('删除下载'));
      await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '删除'));
      assert.deepEqual(plain(b.downloads.items.map(item => item.song.id)), ['second', 'missing']);
      assert.equal(b.files.has('/fixture/first.mp3'), keep); assert.equal(b.files.has('/fixture/first.lrc'), keep);
      assert.equal(b.files.has('/fixture/second.mp3'), true, 'unselected completed audio remains owned and untouched');
      const deletions = b.ownedNativeCalls.filter(call => call.name === 'deleteMediaByPath').map(call => call.paths);
      assert.deepEqual(deletions, keep ? [] : [['/fixture/first.mp3', '/fixture/first.lrc']], 'removeMany retains exact existing file and sidecar ownership contract');
      assert.deepEqual(JSON.parse(b.storage.get('qt-downloads')).items.map(item => item.song.id), ['second', 'missing']);
    } finally { await b.close(); }
  }
}

async function downloadPublishCase() {
  for (const permission of [true, false]) {
    const current = podcastTaskSong('失败恢复后完成落盘');
    const b = await downloadFixture([], { permission, initialStorage:{ 'qt-download-tasks':JSON.stringify({ version:2, tasks:[{ song:current, status:'failed', error:'之前的网络错误' }] }) } });
    try {
      await b.mount('pages/download/index.uvue'); await b.dispatch(b.option('失败'));
      assert.equal(b.pendingNetwork.length, 0, 'restored failure remains idle until its public retry action');
      assert.ok(b.text().includes('之前的网络错误'));
      await b.dispatch(b.byClass('download-tv-task-more')[0]); await b.dispatch(b.option('重试下载'));
      assert.equal(b.downloads.tasks[0].status, 'downloading', 'task More reuses original retry instead of replacing download state');
      assert.equal(b.pendingNetwork.length, 1);
      b.pendingNetwork[0].success(); await b.flush();
      assert.equal(b.pendingNetwork.length, 2);
      b.pendingNetwork[1].progress(65536, 131072); await b.flush();
      b.pendingNetwork[1].success(); await b.flush(); await b.flush();
      assert.equal(b.downloads.tasks.length, 0, 'actual download pipeline removes completed tasks');
      assert.equal(b.downloads.items.length, 1, 'real completion publishes exactly one ledger entry');
      const result = b.downloads.items[0];
      assert.equal(result.size, 131072, 'real ledger records authoritative saved-file bytes');
      assert.deepEqual(plain(result.sidecars), []);
      const operations = b.ownedNativeCalls.filter(call => ['permission','publish','privateSave'].includes(call.name));
      assert.deepEqual(operations.map(call => call.name), permission ? ['permission','publish'] : ['permission','privateSave'], 'existing public-permission decision and private fallback are retained');
      assert.equal(result.path, operations.at(-1).path);
      assert.equal(b.files.has(result.path), true);
      assert.deepEqual(JSON.parse(b.storage.get('qt-download-tasks')).tasks, []);
      assert.equal(JSON.parse(b.storage.get('qt-downloads')).items[0].path, result.path);
      await b.dispatch(b.option('已完成'));
      const before = b.player.playbackRevision(); b.audio.audioPlayer.setGapless(false);
      await b.dispatch(b.byClass('main')[0]);
      assert.equal(b.player.current.url, result.path, 'completed public/private download still plays its actual local file');
      assert.equal(b.player.playbackRevision(), before + 1);
    } finally { await b.close(); }
  }
}

async function downloadHeaderFilterCase() {
  const first = podcastTaskSong('第一待下载任务');
  const second = { ...podcastTaskSong('第二待下载任务'), id:'https://owned.invalid/second.mp3', url:'https://owned.invalid/second.mp3' };
  const failed = { ...podcastTaskSong('失败任务'), id:'https://owned.invalid/failed.mp3', url:'https://owned.invalid/failed.mp3' };
  const finished = downloaded('finished');
  const b = await downloadFixture([finished], { files:{ [finished.path]:2048 }, initialStorage:{ 'qt-download-concurrency':'1',
    'qt-download-tasks':JSON.stringify({ version:2, tasks:[{ song:first, status:'paused', error:'' }, { song:second, status:'paused', error:'' }, { song:failed, status:'failed', error:'保留的旧错误' }] }) } });
  const hit = label => b.byClass('hit').find(node => text(node) === label);
  const filter = label => b.option(label);
  const count = label => text(walk(filter(label)).find(node => hasClass(node, 'qo-description')));
  try {
    await b.mount('pages/download/index.uvue');
    assert.equal(count('下载中'), '0'); assert.equal(count('等待中'), '0'); assert.equal(count('已完成'), '1');
    assert.equal(count('暂停'), '2'); assert.equal(count('失败'), '1');
    await b.dispatch(filter('暂停')); assert.equal(b.byClass('download-tv-task-more').length, 2);
    await b.dispatch(hit('全部继续'));
    assert.equal(b.pendingNetwork.length, 1); assert.equal(count('下载中'), '1'); assert.equal(count('等待中'), '1');
    await b.dispatch(filter('等待中')); assert.equal(b.byClass('download-tv-task-more').length, 1); assert.ok(b.text().includes('第二待下载任务'));
    await b.dispatch(hit('全部暂停'));
    assert.equal(count('下载中'), '0'); assert.equal(count('等待中'), '0'); assert.equal(count('暂停'), '2');
    b.pendingNetwork[0].success(); await b.flush();
    await b.dispatch(filter('失败')); await b.dispatch(hit('全部重试'));
    assert.equal(count('失败'), '0'); assert.equal(count('下载中'), '1'); assert.equal(b.pendingNetwork.length, 2);
    await b.dispatch(filter('下载中')); b.pendingNetwork.at(-1).success(); await b.flush();
    assert.equal(b.pendingNetwork.length, 3);
    await b.dispatch(hit('全部暂停')); assert.equal(b.pendingNetwork.at(-1).aborted, true);
    assert.equal(count('暂停'), '3');
    await b.dispatch(hit('全部取消')); assert.equal(b.downloads.tasks.length, 3);
    assert.ok(b.text().includes('已下载完成的文件不受影响'));
    await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消')); assert.equal(b.downloads.tasks.length, 3);
    await b.dispatch(hit('全部取消')); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '全部取消'));
    assert.equal(b.downloads.tasks.length, 0); assert.deepEqual(JSON.parse(b.storage.get('qt-download-tasks')).tasks, []);
    assert.equal(b.files.has(finished.path), true); assert.equal(b.downloads.items.length, 1);
    await b.dispatch(filter('已完成')); await b.dispatch(hit('管理'));
    await b.dispatch(hit('全选')); assert.match(b.text(), /已选 1 首/); await b.dispatch(hit('取消全选')); assert.match(b.text(), /已选 0 首/);
    await b.dispatch(b.byClass('main')[0]); assert.match(b.text(), /已选 1 首/);
    await b.dispatch(filter('暂停')); assert.equal(b.byClass('qt-checkbox').length, 0);
    await b.dispatch(filter('已完成')); assert.ok(hit('管理')); assert.equal(b.byClass('qt-checkbox').length, 0, 'switching away resets selection before returning to completed downloads');
    await b.dispatch(filter('失败')); for (const show of b.lifecycle.show) await show(); await b.flush();
    assert.ok(b.text().includes('没有失败的下载'), 'onShow preserves the explicitly chosen filter even after all tasks are gone');
    assert.equal(b.byClass('scroll').filter(node => node.tag === 'list-view').length, 0, 'empty filter remains the original non-scrolling view');
  } finally { await b.close(); }
}

const cases = { history:historyCase, 'history-actions':historyActionsCase, 'download-density':downloadDensityCase, 'download-more':downloadMoreCase, 'download-remote':downloadRemoteCase, 'download-selection':downloadSelectionCase, 'download-task-actions':downloadTaskActionsCase, 'download-task-geometry':downloadTaskGeometryCase, 'download-item-geometry':downloadItemGeometryCase, 'history-remote-restore':historyRemoteRestoreCase, 'download-delete-policy':downloadDeletePolicyCase, 'download-publish':downloadPublishCase, 'download-header-filter':downloadHeaderFilterCase };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const selected = process.argv[2] ? { [process.argv[2]]:cases[process.argv[2]] } : cases;
  let failures = 0;
  for (const [name, run] of Object.entries(selected)) {
    try { assert.ok(run, 'known TV library case: ' + name); await run(); console.log('PASS TV library ' + name); }
    catch (error) { failures++; console.error('FAIL TV library ' + name); console.error(error); }
  }
  console.log('TV library: ' + (Object.keys(selected).length - failures) + ' passed, ' + failures + ' failed');
  if (failures) process.exitCode = 1;
}
