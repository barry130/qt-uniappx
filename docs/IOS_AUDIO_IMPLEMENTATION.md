# iOS 原生音频与普通 DLNA

实现入口为 `uni_modules/qt-audio-player/utssdk/app-ios/index.uts`。业务仍通过
`services/audio-player.uts` 使用原有播放器接口；平台行为由同目录的 Swift
源文件实现，HBuilderX 打包时编译并链接这些原生资源。音频插件独立最低系统
版本为 iOS 13；整应用因音源引擎和文件模块要求 iOS 14.0。

## 本机播放

`QtIOSAudio.swift` 使用 AVPlayer、AVAudioSession 和 MediaPlayer。原生队列支持
播放、暂停、停止、定位、上一首/下一首、单曲/列表循环、速度和音量。网络条目
保留 `qt-resolve://` 占位地址，加载时调用业务的取链回调。系统媒体会话显示
标题、歌手、专辑、封面、时长、进度和收藏状态；锁屏及耳机命令进入同一条
播放器控制链路。音频中断和输出设备断开也由原生监听。

直接 HTTP/HTTPS 地址使用 AVPlayer 流式播放。需要 Referer 的地址通过
`QtIOSHTTPAudioLoader.swift` 的公开 AVAssetResourceLoader、URLSession API
传输字节范围，不使用私有的 AVURLAsset HTTP header 配置。业务层须在
`audioResolveDone` 之前调用 `audioSetResolveReferer`。

`QtIOSAudioFiles.swift` 和目录选择模块共用书签字典。播放、封面读取和 DLNA
中继读取沙盒外文件时，恢复最长授权目录前缀，刷新失效书签，并将
security-scoped resource 访问保持到实际读取结束。

完整预取文件保存在 `Library/Caches/qt-audio`，带 LRU 索引与用户缓存额度。
缓存键使用原始条目 URI，包含在线音质和指定音源；清除单曲缓存会移除该
mediaId 的所有缓存版本。已经被 AVPlayer 打开的文件延迟至播放释放后删除。
音源策略更新撤销地址记忆和预取回执，保留完整文件及已经加载的音频。
尚未完成的本机取链回执会失效，并在返回或超时后按新策略重新请求。

## 音效能力

`QtIOSAudioDSP.swift` 通过公开 MTAudioProcessingTap 处理实际 PCM 样本。
五段峰值 EQ 的中心频率为 60、230、910、3600、14000 Hz，范围 ±12 dB，
Q=1；增强增益范围为 0–1800 millibel。支持本机 PCM 的 Float32、Float64
和 Int16，以及交错/平面布局。

`audioEffectsSupported()` 表示当前本机管线可安装并处理音效；投屏、tap
安装失败或不支持的样本布局返回 false。系统继续选择实际解码器和输出格式，
`audioSetFloatOutput`、`audioSetPreferSoftwareDecoder` 没有 iOS 实现，对应设置
由业务能力判定禁用；实际 EQ 与音量增强按本机管线能力开放，投屏时禁用。

iOS 不提供应用随意覆盖其他应用窗口的桌面歌词能力，相关权限/显示查询返回
false。Android 的悬浮歌词、蓝牙歌词字段替换和桌面小组件设置不在此音频模块
的 iOS 能力中。

## 普通 DLNA

`QtIOSDLNAProtocol.swift` 负责 Wi-Fi IPv4 上的 SSDP、设备和服务 XML、
SCPD 能力描述及局域网 HTTP 中继；`QtIOSDLNA.swift` 负责 AVTransport、
RenderingControl、队列和会话状态。服务地址按设备描述中的相对 URL 解析，
设备按 UDN 去重。HTTP 中继的地址含会话 token 与曲目 generation，支持
HEAD、GET 和单段 Range，包括 206/416。

连接时复制原生当前曲目、重复出现的位置、暂停意图和进度；本机 AVPlayer
停止并释放解码项。后续系统媒体命令和队列操作由远端控制器处理。
AVTransport 操作串行执行；播放、定位和音量各自持有操作版本。较旧命令的
成功回执仍反映接收端实际发生的状态，随后按最新播放意图补齐控制动作。
暂停不会被旧的 Play 回执撤销。

取链、下载、设备状态和操作回执受 session/generation 保护。远端曲目切换
以设备时长、已经观测到播放和接近曲末的位置共同确认；设备播放了其他
TrackURI 时报告错误。Seek、SetVolume 在设备声明和实际错误的基础上启用或
降级；音量使用设备声明的范围。

返回本机必须得到远端 Stop 成功回执。新的播放、暂停、停止、定位、队列或
设备连接操作会撤销旧的恢复请求；独立音量和音源策略更新不会撤销恢复。
`[A,B,A,C]` 在第 3 项投屏、同步或返回时保持同一次出现，不会落到首个 A。

本地和授权外部目录文件直接中继。网络歌曲先完整暂存到
`Library/Caches/qt-dlna`，验收的完整文件上限为 512 MiB，请求超时配置为
120 秒；完成后才向设备设置 URI。这使 HEAD、字节长度、MIME、Range 与
Referer/重定向保持一致，但首次起播需要等待完整下载。每次退休曲目会清理
该暂存文件；重启控制器也会清理上次进程终止留下的暂存文件。

电视或音箱使用自身 DLNA 播放器。这里没有电视应用、屏幕镜像、定制轻听页面、
滚动歌词、转码或 AirPlay。

## 打包与验证边界

插件 `Info.plist` 声明 `UIBackgroundModes=audio` 和本地网络使用说明。
HTTP 的 ATS 策略由 `qt-app-native` 的主应用配置统一提供；音频模块不再带
会使该策略失效的 `NSAllowsLocalNetworking` 局部字典。

`app-ios/UTS.entitlements` 按 HBuilderX 官方规定的文件名声明
`com.apple.developer.networking.multicast`。实际签名和 provisioning profile
仍须获准该 Apple entitlement；单独加入文件不能赋予签名权限。

2026-11-09 在 Windows 上完成了以下验证：

- `tools/check-ios-audio.mjs`：31 条生产 UTS 门面回归，使用可控制的原生回执
  验证重复歌曲位置、投屏/本机交接、Stop 失败、过期恢复、独立音量、解析和
  能力传递。
- 六个 Swift 文件通过 tree-sitter Swift 语法检查。
- HBuilderX 5.34 的 UTS 编译器完成整个入口的 UTS → Swift 转译。
- 修改涉及的已跟踪文件通过 `git diff --check`。

回归命令：

```powershell
& 'E:\HBuilderX\plugins\node18\node.exe' tools\check-ios-audio.mjs
```

本机没有 Xcode 或 iOS SDK。以上语法、转译和模拟回执验证没有进行 Apple
SDK 类型检查，也不代表 iOS 原生编译、签名或真机播放成功。交付前仍需在
具备签名权限的 Mac/iPhone 环境验证本机解码、音效、受保护音源、目录书签、
锁屏与耳机控制，以及实际 DLNA 设备的发现、音频格式、定位、音量和连续队列。

本机后台音频走实际 AVPlayer/AVAudioSession。纯远端 DLNA 控制没有本机音频
持续播放，iOS 可能挂起其后台网络和状态轮询；此实现不通过播放静音音频延长
远端会话。持续后台远端控制能力必须以真机观测结果为准。
