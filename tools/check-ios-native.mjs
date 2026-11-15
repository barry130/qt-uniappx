// Production iOS file/tag facade, services and complete UVue scripts.
// Foundation/UIKit/Photos/native I/O and lifecycle hosts are adapters.
// These checks do not represent Apple SDK compilation, signing or device I/O.
import assert from "node:assert/strict";
import { read, load, host, deferred, drain, noop, UTSJSONObject } from "./check-source-auth-session.mjs";
import { preprocessPlatform } from "./platform-preprocess.mjs";

let passed = 0;
async function check(name, test) { await test(); passed++; console.log("  ok " + name); }
class IosObject extends UTSJSONObject { getBoolean(key) { return this.get(key); } }
const iosJSON = { parse: JSON.parse, stringify: JSON.stringify, parseObject: text => new IosObject(JSON.parse(text)) };
const nativeRoot = "uni_modules/qt-app-native/utssdk/";
const byteSource = read(nativeRoot + "embed-bytes.uts");
const byteExports = [...byteSource.matchAll(/^export function (\w+)/gm)].map(match => match[1]);
const bytes = load(byteSource, byteExports);
const embedded = load(read(nativeRoot + "read-embed.uts"), ["readMp3Embedded", "readFlacEmbedded"]);
const nativeExports = ["saveToPublicMedia", "embedAudioTags", "readEmbeddedTags", "importLocalAudio",
  "pickDirectory", "queryPermissionStatesAsync", "getWebCookies"];
function fileFacade() {
  const files = new Map();
  const calls = [];
  const env = { files, calls, failCopy: false };
  const normalize = path => path.startsWith("file://") ? decodeURIComponent(path.slice(7)) : path;
  const native = {
    statFile: path => files.get(normalize(path))?.length ?? -1,
    readPrefix: (path, limit) => files.get(normalize(path))?.subarray(0, limit).toString("base64") ?? "",
    // Native adapter executes the facade's serialized byte/range plan. The
    // plan generator and MP3/FLAC readers above are the actual production code.
    writeTagCopy: (path, ext, json, cb) => {
      calls.push({ path, ext, plan: JSON.parse(json) });
      const source = files.get(normalize(path));
      if (env.failCopy) { cb(normalize(path)); return; }
      const parts = JSON.parse(json).map(part => part.data != null
        ? Buffer.from(part.data, "base64") : source.subarray(part.offset, part.offset + part.length));
      const destination = normalize(path) + ".embed." + ext;
      files.set(destination, Buffer.concat(parts)); cb(destination);
    },
    cacheCover: (encoded, _mime) => { files.set("/cache/cover.jpg", Buffer.from(encoded, "base64")); return "/cache/cover.jpg"; },
    saveFile: (...args) => { calls.push(args.slice(0, -1)); args.at(-1)("file:///Documents/Downloads/result.mp3"); },
    savePhoto: (path, cb) => { calls.push(["photo", path]); cb("photos://fixture"); },
    pickDocument: (kind, cb) => { calls.push(["picker", kind]); cb(JSON.stringify({ ok: true, path: "file:///selected/", count: 2, message: "" })); },
    refreshPermissions: (ids, cb) => { calls.push(["permissions", JSON.parse(ids)]); cb(JSON.stringify([{ id: "ios.notifications", applicable: true, unknown: false, granted: false }])); },
    webCookies: (urls, cb) => { calls.push(["cookies", JSON.parse(urls)]); cb(JSON.stringify(["SESSION=fixture"])); },
  };
  const api = load(read(nativeRoot + "app-ios/index.uts"), nativeExports,
    { ...bytes, ...embedded, QtAppNativeIOS: native, JSON: iosJSON, Uint8Array });
  return { ...env, env, api };
}
const options = ext => ({ ext, title: "标题", artist: "歌手", album: "专辑",
  lrcText: "[00:01.00]测试歌词", coverTempPath: "", coverMime: "image/jpeg" });

