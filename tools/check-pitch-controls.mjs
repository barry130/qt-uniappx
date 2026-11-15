// Public rendered SFC seam only: UVue cells, QtButtons, QtSheet and the real AudioPlayer facade.
// Shared fixture owns only native/IO/storage/SDK lifecycle and platform boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {tvSettingsFixture} from './check-tv-settings.mjs';

async function fixture(options = {}) {
  const b = await tvSettingsFixture({height: 800, platform: 'APP-ANDROID', ...options});
  b.audio.audioPlayer.restore();
  await b.mount('pages/play-settings/index.uvue');
  await b.flush();
  return b;
}
const nativeCalls = (b, name) => b.nativeCalls.filter(call => call.name === name);
const textOf = node => node.text + node.children.map(textOf).join('');
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log('PASS pitch controls ' + label); }

await check('wide/compact public −1, original, +1 without extra page onShow', async () => {
  for (const width of [375, 1280]) {
    const b = await fixture({width, television: width === 1280});
    try {
      await b.dispatch(b.cell('升降调'));
      assert.equal(b.byClass('pitch-body').length, 1, 'hosted first mount opens without second onShow');
      assert.deepEqual(b.byClass('qt-button-label').map(textOf).slice(0, 3), ['−1', '原调', '+1']);
      b.audio.audioPlayer.changeRate(1.5);
      await b.dispatch(b.button('−1'));
      assert.equal(b.audio.audioPlayer.getPitch(), -1);
      await b.dispatch(b.button('+1'));
      assert.equal(b.audio.audioPlayer.getPitch(), 0);
      await b.dispatch(b.button('+1'));
      assert.equal(b.audio.audioPlayer.getPitch(), 1);
      assert.equal(b.audio.audioPlayer.rate, 1.5);
      assert.equal(nativeCalls(b, 'audioSetPitch').at(-1).args[0], 1);
    } finally { await b.close(); }
  }
});

await check('octave bounds, original persistence and disabled endpoint', async () => {
  const b = await fixture({initialStorage: {'qt-playback-pitch': '-12'}});
  try {
    await b.dispatch(b.cell('升降调'));
    const count = nativeCalls(b, 'audioSetPitch').length;
    await b.dispatch(b.button('−1'));
    assert.equal(nativeCalls(b, 'audioSetPitch').length, count);
    await b.dispatch(b.button('原调'));
    assert.equal(b.audio.audioPlayer.getPitch(), 0);
    for (let i = 0; i < 15; i++) await b.dispatch(b.button('+1'));
    assert.equal(b.audio.audioPlayer.getPitch(), 12);
    const upper = nativeCalls(b, 'audioSetPitch').length;
    await b.dispatch(b.button('+1'));
    assert.equal(nativeCalls(b, 'audioSetPitch').length, upper);
    assert.equal(b.storage.get('qt-playback-pitch'), '12');
    assert.equal(b.audio.audioPlayer.rate, 1);
  } finally { await b.close(); }
});

await check('close hides and subsequent public entry reopens', async () => {
  const b = await fixture();
  try {
    await b.dispatch(b.cell('升降调'));
    await b.dispatch(b.byClass('qs-close')[0]);
    assert.equal(b.byClass('pitch-body').length, 0);
    await b.dispatch(b.cell('升降调'));
    assert.equal(b.byClass('pitch-body').length, 1);
  } finally { await b.close(); }
});

