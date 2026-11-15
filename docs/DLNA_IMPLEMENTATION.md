# Android / HarmonyOS / iOS 普通 DLNA

更新：2026-11-09。三个客户端均作为 DLNA 发送端和控制端，接收设备使用自身
MediaRenderer 播放器。播放页和 HD 播放栏复用 `qt-dlna-sheet` 搜索、选择、
断开和切回本机；共享入口已启用 HarmonyOS 和 iOS。

不包含电视应用、屏幕镜像、电视端轻听界面或滚动歌词、转码、Google Cast、
AirPlay，也不将 qt-pc 作为 DLNA 接收端。

## 公共控制链路

`services/dlna.uts`、`services/audio-player.uts` 和播放器 store 保留现有业务
队列与音源取链；平台门面位于 `uni_modules/qt-audio-player/utssdk/`。

- SSDP 搜索和 UDN 去重；按设备 XML 和 SCPD 获取 AVTransport、
  RenderingControl 与实际能力，解析相对服务地址。
- 当前媒体通过会话令牌 HTTP 地址提供，支持 HEAD、GET 和单段 Range，
  包括 206/416；MIME 来自媒体内容或源响应信息。
- 投屏后释放本机解码项，系统媒体命令转向接收设备；进度来自远端。
- 会话、曲目、播放、定位和音量分别校验操作版本，独立音量不会取消暂停。
  Stop 撤销未完成取链、装载和旧媒体回执。
- 接管保留曲目、进度与暂停意图；重复歌曲保留具体队列位置。
  `[A,B,A,C]` 的第 3 项投屏及返回时仍为第 3 项。
- 切回本机先等远端 Stop 成功；失败不自动本机起播，新播放操作取消过期恢复。
- 自然结束需由实际播放状态、有效时长和曲末位置共同确认。
  外部媒体接管、设备掉线、不能定位或不能设置音量均显式反馈或降级。

## 原生实现

| 平台 | 原生链路 | 主要文件 |
|---|---|---|
| Android | Java 网络、Media3 独立 `DlnaSessionPlayer`、既有 MediaSession/服务 | `app-android/dlna.uts`、`dlna-player.uts`、`index.uts` |
| HarmonyOS | NetworkKit、CoreFileKit、既有 MediaKit/AVSessionKit | `app-harmony/dlna.uts`、`index.uts`、`module.json5` |
| iOS | Foundation/Darwin SSDP、Network TCP 中继、MediaPlayer 远端命令 | `app-ios/QtIOSDLNAProtocol.swift`、`QtIOSDLNA.swift`、`index.uts` |

Android 私有文件和 `content://` 地址通过中继读取。Media3 1.11.1 使用
`COMMAND_GET_METADATA` 和 `handleSetVolume(volume, volumeOperationType)`。
Android 14+ Wi-Fi 锁为 `WIFI_MODE_FULL_LOW_LATENCY`，旧系统保留 `HIGH_PERF`；
兼容弃用声明仅在该函数局部处理。

HarmonyOS 按 Range 有界读取网络资源；不支持字节范围的源先完整暂存，验收
上限 256 MiB，超时 120 秒。SDK 没有 TCP Server 关闭监听器 API，因此进程
内复用一个监听器，断开会撤销路由令牌并关闭客户端。HTTP 初始地址和 DNS
经过校验，自动重定向链尚未实现地址钉住。

iOS 的本地及用户授权目录文件直接中继，安全书签访问保持到读取结束。
网络歌曲先完整暂存到 `Library/Caches/qt-dlna`，验收完整文件不超过 512 MiB，
请求超时配置 120 秒，完成后才设置接收设备的媒体 URI。首次起播会等待下载；
不使用短 WAV 或其他替代文件。详见 [iOS 音频实现](IOS_AUDIO_IMPLEMENTATION.md)。

## 打包和使用

手机与接收设备应能在局域网互相访问，设备须启用 DLNA 音频接收。普通电脑
需要另装真正的 DLNA MediaRenderer 才能收听；仓库 Node 模拟设备只用于协议
验证，不解码音频，其默认 12 秒静音 WAV 不能作为整首歌曲试听证据。

原生插件及权限发生变化后必须重建自定义基座或完整应用，旧安装包不会通过
热更新获得新增方法和原生资源。

iOS 整应用最低版本为 14.0。音频插件独立最低版本为 13.0，源引擎及文件模块
要求 14.0。`app-ios/UTS.entitlements` 声明
`com.apple.developer.networking.multicast`，正式 provisioning profile 必须获准
该 entitlement；本地网络访问也需用户允许。

后台本机音频由实际 AVPlayer/AVAudioSession 提供。纯远端 DLNA 没有本机音频
持续播放，iOS 可能挂起 HTTP 中继、网络命令和轮询；没有静音音频保活。

## 2026-11-09 验证

| 检查 | 结果与边界 |
|---|---|
| Android DLNA | 值处理及 13 个延迟 I/O 场景通过 |
| HarmonyOS DLNA | 23 条生产传输、中继及生命周期回归通过 |
| HarmonyOS 原生模块 | HBuilderX UTS → ArkTS、DevEco API 24 原生 HAR 构建通过 |
| HarmonyOS 整应用 | HBuilderX 5.34 / DevEco 26.0.0.851 成功生成未签名 HAP |
| Android 共享应用 | HBuilderX 5.34 Vapor/Kotlin 编译通过；32 个 app-native、85 个 audio 导出与 Kotlin、JAR、DEX 核对通过 |
| iOS 音频/DLNA | 31 条生产 UTS 门面和可控制延迟回执回归通过 |
| iOS 文件与页面 | 17 条生产接口、MP3/FLAC 音频保留、权限及页面生命周期回归通过 |
| iOS 音源引擎 | 19 条默认回归；加真实官方 meta/play 包后 20 条通过 |
| iOS 原生源码 | 8 个 Swift 文件语法检查、3 个完整 UTS → Swift 门面转译通过 |
| 源码一致性 | 44 个本次源码和原生资源与独立验证副本 SHA256 一致 |
| 全量 `npm run check` | 未全绿：现有播放器布局测试仍断言短屏 footer 为 99px，当前实现为 97px；其后各门禁已分别运行，通过 |

iOS 的模拟边界回归、语法和转译不包含 Apple SDK 类型检查、链接、签名或
真机运行。尚未进行 iPhone、HarmonyOS 真机及真实电视/音箱联调；格式解码、
后台网络、锁屏/耳机控制、拖动、音量和连续队列仍需设备验收。

检查命令在项目目录运行：

```powershell
npm run check:dlna
npm run check:ios-native
node --experimental-vm-modules --disable-warning=ExperimentalWarning tools/check-ios-source-engine.mjs ../qt-sources/dist/meta-bundle.js ../qt-sources/dist/play-bundle.js
```

验证副本为 `F:\qtMusic\review-output\ios-harmony-native-verification`，
`node_modules` 是原依赖目录的 junction。未签名 HAP 为该副本下
`unpackage/dist/dev/app-harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`。
源码及编译证据分别见 `review-output/ios-harmony-final-source-hashes.json`、
`ios-harmony-app-build.log`、`ios-harmony-android-build-retry.log`、
`ios-harmony-final-ios-check.log` 和 `ios-source-engine-official-final.log`。
