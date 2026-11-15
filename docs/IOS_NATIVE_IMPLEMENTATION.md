# iOS 原生功能接入

更新：2026-11-09。现有业务接口保留在 UTS 服务中，复杂系统操作由 Swift
原生文件实现。整应用最低 iOS 版本为 14.0。

## 已接入功能和依赖

| 能力 | 原生系统依赖 | 入口 |
|---|---|---|
| 本机播放、队列、缓存、速度、音量、音频中断 | AVFoundation、AVAudioSession | `qt-audio-player/app-ios/QtIOSAudio.swift` |
| 后台本机音频、锁屏/耳机命令、媒体信息和封面 | MediaPlayer、AVFoundation | 同上及音频插件 Info.plist |
| 五段 EQ 与音量增强 | MediaToolbox MTAudioProcessingTap、AudioToolbox | `QtIOSAudioDSP.swift` |
| Referer 保护的流式音频 | 公开 AVAssetResourceLoader、URLSession | `QtIOSHTTPAudioLoader.swift` |
| 普通 DLNA | Darwin UDP、Foundation XML/SOAP、Network TCP | `QtIOSDLNAProtocol.swift`、`QtIOSDLNA.swift` |
| JS 音源包、ESM、网络宿主、定时器和验签 | WebKit、Foundation、CryptoKit Ed25519 | `qt-js-engine/app-ios/QtJsEngineNative.swift`、`index.uts` |
| 文件/目录选择、音频导入、下载保存、扫描、删除 | UIKit、UniformTypeIdentifiers、Foundation、AVFoundation、Darwin | `qt-app-native/app-ios/QtAppNativeIOS.swift` |
| MP3/FLAC 内嵌标签与封面读取 | 共享 UTS 字节计划、原生有界文件 I/O | app-native `index.uts`、Swift 文件桥 |
| 图片保存到系统相册 | Photos add-only 授权 | 同上 |
| 原生音源登录及 HttpOnly Cookie | WKWebView、WKHTTPCookieStore | 同上 |
| 权限刷新、设置跳转、系统浏览器 | UserNotifications、Photos、UIKit | 同上 |
| 听歌存档、日志、音源状态、单调时钟 | Foundation 文件、Darwin 原子 rename、原生时钟 | `listen-stats-file.uts`、`listen-clock.uts`、源引擎 |
| 内存告警、低电量、减少动态效果 | UIKit、ProcessInfo、系统通知 | app-native 性能接口 |

上述路径均位于 `uni_modules/<模块>/utssdk/app-ios/`。系统 frameworks 由各
插件的 `config.json` 声明，不依赖 Web 播放或 Android API 提供 iOS 行为。
音频与音源细节另见 [iOS 音频](IOS_AUDIO_IMPLEMENTATION.md)、
[iOS 音源引擎](ios-engine-handoff.md) 和 [DLNA](DLNA_IMPLEMENTATION.md)。

## 文件与持久化

| 数据 | 位置 |
|---|---|
| 默认下载 | `Documents/Downloads/<subDir>`，当前音乐下载子目录为 `QtDownload/Music` |
| music 类型保存 | `Documents/Music/<subDir>` |
| 用户导入音频 | `Documents/Imports` |
| 听歌存档 | `publicDataDir()` 返回的 `Documents/QtMusic` 下 |
| 音源包状态与产物 | `Library/Application Support/QtMusic/source-bundle` |
| 日志 | `Library/Application Support/QtMusic/logs/quietmusic.log` |
| 本机音频预取 | `Library/Caches/qt-audio` |
| 网络 DLNA 完整暂存 | `Library/Caches/qt-dlna` |

`UIFileSharingEnabled` 和 `LSSupportsOpeningDocumentsInPlace` 使 Documents
可通过系统「文件」应用访问。这些目录仍属于应用沙盒，通常随卸载移除。
下载设置中另可选择文件提供商目录，文件、音频播放和 DLNA 共用安全书签。
刷新失效书签时保留旧地址映射，下载账本中以前保存的地址仍可解析。

目录选择返回授权根目录，访问时按最长目录边界匹配书签并恢复实际位置。
security-scoped resource 的访问覆盖完整读写或播放操作，结束后释放。
系统撤销授权时返回失败并引导重新选择，不把旧地址当作永久可读路径。

保存和导入使用原生协调 I/O、独占新文件创建和重名后缀，分块复制、成功同步
并关闭文件后才返回结果。失败仅回滚本次新文件，不覆盖已有文件。JS 文件
导入按 UTF-8 验收，最大 16 MiB。

MP3/FLAC 标签先生成共享字节计划，再由原生流式复制原音频与保留元数据段。
输出为独立新文件；失败返回原文件，不改写原音频。完整尾段和源长度会复核。
封面超过 4 MiB 时跳过写入；读取也使用有界窗口和封面缓存。

