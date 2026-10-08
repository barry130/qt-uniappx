# qt-stat 轻听音乐统计采集插件

uni-app x 采集插件（设计文档《STATS_DESIGN.md》§7，纯采集版）。
App 侧只需 import 本插件，无需关心上报细节；所有 API 全部 try/catch 包裹，**任何统计异常都不影响 App 主流程**。

## 能力

- **设备匿名标识**：首次启动生成随机 UUID 持久化（`qt-stat-device-id`），**不采集 IMEI/OAID 等硬件标识**。
- **事件采集**：`launcher`（冷启动）、`show`/`hide`（前后台，hide 自动带 `duration` 停留时长）、`page`（页面 PV）、`error`（JS/UTS 运行错误）。
- **批量上报**：内存队列，默认 **10 秒**定时或满 **50 条**触发；服务端单次限 200 条，超量自动分片。
- **可靠性**：`hide` 时队列持久化到 storage（key `qt-stat-queue`），冷启动恢复并先上报；失败回队列重试 ≤3 次；队列上限 500 条丢最旧。
- **匿名上报**：直连 `POST /api/v1/app/stat/report`（匿名公开接口，不走 satoken 刷新体系，属 `services/http.ts` 约定的例外，见设计文档 §7 异常说明）。
- **错误采集边界**：仅覆盖 JS/UTS 层**可捕获的运行错误**（App `onError` → `error` 事件入库，含 message/stack/page/release）。原生崩溃（进程死亡 / NDK / ANR）**不做采集**（自托管 Sentry 因服务器资源受限未部署，M4 已取消）。

## App 侧接入（App.uvue）

```ts
import { initQtStat, qtTrack, qtTrackError, qtStatFlush } from '@/uni_modules/qt-stat'
import { resolveUrl } from '@/services/http'

onLaunch(() => {
  // 统计采集最先初始化
  initQtStat({
    ingestUrl: resolveUrl('app/stat/report'),
    channel: 'official',
    debug: false,
    batchIntervalMs: 10000,
    maxBatchSize: 50,
  })
  qtTrack('launcher')
  // ...原有启动逻辑不变
})

onShow(() => { qtTrack('show') })

onHide(() => {
  // 原有 persist 逻辑保留；追加：补 hide 事件（含停留时长）+ 持久化队列 + 立即上报
  qtStatFlush()
})

onError((err: any) => {
  // JS/UTS 层可捕获的运行错误 → 自建后端（原生崩溃不做采集）
  // err 类型不定：优先取 Error.message/stack（实测 JSON.stringify(Error) 会得到 "{}"），序列化兜底；
  // stack 由运行时提供（含 app-service.js 位置），page 取 getCurrentPages 栈顶路由
  let msg = ''
  let stack = ''
  try {
    const e = err as Error
    const m = e.message
    if (m != null && m.length > 0) msg = m
  } catch (_) {}
  if (msg.length == 0) {
    try {
      msg = JSON.stringify(err)
    } catch (_) {
      msg = ''
    }
  }
  if (msg.length == 0 || msg == '{}') msg = 'unknown'
  try {
    const e2 = err as Error
    const st = e2.stack
    if (st != null) stack = st
  } catch (_) {}
  let page = ''
  try {
    const pages = getCurrentPages()
    if (pages.length > 0) {
      const top = pages[pages.length - 1]
      const r = top.route
      if (r != null) page = r
    }
  } catch (_) {}
  qtTrackError('js', msg, stack, page)
})
```

## 页面 PV（§7.3，首期 5 个主页面）

在页面 `onShow` 里调用一次：

```ts
import { qtTrackPage } from '@/uni_modules/qt-stat'

onShow(() => {
  qtTrackPage('pages/home/index')  // 一次展示 = 1 PV
})
```

首期范围：`pages/home/index`、`pages/player/index`、`pages/search/index`、`pages/playlist/index`、`pages/profile/index`。

## 原生崩溃采集（已取消）

曾计划用自托管 Sentry 采集原生崩溃（进程死亡 / NDK / ANR），后因**服务器资源不满足 Sentry 硬件最低要求**（约 4 核 / 16GB+16GB swap / 20GB 磁盘，且需同时运行 astral 后端）而**取消**。

- 本插件**只采集 JS/UTS 层可捕获的运行错误**（App `onError` → `error` 事件，含 message/stack/page/release）。
- 原生崩溃不做采集：`sentryDsn` 字段、`initSentry()` 桩、`config.json` 依赖、`SENTRY_DSN` 配置均已移除。
- `release` 字段保留：**运行时自动获取**（`uni.getAppBaseInfo().appVersion`，即 manifest.json 的 versionName），与 `appVersion` 字段同源，无需每次升版本手动改配置。用于在自建错误统计里**按版本过滤分析**（哪个版本崩的）。

## 目录结构

```
uni_modules/qt-stat/
├── package.json
├── readme.md
└── utssdk/
    ├── interface.uts                 # 跨端类型（QtStatOptions / QtStatEventType）
    ├── index.uts                     # 未实现平台的兜底空实现（静默降级）
    ├── app-android/
    │   ├── index.uts                 # 采集实现（本项目当前唯一打包端）
    │   └── config.json               # 声明原生依赖（当前为空；采集仅用跨端 uni.* API）
    ├── app-ios/
    │   └── index.uts                 # 采集实现（随 iOS 打包开启后联调）
    └── web/
        └── index.uts                 # 本期预留空实现（ut='web'）
```

## 存储占用

| key | 内容 | 生命周期 |
|---|---|---|
| `qt-stat-device-id` | 匿名 UUID | 永久 |
| `qt-stat-queue` | 未上报事件队列 JSON | hide 写入，上报成功/恢复后清除 |

## 验收对照（设计 §7.4）

1. 冷启动 → 约 10s 内上报 `launcher`/`show`，`stat_device` 出现该设备行、`stat_metric_hourly` 出现对应桶 ✅（需后端 M1 就绪后联调）
2. 前后台切换 → `hide` 带 `duration`，报表停留时长增长 ✅
3. 5 个主页面进出 → `page` 事件 PV 增长 ✅
4. 断网上报失败 → 退后台再冷启恢复，事件不丢、最终补报 ✅
5. JS/UTS 层 throw 运行错误 → `error` 事件入库（含 message/stack/page/release）✅（已验证：`{}`→真实文本、page/stack 采集、release=versionName）
