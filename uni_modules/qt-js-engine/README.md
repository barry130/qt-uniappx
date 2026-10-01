# qt-js-engine

在**安卓端本地执行音源包脚本**（`source-bundle.js`）的 UTS 插件，让「第三方音源接口失效」
这类问题不发版就能修复。iOS 侧计划走系统 JavaScriptCore（阶段二）。

> 本仓库**不内置音源包**：脚本由用户在应用内安装（官方清单下发或粘贴直链），
> 插件只负责「拿一段脚本文本在本地跑起来」，不含任何音源实现。

## 引擎后端：系统 WebView 的 V8（唯一）

| 项 | 值 |
| --- | --- |
| 实现文件 | `utssdk/app-android/webview.uts`（WebView 宿主桥）/ `index.uts`（pump、HTTP、定时器、文件 IO、对外 API） |
| 内核 | 系统 WebView 内置的 V8/JIT |
| 混淆脚本 init | 实测 **200-350ms**（混淆后的音源包脚本 141-242ms）——内嵌解释器上是 6-9s |
| 失败语义 | 系统 WebView 不可用（de-Googled ROM）或启动失败时 `start()` 直接报错，由服务层决定后续 |

> 2026-09-23 之前这里是「WebView 优先 + 内嵌 QuickJS 兜底」双后端。随 QuickJS 后端一并删除的：
> `libs/*.aar`（1.3 MB）、`config.json` 的 `abis`/`minSdkVersion` 限制、prelude 的 `*Async`
> 微任务包装层、`ENGINE_BACKEND` 开关、`start()` 的 `memoryLimitBytes`/`stackLimitBytes`
> /`enableStackTrace` 参数。删除的原因：解释器跑同一段混淆脚本 init 要 6-9s（V8 约 84ms，×75.7），
> 兜底线路一触发就独占引擎线程、吃光整链预算，实际起不到兜底作用。

方案与真机验证清单见项目内部文档（不入库）；存储与热更新流程在 app 侧
`services/source-bundle-fs.uts` / `source-engine.uts` / `source-update.uts`。

两条已实测的引擎行为（桥接设计完全建立其上）：

1. **`evaluateJavascript` 对 Promise 表达式只回调 `"null"`，拿不到值**——所以一律求值
   **同步版**（prelude 的裸函数 + bootstrap 的 `__qtEnv` 信封），微任务由 V8 在每次脚本求值后
   自行跑检查点推进。这与内嵌解释器相反（那边必须求值 Promise 包装版才会跑微任务队列），
   也是删掉 QuickJS 后 `expr*` 不再需要按后端分叉的原因。
2. **`evaluateJavascript` 不回传异常，只回调 `"null"`**——bootstrap 用 `__qtEnv` 包一层
   try/catch + JSON.stringify，脚本抛错时从信封里取错误文本（`webview.uts` 的 `v8LastError()`）。

## 目录

```
qt-js-engine/
├─ package.json
├─ README.md
└─ utssdk/
   ├─ interface.uts            跨端类型（全部回调式，避免 Promise 跨语言转换）
   ├─ index.uts                非安卓平台占位（返回「不支持」，由调用方降级）
   └─ app-android/
      ├─ config.json           空（无原生库，不再限制 abis / minSdk）
      ├─ prelude.uts           宿主注入的 JS 源码（QT_JS_PRELUDE，hostApiVersion=1 的一部分）
      ├─ webview.uts           WebView(V8) 宿主桥（创建 / 求值 / 装载 bundle）
      └─ index.uts             对外 API（引擎线程 / pump / HTTP / 定时器 / 文件 IO）
```

## 桥接：pump 协议（JS ↔ 原生）

**JS 从不直接调用原生函数**。JS 把待办推进队列，原生每 20ms（`PUMP_INTERVAL_MS`）执行
`evaluate("__qtEnvPump()")` 把队列拉空（先跑干微任务、再取走待办行）；
每行是一个 ASCII JSON 对象（`k` 为行类型）：

| k | 队列 | 含义 | 原生回投 |
| --- | --- | --- | --- |
| `H` | httpQueue | 发起一次 HTTP 请求（id/url/method/headers/body/timeoutMs） | `evaluate("__qtEnvResolveHttp(id, status, headersJson, body, error)")` |
| `T` | timerQueue | 设置定时器（id/delayMs/repeat） | 到点后 `evaluate("__qtEnvFireTimer(id)")`；interval 会在 JS 侧自动重新入队 |
| `R` | results | `__qtCall` 发起的入口调用结果（id/ok/value/error） | UTS 侧直接分发给 `invoke` 的回调 |

