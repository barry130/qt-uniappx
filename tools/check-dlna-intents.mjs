/**
 * Execute the real Android DLNA load/control functions with delayed Java I/O
 * boundaries. This checks ordering races; it does not replace native compilation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const native = readFileSync(new URL("../uni_modules/qt-audio-player/utssdk/app-android/dlna.uts", import.meta.url), "utf8");
const protocol = readFileSync(new URL("../uni_modules/qt-audio-player/utssdk/dlna-protocol.uts", import.meta.url), "utf8");
const compile = source => stripTypeScriptTypes(source.replace(/^export /gm, "").replace(/(\w+)!!/g, "$1!"), { mode: "strip" });
const footer = native.slice(native.indexOf("function clearResolveTimeout"));

function setup() {
  const jobs = [], posts = [], effects = [], requests = [];
  let counter = 0;
  class Epoch {
    constructor() { this.value = 1; }
    get() { return { toDouble: () => this.value }; }
    incrementAndGet() { this.value++; return this.get(); }
  }
  class Work {
    constructor(task) { this.task = task; }
    run() { this.task(); }
  }
  class AtomicBoolean {
    constructor(value) { this.value = value; }
    get() { return this.value; }
    set(value) { this.value = value; }
  }
  class MediaResource {
    constructor(uri, referer, session, generation) {
      Object.assign(this, { uri, referer, session, generation, token: String(++counter), size: 192000, mime: "audio/mpeg", seekable: true });
    }
  }
  const context = vm.createContext({
    console, Work, MediaResource,
    sessionEpoch: new Epoch(), mediaEpoch: new Epoch(),
    playIntentEpoch: new Epoch(), seekEpoch: new Epoch(), volumeEpoch: new Epoch(),
    currentDevice: { id: "test", ip: "192.168.1.2", canSeek: true, canVolume: true, minVolume: 0, maxVolume: 100, protocols: "http-get:*:audio/mpeg:*" },
    currentItem: null, currentResourceUri: "", requestedStartMs: 0,
    resolveTimeout: null, refreshUsed: false, playIntent: new AtomicBoolean(false), manualStop: false,
    observedPlaying: false, previousTransport: "", pollFailures: 0, pollRunning: false,
    publicState: { target: "dlna", sessionId: 1, generation: 1, phase: "connected", mediaId: "", positionMs: 0, durationMs: 60000, volume: 0.5, canSeek: true, canSetVolume: true, error: "" },
    INSTANCE: "<InstanceID>0</InstanceID>",
    resources: { clear() {}, put() {}, containsKey: () => true },
    network: { execute: job => jobs.push(job) },
    main: { removeCallbacks() {}, postDelayed() {}, post: job => posts.push(() => job.run()) },
    post: task => { posts.push(task); context.postHook?.(); },
    resolveListener: { invoke: (id, generation) => requests.push({ id, generation }) },
    active: (session, generation) => context.sessionEpoch.value === session && context.mediaEpoch.value === generation && context.publicState.target === "dlna",
    dlnaActive: () => context.publicState.target === "dlna",
    dlnaPositionMs: () => context.publicState.positionMs,
    notify() {}, acquireLocks() {}, releaseLocks() {}, closeMediaServer() {},
    mediaBase: () => "http://192.168.1.1:1234",
    probe: () => context.probeHook?.(),
    soap: (_renderer, action) => { effects.push(action); context.soapHook?.(action); return { find: () => null }; },
    fail: (_session, _generation, error) => { context.publicState.phase = "error"; context.publicState.error = error; },
  });
  vm.runInContext(compile(protocol) + "\n" + compile(footer) + "\nschedulePoll = () => {};\nglobalThis.api = { dlnaLoad, dlnaResolveDone, dlnaStop, dlnaPause, dlnaPlay, dlnaSetVolume, dlnaDisconnect };", context);
  const song = { mediaId: "wyy:test", uri: "qt-resolve://?mid=wyy%3Atest", title: "test", artist: "", album: "", coverUrl: "", duration: 60 };
  const drain = () => {
    let limit = 100;
    while (jobs.length || posts.length) {
      assert.ok(limit-- > 0, "native work unexpectedly kept scheduling");
      while (jobs.length) jobs.shift().run();
      while (posts.length) posts.shift()();
    }
  };
  const deliver = request => context.api.dlnaResolveDone(request.id, "https://audio.example/test.mp3", "", request.generation);
  return { context, effects, requests, song, drain, deliver };
}

let failed = 0;
function check(name, test) {
  try { test(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

check("Wi-Fi locks preserve legacy background behavior and use the modern mode on Android 14+", () => {
  const locks = native.slice(native.indexOf("function createDlnaWifiLock"), native.indexOf("function fail("))
    .replace(/@Suppress\("DEPRECATION"\)/g, "");
  for (const sdk of [23, 28, 29, 33, 34, 36]) {
    const created = [];
    const makeLock = kind => {
      const lock = {
        kind, held: false, acquisitions: 0, releases: 0, referenceCounted: true,
        setReferenceCounted(value) { this.referenceCounted = value; },
        isHeld() { return this.held; },
        acquire() { this.held = true; this.acquisitions++; },
        release() { assert.ok(this.held); this.held = false; this.releases++; },
      };
      created.push(lock);
      return lock;
    };
    const appContext = {
      getSystemService: name => name === "power"
        ? { newWakeLock: () => makeLock("cpu") }
        : { createWifiLock: mode => {
          assert.equal(mode, sdk >= 34 ? 4 : 3, `Wi-Fi mode for API ${sdk}`);
          return makeLock("wifi");
        } },
    };
    const context = vm.createContext({
      console, Build: { VERSION: { SDK_INT: sdk } },
      Context: { POWER_SERVICE: "power", WIFI_SERVICE: "wifi" },
      PowerManager: { PARTIAL_WAKE_LOCK: 1 },
      WifiManager: { WIFI_MODE_FULL_HIGH_PERF: 3, WIFI_MODE_FULL_LOW_LATENCY: 4 },
      UTSAndroid: { getAppContext: () => appContext }, wakeLock: null, wifiLock: null,
    });
    vm.runInContext(compile(locks), context);
    vm.runInContext("acquireLocks(); acquireLocks(); releaseLocks(); releaseLocks(); acquireLocks(); releaseLocks();", context);
    assert.equal(created.length, 2, "reuse each lock across DLNA playback sessions");
    for (const lock of created) {
      assert.equal(lock.referenceCounted, false);
      assert.equal(lock.acquisitions, 2);
      assert.equal(lock.releases, 2);
      assert.equal(lock.held, false);
    }
  }
});

check("Stop before URL completion retires the old load", () => {
  const h = setup();
  h.context.api.dlnaLoad(h.song, 0, true);
  h.context.api.dlnaStop();
  h.deliver(h.requests[0]); h.drain();
  assert.ok(!h.effects.includes("SetAVTransportURI"), h.effects.join(","));
  assert.ok(!h.effects.includes("Play"), h.effects.join(","));
});
check("Pause before URL completion never resurrects autoplay", () => {
  const h = setup();
  h.context.api.dlnaLoad(h.song, 0, true);
  h.context.api.dlnaPause();
  h.deliver(h.requests[0]); h.drain();
  assert.ok(!h.effects.includes("Play"), h.effects.join(","));
  assert.equal(h.context.publicState.phase, "paused");
});
check("Pause while probing rechecks the live playback intent", () => {
  const h = setup();
  h.context.api.dlnaLoad(h.song, 0, true);
  h.context.probeHook = () => { h.context.probeHook = null; h.context.api.dlnaPause(); };
  h.deliver(h.requests[0]); h.drain();
  assert.ok(!h.effects.includes("Play"), h.effects.join(","));
});
check("Stop while probing prevents a later media mount", () => {
  const h = setup();
  h.context.api.dlnaLoad(h.song, 0, true);
  h.context.probeHook = () => { h.context.probeHook = null; h.context.api.dlnaStop(); };
  h.deliver(h.requests[0]); h.drain();
  assert.ok(!h.effects.includes("SetAVTransportURI"), h.effects.join(","));
});
check("Replay after stopping an unresolved item obtains a fresh generation", () => {
  const h = setup();
  h.context.api.dlnaLoad(h.song, 0, true);
  const first = h.requests[0];
  h.context.api.dlnaStop(); h.drain();
  h.context.api.dlnaPlay();
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].generation > first.generation);
});
check("Pause during a Play response sends a following Pause", () => {
  const h = setup();
  h.context.api.dlnaLoad(h.song, 0, true);
  h.context.soapHook = action => {
    if (action === "Play") { h.context.soapHook = null; h.context.api.dlnaPause(); }
  };
  h.deliver(h.requests[0]); h.drain();
  assert.equal(h.effects.at(-1), "Pause", h.effects.join(","));
  assert.equal(h.context.publicState.phase, "paused");
});
check("Pause between load I/O and the main-thread receipt still reaches the renderer", () => {
  const h = setup();
  h.context.api.dlnaLoad(h.song, 0, true);
  h.context.postHook = () => { h.context.postHook = null; h.context.api.dlnaPause(); };
  h.deliver(h.requests[0]); h.drain();
  assert.equal(h.effects.at(-1), "Pause", h.effects.join(","));
  assert.equal(h.context.publicState.phase, "paused");
});
for (const [initial, operation, expected] of [["paused", "dlnaPlay", "Play"], ["playing", "dlnaPause", "Pause"]]) {
  check(`${expected} followed by volume keeps both independent effects`, () => {
    const h = setup();
    h.context.currentResourceUri = "http://192.168.1.1:1234/dlna/loaded";
    h.context.currentItem = h.song;
    h.context.publicState.phase = initial;
    h.context.api[operation](); h.context.api.dlnaSetVolume(0.6); h.drain();
    assert.deepEqual(h.effects, [expected, "SetVolume"]);
  });
}
check("A restored paused song seeds the remote timeline at its saved position", () => {
  const source = readFileSync(new URL("../stores/player.ts", import.meta.url), "utf8");
  const start = source.indexOf("  adoptDlnaTarget("), end = source.indexOf("\n  private pushTimeline(", start);
  assert.ok(start >= 0 && end > start);
  const state = { mediaId: "" }, mounts = [];
  const Host = vm.runInNewContext(compile("class Host {\n" + source.slice(start, end) + "\n}\nHost"), {
    audioPlayer: { dlnaPlaybackState: () => state },
  });
  const host = new Host();
  host.current = { id: "test", platform: "wyy" };
  host.mediaIdOf = song => `${song.platform}:${song.id}`;
  host.pushTimeline = (...args) => mounts.push(args);
  host.adoptDlnaTarget("wyy:test", 42, false);
  assert.deepEqual(mounts, [[host.current, 42, false]]);
  state.mediaId = "wyy:test";
  host.adoptDlnaTarget("wyy:test", 42, false);
  host.adoptDlnaTarget("wyy:stale", 99, true);
  assert.equal(mounts.length, 1, "existing or obsolete selections must not remount");
});
check("Disconnect confirms Stop before allowing local replay", () => {
  const h = setup(), receipts = [];
  h.context.api.dlnaDisconnect({ invoke: stopped => receipts.push(stopped) });
  assert.deepEqual(receipts, []);
  h.drain();
  assert.deepEqual(h.effects, ["Stop"]);
  assert.deepEqual(receipts, [true]);
});
check("Failed remote Stop does not authorize automatic local replay", () => {
  const h = setup(), receipts = [];
  h.context.soapHook = () => { throw new Error("offline renderer"); };
  h.context.api.dlnaDisconnect({ invoke: stopped => receipts.push(stopped) });
  h.drain();
  assert.deepEqual(receipts, [false]);
  assert.ok(h.context.publicState.error.length > 0);
});
check("A newer cast cancels the disconnected session's replay receipt", () => {
  const h = setup(), receipts = [];
  h.context.api.dlnaDisconnect({ invoke: stopped => receipts.push(stopped) });
  h.context.sessionEpoch.incrementAndGet();
  h.context.publicState.target = "dlna";
  h.drain();
  assert.deepEqual(receipts, []);
});
if (failed) process.exitCode = 1;
else console.log("Android DLNA delayed-I/O intent regressions passed.");
