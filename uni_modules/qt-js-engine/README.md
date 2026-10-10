# qt-js-engine

在**安卓 / 鸿蒙端本地执行音源包脚本**（`source-bundle.js`）的 UTS 插件，让「第三方音源接口失效」
这类问题不发版就能修复。iOS 侧计划走系统 JavaScriptCore（阶段二）。

> 本仓库**不内置音源包**：脚本由用户在应用内安装（官方清单下发或粘贴直链），
> 插件只负责「拿一段脚本文本在本地跑起来」，不含任何音源实现。

## 引擎后端：系统 WebView 的 V8（唯一）

| 项 | 值 |
| --- | --- |
| 实现文件（安卓） | `utssdk/app-android/webview.uts`（WebView 宿主桥）/ `index.uts`（pump、HTTP、定时器、文件 IO、对外 API） |
| 实现文件（鸿蒙） | `utssdk/app-harmony/builder.ets`（ArkWeb 宿主桥）/ `index.uts`（同上）/ `prelude.uts`（注入源码） |
| 内核 | 系统 WebView / ArkWeb 内置的 V8/JIT |
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
   ├─ index.uts                未实现平台占位（返回「不支持」，由调用方降级）
   ├─ app-android/
   │  ├─ config.json           空（无原生库，不再限制 abis / minSdk）
   │  ├─ prelude.uts           宿主注入的 JS 源码（QT_JS_PRELUDE，hostApiVersion=1 的一部分）
   │  ├─ webview.uts           WebView(V8) 宿主桥（创建 / 求值 / 装载 bundle）
   │  └─ index.uts             对外 API（引擎线程 / pump / HTTP / 定时器 / 文件 IO）
   └─ app-harmony/
      ├─ config.json           空（无 ohpm 依赖）
      ├─ module.json5          har 模块声明（含 ohos.permission.INTERNET）
      ├─ prelude.uts           宿主注入的 JS 源码（QT_JS_PRELUDE，与安卓同源，平台号 1106）
      ├─ builder.ets           ArkWeb 宿主桥（1×1 隐藏 Web + onInterceptRequest 内存供源码）
      └─ index.uts             对外 API（两条串行队列 / pump / HTTP / 定时器 / 文件 IO）
```

> 鸿蒙实现（`app-harmony/`）与安卓**同一套架构的第二份平台实现**，上层与音源包零改动。
> 三处无法照抄的差异：① 没有引擎线程 → 换成「求值队列 + 操作队列」两条显式串行队列
> （阻塞等待变回调续接，超时改用看门狗定时器）；② 没有 headless JS 运行时 → 必须给
> 1×1 的 `Web` 找挂载点（**三级回落**：覆盖层 `OverlayManager` → 页面节点
> `qt-js-engine-host` → 根节点约定 id `root`；**应用侧不必提供那个 view**，
> 三级全失败才报错并列出每级原因）；
> ③ 模块源码不落盘 → `onInterceptRequest` 用 `WebResourceResponse` 直接从内存回填。
> 定时器仍归原生管（免疫 ArkWeb 对不可见页面的定时器节流）。

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
- `loadPlayBundle` 是**播放包专用**的第二条同款通道：落盘到 `qt-v8-play-bundle.js`
  （与 meta 分文件）、受拦路径 `/qt-play-bundle.js`、装载状态与校验对象都独立
  （`__qtPlayLoadStatus` / 认 `globalThis.__qtPlayPackFactory`），因此 meta 重装不会
  冲掉播放包、反之亦然。装载成功后插件把工厂另存到 `globalThis.__qtPlayFactoryStash`，
  供宿主用几十字节的交接桩交回 meta 完成装配（`installPlayPack` 在求值传参**之前**
  会先把 `__qtPlayPackFactory` 置空，所以桩必须读 stash 而不是读它）。
  模块 URL 每次带新的 `?v=N`：模块图按完整 URL 缓存，播放包会在同一引擎生命周期里
  被反复装载，不带查询串会命中旧模块而拿到上一个包的工厂；
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
  loadBundle, loadPlayBundle, invoke, dropOp,
  isRunning, isHealthy, dataDir,
  readTextFile, writeTextFile, exists, remove, mkdirs, listDir, readAssetText,
} from '@/uni_modules/qt-js-engine'

// 1) 起引擎（启动 WebView 并注入 bootstrap + prelude；当前 V8 后端不需要任何参数）
start({}, (info, error) => {
  // info.engine === 'webview-v8'；info.version 是 WebView 版本；info.probe === '2'
})

// 2) 装载音源包（写盘 → 页面动态 import → 校验 __qtEntries 非空；全程不触网）
loadBundle('F:/.../source-bundle.js 的源码文本', (ok, error) => {})

// 2b) 装载播放包（同款文件通道；校验 globalThis.__qtPlayPackFactory 已挂出）
loadPlayBundle('F:/.../play-bundle.js 的源码文本', (ok, error) => {})

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

实现约定（`app-harmony/index.uts`，与上面逐条对应）：

- 没有引擎线程：`gEvalQueue`（一次只发一条 `runJavaScript`，回来才发下一条）+ `gOpQueue`
  （start/stop/求值/装载/invoke 互不交错）两条串行队列，等价于「都 post 到同一条线程」；
  单次求值超时由看门狗定时器结算（`EVAL_TIMEOUT_MS`），不是阻塞等待；
- HTTP 走 `@kit.NetworkKit` 的 `http.createHttp()`（每请求配一次 `destroy()`；
  包自带的 `Accept-Encoding` 被主动丢弃——NetworkKit 自己协商并透明解压）；
- 文件 IO 走 `@kit.CoreFileKit` 的 `fileIo`，语义与安卓 java.io 版逐条对齐
  （`exists` 的 value 是字符串 `"1"`/`"0"`；`remove` 对不存在的路径算成功；`listDir` 目录不存在返回 `[]`）；
- 回调一律经 `onMain`（`setTimeout(fn, 0)`）投递一拍，与安卓 `Handler.post` 的时序对齐。

> 鸿蒙侧编译前需确认：本机当前**没有 DevEco Studio / HarmonyOS SDK**，
> 但 `index.uts` / `builder.ets` 里的原生签名已用 HBuilderX 自带的鸿蒙 SDK 类型定义
> （`.../uni-uts-v1/lib/uts/types/uni-x/app-harmony/ohos/`）逐条核对过一轮，
> 核对结论写在 `index.uts` 文件头的 `[A1]~[A9]` 清单里，分「已核对通过」与「仍待验证」两类。
>
> 仍待验证的只剩两类：
> ① **ArkUI 组件层**（`Web` 组件及其属性、`wrapBuilder`、`WebResourceResponse`、
>    `WebResourceRequest`）——这些声明属 DevEco SDK 的 `component/` 目录，本机没有，
>    在 `app-harmony` 类型树里各出现 0 次。其中已发现并修正一个真错：
>    `WebResourceResponse` **不属于 `webview` 命名空间**，它是与 `Web`/`Color` 同层的
>    组件全局声明类，必须写裸名（builder.ets 是原生 `.ets`，ambient 全局可见）。
>    `wrapBuilder` 同理是全局函数——DCloud 官方混编示例在 `.uts` 里直接调用而**不 import**。
> ② `setTimeout` / `clearTimeout` 全局函数（UTS 注入，不在 SDK 类型树里）。
>
> 也就是说：真正的编译风险已收敛到 ArkUI 组件属性名这一小块，其余全是已核对签名。

## app 侧怎么用（数据流）

```
App.uvue onLaunch
  └─ prewarmSourceEngine()                    恢复 state.json → start() → loadBundle(meta 槽: 生效数据包，未装则跳过) → 装生效播放包
