// Run after an Android development build. Resource export alone does not validate
// the Vapor debug proxy, Kotlin dispatch table and DEX cached by HBuilderX.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, process.argv[2] ||
  'unpackage/cache/vapor/uts_custom_android/app-android/uts/uni_modules/qt-app-native');
const plugin = resolve(root, 'uni_modules/qt-app-native');
const read = path => readFileSync(path, 'utf8');
const android = read(resolve(plugin, 'utssdk/app-android/index.uts'));
const proxy = read(resolve(cache, 'utssdk.js'));
const kotlin = read(resolve(cache, 'index.kt'));
const manifest = JSON.parse(read(resolve(cache, 'manifest.json')));

// A fresh manifest can coexist with stale proxy/DEX after an interrupted watch
// build. Validate the actual generated exports as well as source fingerprints.
for (const [file, fingerprint] of Object.entries(manifest.files)) {
  const hash = createHash('md5').update(readFileSync(resolve(plugin, file))).digest('hex');
  assert.equal(hash, fingerprint.md5, `${file}: native cache is stale; rebuild the module`);
}
const exports = new Map();
for (const match of proxy.matchAll(/export\s+const\s+(\w+)\s*=\s*initUTSProxyFunction\(moduleName,\s*\{([^}]+)\}\)/g)) {
  const [, symbol, options] = match;
  const name = options.match(/\bname:\s*"([^"]+)"/)?.[1];
  const id = options.match(/\bmethodId:\s*(\d+)/)?.[1];
  const async = options.match(/\basync:\s*(true|false)/)?.[1];
  assert.equal(name, symbol, `${symbol}: invalid proxy name`);
  assert.ok(id != null && async != null, `${symbol}: missing bridge metadata`);
  exports.set(symbol, { id: Number(id), async: async === 'true' });
}
assert.ok(exports.size > 0, 'No native function exports in generated proxy');
const declared = [...android.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)]
  .map(match => match[1]);
assert.deepEqual([...exports.keys()].sort(), [...declared].sort(),
  'Generated proxy exports differ from Android source; rebuild the complete native cache');
const service = read(resolve(root, 'services/app-native.uts'));
for (const match of service.matchAll(/^import\s*\{([^}]+)\}\s*from\s*"@\/uni_modules\/qt-app-native"/gm)) {
  for (const specifier of match[1].split(',')) {
    const name = specifier.trim().split(/\s+as\s+/)[0];
    assert.ok(exports.has(name), `Service imports ${name}, but the generated proxy does not export it`);
  }
}

// Verify IDs against Kotlin's actual dispatch table, not source declaration order.
const dispatch = kotlin.slice(kotlin.indexOf('UTSBridge.registerUTSMethod("qt-app-native"'));
assert.ok(dispatch.startsWith('UTSBridge.registerUTSMethod'), 'Native dispatch table missing');
const branches = [...dispatch.matchAll(/^( +)(\d+) ->\s*$/gm)];
assert.ok(branches.length > 0, 'Native dispatch branches missing');
const methods = branches.filter(branch => branch[1].length === branches[0][1].length);
assert.equal(methods.length, exports.size, 'Proxy and Kotlin have different method counts');
assert.equal(new Set([...exports.values()].map(value => value.id)).size, exports.size, 'Duplicate method IDs');
for (const [name, metadata] of exports) {
  const index = methods.findIndex(method => Number(method[2]) === metadata.id);
  assert.ok(index >= 0, `${name}: method ${metadata.id} missing from Kotlin`);
  const body = dispatch.slice(methods[index].index, methods[index + 1]?.index);
  assert.match(body, new RegExp(`\\b${name}\\(`), `${name}: proxy dispatches to a different native function`);
  assert.equal(body.includes('.then(fun('), metadata.async, `${name}: async bridge contract differs`);
}
for (const [filename, signature] of [['classes.dex', 'dex\n'], ['index.jar', 'PK']]) {
  const artifact = resolve(cache, filename);
  assert.ok(statSync(artifact).size > 100, `${filename} missing/empty`);
  assert.equal(readFileSync(artifact).subarray(0, signature.length).toString(), signature,
    `${filename}: invalid binary output`);
}
assert.equal(exports.get('exitAppNative')?.id, 9, 'Existing exit bridge ID must remain stable');
assert.deepEqual(exports.get('moveAppToBackgroundNative'), { id: 27, async: true });
console.log(`PASS native-proxy: ${exports.size} exports, source hashes, Kotlin IDs, JAR and DEX verified`);
