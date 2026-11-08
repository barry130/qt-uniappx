# Android 普通 DLNA

原生实现位于 `uni_modules/qt-audio-player/utssdk/app-android/dlna.uts`，独立的
`DlnaSessionPlayer` 接入现有 MediaSession；投屏时本地 ExoPlayer 停止解码。
JS 侧通过 `services/dlna.uts`、`services/audio-player.uts` 和播放器 store 接入。

入口在播放页和 HD 播放栏，设备选择复用 `qt-dlna-sheet`。其他平台暂时隐藏入口。
私有媒体、content URI 和封面转换为会话令牌 HTTP 地址，支持 GET/HEAD 和单段 Range。
当前曲目使用真实远端进度，网络轮询不依赖本地 100ms 进度时钟。

播放意图使用原生原子状态；停止撤销旧媒体代次，暂停在探测后重新核对。
Play/Pause、Seek、音量回执独立校验。冷启动接管保留原进度/暂停状态；
切回本机先确认远端停止，新播放操作取消过期的恢复请求。

Media3 1.11.1 适配使用 `COMMAND_GET_METADATA` 和
`handleSetVolume(volume, volumeOperationType)`，不再使用已弃用的别名/旧签名。
Wi-Fi 锁在 Android 14+ 使用 `WIFI_MODE_FULL_LOW_LATENCY`；Android 13 及以下
保留 `HIGH_PERF`，以免退化旧系统后台/熄屏投屏的网络保活。
弃用诊断只在这个旧系统兼容函数上局部处理，不关闭项目或模块的编译警告。

`npm run check:dlna` 覆盖值处理、Wi-Fi 锁的版本选择/生命周期与 13 个真实控制函数的延迟 I/O 回归。
完整检查和真实 HBuilderX 5.34 Android Vapor/Kotlin 编译已通过；2026-11-08
在当前工作区再次完成调试编译和 Android 资源导出，编译日志无错误或警告。
`node tools/check-native-proxy.mjs` 可核对原生导出与本地生成的代理、JAR、DEX 是否一致。

需要重建自定义基座/APK使新增原生方法和权限生效。真实电视、锁屏、通知栏和蓝牙按键
尚待设备验证。没有引入电视应用、转码、Google Cast 或 AirPlay。