await check("iOS MP3 tags preserve every audio byte and round-trip lyrics", async () => {
  const b = fileFacade(), audio = Buffer.alloc(700000, 0x52); audio[0] = 0xff; audio[1] = 0xfb;
  const old = bytes.planMp3(new Uint8Array(audio), { title: "旧标题", artist: "", album: "",
    lrcText: "旧歌词", coverBytes: null, coverMime: "" });
  const original = Buffer.concat([Buffer.from(old.newTag), audio]);
  b.files.set("/temporary/song.mp3", original);
  const result = await b.api.embedAudioTags("file:///temporary/song.mp3", options("mp3"));
  const written = b.files.get(result);
  assert.notEqual(result, "/temporary/song.mp3");
  assert.deepEqual(written.subarray(written.length - audio.length), audio);
  assert.deepEqual(b.files.get("/temporary/song.mp3"), original);
  assert.equal(b.api.readEmbeddedTags(result).lrcText, options("mp3").lrcText);
  const tail = b.calls[0].plan.at(-1);
  assert.equal(tail.offset + tail.length, original.length);
});
await check("iOS FLAC tags preserve STREAMINFO, APPLICATION metadata and audio frames", async () => {
  const b = fileFacade(), stream = Buffer.concat([Buffer.from([0, 0, 0, 34]), Buffer.alloc(34, 7)]);
  const retained = Buffer.from([0x82, 0, 0, 6, 0x51, 0x54, 0x41, 0x50, 0x21, 0x22]);
  const audio = Buffer.alloc(500000, 0x74);
  const original = Buffer.concat([Buffer.from("fLaC"), stream, retained, audio]);
  b.files.set("/temporary/song.flac", original);
  const result = await b.api.embedAudioTags("/temporary/song.flac", options("flac"));
  const written = b.files.get(result);
  assert.deepEqual(written.subarray(8, 42), original.subarray(8, 42));
  assert.ok(written.includes(retained.subarray(4)));
  assert.deepEqual(written.subarray(written.length - audio.length), audio);
  assert.deepEqual(b.files.get("/temporary/song.flac"), original);
  assert.equal(b.api.readEmbeddedTags(result).lrcText, options("flac").lrcText);
});
await check("iOS oversized cover is omitted and a failed native tag copy returns the original", async () => {
  const b = fileFacade(), original = Buffer.alloc(4096, 0x58); original[0] = 0xff; original[1] = 0xfb;
  b.files.set("/temporary/song.mp3", original);
  b.files.set("/temporary/cover.jpg", Buffer.alloc(4 * 1024 * 1024 + 1, 0xff));
  const opts = { ...options("mp3"), coverTempPath: "/temporary/cover.jpg" };
  const result = await b.api.embedAudioTags("/temporary/song.mp3", opts);
  assert.equal(b.api.readEmbeddedTags(result).coverBytes, 0);
  b.env.failCopy = true;
  assert.equal(await b.api.embedAudioTags("file:///temporary/song.mp3", opts), "/temporary/song.mp3");
  assert.deepEqual(b.files.get("/temporary/song.mp3"), original);
});
await check("iOS malformed file URI and unsupported formats finish without a tag write", async () => {
  const b = fileFacade();
  assert.equal(await b.api.embedAudioTags("file:///bad%uri", options("mp3")), "file:///bad%uri");
  assert.equal(await b.api.embedAudioTags("/temporary/a.m4a", options("m4a")), "/temporary/a.m4a");
  assert.equal(b.calls.length, 0);
});
await check("iOS file/photo saves, document import, directory picker and cookies use native bridges", async () => {
  const b = fileFacade();
  assert.equal(await b.api.saveToPublicMedia("/temporary/song", "download", "result.mp3", "QtDownload/Music", ""), "file:///Documents/Downloads/result.mp3");
  assert.equal(await b.api.saveToPublicMedia("/temporary/image", "picture", "result.jpg"), "photos://fixture");
  let imported = 0, directory;
  b.api.importLocalAudio(count => { imported = count; });
  b.api.pickDirectory(result => { directory = result; });
  assert.equal(imported, 2); assert.equal(directory.path, "file:///selected/");
  assert.equal((await b.api.getWebCookies(["https://login.example.test/"]))[0], "SESSION=fixture");
  assert.deepEqual(b.calls.slice(0, 2), [
    ["/temporary/song", "download", "result.mp3", "QtDownload/Music", ""], ["photo", "/temporary/image"],
  ]);
});

