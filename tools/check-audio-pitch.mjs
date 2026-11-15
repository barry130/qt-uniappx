// Execute the complete public AudioPlayer facade; only native audio/storage/events are host boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { preprocessPlatform } from './platform-preprocess.mjs';
const source = readFileSync(new URL('../services/audio-player.uts', import.meta.url), 'utf8');
const noop = () => {};
function host(platform = 'APP-ANDROID', initial = {}) {
  const storage = new Map(Object.entries(initial)), calls = [], events = [], toasts = [], warnings = [];
  const callbacks = new Map();
  let dlna = false, failWrite = false, failRead = false;
  const native = new Proxy({}, { get: (_, key) => {
    if (key === 'audioDlnaActive') return () => dlna;
    if (key === 'audioEffectsSupported') return () => true;
    if (key === 'audioDlnaState') return () => ({ target: dlna ? 'dlna' : 'local' });
    return (...args) => {
      if (String(key).startsWith('audioOn')) callbacks.set(key, args[0]);
      else calls.push([key, ...args]);
    };
  } });
  const module = { exports: {} };
  const uni = {
    getStorageSync(key) { if (failRead) throw Error('storage-read'); return storage.get(key) ?? ''; },
    setStorageSync(key, value) { if (failWrite) throw Error('storage-write'); storage.set(key, value); },
    $emit: (...args) => events.push(args),
  };
  const output = ts.transpileModule(preprocessPlatform(source, platform), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, uni, console,
    require(id) {
      if (id === '@/uni_modules/qt-audio-player') return native;
      if (id === '@/services/logger') return { logInfo: noop, logErrV: noop, logWarnV: (...args) => warnings.push(args) };
      if (id === '@/services/toast') return { qtShowToast: value => toasts.push(value) };
      throw Error('Unexpected runtime import: ' + id);
    },
  }, { filename: 'services/audio-player.uts' });
  const api = new module.exports.AudioPlayer();
  return { ...module.exports, api, storage, calls, events, toasts, warnings,
    setDlna(value) { dlna = value; }, failWrite() { failWrite = true; }, failRead() { failRead = true; },
    receive(event, ...args) { callbacks.get(event)?.(...args); },
    pitchCalls: () => calls.filter(row => row[0] === 'audioSetPitch').map(row => row[1]),
  };
}
let passed = 0;
function check(label, test) { test(); console.log('PASS ' + label); passed++; }
check('new Android install restores original key before any playback', () => {
  const h = host(); h.api.restore();
  assert.equal(h.audioCapabilities().pitch, true);
  assert.equal(h.api.getPitch(), 0);
  assert.deepEqual(h.pitchCalls(), [0]);
  assert.equal(h.calls.some(row => row[0] === 'audioPlay'), false);
});
check('semitone edits preserve speed, publish their value and survive a fresh instance', () => {
  const h = host(); h.api.restore(); h.api.changeRate(1.5);
  assert.equal(h.api.setPitch(-4), true);
  assert.equal(h.api.rate, 1.5);
  assert.equal(h.api.getPitch(), -4);
  assert.equal(h.storage.get('qt-playback-pitch'), '-4');
  assert.equal(h.events.at(-1)[0], h.PLAYER_PITCH_CHANGED_EVENT);
  assert.equal(h.events.at(-1)[1], -4);
  h.api.changeRate(0.75);
  assert.equal(h.api.getPitch(), -4);
  assert.deepEqual(h.pitchCalls(), [0, -4]);
  const next = host('APP-ANDROID', Object.fromEntries(h.storage)); next.api.restore();
  assert.equal(next.api.getPitch(), -4); assert.equal(next.api.rate, 0.75);
  assert.deepEqual(next.pitchCalls(), [-4]);
});
check('public setter normalizes whole semitones and clamps both octave bounds', () => {
  const h = host(); h.api.restore();
  for (const [input, expected] of [[12, 12], [50, 12], [-50, -12], [2.4, 2], [-3.6, -4], [NaN, 0], [Infinity, 0], [-Infinity, 0]]) {
    assert.equal(h.api.setPitch(input), true); assert.equal(h.api.getPitch(), expected);
    assert.equal(h.pitchCalls().at(-1), expected);
  }
});
check('damaged persisted pitch restores original key without affecting valid speed', () => {
  for (const value of ['', 'abc', '4x', 'Infinity', '13', '-13', '2.5']) {
    const h = host('APP-ANDROID', { 'qt-playback-pitch': value, 'qt-playback-rate': '1.25' });
    h.api.restore(); assert.equal(h.api.getPitch(), 0); assert.equal(h.api.rate, 1.25);
    assert.deepEqual(h.pitchCalls(), [0]);
  }
  const h = host(); h.failRead(); h.api.restore(); assert.equal(h.api.getPitch(), 0);
});
check('DLNA uses original stream while retaining the chosen local pitch', () => {
  const h = host(); h.api.restore(); h.api.setPitch(5);
  h.receive('audioOnTimeUpdate', 1, 240); h.setDlna(true); h.receive('audioOnTimeUpdate', 2, 240);
  assert.equal(h.audioCapabilities().pitch, false);
  const calls = h.pitchCalls().length;
  assert.equal(h.api.setPitch(-3), false);
  assert.equal(h.api.getPitch(), 5); assert.equal(h.storage.get('qt-playback-pitch'), '5');
  assert.equal(h.pitchCalls().length, calls); assert.ok(h.toasts.at(-1).title.includes('DLNA'));
  assert.ok(h.events.some(row => row[0] === h.PLAYER_CAPABILITIES_CHANGED_EVENT));
  h.setDlna(false); h.receive('audioOnTimeUpdate', 3, 240);
  assert.equal(h.audioCapabilities().pitch, true); assert.equal(h.api.getPitch(), 5);
});
check('global settings reset clears the local pitch even while casting', () => {
  const h = host(); h.api.restore(); h.api.setPitch(7); h.setDlna(true);
  h.api.resetPitch();
  assert.equal(h.api.getPitch(), 0); assert.equal(h.storage.get('qt-playback-pitch'), '0');
  assert.equal(h.pitchCalls().at(-1), 0);
  assert.equal(h.events.at(-1)[1], 0);
});
check('a storage write failure keeps the live audio setting and reports the persistence failure', () => {
  const h = host(); h.api.restore(); h.failWrite();
  assert.equal(h.api.setPitch(-2), true);
  assert.equal(h.api.getPitch(), -2); assert.equal(h.pitchCalls().at(-1), -2);
  assert.ok(h.warnings.length > 0);
});
check('unsupported platforms never advertise or invoke pitch DSP', () => {
  for (const platform of ['APP-IOS', 'APP-HARMONY', 'H5']) {
    const h = host(platform); h.api.restore();
    assert.equal(h.audioCapabilities().pitch, false);
    assert.equal(h.api.setPitch(3), false);
    assert.equal(h.api.getPitch(), 0); assert.deepEqual(h.pitchCalls(), []);
    assert.equal(h.storage.has('qt-playback-pitch'), false);
  }
});
console.log(`Audio pitch service: ${passed} public behavior groups passed`);
