import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Existing approved Android seam: production clock/state functions plus the whole
// load/control/poll tail; Java I/O and thread queues are substituted. This is not
// a whole native module or native compilation test. Harmony covers the whole module.
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const native = read("uni_modules/qt-audio-player/utssdk/app-android/dlna.uts");
const protocol = read("uni_modules/qt-audio-player/utssdk/dlna-protocol.uts");
const compile = source => stripTypeScriptTypes(source.replace(/^export /gm, "").replace(/(\w+)!!/g, "$1!").replace(/\?\.invoke\(/g, "?.(").replace(/\.invoke\(/g, "("), { mode: "strip" });
const transport = native.slice(native.indexOf("function post("), native.indexOf("class XmlNode"));
const footer = native.slice(native.indexOf("function clearEndEvidence(") >= 0 ? native.indexOf("function clearEndEvidence(") : native.indexOf("function clearResolveTimeout("));
class Work { constructor(task) { this.task = task; } run() { this.task(); } }
class Epoch {
  value = 1;
  get() { return { toDouble: () => this.value }; }
  incrementAndGet() { this.value++; return this.get(); }
}
function fixture() {
  let now = 100000;
  const jobs = [], posts = [], timers = [], requests = [], states = [];
  const remote = { transport: 'PLAYING', uri: 'http://phone/song', position: 58000, duration: 60000 };
  const text = ms => new Date(ms).toISOString().slice(11, 19);
  const context = vm.createContext({
    Work, console, SystemClock: { elapsedRealtime: () => ({ toDouble: () => now }) },
    main: { post: task => posts.push(() => task.run()), postDelayed: (task, delay) => timers.push({ task, at: now + delay }), removeCallbacks: task => { const i = timers.findIndex(t => t.task === task); if (i >= 0) timers.splice(i, 1); } },
    network: { execute: job => jobs.push(job) },
    publicState: { target: 'dlna', sessionId: 1, generation: 1, phase: 'paused', mediaId: 'test:song', positionMs: 0, durationMs: 60000, volume: 0.5, deviceId: 'renderer', deviceName: 'Renderer', canSeek: true, canSetVolume: true, error: '' },
    currentDevice: { id: 'renderer', minVolume: 0, maxVolume: 100 }, currentResourceUri: remote.uri,
    currentItem: { mediaId: 'test:song', uri: 'qt-resolve://song', title: 'Song', artist: '', album: '', coverUrl: '', duration: 60 },
    anchorAt: now, sessionEpoch: new Epoch(), mediaEpoch: new Epoch(), playIntentEpoch: new Epoch(), seekEpoch: new Epoch(), volumeEpoch: new Epoch(),
    observedPlaying: false, previousTransport: '', manualStop: false,
    playingPositionMs: 0, playingAt: 0, playingPlayRevision: 0, playingSeekRevision: 0, playingSession: -1, playingGeneration: -1, playingUri: '',
    playIntent: { value: false, get() { return this.value; }, set(value) { this.value = value; } },
    INSTANCE: '<InstanceID>0</InstanceID>', requestedStartMs: 0, pollRunning: false, pollFailures: 0, refreshUsed: false, resolveTimeout: null,
    resources: { clear() {} }, resolveListener: null, endListener: null, nativeStateListener: null, stateListener: null,
    acquireLocks() {}, releaseLocks() {}, closeMediaServer() {},
    parseXml: text => ({ find: () => ({ text: text.match(/<Target>(.*?)<\/Target>/)?.[1] ?? '' }) }),
    fail: (_session, _generation, error) => { context.publicState.phase = 'error'; context.publicState.error = error; context.playIntent.set(false); },
    soap: (_device, action, args) => {
      requests.push(action); context.soapHook?.(action);
      if (context.failAction === action) throw new Error('receiver unavailable');
      if (action === 'Play') remote.transport = 'PLAYING';
      if (action === 'Pause') remote.transport = 'PAUSED_PLAYBACK';
      if (action === 'Stop') remote.transport = 'STOPPED';
      if (action === 'Seek') { const p = args.match(/<Target>(.*?)<\/Target>/)[1].split(':').map(Number); remote.position = (p[0] * 3600 + p[1] * 60 + p[2]) * 1000; }
      const values = action === 'GetTransportInfo' ? { CurrentTransportState: remote.transport }
        : action === 'GetPositionInfo' ? { TrackDuration: text(remote.duration), RelTime: text(remote.position), TrackURI: remote.uri } : {};
      return { find: key => values[key] == null ? null : { text: values[key] } };
    },
  });
  vm.runInContext(compile(protocol + '\n' + transport + '\n' + footer) + '\nglobalThis.api = { dlnaState, dlnaOnState, dlnaOnEnded, dlnaPlay, dlnaPause, dlnaStop, dlnaSeek, dlnaLoad, dlnaSetVolume, dlnaDisconnect };', context);
  const api = context.api;
  let ends = 0;
  api.dlnaOnEnded(() => ends++); api.dlnaOnState(state => states.push(state));
  const drain = () => {
    for (let guard = 100; jobs.length || posts.length; guard--) {
      assert.ok(guard > 0, 'I/O should settle');
      while (jobs.length) jobs.shift().run();
      while (posts.length) posts.shift()();
    }
  };
  const tick = ms => {
    now += ms;
    for (let guard = 100; timers.some(t => t.at <= now); guard--) {
      assert.ok(guard > 0, 'timer should settle');
      const i = timers.findIndex(t => t.at <= now); timers.splice(i, 1)[0].task.run(); drain();
    }
  };
  api.dlnaPlay(); drain();
  return { api, context, remote, states, requests, tick, drain, ends: () => ends, advance: ms => { now += ms; } };
}
let passed = 0;
function check(name, test) { test(); passed++; console.log('PASS ' + name); }
check('position grows beyond 1.25s, freezes paused and respects duration', () => {
  const h = fixture(); h.remote.position = 1000; h.tick(1000);
  h.advance(2000); assert.equal(h.api.dlnaState().positionMs, 3000);
  h.advance(3000); assert.equal(h.api.dlnaState().positionMs, 6000);
  h.api.dlnaPause(); h.drain(); const paused = h.api.dlnaState().positionMs;
  h.advance(2000); assert.equal(h.api.dlnaState().positionMs, paused);
  const end = fixture(); end.remote.position = 59000; end.tick(1000); end.advance(3000);
  assert.equal(end.api.dlnaState().positionMs, 60000);
});
for (const terminal of ['STOPPED', 'NO_MEDIA_PRESENT']) for (const uri of ['same', 'empty']) {
  check('58s/60s + 1.5s then ' + terminal + '/' + uri + ' completes once', () => {
    const h = fixture(); h.tick(1000);
    h.remote.transport = terminal; h.remote.position = 0; if (uri === 'empty') h.remote.uri = '';
    h.tick(1500); assert.equal(h.ends(), 1); assert.equal(h.api.dlnaState().phase, 'stopped');
    h.tick(2000); assert.equal(h.ends(), 1); assert.ok(!h.states.some(s => s.phase === 'error'));
  });
}
function terminal(h, elapsed = 1000) {
  h.remote.transport = 'STOPPED'; h.remote.position = 0; h.remote.uri = ''; h.tick(elapsed);
}
for (const elapsed of [5000, 5001]) check('PLAYING evidence expires after five seconds: ' + elapsed, () => {
  const h = fixture(); h.tick(1000); terminal(h, elapsed); assert.equal(h.ends(), elapsed === 5000 ? 1 : 0);
});
for (const state of ['TRANSITIONING', 'UNKNOWN']) check(state + ' revokes earlier PLAYING evidence', () => {
  const h = fixture(); h.tick(1000); h.remote.transport = state; h.tick(1000); terminal(h); assert.equal(h.ends(), 0);
});
for (const field of ['position', 'uri']) check('invalid PLAYING ' + field + ' revokes earlier evidence', () => {
  const h = fixture(); h.tick(1000); h.remote[field] = field === 'position' ? 0 : ''; h.tick(1000); terminal(h); assert.equal(h.ends(), 0);
});
for (const action of ['GetTransportInfo', 'GetPositionInfo']) check(action + ' failure revokes earlier evidence', () => {
  const h = fixture(); h.tick(1000); h.context.failAction = action; h.tick(1000);
  h.context.failAction = ''; terminal(h); assert.equal(h.ends(), 0);
});
for (const control of ['dlnaPause', 'dlnaPlay', 'dlnaStop', 'dlnaSeek']) check(control + ' revokes evidence before another sample', () => {
  const h = fixture(); h.tick(1000); h.api[control](59000); h.drain(); terminal(h); assert.equal(h.ends(), 0);
});
for (const control of ['dlnaPause', 'dlnaSeek']) check(control + ' during an ending poll invalidates its late reply', () => {
  const h = fixture(); h.tick(1000);
  h.context.soapHook = action => {
    if (action !== 'GetPositionInfo') return;
    h.context.soapHook = null; h.api[control](10000);
  };
  terminal(h); assert.equal(h.ends(), 0);
  if (control === 'dlnaPause') assert.equal(h.api.dlnaState().phase, 'paused');
});
check('independent volume change preserves current playback qualification', () => {
  const h = fixture(); h.tick(1000); h.api.dlnaSetVolume(0.75); h.drain(); terminal(h); assert.equal(h.ends(), 1);
});
check('load invalidates the old generation while its poll is in flight', () => {
  const h = fixture(); h.tick(1000);
  h.context.soapHook = action => {
    if (action !== 'GetPositionInfo') return;
    h.context.soapHook = null; h.api.dlnaLoad({ ...h.context.currentItem, mediaId: 'test:next' }, 0, true);
  };
  terminal(h); assert.equal(h.ends(), 0); assert.equal(h.api.dlnaState().mediaId, 'test:next');
});
check('nonempty foreign terminal URI never advances the current queue', () => {
  const h = fixture(); h.tick(1000); h.remote.transport = 'STOPPED'; h.remote.position = 0;
  h.remote.uri = 'http://other/song'; h.tick(1000); assert.equal(h.ends(), 0); assert.equal(h.api.dlnaState().phase, 'error');
});
check('midtrack stop is not upgraded to EOF by later terminal polls', () => {
  const h = fixture(); h.remote.position = 54000; h.tick(1000); terminal(h); h.tick(4300); assert.equal(h.ends(), 0);
});
check('a tiny reported duration does not qualify as a full song', () => {
  const h = fixture(); h.remote.duration = 1000; h.remote.position = 1000; h.tick(1000); terminal(h); assert.equal(h.ends(), 0);
});
console.log('[check-dlna-continuation] ' + passed + ' Android polling regressions passed');
// Existing approved source-extraction boundary: original store onEnded closure
// and JS facade forwarding, not the complete PlayerStore module.
{
  const store = read('stores/player.ts'), facade = read('services/audio-player.uts');
  const bind = store.indexOf('    audioPlayer.bind(');
  const start = store.indexOf('      () => {\n        const now = Date.now();', bind) + 6;
  const end = store.indexOf('\n      },', start) + 8;
  const onEnded = store.slice(start, end).trim();
  const facadeStart = facade.indexOf('    audioOnEnded(() => {');
  const facadeEnd = facade.indexOf('\n    });', facadeStart) + 8;
  const nextCalls = [], sessions = [], host = { audioOnEnded: cb => cb(), onEnd: null };
  vm.runInNewContext(compile(facade.slice(facadeStart, facadeEnd).trim() + '\nglobalThis.forward = () => onEnd?.()'), host);
  const player = { skipNextEndedAt: 0, skipNextNativeTransitionAt: 0, logMsg() {}, finishListenSession() { sessions.push('finished'); }, next(auto) { nextCalls.push(auto); } };
  host.onEnd = vm.runInNewContext('(' + onEnded + ')', player); host.forward();
  assert.deepEqual(sessions, ['finished']); assert.deepEqual(nextCalls, [true]);
  console.log('PASS original PlayerStore completion closure calls next(true) once');
}