function appServices(extra = {}) {
  return load(preprocessPlatform(read("services/app-native.uts"), "APP-IOS"),
    ["queryPermissionStatesAsync", "importLocalAudio", "supportsLocalAudioImport", "downloadDirectoryHint"],
    { logErrV: noop, logWarn: noop, ...extra });
}
await check("iOS async permission revocation and native bridge failure are returned truthfully", async () => {
  let callback;
  const api = appServices({ queryPermissionStatesAsyncNative: (_ids, cb) => { callback = cb; } });
  const pending = api.queryPermissionStatesAsync(["ios.notifications"]);
  callback([{ id: "ios.notifications", applicable: true, unknown: false, granted: false }]);
  assert.equal((await pending)[0].granted, false);
  const failed = appServices({ queryPermissionStatesAsyncNative: () => { throw Error("native unavailable"); } });
  assert.equal((await failed.queryPermissionStatesAsync(["ios.notifications"]))[0].unknown, true);
});
await check("iOS import and directory display use native results without exposing a sandbox path", async () => {
  const api = appServices({ importLocalAudioNative: cb => cb(2, "") });
  assert.equal(api.supportsLocalAudioImport(), true);
  assert.equal((await api.importLocalAudio()).count, 2);
  assert.ok(api.downloadDirectoryHint("", "/private/container").startsWith("文件 / 轻听"));
  assert.equal(api.downloadDirectoryHint("file:///provider/My%20Music/", ""), "所选目录：My Music");
});

function permissionsPage(width = 390) {
  const b = host(), requests = [], settings = [];
  const api = load(read("pages/permissions/index.uvue"),
    ["refresh", "states", "perms", "actionableOf", "onPermTap", "statusText", "grantedCount", "pendingCount"],
    { ...b.vue, uni: b.uni, isIosOs: () => true, isAndroidOs: () => false, isHarmonyOs: () => false,
      useQtTwoColumn: () => ({ layout: { isWide: width >= 900 }, twoColumn: width >= 1280, colStyle: "", colsStyle: "" }),
      useThemeStore: () => ({ skin: {} }), queryPermissionStatesAsync: ids => {
        const d = deferred(); requests.push({ ids, ...d }); return d.promise;
      },
      openPermissionSettings: id => { settings.push(id); return true; },
      isIgnoringBatteryOptimizations: () => { throw Error("Android battery API must stay unused on iOS"); },
      qtTrackPage: noop,
    });
  return { ...b, api, requests, settings };
}
for (const width of [390, 1440]) await check(`iOS permission list and settings action at ${width}px`, async () => {
  const b = permissionsPage(width); b.hooks.show[0]();
  assert.deepEqual(Array.from(b.requests[0].ids), ["ios.notifications", "ios.photosAdd", "ios.localNetwork", "ios.files", "ios.backgroundAudio"]);
  b.requests[0].resolve([{ id: "ios.localNetwork", applicable: true, unknown: true, granted: false }]);
  await drain();
  assert.equal(b.api.statusText("ios.localNetwork"), "到设置确认");
  assert.equal(b.api.actionableOf("ios.localNetwork"), true);
  b.api.onPermTap(b.api.perms.find(item => item.id == "ios.localNetwork"));
  assert.deepEqual(b.settings, ["ios.localNetwork"]);
  assert.equal(b.api.grantedCount(), 0); assert.equal(b.api.pendingCount(), 0);
});
await check("late iOS permission results cannot overwrite a newer refresh or revive an unmounted page", async () => {
  const b = permissionsPage();
  const old = b.api.refresh(), next = b.api.refresh();
  b.requests[1].resolve([{ id: "ios.notifications", granted: false, applicable: true, unknown: false }]); await next;
  b.requests[0].resolve([{ id: "ios.notifications", granted: true, applicable: true, unknown: false }]); await old;
  assert.equal(b.api.states.value[0].granted, false);
  const gone = b.api.refresh(); b.hooks.unmounted[0]();
  b.requests[2].resolve([{ id: "ios.notifications", granted: true, applicable: true, unknown: false }]); await gone;
  assert.equal(b.api.states.value[0].granted, false);
  b.hooks.show[0]();
  assert.equal(b.requests.length, 3, "destroyed embedded page cannot resume its permission bridge");
});

