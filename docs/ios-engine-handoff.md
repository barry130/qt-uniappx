# iOS 音源引擎开发与验证

2026-11-09，子智能体 `ios_engine_next`。实现和当前 Windows 可执行的检查已完成。
父级集成记录位于 `review-output/ios-engine-next.md`，共享原生约定见
`review-output/ios-native-coordination.md`。

## 实际实现

新增 `uni_modules/qt-js-engine/utssdk/app-ios/`：

- `index.uts`：保留现有接口，串行操作/求值队列，H/T/R 泵协议，原生定时器、
  超时和取消、停止/重启隔离、内容进程健康检查。
- `QtJsEngineNative.swift`：系统 WKWebView/WKURLSchemeHandler 原样供应 ESM，
  原生 URLSession 网络、串行文件 IO、CryptoKit Ed25519 验签。
- `bootstrap.uts` / `prelude.uts`：两个包槽、生产工厂交接、统一宿主接口，
  1102 平台号；网页外联由 CSP、内容规则、导航委托和禁用 API 一起阻断。
- `config.json`：iOS 14.0+，Foundation/WebKit/UIKit/CryptoKit/CoreFoundation。

官方数据包是真正 ESM，播放包是保持原文字节的 IIFE。后端使用系统模块加载器，
每次载入采用新模块 URL，不对包源码正则去导出或重打印。HTTP 支持 8MiB 流式
上限、超时、手动重定向、charset/base64、响应头小写与 FLAC 位深嗅探；不继承
Safari Cookie/凭据，跨域重定向删除认证和客户端身份头。

目录：

- 私有 `Library/Application Support/QtMusic`，音源包在 `source-bundle/`。
- 文档 `Documents/QtMusic`，由 `publicDataDir()` 返回。
- 日志位于私有 `logs/quietmusic.log`。
- 内置资源由 `UTSiOS.getResourcePath()` 定位。

文件限定于应用沙盒；用户外部音源包文件先由 app-native 导入到沙盒再读取。
文件覆盖采用同分区 POSIX rename，已有 state.json/产物不会阻止后续提交；
追加写必须成功关闭句柄才报告成功。缺失文件规范化为 `ENOENT`，不依赖系统语言。

必要集成同时补齐：

- `services/source-bundle-fs.uts` / `services/logger.uts` 启用 APP-IOS；
  降级分支采用嵌套单平台 #ifndef。
- `services/source-update.uts` 新增 `PLATFORM_IOS = 1102`；manifest 查询、
  白名单过滤和更新上报统一使用实际平台号。
- `tools/check-source-integrity.mjs` 改用真实平台预处理；原有失败恢复用例保留。
- 插件元数据、README/interface 说明和 pack-signature 原生验签说明已更新。

共享服务的上述窄改动完成后才看到父级新增的共享文件禁改协作要求；后续共享
接入由父级负责。本子任务没有改音频、DLNA、app-native 原生实现或页面。

## 检查结果

`tools/check-ios-source-engine.mjs`：

```sh
node --experimental-vm-modules --disable-warning=ExperimentalWarning tools/check-ios-source-engine.mjs ../qt-sources/dist/meta-bundle.js ../qt-sources/dist/play-bundle.js
```

带实际官方产物时 **20 项通过**；不带产物时 19 项。执行真实 UTS 驱动、两个
JS 模板及完整存储/日志/更新服务，ESM 由 vm.SourceTextModule 解析执行。
包含串行求值、Unicode/异常、包槽、HTTP 桥接、超时/取消/停止、迟到回执、
进程健康、定时器、文件/签名回调、音源版本覆盖和重启恢复、日志持久化、
三个原生平台的 manifest/上报与 H5 降级。原生接口使用异步替身。

另通过：11 组 source-integrity、engine-revive、empty-catch、v8-bootstrap、
19 组 chart-api-cache 和 35 组 chart-loading（后两项确认共享文件分支没有破坏
现有排行榜回归）。

`review-output/verify-ios-engine-source.mjs` 使用 HBuilderX bundled Node 18：

```sh
E:/HBuilderX/plugins/node18/node.exe F:/qtMusic/review-output/verify-ios-engine-source.mjs
```

原生 Swift 语法检查和完整 `@dcloudio/uts.bundleSwift` 转译通过。输出位于
`review-output/ios-source-engine-transpile/`，包含转译结果和已验证源码 SHA256。
这些结果不代表 Apple SDK 类型检查、签名打包或真机运行通过。

## 共享集成与剩余设备验证

2026-11-09 共享集成已完成。主 `npm run check` 包含 `check:ios-native`，
其中源引擎用 `--experimental-vm-modules` 运行 19 条默认用例；上面的显式命令
另验证真实官方包，共 20 条。

ATS 由 app-native 的 `Info.plist` 统一声明 `NSAllowsArbitraryLoads=true`，
支持 DLNA 和用户配置的明文 HTTP 音源。音频模块没有另加 ATS 字典，不与
`NSAllowsLocalNetworking` 或 `NSAllowsArbitraryLoadsInWebContent` 混用。
WKWebView 直接外联仍受 CSP、内容规则和原生导航边界限制，音源请求仍走宿主。

`services/listen-stats-file.uts` 已接入 iOS `publicDataDir()` 的 Documents
存档，不请求 Android 存储权限；`services/listen-clock.uts` 已接入 iOS 原生
单调时钟。32 条跨平台存档回归验证原子覆盖失败不破坏原文件、备份与删除，
以及三端时钟和 Android 原有权限行为。Documents 随应用沙盒管理，通常在
卸载时被移除，不承诺重装保留存档。

Mac/iPhone 上必须继续验证自定义 scheme ESM、URLSession charset/redirect、
CryptoKit 官方验签、ATS，以及后台持续在线取链。WKWebView 后台暂停行为
不能从 Windows VM 推断；实现没有调用私有 WebKit API。

未创建提交、发布包或安装到设备。