## 登录、权限和页面接入

音源网页登录使用原生 WKWebView，支持返回、取消、自定义 UA、外部 scheme，
以及共享 Cookie store 中的 HttpOnly Cookie。替换或关闭旧登录请求会撤销
尚未展示的页面，过期回执不能关闭或覆盖新的登录实例。

通知状态通过异步系统 API 刷新；本地网络开关没有公开读取接口，因此显示
未知而非伪造已授权。首次网络发现由 iOS 触发授权提示。相册保存只申请
add-only 权限，文件选择不请求 Android 存储权限。

本地页接入系统音频导入与扫描；导入在原生提交文件后触发一次重新扫描。
本地页和权限页都有操作版本与离页保护，迟到回执不能更新已卸载页面。
390px、1440px 两种布局通过真实页面脚本与模板回归；共享页面另经过实际
Android Vapor 和 HarmonyOS 整应用编译。此结果不包含 iOS 原生视觉验收。

均衡器和音量增强读取实际 PCM 处理能力，切换到 DLNA 时禁用，返回本机后
重新发布能力。浮点输出和指定软件解码器设置在当前 AVFoundation 链路禁用；
系统负责选择实际解码器与输出格式。

## iOS 无法等价提供的系统能力

应用任意覆盖其他应用的悬浮歌词、Android Activity 重建/主动退后台、APK
安装、自启动/Doze 白名单和 Android 小组件并非当前 iOS 公开 API 的等价
能力。相关查询明确不支持，设置入口按平台隐藏或禁用，没有伪造成功。
原生用户通知和锁屏音频命令已实现；iOS 小组件、Live Activity、CarPlay
不在本次新增实现中。

## 原生资源与签名

三个插件的 `config.json` 声明系统 frameworks。app-native、源引擎最低版本
为 14.0，音频插件独立最低为 13.0；整应用采用较高的 14.0。

app-native 的 `Info.plist` 统一声明明文 HTTP 音源和 DLNA 所需 ATS 策略，
仅含 `NSAllowsArbitraryLoads=true`，不混入会使该 blanket key 被忽略的
WebContent/LocalNetworking 键。Photos 使用说明、文件共享和隐私清单已加入。
隐私清单声明文件时间戳 `C617.1`、UserDefaults `CA92.1`；最终主应用和其他
依赖的隐私配置仍以实际合并包为准。

音频插件保留 `UIBackgroundModes=audio` 与本地网络使用说明。
按 HBuilderX 官方资源文件名 `UTS.entitlements` 声明
`com.apple.developer.networking.multicast`。签名 profile 必须获得 Apple 的
相应授权；Windows 上新增此资源不代表授权、签名或 IPA 已完成。

## 检查证据及剩余验证

2026-11-09 已完成：

- 17 条 iOS 文件、标签、权限、页面生命周期及原生门面回归。
- 31 条 iOS 音频/DLNA 门面与延迟回执回归。
- 20 条音源引擎回归，包含真实官方 meta/play 产物；默认 npm 门禁运行 19 条。
- 32 条听歌存档回归，包含 iOS 覆盖失败、备份/删除及三端单调时钟。
- 8 个 Swift 文件的语法检查，以及三个完整 UTS → Swift 门面转译。
- HarmonyOS 原生 HAR 和完整未签名 HAP 构建，Android 共享应用编译。
- 44 个本次源码与原生资源同独立验证副本逐字节和 SHA256 核对一致。

全量 `npm run check` 尚未全绿，当前阻塞是已有播放器布局测试中的短屏
footer 尺寸断言（99px 对当前 97px）。响应式、UI 选择及随后各业务/原生门禁
已分别验证；未通过修改播放器页面去消除该断言差异。

检查日志在工作区 `review-output/`，主要为
`ios-harmony-final-ios-check.log`、`ios-source-engine-official-final.log`、
`ios-app-native-transpile-final.log`、`ios-audio-source-check-final.log`、
`ios-source-engine-check-final.log`、`ios-harmony-full-check-final.log`。

本机是 Windows，没有 Apple SDK/Xcode。Swift 语法与 UTS 转译不验证 Apple
API 类型、链接、签名或真机运行。后续须在 Mac 编译完整 iOS 应用，并在
iPhone 和实际接收设备验证本机格式、DSP、授权目录、受保护音源、锁屏/耳机
控制、连续队列、DLNA 网络授权及后台挂起行为。

纯远端 DLNA 的中继与命令可能在 iOS 后台暂停；网络歌曲首次投屏还会等待
完整下载。这两项是当前实现边界。没有创建或发布 IPA，也没有安装到设备。