function localPage() {
  const b = host(), imports = [], scans = [];
  const api = load(read("pages/local/index.uvue"), ["importFiles", "startScan", "allItems", "scanning", "viewMode"],
    { ...b.vue, uni: b.uni, useThemeStore: () => ({ skin: {} }), useQtLayout: () => ({ isWide: false }),
      usePlayerStore: () => ({ current: null }), useQtSongColumns: () => ({ twoColumn: false, cellStyle: "", rightCellStyle: "" }),
      supportsLocalAudioImport: () => true, importLocalAudio: () => { const d = deferred(); imports.push(d); return d.promise; },
      scanLocalAudio: cb => scans.push(cb), qtTrackPage: noop,
    });
  return { ...b, api, imports, scans };
}
await check("iOS import rescans exactly once after native files are committed", async () => {
  const b = localPage(), pending = b.api.importFiles(); b.api.importFiles();
  assert.equal(b.imports.length, 1); assert.equal(b.scans.length, 0);
  b.imports[0].resolve({ count: 2, message: "" }); await pending;
  assert.equal(b.scans.length, 1); assert.equal(b.api.scanning.value, true);
  b.scans[0]([{ id: "song", path: "/Documents/Imports/song.mp3", title: "song", duration: 120 }]);
  assert.equal(b.api.allItems.value.length, 1); assert.equal(b.api.scanning.value, false);
});
for (const stage of ["import", "scan"]) await check(`iOS ${stage} callback after page departure cannot publish or rescan`, async () => {
  const b = localPage();
  if (stage == "import") {
    const pending = b.api.importFiles(); b.hooks.unload[0]();
    b.imports[0].resolve({ count: 2, message: "" }); await pending;
  } else {
    b.api.startScan("all"); b.hooks.unmounted[0](); b.scans[0]([{ id: "song", path: "/song.mp3" }]);
  }
  assert.equal(b.api.allItems.value.length, 0); assert.equal(b.toasts.length, 0); assert.equal(b.storage.size, 0);
  if (stage == "import") assert.equal(b.scans.length, 0);
});
await check("iOS source Referer is installed before local resolution and preserved separately for DLNA", () => {
  const calls = [];
  const source = preprocessPlatform(read("services/audio-player.uts"), "APP-IOS");
  const { AudioPlayer } = load(source, ["AudioPlayer"], {
    audioDlnaActive: () => false,
    audioSetResolveReferer: (...args) => calls.push(["referer", ...args]),
    audioResolveDone: (...args) => calls.push(["local", ...args]),
    audioDlnaResolveDone: (...args) => calls.push(["dlna", ...args]),
  });
  const audio = new AudioPlayer();
  audio.resolveDone("id", "https://audio.example.test/song", 0, "https://source.example.test/");
  audio.resolveDone("id", "https://audio.example.test/song", 5, "https://source.example.test/");
  assert.deepEqual(calls.map(call => call[0]), ["referer", "local", "dlna"]);
  assert.equal(calls[0][2], "https://source.example.test/"); assert.equal(calls[2][3], "https://source.example.test/");
});
await check("iOS DSP capabilities publish only when native capability changes", () => {
  const callbacks = {}, events = [];
  let dsp = true, casting = false;
  const extras = { logInfo: noop, logWarnV: noop, logErrV: noop, uni: { $emit: event => events.push(event) },
    audioDlnaActive: () => casting, audioEffectsSupported: () => dsp };
  for (const name of ["Play", "Pause", "Stop", "Ended", "TimeUpdate", "Error", "Next", "Prev", "ResolveRequest", "TrackChanged", "SetRating"])
    extras["audioOn" + name] = cb => { callbacks[name] = cb; };
  extras.audioDlnaOnResolveRequest = noop;
  const api = load(preprocessPlatform(read("services/audio-player.uts"), "APP-IOS"), ["AudioPlayer", "PLAYER_CAPABILITIES_CHANGED_EVENT"], extras);
  const audio = new api.AudioPlayer(); audio.ensureNativeBound();
  callbacks.Play(); callbacks.TimeUpdate(1, 180);
  assert.deepEqual(events, [api.PLAYER_CAPABILITIES_CHANGED_EVENT]);
  dsp = false; callbacks.TimeUpdate(2, 180); callbacks.TimeUpdate(3, 180);
  assert.equal(events.length, 2);
  dsp = true; callbacks.Play(); casting = true; callbacks.Pause();
  assert.equal(events.length, 4);
});
await check("native service imports exist on all three platform facades", () => {
  for (const platform of ["APP-ANDROID", "APP-HARMONY", "APP-IOS"]) {
    const directory = platform.toLowerCase();
    for (const plugin of ["qt-audio-player", "qt-app-native", "qt-js-engine"]) {
      const native = read(`uni_modules/${plugin}/utssdk/${directory}/index.uts`);
      const contract = read(`uni_modules/${plugin}/utssdk/interface.uts`);
      const names = new Set([...`${native}\n${contract}`.matchAll(/^export\s+(?:(?:async\s+)?function|const|let|class|type|interface)\s+(\w+)/gm)].map(m => m[1]));
      for (const service of ["audio-player.uts", "dlna.uts", "app-native.uts", "source-bundle-fs.uts", "logger.uts", "listen-clock.uts"]) {
        const selected = preprocessPlatform(read(`services/${service}`), platform);
        for (const match of selected.matchAll(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']@\/uni_modules\/([^"']+)["'];?/gm)) {
          if (match[2] != plugin) continue;
          for (const item of match[1].split(",")) {
            const name = item.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "");
            if (name.length == 0) continue;
            assert.ok(names.has(name), `${platform} ${service}: missing ${plugin}.${name}`);
          }
        }
      }
    }
  }
});
await check("iOS packaging supplies multicast, background audio, HTTP source support and iOS 14 minimum", () => {
  const info = read(nativeRoot + "app-ios/Info.plist");
  const audioInfo = read("uni_modules/qt-audio-player/utssdk/app-ios/Info.plist");
  const entitlement = read("uni_modules/qt-audio-player/utssdk/app-ios/UTS.entitlements");
  assert.ok(info.includes("<key>NSAllowsArbitraryLoads</key>"));
  assert.ok(!`${info}\n${audioInfo}`.includes("<key>NSAllowsLocalNetworking</key>"));
  assert.ok(!`${info}\n${audioInfo}`.includes("<key>NSAllowsArbitraryLoadsInWebContent</key>"));
  assert.ok(audioInfo.includes("<key>NSLocalNetworkUsageDescription</key>"));
  assert.ok(audioInfo.includes("<string>audio</string>"));
  assert.ok(entitlement.includes("<key>com.apple.developer.networking.multicast</key>"));
  assert.equal(JSON.parse(read("uni_modules/qt-js-engine/utssdk/app-ios/config.json")).deploymentTarget, "14.0");
  assert.equal(JSON.parse(read(nativeRoot + "app-ios/config.json")).deploymentTarget, "14.0");
});
console.log(`iOS native integration: ${passed} passed (native boundaries mocked; no Apple SDK/device evidence).`);