await check('real DLNA capability invalidation and false service receipt', async () => {
  const b = await fixture({initialStorage: {'qt-playback-pitch': '5'}});
  try {
    await b.dispatch(b.cell('升降调'));
    const before = nativeCalls(b, 'audioSetPitch').length;
    b.audioBoundary.dlna = true;
    await b.dispatch(b.button('+1'));
    assert.equal(b.audio.audioPlayer.getPitch(), 5, 'stale visible controls respect the real false service receipt');
    assert.equal(nativeCalls(b, 'audioSetPitch').length, before);
    for (const fn of b.lifecycle.hide) fn();
    for (const fn of b.lifecycle.show) fn();
    await b.flush();
    assert.ok(b.text().includes('DLNA 沿用原调'));
    assert.equal(b.byClass('pitch-body').length, 0);
    assert.equal(b.audio.audioPlayer.getPitch(), 5);
    assert.equal(b.storage.get('qt-playback-pitch'), '5');
    assert.equal(nativeCalls(b, 'audioSetPitch').length, before);
    assert.equal(b.audio.audioPlayer.setPitch(3), false);
  } finally { await b.close(); }
});

await check('unsupported Harmony/iOS presentation, no native command, hidden lifecycle', async () => {
  for (const platform of ['APP-HARMONY', 'APP-IOS']) {
    const b = await fixture({platform});
    try {
      const count = nativeCalls(b, 'audioSetPitch').length;
      await b.dispatch(b.cell('升降调'));
      assert.ok(textOf(b.cell('升降调')).includes('当前平台暂不支持'));
      assert.equal(b.byClass('pitch-body').length, 0);
      for (const fn of b.lifecycle.hide) fn();
      for (const fn of b.lifecycle.show) fn();
      await b.flush();
      assert.equal(nativeCalls(b, 'audioSetPitch').length, count);
      assert.equal(b.audio.audioPlayer.setPitch(2), false);
    } finally { await b.close(); }
  }
});

await check('unload lifecycle completes without pitch writes or renderer errors', async () => {
  const b = await fixture();
  try {
    await b.dispatch(b.cell('升降调'));
    for (const fn of b.lifecycle.hide) fn();
    for (const fn of b.lifecycle.unload) fn();
    const before = nativeCalls(b, 'audioSetPitch').length;
    for (const fn of b.lifecycle.hide) fn();
    for (const fn of b.lifecycle.unload) fn();
    await b.flush();
    assert.equal(nativeCalls(b, 'audioSetPitch').length, before);
    assert.deepEqual(b.warnings, []);
  } finally { await b.close(); }
});

