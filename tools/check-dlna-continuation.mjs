import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const native = read("uni_modules/qt-audio-player/utssdk/app-android/dlna.uts");
const protocol = read("uni_modules/qt-audio-player/utssdk/dlna-protocol.uts");
const compile = source => stripTypeScriptTypes(source.replaceAll("export ", ""), { mode: "strip" });
const transport = native.slice(native.indexOf("function post("), native.indexOf("class XmlNode"));
const polling = native.slice(native.indexOf("function schedulePoll("), native.indexOf("function controlRevision("));
const instance = native.slice(native.indexOf("const INSTANCE"), native.indexOf("\n", native.indexOf("const INSTANCE")));
const parser = protocol.slice(0, protocol.indexOf("export type DlnaByteRange"))
  + "\n" + protocol.slice(protocol.indexOf("/** 接收端必须给出可靠时长"));

class Work {
  constructor(task) { this.task = task; }
  run() { this.task(); }
}

function fixture() {
  let now = 0;
  const context = vm.createContext({
    Work, console,
    SystemClock: { elapsedRealtime: () => ({ toDouble: () => now }) },
    main: { postDelayed: task => delayed.push(task) },
    network: { execute: job => jobs.push(job) },
    publicState: { target: "dlna", phase: "playing", mediaId: "test:song", positionMs: 1000, durationMs: 60000 },
    currentDevice: {}, currentResourceUri: "http://phone/song", anchorAt: 0,
    observedPlaying: true, previousTransport: "PLAYING", manualStop: false,
  });
  vm.runInContext(compile(parser) + "\n" + compile(transport), context);
  return { context, setNow(value) { now = value } };
}

const h = fixture();
assert.equal(h.context.dlnaPositionMs(), 1000);
h.setNow(200);
assert.equal(h.context.dlnaPositionMs(), 1200);
h.setNow(2000);
assert.equal(h.context.dlnaPositionMs(), 3000, "position must grow beyond a 1.25s compensation window between slow polls");
h.setNow(5000);
assert.equal(h.context.dlnaPositionMs(), 6000, "playing position continues to track elapsed time until the next renderer response");
h.context.publicState.phase = "paused";
h.setNow(6000);
assert.equal(h.context.dlnaPositionMs(), 1000, "paused position must not advance");
h.context.publicState.positionMs = 59000;
h.context.publicState.phase = "playing";
assert.equal(h.context.dlnaPositionMs(), 60000, "position is still capped by the known media duration");
console.log("PASS DLNA position extrapolates through delayed polls, freezes paused, and respects duration");
function pollFixture({ manualStop = false, initial = 58000 } = {}) {
  let now = 0;
  const delayed = [], jobs = [], posts = [], requests = [];
  const context = vm.createContext({
    Work, console,
    SystemClock: { elapsedRealtime: () => ({ toDouble: () => now }) },
    main: { post: task => posts.push(() => task.run()), postDelayed: task => delayed.push(task) },
    network: { execute: job => jobs.push(job) },
    publicState: { target: "dlna", sessionId: 1, generation: 1, phase: "playing", mediaId: "test:song", positionMs: initial, durationMs: 60000, volume: 0.5, deviceId: "renderer", deviceName: "Renderer", canSeek: true, canSetVolume: true, error: "" },
    currentDevice: { id: "renderer" }, currentResourceUri: "http://phone/song", anchorAt: 0,
    sessionEpoch: { get: () => ({ toDouble: () => 1 }) },
    mediaEpoch: { get: () => ({ toDouble: () => 1 }) },
    observedPlaying: !manualStop, previousTransport: "PLAYING", manualStop,
    playIntent: { get: () => true }, requestedStartMs: 0, pollRunning: false, pollFailures: 0,
    endListener: null, nativeStateListener: null, stateListener: null,
    post: fn => posts.push(fn),
    fail: () => { throw new Error("Unexpected cast failure"); },
    active: session => session == publicState.sessionId, dlnaActive: () => true,
    acquireLocks() {}, releaseLocks() {}, notify() {},
    refreshUsed: false,
    soap: (_device, action) => {
      now += 750;
      requests.push(action);
      const values = action === "GetTransportInfo"
        ? { CurrentTransportState: "STOPPED" }
        : { TrackDuration: "00:01:00", RelTime: "00:00:00", TrackURI: "http://phone/song" };
      return { find: key => values[key] === undefined ? null : { text: values[key] } };
    },
  });
  const callbacks = native.slice(native.indexOf("export function dlnaOnState("), native.indexOf("class XmlNode"))
    .replace(/^export /gm, "").replaceAll("(() => void) | null", "any")
    .replace(/Audio[A-Za-z]+Callback/g, "any");
  vm.runInContext(compile(instance + "\n" + parser + "\n" + transport + "\n" + callbacks + "\n" + polling) + "\n;globalThis.api = { dlnaOnEnded, dlnaState }", context);
  const api = vm.runInContext("globalThis.api", context);
  context.endedCount = 0;
  api.dlnaOnEnded(Object.assign(() => { context.endedCount++; }, { invoke() { this(); } }));
  vm.runInContext("schedulePoll()", context);
  assert.equal(delayed.length, 1, "the real scheduler must queue its delayed poll");
  delayed.shift().run();
  for (let guard = 50; jobs.length || posts.length; guard--) {
    assert.ok(guard > 0, "the polled terminal state must settle");
    while (jobs.length) jobs.shift().run();
    while (posts.length) posts.shift()();
  }
  assert.deepEqual(requests, ["GetTransportInfo", "GetPositionInfo"], "the poll must perform both renderer calls");
  return { ended: context.endedCount, state: api.dlnaState() };
}

const stopped = pollFixture({ manualStop: true });
assert.equal(stopped.state.phase, "stopped", "manual stop must still update native state");
assert.equal(stopped.ended, 0, "manual stop remains guarded");
const ended = pollFixture();
assert.equal(ended.ended, 1, "a renderer clearing RelTime at confirmed near-end must complete the current track");
console.log("PASS DLNA near-end callback uses monotonic progress while guarded stops stay silent");
// Exercise the exact production store onEnded closure and its native-language invoke seam.
{
  const store = read("stores/player.ts");
  const facade = read("services/audio-player.uts");
  const bind = store.indexOf("    audioPlayer.bind(");
  const start = store.indexOf("      () => {\n        const now = Date.now();", bind) + 6;
  const end = store.indexOf("\n      },", start) + 8;
  const onEnded = store.slice(start, end).trim();
  const facadeStart = facade.indexOf("    audioOnEnded(() => {");
  const facadeEnd = facade.indexOf("\n    });", facadeStart) + 8;
  const facadeBody = facade.slice(facadeStart, facadeEnd).trim();
  const nextCalls = [], sessions = [];
  const host = { audioOnEnded: cb => cb(), onEnd: null };
  vm.runInNewContext(compile(facadeBody + "\nglobalThis.forward = () => onEnd?.()"), host);
  const player = {
    skipNextEndedAt: 0, skipNextNativeTransitionAt: 0, logMsg() {},
    finishListenSession() { sessions.push("finished"); },
    next(auto) { nextCalls.push(auto); },
  };
  const ended = vm.runInNewContext("(" + onEnded + ")", player);
  host.onEnd = ended;
  host.forward();
  assert.deepEqual(sessions, ["finished"], "the original store completion closure must settle the listen session");
  assert.deepEqual(nextCalls, [true], "the original completion callback advances the existing queue exactly once, not merely reports stopped");
  console.log("PASS DLNA ended forwarding invokes the original PlayerStore automatic-next callback");
}
