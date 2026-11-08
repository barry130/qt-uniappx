// Execute the Android production focus handler against a simulated AudioManager/ExoPlayer.
// No duplicate policy implementation: exercise request ownership and delayed system callbacks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../uni_modules/qt-audio-player/utssdk/app-android/index.uts', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('class QtAudioFocusListener'), source.indexOf('// ==================== 播放核心事件'));
let passed = 0;
function check(name, fn) { fn(); console.log('  ok ' + name); passed++; }
function environment() {
  const events = [], requests = [], abandoned = [];
  const player = { playing: true, volume: 0.8, pause() { this.playing = false; events.push('pause'); },
    play() { this.playing = true; events.push('play'); }, setVolume(v) { this.volume = v; events.push('volume:' + v); } };
  class Builder {
    constructor(gain) { this.gain = gain; }
    setOnAudioFocusChangeListener(listener, handler) { this.listener = listener; this.handler = handler; return this; }
    setWillPauseWhenDucked(value) { this.pauseOnDuck = value; return this; }
    build() { return this; }
  }
  const am = { requestAudioFocus(req) { requests.push(req); return 1; }, abandonAudioFocusRequest(req) { abandoned.push(req); return 1; } };
  const AudioManager = { AUDIOFOCUS_GAIN: 1, AUDIOFOCUS_LOSS: -1, AUDIOFOCUS_LOSS_TRANSIENT: -2,
    AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: -3, AUDIOFOCUS_REQUEST_GRANTED: 1, OnAudioFocusChangeListener: class {} };
  const context = vm.createContext({ console: { log() {} }, AudioManager, AudioFocusRequest: { Builder },
    Context: { AUDIO_SERVICE: 'audio' }, getContext: () => ({ getSystemService: () => am }), getHandler: () => 'main-handler',
    isPlaying: () => player.playing, dlnaActive: () => false });
  const state = `let gFocusListener = null, gFocusRequest = null, gFocusRequestGainMode = -1;
    let gFocusHeld = false, gPausedByFocusLoss = false, gConcurrentMode = 0, gDucked = false;
    let gMediaPlayer = null, gUserVolume = 0.8; const DUCK_VOLUME = 0.3;`;
  vm.runInContext(stripTypeScriptTypes(state + section.replaceAll('.toFloat()', ''), { mode: 'strip' }) + `
    globalThis.api = { nativeSetConcurrentMode, requestAudioFocusIfNeeded, abandonAudioFocus,
      setPlayer(p) { gMediaPlayer = p; },
      manualPause() { gPausedByFocusLoss = false; gMediaPlayer.pause(); },
      state() { return { mode: gConcurrentMode, held: gFocusHeld, paused: gPausedByFocusLoss, ducked: gDucked }; } };`, context);
  const api = context.api;
  api.setPlayer(player);
  return { ...api, player, events, requests, abandoned,
    focus(value, req = requests.at(-1)) { req.listener.onAudioFocusChange(value); } };
}

check('all-scenes startup and repeated playback requests never compete for focus', () => {
  const e = environment(); e.nativeSetConcurrentMode(2);
  for (let i = 0; i < 100; i++) e.requestAudioFocusIfNeeded();
  assert.equal(e.requests.length, 0); assert.equal(e.abandoned.length, 0);
  assert.deepEqual(e.events, []); assert.equal(e.player.volume, 0.8);
});
check('switching to all-scenes while temporarily interrupted resumes without requesting focus', () => {
  const e = environment(); e.requestAudioFocusIfNeeded(); e.focus(-2);
  assert.equal(e.player.playing, false);
  e.nativeSetConcurrentMode(2);
  assert.equal(e.player.playing, true); assert.equal(e.requests.length, 1);
  assert.equal(e.abandoned[0], e.requests[0]); assert.equal(e.state().paused, false);
  e.focus(1); assert.deepEqual(e.events, ['pause', 'play']);
});
check('manual pause before choosing all-scenes is never undone', () => {
  const e = environment(); e.requestAudioFocusIfNeeded(); e.focus(-2); e.manualPause();
  e.nativeSetConcurrentMode(2); e.focus(1);
  assert.equal(e.player.playing, false); assert.ok(!e.events.includes('play'));
});
check('duck handling stays in the app, so switching to all-scenes restores actual gain', () => {
  const e = environment(); e.nativeSetConcurrentMode(1);
  assert.equal(e.requests[0].pauseOnDuck, true, 'disable Android automatic ducking; it bypasses our gain state');
  assert.equal(e.requests[0].handler, 'main-handler');
  e.focus(-3); assert.equal(e.player.volume, 0.24); assert.equal(e.player.playing, true);
  e.nativeSetConcurrentMode(2); assert.equal(e.player.volume, 0.8); assert.equal(e.requests.length, 1);
  assert.ok(!e.events.includes('pause')); assert.ok(!e.events.includes('play'));
});
check('permanent loss still unregisters the old request when choosing all-scenes', () => {
  const e = environment(); e.requestAudioFocusIfNeeded(); e.focus(-1);
  assert.equal(e.state().held, false); e.nativeSetConcurrentMode(2);
  assert.equal(e.abandoned[0], e.requests[0]); assert.equal(e.player.playing, false);
});
check('delayed callbacks from abandoned requests cannot pause a later playback mode', () => {
  const e = environment(); e.requestAudioFocusIfNeeded(); const old = e.requests[0];
  e.nativeSetConcurrentMode(2); e.nativeSetConcurrentMode(0);
  const current = e.requests.at(-1); assert.notEqual(current, old);
  for (const value of [-1, -2, -3, 1]) e.focus(value, old);
  assert.equal(e.player.playing, true); assert.deepEqual(e.events, []);
  e.focus(-2, current); assert.equal(e.player.playing, false);
  e.focus(1, current); assert.equal(e.player.playing, true);
});
check('repeated video/ad focus callbacks cannot interrupt, duck or restart all-scenes playback', () => {
  const e = environment(); e.requestAudioFocusIfNeeded(); const old = e.requests[0];
  e.nativeSetConcurrentMode(2);
  for (let i = 0; i < 100; i++) {
    for (const value of [-3, 1, -2, 1, -1]) e.focus(value, old);
    e.requestAudioFocusIfNeeded();
  }
  assert.equal(e.requests.length, 1); assert.equal(e.abandoned.length, 1);
  assert.equal(e.player.playing, true); assert.equal(e.player.volume, 0.8); assert.deepEqual(e.events, []);
});
check('exclusive and partial modes retain pause/resume/duck semantics', () => {
  for (const mode of [0, 1]) {
    const e = environment(); e.nativeSetConcurrentMode(mode); e.requestAudioFocusIfNeeded();
    e.focus(-3);
    assert.equal(e.player.playing, mode === 1); assert.equal(e.player.volume, mode === 1 ? 0.24 : 0.8);
    e.focus(1); assert.equal(e.player.playing, true); assert.equal(e.player.volume, 0.8);
    e.focus(-2); e.focus(-2); e.focus(1); assert.equal(e.player.playing, true);
    e.focus(-1); e.focus(1); assert.equal(e.player.playing, false);
  }
});
check('Media3 never independently requests focus and headphone-disconnect protection remains enabled', () => {
  assert.match(source, /\.setAudioAttributes\(attr, false\)/);
  assert.match(source, /\.setHandleAudioBecomingNoisy\(true\)/);
  assert.equal((source.match(/\.requestAudioFocus\(/g) ?? []).length, 1);
});
console.log('audio focus: ' + passed + ' checks passed');
