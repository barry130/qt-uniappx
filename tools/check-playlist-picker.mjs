import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const source = read('uni_modules/qt-ui/components/qt-playlist-picker/qt-playlist-picker.uvue');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const runnable = stripTypeScriptTypes(script.replace(/^import .*;$/gm, ''), { mode: 'strip' });
function picker(batchMode = false) {
  const emitted = [], calls = [], watchers = [];
  const props = {
    visible: true, song: { id: 'song' }, playlists: [{ id: 'old', name: '原歌单', picUrl: '' }],
    selectedIds: ['old'], batchMode,
    createPlaylist(name) {
      calls.push(name);
      const playlist = { id: 'new-' + calls.length, name, picUrl: '' };
      props.playlists.push(playlist);
      return playlist;
    },
  };
  const layout = { isWide: true, windowHeight: 600, safeBottomPx: 0, sizeEpoch: 0 };
  const context = {
    defineProps: () => props, withDefaults: (value, defaults) => Object.assign(defaults, value),
    defineEmits: () => (event, value) => emitted.push([event, value]),
    ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
    watch: (getter, callback, options) => { watchers.push({ getter, callback }); if (options?.immediate) callback(); },
    useQtLayout: () => layout, qtRpx: value => value / 2, fontScale: { scale: 1 },
    useThemeStore: () => ({ dark: false, skin: {} }), qtSelectionColor: () => '#d93c43',
    useQtSelectionReveal: () => ({ anchor: { value: '' }, itemId: index => 'row-' + index }),
  };
  const api = runInNewContext(runnable + '\n({props,newName,createError,selectedPlaylistIds,isSelected,submitCreate,confirm,close,togglePlaylist,onNameInput,listStyle});', context);
  return { ...api, emitted, calls, watchers, layout };
}
const one = picker();
one.newName.value = '  ';
one.submitCreate();
assert.equal(one.calls.length, 0);
one.newName.value = '  新建歌单  ';
one.submitCreate();
assert.deepEqual(one.calls, ['新建歌单']);
assert.equal(one.newName.value, '');
assert.equal(one.isSelected('old'), true);
assert.equal(one.isSelected('new-1'), true);
assert.equal(one.emitted.length, 0, 'creation must not submit a single-song draft');
one.newName.value = ' 新建歌单 ';
one.submitCreate();
assert.equal(one.calls.length, 1, 'double submission must not create another playlist');
assert.match(one.createError.value, /同名/);
assert.equal(one.newName.value, ' 新建歌单 ');
one.togglePlaylist(one.props.playlists[1]);
assert.equal(one.isSelected('new-1'), false);
one.togglePlaylist(one.props.playlists[1]);
one.close();
assert.deepEqual(one.emitted, [['update:visible', false]], 'cancel never saves song memberships');
one.confirm();
assert.equal(JSON.stringify(one.emitted[1]), JSON.stringify(['confirm', ['old', 'new-1']]));
// The next open restores persisted selection rather than a cancelled draft.
one.watchers[1].callback();
assert.equal(one.isSelected('new-1'), false);
const failed = picker();
failed.props.createPlaylist = () => null;
failed.newName.value = '保留名称';
failed.submitCreate();
assert.equal(failed.newName.value, '保留名称');
assert.match(failed.createError.value, /未能/);
failed.props.createPlaylist = () => { throw Error('storage failed'); };
failed.submitCreate();
assert.equal(failed.newName.value, '保留名称');
assert.equal(failed.selectedPlaylistIds.value.length, 1);
failed.onNameInput({ detail: { value: '重试名称' } });
assert.equal(failed.createError.value, '');
const batch = picker(true);
batch.newName.value = '批量'; batch.submitCreate();
assert.equal(batch.isSelected('new-1'), false, 'batch selection must wait for actual collection result');
batch.props.selectedIds.push('new-1');
assert.equal(batch.isSelected('new-1'), true);
batch.togglePlaylist(batch.props.playlists[1]);
assert.deepEqual(batch.emitted, [['toggle', 'new-1']]);
for (const wide of [true, false]) {
  const list = picker(); list.layout.isWide = wide;
  const height = () => Number(list.listStyle.value.match(/height:([\d.]+)px/)[1]);
  const single = height();
  list.props.playlists.push(...Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: String(i) })));
  assert.ok(height() > single && height() <= 300);
  list.layout.windowHeight = 280;
  assert.ok(height() >= 0 && height() < single, 'keyboard/short windows must reduce scroll viewport');
}
for (const page of ['artist', 'daily', 'daily-recommend', 'playlist', 'player']) {
  const hosts = [...read('pages/' + page + '/index.uvue').matchAll(/<QtPlaylistPicker\b[\s\S]*?\/>/g)];
  assert.ok(hosts.length > 0);
  for (const [host] of hosts) assert.ok(host.includes(':create-playlist='), page + ': every picker must support creation');
}
console.log('playlist picker: create/select/confirm/cancel, duplicate/failure retention, batch controlled selection, bounded compact/wide list and all hosts passed');