所有 id（http/timer/op）在 JS 侧一律 `String(++seq)`，原生侧也全程按字符串处理，避免 `"12"` vs `"12.0"` 的格式错位。

**ASCII-only 边界**：跨语言边界的字符串一律保持纯 ASCII——

- 进 JS 的字符串：UTS 侧 `quoteAscii()` 把非 ASCII 转成 `\uXXXX`；
- 出 JS 的字符串：prelude 里 `asciiJson()` 把结果值转义成 ASCII JSON 文本；
  中文在 UTS 侧 `JSON.parse` 后自动还原。

**主线程回调**：所有 UTS → 调用方的回调（start/stop/evaluate/loadBundle/invoke/文件 IO/spike）统一经
`Handler(Looper.getMainLooper())` 派发（与 `qt-audio-player` 的既有做法一致），引擎线程上只做求值编排与网络 IO。

**异步语义**：`__qtCall` 的入口函数在 `Promise.resolve().then(...)` 里跑，结果（含异步）统一以
`{k:'R', id, ok, value, error}` 回投；入口 resolve 出非字符串值时由 prelude 用 `asciiJson` 序列化。
等待原生回投期间 pump 空转，无害。注意这个 `then` 回调只有原生下次 evaluate（V8 每次求值后
自行跑微任务检查点）时才真正执行。

## Bundle 入口契约（hostApiVersion = 1）

音源包脚本（`source-bundle.js`，由音源包构建端这个独立工程产出，本仓库不内置）在顶层只做注册，
不发起任何请求。**同一份产物两端共用**：

- PC：引擎页动态 `import`，取 `createSourceLayer` 等命名导出；
- 安卓：本插件把 bundle 当**模块脚本**装载（写盘后由 WebView 页面动态 `import`，
  顶层 `export` 合法，语法错在 reject 里且顶层零执行），只认下面这套全局注册。
  产物末尾由构建端的 `engine-entry.ts` → `qt-entries.ts` 自注册，
  仅当宿主提供 `__qtHost` 时生效（PC 无此全局，导入无副作用）。

```js
globalThis.__qtEntries = {
  bundleInfo: function () {},          // → JSON: {name, version, chainRevision, platforms:[1101], hostApiVersion:1}
  loadChain:  function (chainJson) {}, // chain.json 原文 → JSON: {ok:true, lines:N}；非法时抛错
  getPlayUrl: function (args) {},      // args = JSON 数组文本 [ {platform,id,name,singer,album,quality,duration} ]
                                       // → JSON: {url, source, quality}；取不到时抛错
  verifyPlayable: function (args) {}   // args = JSON 数组文本 [ {url} ]
                                       // → JSON: {ok, status, length}
};
```

约定：

- 入参是 **JSON 数组文本**（`JSON.stringify([args])`），返回值是 **JSON 文本**；
- `loadBundle` 的装载校验 = ① `v8LoadBundle()` 落盘 + 页面动态 `import`（语法错在 reject 里，
  顶层零执行，这就是热更新三道闸门的第 ② 道）→ ② `__qtEnvEntries()` 数入口必须 > 0；
- **平台过滤**：`__qtHost.platform`（prelude 固定 1101）透传到取链执行器，chain.json 的
  行级 `platforms` 白名单按它生效（PC 专属线路不会在安卓参与，反之亦然）；
- prelude 提供 `__qtHost.request(url, opts)`（Promise）、`__qtHost.log(msg)`、
  `setTimeout/setInterval/clearTimeout/clearInterval`（原生-backed）、TextEncoder/TextDecoder、
  btoa/atob、crypto.getRandomValues 等 ES 补丁（全部「有就不动」，老 WebView 也缺这些）；
- `__qtHost.request` 与 PC 的 Rust `builtin_request` **同契约**：响应头名一律小写、
  响应体先试 `JSON.parse` 失败则原样字符串（上游普遍回 text/plain 却带 JSON 体，
  脚本按 `res.body` 直接取对象）。

## API