await check('player-bar registry: pitch tool default-off, quota toggle and sanitize', async () => {
  const b = await tvSettingsFixture({height: 800, platform: 'APP-ANDROID',
    boundaryOverrides: {'stores/player-bar': undefined}});
  try {
    const storeModule = b.load('stores/player-bar.ts');
    const pitch = storeModule.PLAYER_BAR_TOOLS.find(tool => tool.id === 'pitch');
    assert.ok(pitch, 'pitch tool is registered in the real PLAYER_BAR_TOOLS registry');
    assert.equal(pitch.label, '升降调');
    assert.ok(pitch.hint.includes('半音'), 'hint states the semitone range');
    assert.equal(pitch.icon, 'tone', 'pitch uses the dedicated tone icon');
    assert.equal(pitch.adminOnly, false, 'pitch is not admin-gated');
    assert.equal(storeModule.PLAYER_BAR_TOOLS.findIndex(tool => tool.id === 'speed') + 1,
      storeModule.PLAYER_BAR_TOOLS.findIndex(tool => tool.id === 'pitch'),
      'pitch sits next to speed in the shared settings order');
    assert.match(readFileSync(new URL('../uni_modules/qt-ui/services/icons.ts', import.meta.url), 'utf8'),
      /\btone:\s*['"]/, 'the tone icon exists in the shared icon set');
    const store = storeModule.usePlayerBarStore();
    store.restore();
    assert.equal(store.isVisible('pitch'), false, 'new bar tools stay default-hidden');
    assert.equal(store.toggle('pitch', () => true), true, 'user can enable pitch within the visible quota');
    assert.equal(store.isVisible('pitch'), true);
    store.restore();
    assert.equal(store.isVisible('pitch'), true, 'enabling pitch persists through the real storage key');
    assert.equal(store.toggle('speed', () => true), false, 'quota stays at four counted tools');
    assert.equal(store.toggle('pitch', () => true), true, 'switching pitch off always succeeds');
    assert.equal(store.isVisible('pitch'), false);
    const sanitized = storeModule.sanitizeVisibleTools(['pitch', 'bogus', 'download']);
    assert.deepEqual([...sanitized].sort(), ['download', 'pitch'].sort(), 'sanitize keeps pitch and drops unknown ids');
  } finally { await b.close(); }
});

await check('player page wires pitch into the shared bar-tool surfaces', async () => {
  const source = readFileSync(new URL('../pages/player/index.uvue', import.meta.url), 'utf8');
  assert.match(source, /import QtPitchControls from "@\/uni_modules\/qt-ui\/components\/qt-pitch-controls\/qt-pitch-controls\.uvue";/);
  assert.match(source, /import \{ audioPlayer, audioCapabilities, PLAYER_CAPABILITIES_CHANGED_EVENT, PLAYER_PITCH_CHANGED_EVENT \} from "@\/services\/audio-player";/);
  assert.match(source, /else if \(id == "pitch"\) showPitchControls\(\);/, 'bar-tool dispatch routes pitch to the shared sheet');
  assert.match(source, /if \(id == "pitch"\) return pitchSupported\.value && appliedPitch\.value != 0 \? theme\.skin\.accent : playerMuted\.value;/,
    'non-zero pitch gets the same accent treatment as non-default speed');
  assert.match(source, /<QtPitchControls :visible="pitchSheetVisible" :value="sheetPitch" :supported="pitchSupported" @update:visible="pitchSheetVisible = \$event" @change="changePitch" \/>/,
    'player page mounts the same shared pitch sheet as play-settings');
  assert.match(source, /uni\.\$on\(PLAYER_PITCH_CHANGED_EVENT, onPitchChanged\);/);
  assert.match(source, /uni\.\$off\(PLAYER_PITCH_CHANGED_EVENT, onPitchChanged\);/, 'listeners unregister symmetrically');
  assert.match(source, /title: casting\.value \? "DLNA 接收设备使用原调播放" : "当前平台暂不支持升降调"/,
    'casting and unsupported entries explain the reason instead of opening the sheet');
  assert.match(source, /if \(!audioPlayer\.setPitch\(value\)\) \{[\s\S]*?appliedPitch\.value = audioPlayer\.getPitch\(\);[\s\S]*?sheetPitch\.value = appliedPitch\.value;[\s\S]*?return;[\s\S]*?\}/,
    'a rejected service receipt reverts the shown value to the real applied one');
});

await check('播放页展示 settings render the new pitch row from the real registry', async () => {
  const b = await tvSettingsFixture({height: 800, platform: 'APP-ANDROID',
    boundaryOverrides: {'stores/player-bar': undefined}});
  try {
    await b.mount('pages/player-bar/index.uvue');
    await b.flush();
    const walk = node => node == null ? [] : [node, ...(node.children ?? []).flatMap(walk)];
    const hasClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name);
    const store = b.load('stores/player-bar.ts').usePlayerBarStore();
    store.restore();
    assert.equal(store.isVisible('pitch'), false, 'pitch starts default-off');
    const cell = b.cell('升降调');
    assert.ok(cell, 'the settings page renders the pitch row from the registry alone');
    const rowSwitch = walk(cell).find(node => hasClass(node, 'qsw'));
    assert.ok(rowSwitch, 'pitch row exposes the shared switch control');
    await b.dispatch(rowSwitch);
    assert.equal(store.isVisible('pitch'), true, 'switching the row toggles the real store');
    await b.dispatch(rowSwitch);
    assert.equal(store.isVisible('pitch'), false, 'switching back restores the default-off state');
  } finally { await b.close(); }
});
console.log('Pitch controls: ' + passed + ' full-production SFC groups passed');