music-api.resolvePlayUrl()
  └─ getPlayUrlByEngineResult(song, quality)  引擎可用则走音源包；返回 {url, stalled, line}，
                                               未安装/取不到时 url=""，失败性质与命中线路随返回值带回
                                               （并发取链下不能用全局标记，见该函数注释）
services/source-update.discoverUpdatesAtStartup()  启动更新发现（各包自述 updateUrl + astral manifest，4h 节流）
  └─ SOURCE_UPDATE_FOUND_EVENT                仅提示：App.uvue 弹确认框，用户点「更新」才 applyUpdate()（绝不静默安装）
services/source-update.installFromUrl()/installFromLocalFile()/installFromText()
                                              统一安装管线：解析 /*__QT_PACK__*/ 头 → 校验 → install/<id>/ 落盘 → 登记 → 按需生效
pages/settings/index.uvue 「音源包管理」        检查更新 / 从链接·本地文件安装 / 逐包启用·停用·卸载（卸载生效数据包 = 数据面停用）
```

包体与状态全部经本插件的文件 API 存放在 `filesDir/source-bundle/`
（`state.json` + `install/<packId>/meta-bundle.js|play-bundle.js|chain.json`），
schema 3 见 `services/source-bundle-fs.uts` 头注释。

**仓库不内置任何音源包**：数据包与播放包都由用户在「音源包管理」页从 https
直链或本地 .js 文件安装（包头自述 id/版本/updateUrl，同 id 新版本原地替换，
多包共存；播放包 activeId / 数据包 activeMetaId 指定生效包，均只对已装包提示
更新）。未装数据包时在线搜索/歌单/歌词及在线播放不可用（播放注入依赖数据包
的装载入口；本地音乐照常），首页引导只指路设置页。
所有包的身份都是「自述 id + 内容签名」：官方包是保留 id
（`play-official` / `meta-official`）+ 发布私钥的 ed25519 尾部签名块
（`__QT_SIGN__`），安装/更新时用 APK 内置 tweetnacl 公钥硬校验
（`services/pack-signature.uts`），验不过直接拒绝；第三方包不签名、
流程不变。

> 注意：改了 UTS 插件后真机调试要重新编译该插件；`HBuilderX` 会按文件指纹跳过未变化的插件，
> 必要时加 `--cleanCache true`。本插件已无原生库，不再需要为 `.so` 打自定义基座。