```ts
import {
  start, stop, evaluate,
  loadBundle, invoke, dropOp,
  isRunning, isHealthy, dataDir,
  readTextFile, writeTextFile, exists, remove, mkdirs, listDir, readAssetText,
} from '@/uni_modules/qt-js-engine'

// 1) 起引擎（启动 WebView 并注入 bootstrap + prelude；当前 V8 后端不需要任何参数）
start({}, (info, error) => {
  // info.engine === 'webview-v8'；info.version 是 WebView 版本；info.probe === '2'
})

// 2) 装载音源包（写盘 → 页面动态 import → 校验 __qtEntries 非空；全程不触网）
loadBundle('F:/.../source-bundle.js 的源码文本', (ok, error) => {})

// 3) 调入口（opId 由本函数生成并返回，用于超时后 dropOp 丢弃结果）
const opId = invoke('getPlayUrl', JSON.stringify([args]), 12000, (ok, value, error) => {})
dropOp(opId)   // 超时放弃：晚到的 R 行按未知 id 丢弃

// 4) 通用求值（返回字符串；约定 JS 里 String(...) 包一层）
evaluate('String(1 + 1)', (r) => { /* r.value === '2' */ })

// 5) 文件 IO（dataDir 即 filesDir/source-bundle/，包体落盘在 pkg/<versionCode>/ 下）
writeTextFile('state.json', json, cb); readTextFile('state.json', cb)
exists('pkg/2026091801/chain.json', cb); listDir('pkg', cb); remove('pkg/2026091801', cb); mkdirs('pkg', cb)

// 5b) 读 APK 内置资源（通用资源读取；path 相对 www 根，appid 由插件现场发现）
readAssetText('static/theme.json', (ok, value, error) => {})

// 6) 状态与健康
isRunning(cb); isHealthy(cb)   // isHealthy === false 即已 poison；服务层 ensureEngine() 会自动 stop + start 重建
stop((r) => {})                // 正常关停；对已 poison 的引擎放弃线程直接释放
```

实现约定（`app-android/index.uts`）：

- 所有引擎操作经 `engineHandler` 在固定的 `"qt-js-engine"` 线程上串行投递，
  WebView 的创建/求值再 marshal 到主线程（WebView 只能在主线程上使用）；
- HTTP 走 `HttpURLConnection`（超时/重定向/gzip/限流 `MAX_RESPONSE_BYTES` 8MB/错误流读取都有护栏）；
- waiter 带超时（`expireWaiters` 统一过期），回调不丢；
- 文件 IO 在引擎线程之外的独立线程执行，避免与 evaluate 争抢。

## app 侧怎么用（数据流）

```
App.uvue onLaunch
  └─ prewarmSourceEngine()                    恢复 state.json → start() → loadBundle(meta 槽: 生效数据包|内置基线) → 装生效播放包
music-api.resolvePlayUrl()
  └─ getPlayUrlByEngine(song, quality)        引擎可用则走音源包；未安装/取不到返回 ""，由调用方报「暂时无法播放」
services/source-update.discoverUpdatesAtStartup()  启动更新发现（各包自述 updateUrl + astral manifest，4h 节流）
  └─ SOURCE_UPDATE_FOUND_EVENT                仅提示：App.uvue 弹确认框，用户点「更新」才 applyUpdate()（绝不静默安装）
services/source-update.installFromUrl()/installFromLocalFile()/installFromText()
                                              统一安装管线：解析 /*__QT_PACK__*/ 头 → 校验 → install/<id>/ 落盘 → 登记 → 按需生效
pages/settings/index.uvue 「音源包管理」        检查更新 / 从链接·本地文件安装 / 逐包启用·卸载（数据包卸载回内置基线）
```

包体与状态全部经本插件的文件 API 存放在 `filesDir/source-bundle/`
（`state.json` + `install/<packId>/meta-bundle.js|play-bundle.js|chain.json`），
schema 3 见 `services/source-bundle-fs.uts` 头注释。

**仓库不内置播放包**：`static/` 下只有数据包基线（`source-meta-code.uts`），
播放包全部由用户安装——官方与自定义机制完全一致（https 直链或本地 .js 文件，
包头自述 id/版本/updateUrl，同 id 新版本原地替换，多包共存、activeId 指定生效包）。
数据包（meta）内置基线开箱可用，也可安装更高版本（activeMetaId 生效，卸载回基线）。
所有包的身份都是「自述 id + 安装渠道」：官方只是发布方推荐的 id
（`play-official` / `meta-official`），不做内容级验签。

> 注意：改了 UTS 插件后真机调试要重新编译该插件；`HBuilderX` 会按文件指纹跳过未变化的插件，
> 必要时加 `--cleanCache true`。本插件已无原生库，不再需要为 `.so` 打自定义基座。
