/**
 * Execute the real Harmony DLNA transport and AVSession facade with native I/O
 * substitutes. These regressions cover delayed replies and complete byte relay;
 * real UTS/ArkTS compilation and receiver compatibility remain separate checks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../uni_modules/qt-audio-player/utssdk/' + name, import.meta.url), 'utf8');
const executable = text => stripTypeScriptTypes(text
  .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*\r?\n/gm, '')
  .replace(/^export /gm, ''));
const protocol = executable(read('dlna-protocol.uts'));
const transport = executable(read('app-harmony/dlna.uts'));
const facade = executable(read('app-harmony/index.uts'));
const decodeXml = text => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return this[key] ?? null; }
  getString(key) { return typeof this[key] === 'string' ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
const json = {
  stringify: JSON.stringify,
  parse: text => Object.assign(new UTSJSONObject(), JSON.parse(text)),
};
const eventTypes = { START_TAG: 1, END_TAG: 2, TEXT: 3, CDSECT: 4, ENTITY_REFERENCE: 5 };
class XmlPullParser {
  constructor(buffer) { this.text = new TextDecoder().decode(buffer); }
  parse(options) {
    for (const part of this.text.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^>]+)>|<([^>]+)>|([^<]+)/g)) {
      if (part[1] != null) options.tokenValueCallbackFunction(eventTypes.CDSECT, { getText: () => part[1] });
      else if (part[2] != null) options.tokenValueCallbackFunction(eventTypes.END_TAG, {});
      else if (part[3] != null) {
        if (part[3].startsWith('?') || part[3].startsWith('!')) continue;
        const name = part[3].split(/\s/)[0].replace(/\/$/, '');
        options.tokenValueCallbackFunction(eventTypes.START_TAG, { getName: () => name });
        if (part[3].endsWith('/')) options.tokenValueCallbackFunction(eventTypes.END_TAG, {});
      } else options.tokenValueCallbackFunction(eventTypes.TEXT, { getText: () => decodeXml(part[4]) });
    }
  }
}
const address = '192.168.20.2';
const base = 'http://' + address + ':49160';
const audioUrl = 'https://media.test/song.mp3';
const item = (id = 'test:one', duration = 300) => ({
  mediaId: id, uri: 'qt-resolve://?mid=' + encodeURIComponent(id), title: '完整曲目 & 标题', artist: '歌手',
  album: '专辑', coverUrl: '', duration,
});
const responseXml = body => '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + body + '</s:Body></s:Envelope>';
const description = '<root><URLBase>' + base + '/services/</URLBase><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>' +
  '<friendlyName>Harmony test receiver</friendlyName><UDN>uuid:renderer</UDN><serviceList>' +
  '<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>../control/av</controlURL><SCPDURL>av.xml</SCPDURL></service>' +
  '<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>../control/render</controlURL><SCPDURL>render.xml</SCPDURL></service>' +
  '<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>../control/connection</controlURL></service>' +
  '</serviceList></device></root>';
const avSchema = '<scpd><actionList><action><name>Seek</name></action></actionList></scpd>';
const renderSchema = '<scpd><actionList><action><name>SetVolume</name></action></actionList><serviceStateTable><stateVariable><name>Volume</name>' +
  '<allowedValueRange><minimum>10</minimum><maximum>50</maximum></allowedValueRange></stateVariable></serviceStateTable></scpd>';

function setup({ size = 800000 } = {}) {
  let now = 100000, timerId = 0, uuidId = 0, fdId = 0;
  const timers = new Map(), effects = [], requests = [], udpCalls = [], destroyed = [], files = new Map(), descriptors = new Map(), deleted = [];
  const audio = Buffer.alloc(size);
  for (let i = 0; i < size; i++) audio[i] = i % 251;
  audio.write('ID3', 0, 'ascii');
  const remote = { uri: '', transport: 'STOPPED', position: 0, duration: 300000, volume: 30 };
  const env = { effects, requests, udpCalls, destroyed, files, deleted, audio, remote, holds: new Map(), streamIgnoreRange: false, streamTruncated: false };
  const setTimer = (task, delay) => { const id = ++timerId; timers.set(id, { task, at: now + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
  env.settle = settle;
  env.tick = async ms => {
    now += ms;
    let count = 0;
    while (true) {
      const entry = [...timers.entries()].find(([, value]) => value.at <= now);
      if (!entry) break;
      assert.ok(count++ < 100, 'unexpected timer loop');
      timers.delete(entry[0]); entry[1].task();
      await settle();
    }
  };
  env.waitFor = async predicate => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await settle(); }
    throw new Error('native I/O boundary was not reached');
  };
  env.hold = name => { const hold = deferred(); env.holds.set(name, hold); return hold; };
  const awaitHold = async name => { const hold = env.holds.get(name); if (hold) await hold.promise; };
  const bytes = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const smallResponse = (text, header = {}) => ({ responseCode: 200, resultType: 'string', result: text, header });
  const secondsText = ms => new Date(ms).toISOString().substring(11, 19);

  class HttpRequest {
    constructor() { this.listeners = new Map(); this.destroyed = false; }
    on(event, callback) { this.listeners.set(event, callback); }
    off(event) { this.listeners.delete(event); }
    destroy() { this.destroyed = true; destroyed.push(this); }
    async request(url, options) {
      requests.push({ url, options, request: this });
      if (url === base + '/description.xml') return smallResponse(description);
      if (url === base + '/services/av.xml') return smallResponse(avSchema);
      if (url === base + '/services/render.xml') return smallResponse(renderSchema);
      if (options.method === 'POST') {
        const action = options.header.SOAPAction.match(/#([^"]+)/)[1];
        effects.push(action);
        await awaitHold(action);
        if (env.failAction === action) throw new Error('receiver unavailable');
        const extract = name => decodeXml(options.extraData.match(new RegExp('<' + name + '>([^]*?)</' + name + '>'))?.[1] ?? '');
        if (action === 'SetAVTransportURI') { remote.uri = extract('CurrentURI'); env.didl = extract('CurrentURIMetaData'); remote.transport = 'STOPPED'; }
        if (action === 'Play') remote.transport = 'PLAYING';
        if (action === 'Pause') remote.transport = 'PAUSED_PLAYBACK';
        if (action === 'Stop') remote.transport = 'STOPPED';
        if (action === 'Seek') {
          const parts = extract('Target').split(':').map(Number);
          remote.position = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }
        if (action === 'SetVolume') remote.volume = Number(extract('DesiredVolume'));
        const body = action === 'GetProtocolInfo' ? '<Sink>http-get:*:audio/mpeg:*</Sink>'
          : action === 'GetVolume' ? '<CurrentVolume>' + remote.volume + '</CurrentVolume>'
          : action === 'GetTransportInfo' ? '<CurrentTransportState>' + remote.transport + '</CurrentTransportState>'
          : action === 'GetPositionInfo' ? '<TrackDuration>' + secondsText(remote.duration) + '</TrackDuration><RelTime>' +
            secondsText(remote.position) + '</RelTime><TrackURI>' + remote.uri.replaceAll('&', '&amp;') + '</TrackURI>' : '';
        return smallResponse(responseXml(body));
      }
      assert.equal(url, audioUrl);
      await awaitHold('Media');
      if (env.expired) return { responseCode: 403, resultType: 'arraybuffer', result: new ArrayBuffer(0), header: {} };
      const range = options.header.Range.match(/bytes=(\d+)-(\d+)/);
      const start = Number(range[1]), end = Math.min(audio.length - 1, Number(range[2]));
      const body = env.streamIgnoreRange ? audio : audio.subarray(start, end + 1);
      if (body.length > options.maxLimit) throw new Error('response exceeded native maxLimit');
      return { responseCode: env.streamIgnoreRange ? 200 : 206, resultType: 'arraybuffer', result: bytes(body),
        header: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes ' + start + '-' + end + '/' + audio.length, 'Content-Length': String(body.length) } };
    }
    async requestInStream(url, options) {
      requests.push({ url, options, request: this, streaming: true });
      assert.equal(url, audioUrl);
      this.listeners.get('headersReceive')?.({ 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length) });
      await awaitHold('Stage');
      if (this.destroyed) throw new Error('cancelled native stream');
      const limit = env.streamTruncated ? audio.length - 10 : audio.length;
      for (let offset = 0; offset < limit; offset += 32768) {
        if (this.destroyed) throw new Error('cancelled native stream');
        this.listeners.get('dataReceive')?.(bytes(audio.subarray(offset, Math.min(limit, offset + 32768))));
        await Promise.resolve();
      }
      this.listeners.get('dataEnd')?.();
      return 200;
    }
  }
  class Udp {
    listeners = new Map();
    on(event, callback) { this.listeners.set(event, callback); }
    off(event) { this.listeners.delete(event); }
    async bind(value) { this.bound = value.address; udpCalls.push(['bind', value]); }
    async send(value) {
      udpCalls.push(['send', value]);
      const message = 'HTTP/1.1 200 OK\r\nLOCATION: ' + base + '/description.xml\r\n\r\n';
      this.listeners.get('message')?.({ message: bytes(Buffer.from(message)), remoteInfo: { address } });
    }
    async close() { udpCalls.push(['close', this.bound]); }
  }
  class Client {
    listeners = new Map();
    constructor(ip = address) { this.ip = ip; this.parts = []; this.closed = false; }
    on(event, callback) { this.listeners.set(event, callback); }
    off(event) { this.listeners.delete(event); }
    async getRemoteAddress() { return { address: this.ip, family: 1, port: 50000 }; }
    async send(value) {
      if (this.closed) throw new Error('client closed');
      this.parts.push(typeof value.data === 'string' ? Buffer.from(value.data) : Buffer.from(value.data));
      if (typeof value.data !== 'string') await env.sendHook?.(value.data);
    }
    async close() { this.closed = true; this.listeners.get('close')?.(); }
  }
  const fileIo = {
    OpenMode: { READ_ONLY: 1, READ_WRITE: 2, CREATE: 4, TRUNC: 8 },
    WhenceType: { SEEK_SET: 0 },
    openSync(uri, mode) {
      if ((mode & 4) !== 0) files.set(uri, Buffer.alloc(0));
      if (!files.has(uri)) throw new Error('file missing');
      const file = { fd: ++fdId }; descriptors.set(file.fd, { uri, position: 0 }); return file;
    },
    async open(uri, mode) { return this.openSync(uri, mode); },
    statSync(fd) { const buffer = files.get(descriptors.get(fd).uri); return { size: buffer.length, isFile: () => true }; },
    lseek(fd, offset, whence) { assert.equal(whence, 0); descriptors.get(fd).position = offset; return offset; },
    async read(fd, buffer, { offset = 0, length }) {
      const descriptor = descriptors.get(fd), start = descriptor.position + offset;
      const input = files.get(descriptor.uri), end = Math.min(input.length, start + length);
      new Uint8Array(buffer).set(input.subarray(start, end)); descriptor.position = end; return end - start;
    },
    writeSync(fd, buffer, { offset = 0, length }) {
      const descriptor = descriptors.get(fd), start = descriptor.position + offset;
      const old = files.get(descriptor.uri), next = Buffer.alloc(Math.max(old.length, start + length));
      old.copy(next); Buffer.from(buffer).copy(next, start); files.set(descriptor.uri, next);
      descriptor.position = start + length; return length;
    },
    closeSync(file) { descriptors.delete(typeof file === 'number' ? file : file.fd); },
    unlinkSync(uri) { assert.match(uri, /^\/cache\/qt-dlna-[\w-]+\.media$/); files.delete(uri); deleted.push(uri); },
  };
  const context = vm.createContext({
    console, UTSJSONObject, JSON: json, Uint8Array, ArrayBuffer, Map, Set,
    Date: class extends Date { static now() { return now; } },
    systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => now },
    setTimeout: setTimer, clearTimeout: clearTimer,
    xml: { EventType: eventTypes, XmlPullParser },
    util: {
      TextEncoder: class { encodeInto(value) { return new TextEncoder().encode(value); } },
      TextDecoder: class { decodeToString(value) { return new TextDecoder().decode(value); } },
      generateRandomUUID: () => '12345678-1234-1234-1234-' + String(++uuidId).padStart(12, '0'),
    },
    url: { URL: { parseURL: (value, parent) => new URL(value, parent) } },
    http: { createHttp: () => new HttpRequest(), RequestMethod: { GET: 'GET', POST: 'POST', HEAD: 'HEAD' },
      HttpDataType: { STRING: 'string', ARRAY_BUFFER: 'arraybuffer' } },
    fileIo,
    connection: {
      getAllNets: async () => [{ netId: 1 }, { netId: 2 }],
      getConnectionProperties: async net => ({ linkAddresses: [{ address: { address: net.netId === 1 ? '192.168.20.4' : '192.168.30.4' } }] }),
      getAddressesByName: async host => [{ address: host === 'media.test' ? '203.0.113.20' : host }],
    },
    socket: {
      constructUDPSocketInstance: () => new Udp(),
      constructTCPSocketServerInstance: () => ({ on() {}, async listen(value) { env.listenAddress = value; }, async getLocalAddress() { return { address: '0.0.0.0', port: 50001 }; } }),
      constructTCPSocketInstance: () => ({ async bind() {}, async connect() {}, async getLocalAddress() { return { address: '192.168.20.4', port: 50002 }; }, async close() {} }),
    },
    UTSHarmony: { getUIAbilityContext: () => ({ cacheDir: '/cache' }), convert2AbsFullPath: uri => '/local/' + uri.substring(10) },
  });
  const exports = ['dlnaActive', 'dlnaState', 'dlnaIntendingToPlay', 'dlnaDiscover', 'dlnaConnect', 'dlnaDisconnect', 'dlnaOnState', 'dlnaOnResolve',
    'dlnaOnNativeState', 'dlnaOnEnded', 'dlnaLoad', 'dlnaResolveDone', 'dlnaResolveFailed', 'dlnaPlay', 'dlnaPause', 'dlnaStop', 'dlnaSeek', 'dlnaSetVolume'];
  const api = vm.runInContext(protocol + '\n' + transport + '\n({' + exports.join(',') +
    ', debug: () => ({ pending: networkRunning || networkTasks.length > 0, tokens: [...resources.keys()], clients: clients.length }), parseXml, privateAddress, acceptClient })', context);
  env.api = api;
  env.drain = async () => env.waitFor(() => !api.debug().pending);
  env.discover = async () => {
    let devices, error;
    api.dlnaDiscover((found, failure) => { devices = found; error = failure; });
    await env.waitFor(() => udpCalls.some(value => value[0] === 'send'));
    await env.tick(3000);
    await env.waitFor(() => devices != null);
    assert.equal(error, '');
    assert.equal(devices.length, 1);
    return devices[0];
  };
  env.connect = async () => { const device = await env.discover(); assert.equal(api.dlnaConnect(device.id), true); await env.drain(); };
  env.load = async (song = item(), start = 0, play = true) => {
    api.dlnaLoad(song, start, play);
    api.dlnaResolveDone(song.mediaId, audioUrl, 'https://referer.test/', api.dlnaState().generation);
    await env.drain();
  };
  env.client = async (path, headers = '', method = 'GET', ip = address) => {
    const client = new Client(ip);
    api.acceptClient(client);
    client.listeners.get('message')?.({ message: bytes(Buffer.from(method + ' ' + path + ' HTTP/1.1\r\nHost: sender\r\n' + headers + '\r\n')) });
    await env.waitFor(() => client.closed);
    const response = Buffer.concat(client.parts), end = response.indexOf('\r\n\r\n');
    return { header: response.subarray(0, end).toString(), body: response.subarray(end + 4), raw: response };
  };
  return env;
}

function createFacade(env) {
  const playerCallbacks = [], sessions = [], playerCalls = [];
  const playbackState = { PLAYBACK_STATE_STOP: 0, PLAYBACK_STATE_PLAY: 1, PLAYBACK_STATE_PAUSE: 2, PLAYBACK_STATE_PREPARE: 3,
    PLAYBACK_STATE_COMPLETED: 4, PLAYBACK_STATE_ERROR: 5 };
  const context = vm.createContext({
    console, Map, Set, JSON: json, ...env.api,
    UTSHarmony: { getUIAbilityContext: () => ({ abilityInfo: { bundleName: 'qt.test', name: 'EntryAbility' } }) },
    media: {
      createAVPlayer(callback) { playerCallbacks.push(callback); playerCalls.push('create'); },
      PlaybackSpeed: { SPEED_FORWARD_0_50_X: 0.5, SPEED_FORWARD_1_00_X: 1, SPEED_FORWARD_2_00_X: 2 },
    },
    avSession: {
      PlaybackState: playbackState, LoopMode: { LOOP_MODE_SINGLE: 1, LOOP_MODE_LIST: 2, LOOP_MODE_SEQUENCE: 0 },
      createAVSession(_context, _tag, _kind, callback) {
        const session = { listeners: new Map(), states: [], on(name, fn) { this.listeners.set(name, fn); }, activate() {},
          setAVMetadata(value) { this.metadata = value; }, setAVPlaybackState(value) { this.states.push(value); },
          setAVQueueItems() {}, setLaunchAbility() {}, onDesktopLyricVisibilityChanged() {} };
        sessions.push(session); callback({ code: 0 }, session);
      },
      isDesktopLyricSupported: async () => false,
    },
    backgroundTaskManager: {
      BackgroundMode: { AUDIO_PLAYBACK: 1 },
      startBackgroundRunning(_context, _mode, _agent, callback) { callback({ code: 0 }); },
      stopBackgroundRunning(_context, callback) { callback({ code: 0 }); },
    },
    wantAgent: { OperationType: { START_ABILITY: 1 }, WantAgentFlags: { UPDATE_PRESENT_FLAG: 1 }, getWantAgent(_options, callback) { callback({ code: 0 }, {}); } },
    systemDateTime: { getTime: () => 0 }, notificationManager: {}, image: {}, audio: {}, http: {},
    setTimeout: () => 1, clearTimeout() {},
  });
  const names = ['audioSetPlaylist', 'audioPlayTimelineIndex', 'audioResume', 'audioPause', 'audioStop', 'audioSeek', 'audioGetCurrentTime',
    'audioCurrentMediaId', 'audioTimelineSize', 'audioOnResolveRequest', 'audioResolveDone', 'audioOnEnded', 'audioDlnaConnect',
    'audioDlnaDisconnect', 'audioDlnaState', 'audioDlnaResolveDone', 'audioSetRepeatMode'];
  const api = vm.runInContext(facade + '\n({' + names.join(',') + ', debug: () => ({ gPendingPositionSec, gPlayer, gItems, gIndex, gIntendPlay }) })', context);
  return { api, playerCallbacks, sessions, playerCalls };
}

let passed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log('  ✓ ' + name); }
  catch (error) { console.error('FAIL ' + name); throw error; }
}

await check('SSDP searches each IPv4 interface and deduplicates renderer UDN', async () => {
  const env = setup(), device = await env.discover();
  assert.equal(device.canSeek, true); assert.equal(device.canSetVolume, true);
  assert.equal(env.udpCalls.filter(value => value[0] === 'bind').length, 2);
  assert.equal(env.udpCalls.filter(value => value[0] === 'close').length, 2);
  assert.ok(env.requests.some(value => value.url === base + '/services/av.xml'));
});
await check('device XML rejects DOCTYPE and bounds nesting; private mapped IPs are rejected', () => {
  const { api } = setup();
  assert.throws(() => api.parseXml('<!DOCTYPE root><root/>'), /XML/);
  assert.throws(() => api.parseXml('<a>'.repeat(66) + '</a>'.repeat(66)), /XML/);
  for (const ip of ['127.0.0.1', '169.254.1.2', '192.168.1.2', '::1', 'fe80::1', '::ffff:7f00:1']) assert.equal(api.privateAddress(ip), true, ip);
  assert.equal(api.privateAddress('203.0.113.20'), false);
});
await check('connect reads receiver volume range; load publishes full track length and metadata', async () => {
  const env = setup(); await env.connect(); await env.load(item(), 42000, false);
  assert.equal(env.api.dlnaState().volume, 0.5);
  assert.equal(env.api.dlnaState().positionMs, 42000);
  assert.equal(env.api.dlnaState().durationMs, 300000);
  assert.equal(env.api.dlnaState().phase, 'paused');
  assert.match(env.didl, /size="800000"/); assert.match(env.didl, /duration="00:05:00"/);
  assert.ok(!env.effects.includes('Play'));
});
await check('receiver capability probing never overwrites a newer volume selection', async () => {
  const env = setup(), device = await env.discover(), hold = env.hold('GetProtocolInfo');
  env.api.dlnaConnect(device.id);
  await env.waitFor(() => env.effects.includes('GetProtocolInfo'));
  env.api.dlnaSetVolume(0.25);
  hold.resolve(); await env.drain();
  assert.equal(env.remote.volume, 20); assert.equal(env.api.dlnaState().volume, 0.25);
});
await check('pause during a delayed media probe prevents remote Play', async () => {
  const env = setup(); await env.connect();
  const hold = env.hold('Media'), song = item();
  env.api.dlnaLoad(song, 0, true); env.api.dlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation);
  await env.waitFor(() => env.requests.some(value => value.url === audioUrl));
  env.api.dlnaPause(); hold.resolve(); await env.drain();
  assert.equal(env.api.dlnaState().phase, 'paused'); assert.ok(!env.effects.includes('Play'));
});
await check('pause during an in-flight Play is reconciled before publishing the load receipt', async () => {
  const env = setup(); await env.connect();
  const hold = env.hold('Play'), song = item();
  env.api.dlnaLoad(song, 0, true); env.api.dlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation);
  await env.waitFor(() => env.effects.includes('Play'));
  env.api.dlnaPause(); hold.resolve(); await env.drain();
  assert.equal(env.remote.transport, 'PAUSED_PLAYBACK'); assert.equal(env.api.dlnaState().phase, 'paused');
});
await check('Stop retires pending resolve callbacks and delayed media replies', async () => {
  const env = setup(); await env.connect();
  const hold = env.hold('Media'), song = item();
  env.api.dlnaLoad(song, 0, true);
  const generation = env.api.dlnaState().generation;
  env.api.dlnaResolveDone(song.mediaId, audioUrl, '', generation);
  await env.waitFor(() => env.requests.some(value => value.url === audioUrl));
  env.api.dlnaStop(); hold.resolve(); await env.drain();
  env.api.dlnaResolveDone(song.mediaId, audioUrl, '', generation); await env.drain();
  assert.equal(env.api.dlnaState().phase, 'stopped'); assert.equal(env.api.debug().tokens.length, 0);
  assert.ok(!env.effects.includes('Play')); assert.ok(env.effects.includes('Stop'));
});
await check('Seek and volume use independent receipt revisions', async () => {
  const env = setup(); await env.connect(); await env.load();
  const hold = env.hold('Seek'); env.api.dlnaSeek(78000);
  await env.waitFor(() => env.effects.includes('Seek'));
  env.api.dlnaSetVolume(0.25); hold.resolve(); await env.drain();
  assert.equal(env.api.dlnaState().positionMs, 78000); assert.equal(env.api.dlnaState().volume, 0.25);
  assert.equal(env.remote.volume, 20); assert.ok(env.effects.includes('SetVolume'));
});
await check('delayed poll never overrides a newer user pause', async () => {
  const env = setup(); await env.connect(); await env.load();
  const hold = env.hold('GetTransportInfo'), phases = [];
  env.api.dlnaOnState(state => phases.push(state.phase));
  await env.tick(1000); env.api.dlnaPause(); const mark = phases.length;
  hold.resolve(); await env.drain();
  assert.equal(env.api.dlnaState().phase, 'paused'); assert.ok(!phases.slice(mark).includes('playing'));
});
await check('foreign media disables the cast and revokes its relay tokens', async () => {
  const env = setup(); await env.connect(); await env.load();
  env.remote.uri = 'http://other.test/track.mp3'; await env.tick(1000); await env.drain();
  assert.equal(env.api.dlnaState().phase, 'error'); assert.equal(env.api.debug().tokens.length, 0);
});
await check('only a confirmed near-end transition emits natural completion', async () => {
  for (const nearEnd of [false, true]) {
    const env = setup(); await env.connect(); await env.load(item('test:end', 100));
    let ends = 0; env.api.dlnaOnEnded(() => ends++);
    env.remote.duration = 100000; env.remote.position = nearEnd ? 99000 : 12000;
    await env.tick(1000); await env.drain();
    env.remote.transport = 'STOPPED'; env.remote.position = 0;
    await env.tick(1000); await env.drain();
    assert.equal(ends, nearEnd ? 1 : 0);
  }
});
await check('58s of 60s plus 1.5s then STOPPED at zero emits completion once', async () => {
  const env = setup(); await env.connect(); await env.load(item('test:bounded-end', 60));
  let ends = 0; env.api.dlnaOnEnded(() => ends++);
  env.remote.duration = 60000; env.remote.position = 58000;
  await env.tick(1000); await env.drain();
  env.remote.transport = 'STOPPED'; env.remote.position = 0;
  await env.tick(1500); await env.drain();
  assert.equal(ends, 1);
  assert.equal(env.api.dlnaState().phase, 'stopped');
  await env.tick(2000); await env.drain();
  assert.equal(ends, 1);
});
for (const terminal of ['STOPPED', 'NO_MEDIA_PRESENT']) for (const uri of ['same', 'empty']) {
  await check('near-end ' + terminal + ' with ' + uri + ' URI completes before any missing-media error', async () => {
    const env = setup(); await env.connect(); await env.load(item('test:terminal', 60));
    const states = []; let ends = 0;
    env.api.dlnaOnState(state => states.push(state)); env.api.dlnaOnEnded(() => ends++);
    env.remote.duration = 60000; env.remote.position = 58000;
    await env.tick(1000); await env.drain();
    env.remote.transport = terminal; env.remote.position = 0;
    if (uri === 'empty') env.remote.uri = '';
    await env.tick(1500); await env.drain();
    assert.equal(ends, 1);
    assert.equal(env.api.dlnaState().phase, 'stopped');
    assert.ok(!states.some(state => state.phase === 'error'));
    await env.tick(3000); await env.drain(); assert.equal(ends, 1);
  });
}
await check('a seek near the tail revokes old PLAYING evidence until a new successful poll', async () => {
  const env = setup(); await env.connect(); await env.load(item('test:seek-end', 60));
  let ends = 0; env.api.dlnaOnEnded(() => ends++);
  env.remote.duration = 60000; env.remote.position = 59000;
  await env.tick(1000); await env.drain();
  env.api.dlnaSeek(59000); await env.drain();
  env.remote.transport = 'STOPPED'; env.remote.position = 0;
  await env.tick(1000); await env.drain();
  assert.equal(ends, 0);
});
await check('one failed poll revokes near-end evidence before a terminal response', async () => {
  const env = setup(); await env.connect(); await env.load(item('test:offline-end', 60));
  let ends = 0; env.api.dlnaOnEnded(() => ends++);
  env.remote.duration = 60000; env.remote.position = 59000;
  await env.tick(1000); await env.drain();
  env.failAction = 'GetPositionInfo'; await env.tick(1000); await env.drain();
  env.failAction = ''; env.remote.transport = 'STOPPED'; env.remote.position = 0;
  await env.tick(1000); await env.drain(); assert.equal(ends, 0);
});
for (const operation of ['play', 'pause', 'stop']) {
  await check(operation + ' after a successful near-end poll requires new PLAYING evidence', async () => {
    const env = setup(); await env.connect(); await env.load(item('test:control-end', 60));
    let ends = 0; env.api.dlnaOnEnded(() => ends++);
    env.remote.duration = 60000; env.remote.position = 59000;
    await env.tick(1000); await env.drain();
    env.api[{ play: 'dlnaPlay', pause: 'dlnaPause', stop: 'dlnaStop' }[operation]](); await env.drain();
    env.remote.transport = 'STOPPED'; env.remote.position = 0;
    await env.tick(1000); await env.drain(); assert.equal(ends, 0);
  });
}
await check('relay serves HEAD and exact prefix/suffix bytes; rejects multiple ranges and foreign peers', async () => {
  const env = setup(); await env.connect(); await env.load();
  const path = '/dlna/' + env.api.debug().tokens[0];
  const head = await env.client(path, '', 'HEAD');
  assert.match(head.header, /Content-Length: 800000/); assert.equal(head.body.length, 0);
  const prefix = await env.client(path, 'Range: bytes=0-127\r\n');
  assert.match(prefix.header, /206 Partial Content/); assert.deepEqual(prefix.body, env.audio.subarray(0, 128));
  const suffix = await env.client(path, 'Range: bytes=-23\r\n');
  assert.deepEqual(suffix.body, env.audio.subarray(env.audio.length - 23));
  assert.match((await env.client(path, 'Range: bytes=0-1,4-5\r\n')).header, /416 Range Not Satisfiable/);
  assert.match((await env.client(path, '', 'HEAD', '192.168.20.9')).header, /403 Forbidden/);
});
await check('complete long relay keeps flowing beyond two minutes and bounds each upstream request', async () => {
  const env = setup({ size: 4 * 1024 * 1024 }); await env.connect(); await env.load();
  env.sendHook = async () => env.tick(15000);
  const result = await env.client('/dlna/' + env.api.debug().tokens[0]);
  assert.deepEqual(result.body, env.audio);
  const chunks = env.requests.filter(value => value.url === audioUrl);
  for (const request of chunks) assert.ok(request.options.maxLimit <= 256 * 1024);
  assert.ok(chunks.length > 10);
});
await check('source without byte ranges stages to disk and clears only its own temporary media', async () => {
  const env = setup(); env.streamIgnoreRange = true; env.files.set('/local/music.mp3', Buffer.from('original'));
  await env.connect(); await env.load();
  assert.equal(env.api.dlnaState().phase, 'buffering');
  assert.ok(env.requests.some(value => value.streaming));
  const result = await env.client('/dlna/' + env.api.debug().tokens[0]);
  assert.deepEqual(result.body, env.audio);
  env.api.dlnaDisconnect(); await env.drain();
  assert.equal(env.deleted.length, 1); assert.ok(env.files.has('/local/music.mp3'));
});
await check('truncated staged responses fail and clean their temporary file', async () => {
  const env = setup(); env.streamIgnoreRange = true; env.streamTruncated = true;
  await env.connect(); await env.load();
  assert.equal(env.api.dlnaState().phase, 'error'); assert.equal(env.api.debug().tokens.length, 0);
  assert.equal(env.deleted.length, 1); assert.ok(!env.effects.includes('Play'));
});
await check('Stop cancels an in-flight staged download without waiting for its total timeout', async () => {
  const env = setup(); env.streamIgnoreRange = true; await env.connect();
  const hold = env.hold('Stage'), song = item();
  env.api.dlnaLoad(song, 0, true); env.api.dlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation);
  await env.waitFor(() => env.requests.some(value => value.streaming));
  env.api.dlnaStop(); await env.drain();
  assert.equal(env.api.dlnaState().phase, 'stopped'); assert.ok(env.effects.includes('Stop'));
  assert.equal(env.deleted.length, 1);
  hold.resolve(); await env.settle();
});
await check('disconnect waits for remote Stop and ignores receipts superseded by reconnect', async () => {
  const env = setup(); await env.connect(); await env.load();
  const hold = env.hold('Stop'), receipts = [], stops = env.effects.filter(value => value === 'Stop').length;
  env.api.dlnaDisconnect(value => receipts.push(value));
  await env.waitFor(() => env.effects.filter(value => value === 'Stop').length > stops);
  assert.equal(receipts.length, 0);
  env.api.dlnaConnect('uuid:renderer'); hold.resolve(); await env.drain();
  assert.equal(receipts.length, 0); assert.equal(env.api.dlnaActive(), true);
});
await check('cold paused queue preserves position and releases a local create callback after casting', async () => {
  const env = setup(); await env.connect(); env.api.dlnaDisconnect(); await env.drain();
  const local = createFacade(env), song = item();
  local.api.audioOnResolveRequest(() => {});
  local.api.audioSetPlaylist([song], 0, false, 42);
  assert.equal(local.playerCallbacks.length, 1);
  assert.equal(local.api.audioDlnaConnect('uuid:renderer'), true);
  let released = false;
  local.playerCallbacks[0]({ code: 0 }, { release() { released = true; } });
  local.api.audioResolveDone(song.mediaId, audioUrl);
  local.api.audioDlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation);
  await env.drain();
  assert.equal(released, true); assert.equal(env.api.dlnaState().positionMs, 42000);
  assert.equal(env.api.dlnaState().phase, 'paused'); assert.equal(local.api.audioTimelineSize(), 1);
  assert.equal(local.api.debug().gPlayer, null);
});
await check('AVSession play, pause, seek and queue commands route to the remote target', async () => {
  const env = setup(); await env.connect(); env.api.dlnaDisconnect(); await env.drain();
  const local = createFacade(env), first = item(), second = item('test:two');
  local.api.audioOnResolveRequest(() => {});
  local.api.audioSetPlaylist([first, second], 0, false, 0); local.api.audioDlnaConnect('uuid:renderer');
  local.api.audioDlnaResolveDone(first.mediaId, audioUrl, '', env.api.dlnaState().generation); await env.drain();
  const session = local.sessions[0];
  session.listeners.get('play')(); await env.drain(); assert.equal(env.remote.transport, 'PLAYING');
  session.listeners.get('pause')(); await env.drain(); assert.equal(env.remote.transport, 'PAUSED_PLAYBACK');
  session.listeners.get('seek')(53000); await env.drain(); assert.equal(env.remote.position, 53000);
  session.listeners.get('skipToQueueItem')(1); assert.equal(env.api.dlnaState().mediaId, second.mediaId);
  assert.equal(local.playerCallbacks.length, 1);
});
await check('facade return-to-local starts only after Stop confirmation; newer pause cancels it', async () => {
  for (const newerPause of [false, true]) {
    const env = setup(); await env.connect(); env.api.dlnaDisconnect(); await env.drain();
    const local = createFacade(env), song = item();
    local.api.audioOnResolveRequest(() => {});
    local.api.audioSetPlaylist([song], 0, false, 25); local.api.audioDlnaConnect('uuid:renderer');
    local.api.audioDlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation); await env.drain();
    const hold = env.hold('Stop'), before = local.playerCallbacks.length, stops = env.effects.filter(value => value === 'Stop').length;
    local.api.audioDlnaDisconnect(true);
    await env.waitFor(() => env.effects.filter(value => value === 'Stop').length > stops);
    assert.equal(local.playerCallbacks.length, before);
    if (newerPause) local.api.audioPause();
    hold.resolve(); await env.drain();
    assert.equal(local.playerCallbacks.length, before + (newerPause ? 0 : 1));
    assert.equal(local.api.debug().gPendingPositionSec, 25);
  }
});
await check('duplicate songs retain the selected queue occurrence through casting and return-to-local', async () => {
  const env = setup(); await env.connect(); env.api.dlnaDisconnect(); await env.drain();
  const local = createFacade(env), song = item('test:duplicate');
  local.api.audioOnResolveRequest(() => {});
  local.api.audioSetPlaylist([item(song.mediaId), item('test:middle'), song, item('test:next')], 2, false, 42);
  local.api.audioDlnaConnect('uuid:renderer');
  local.api.audioDlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation); await env.drain();
  assert.equal(local.api.debug().gIndex, 2); assert.equal(env.api.dlnaState().positionMs, 42000);
  local.api.audioDlnaDisconnect(true); await env.drain();
  assert.equal(local.api.debug().gIndex, 2); assert.equal(local.api.debug().gPendingPositionSec, 42);
});
await check('pause from the completion callback prevents native queue advancement', async () => {
  const env = setup(); await env.connect(); env.api.dlnaDisconnect(); await env.drain();
  const local = createFacade(env), song = item('test:finish', 100);
  local.api.audioOnResolveRequest(() => {});
  local.api.audioSetPlaylist([song, item('test:next')], 0, true, 0); local.api.audioDlnaConnect('uuid:renderer');
  local.api.audioDlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation); await env.drain();
  local.api.audioOnEnded(() => local.api.audioPause());
  env.remote.duration = 100000; env.remote.position = 99000;
  await env.tick(1000); await env.drain();
  const generation = env.api.dlnaState().generation;
  env.remote.transport = 'STOPPED'; env.remote.position = 0;
  await env.tick(1000); await env.drain();
  assert.equal(env.api.dlnaState().mediaId, song.mediaId);
  assert.equal(env.api.dlnaState().generation, generation); assert.equal(local.api.debug().gIndex, 0);
});
await check('same-track reload from the JS completion callback prevents duplicate native queue advance', async () => {
  const env = setup(); await env.connect(); env.api.dlnaDisconnect(); await env.drain();
  const local = createFacade(env), song = item('test:repeat', 100);
  local.api.audioOnResolveRequest(() => {});
  local.api.audioSetPlaylist([song, item('test:next')], 0, true, 0); local.api.audioDlnaConnect('uuid:renderer');
  local.api.audioDlnaResolveDone(song.mediaId, audioUrl, '', env.api.dlnaState().generation); await env.drain();
  local.api.audioOnEnded(() => local.api.audioPlayTimelineIndex(0));
  env.remote.duration = 100000; env.remote.position = 99000;
  await env.tick(1000); await env.drain();
  const generation = env.api.dlnaState().generation;
  env.remote.transport = 'STOPPED'; env.remote.position = 0;
  await env.tick(1000); await env.drain();
  assert.equal(env.api.dlnaState().mediaId, song.mediaId);
  assert.equal(env.api.dlnaState().generation, generation + 1);
});

console.log('[check-harmony-dlna] ' + passed + ' transport, relay and lifecycle regressions passed');
