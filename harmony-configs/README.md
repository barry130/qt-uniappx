# harmony-configs —— 鸿蒙工程覆盖层

HBuilderX 编译鸿蒙时的真实流程（读 `HarmonyLauncher.js` 的 `run()` 得到）：

1. `prepareHarmonyProjectPath()`：把内置模板工程解压到 `unpackage/dist/dev/app-harmony/`，
   紧接着**把本目录的文件逐个覆盖（复制）到工程同名路径上**；
2. `assembleCompileOutput()`：拷贝各 uts 插件的 `utssdk/app-harmony` 产物到工程的
   `uni_modules/` 下，并合并 `oh-package.json5` / `build-profile.json5`；
3. `assembleCompiledManifest()`：按 manifest.json 注入 bundleName / 版本 / 图标 /
   app_name / ability metadata；
4. 最后由 DevEco/hvigor 构建 `.hap`。

**注意覆盖层是第 1 步、manifest 注入是第 3 步**（`run()` 里 `prepareHarmonyProjectPath`
在 `assembleCompiledManifest` 之前），所以 manifest 注入的字段会**覆盖**覆盖层里同名的值。
`assembleCompiledManifest()` 会往 `module.json5` 写 `module.deviceTypes`（来自
`app-harmony.distribute.deviceTypes`）并在有改动时追加 `module.metadata`；本项目配了
`deviceTypes`，所以这个文件**每次都会被重写**——它保留覆盖层的 `backgroundModes` /
`requestPermissions`，只是被注入 `deviceTypes` 与末尾的 `"metadata": []`。
详见下一节。

另有一条硬约束：覆盖层里**不能**覆盖 `entry/src/main/ets/entryability/EntryAbility.ets`
等 4 个文件——它们在 `HARMONY_TEMPLATE_RESERVED_FILES` 里被标为 `false`（跳过），
写进来也会被忽略。

也就是说本目录是「覆盖层」，同名文件以本目录为准。源码依据见
`E:\HBuilderX\plugins\launcher\out\export\HarmonyLauncher.js`（`harmonyConfigsPath` +
`copyDirectoryEx(...)` + `HARMONY_TEMPLATE_RESERVED_FILES`）。若本目录不存在，
HBuilderX 会用纯模板工程编译。

## 为什么必须有 `AppScope/app.json5`

模板里的 `vendor` 是占位值 `"example"`，而 `assembleCompiledManifest()` **只写
`bundleName` / `versionName` / `versionCode`**，从不写 `vendor`（在打包后的
`main.js` 里搜 `vendor` 只有无关的 `vendorId` 事件名，零处写 app.json5 的 vendor）。
不覆盖的话上架审核会看到 `vendor: example`，所以这里放一份覆盖版，并顺带把
`bundleName`/版本写成与 manifest 一致（这两个随后会被注入覆盖成同样的值，不冲突）。

**vendor 已去隐私化（2026-10-25）**：仓库里只留品牌名 `轻听`；真实开发者主体名只存在
本地 gitignored 的发行证书里（`.harmony-csr/轻听.cer` 的 subject `O=` 字段，与华为
开发者账号主体一致）。**正式上架构建前**把 vendor 临时改回证书主体名（本地查看：
`keytool -printcert -file .harmony-csr/轻听.cer | grep O=`），构建完成后再改回 `轻听`，
不要把主体名提交入库。

## 图标与启动图（manifest 注入，不放在覆盖层）

`app-harmony.distribute.icons` / `splashScreens` 由 `assembleCompiledManifest()` 直接
拷进 `AppScope/resources/base/media/`，所以**源文件放 `static/icon/harmony/`、在
manifest 里引用**，不要放本目录（会被打包产物覆盖，且不是覆盖层该管的事）：

| manifest 键 | 目标文件 | 尺寸 |
| --- | --- | --- |
| `icons.background` | `media/background.png` | 288×288 RGB，**满铺不透明**（系统自己套遮罩，自带圆角会露白边） |
| `icons.foreground` | `media/foreground.png` | 288×288 RGBA，图形留安全区 |
| `splashScreens.startWindowIcon` | `media/startIcon.png` | 144×144 RGBA |
| `splashScreens.startWindowBackground` | 改写 `element/color.json` 的 `start_window_background` | 色值字符串 |

模板自带的 `foreground.png` 是 72×72、`startIcon.png` 是 **1×1 占位图**，必须替换。
生成脚本：`tools/gen-harmony-icon.py`（母版 `tools/brand-glyph-master.png`，
底色纯黑，与 `static/icon/*.png` 桌面图标一致）。改完重新生成即可，不用手改 PNG。

## 为什么必须有 `entry/src/main/module.json5`

鸿蒙的后台音频（长时任务）必须在**应用入口 ability** 上声明 `backgroundModes: ["audioPlayback"]`，
而应用入口 ability 属于 `entry` 模块——uts 插件自己是一个 har 模块（`type: "har"`），
har 里没有 ability，因此这条声明**没法在插件内配置**，只能靠本覆盖文件加。

同时权限也在这里声明。**两处都写是刻意的冗余**：插件 `utssdk/app-harmony/module.json5`
声明后权限在整个应用生效（官方文档《如何通过 uts 插件配置鸿蒙权限》明确说子模块申请的权限
无需在主项目重复），而 `backgroundModes` 只能写在 entry 模块的 ability 上，没法放进插件，
所以这个覆盖文件必须存在。

当前共声明 9 条权限（清单见 `entry/src/main/module.json5` 的 `requestPermissions`）：

| 权限 | 授权方式 | 用途 |
| --- | --- | --- |
| `ohos.permission.INTERNET` | system_grant | 在线音频流与封面下载 |
| `ohos.permission.KEEP_BACKGROUND_RUNNING` | system_grant | 启动 AUDIO_PLAYBACK 长时任务（退到后台继续播）的前置条件 |
| `ohos.permission.GET_NETWORK_INFO` | system_grant | 网络状态判断（在线/离线音源切换） |
| `ohos.permission.RUNNING_LOCK` | system_grant | 申请运行锁，长时任务期间防休眠 |
| `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | **user_grant** | 读取/写入下载目录（本地导入导出） |
| `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY` | **user_grant** | 读取/写入文档目录（歌词、备份文件） |
| `ohos.permission.MODIFY_AUDIO_SETTINGS` | system_grant | 音频设置（音量/输出设备） |
| `ohos.permission.ACCESS_CAR_AUDIO` | system_grant | 车机音频（`deviceTypes: ["car"]`，手机上是「系统版本不适用」） |
| `ohos.permission.FILE_ACCESS_PERSIST` | system_grant | 文件访问持久化（重启后保留授权） |

**只有两条 `READ_WRITE_*_DIRECTORY` 是 user_grant**，所以只有它们需要 `reason` 字符串资源
与 `usedScene`；其余 7 条安装即授予。正因如此**需要**
`entry/src/main/resources/{base,zh_CN,en_US}/element/string.json`（内含 `reason_*` 键），
三个目录各一份，缺一个都会在构建期报字符串资源找不到。

> 悬浮窗权限（`ohos.permission.SYSTEM_FLOAT_WINDOW`）**不在列表里**：它的
> `availableLevel` 是 `system_basic`，普通应用申请也拿不到，写进去只会让权限页显示
> 「无法确定」。鸿蒙的桌面歌词由系统绘制，走 AVSession，本来就不需要悬浮窗权限。

`backgroundModes: ["audioPlayback"]` 的枚举值已对着本机 DevEco 模块 schema 核对过：
`hbuilderx-language-services/jsservice/src/schemas/devEco/sdk/default/hms/toolchains/modulecheck/module.json`
里 `backgroundModes.items.enum` 含 `audioPlayback`（驼峰，不是 `AUDIO_PLAYBACK`）。
该 schema 的 description 写的是「dedicated to the abilities using the Service template」，
而模板工程的 `EntryAbility` 是 UIAbility —— 鸿蒙官方《长时任务》文档要求的就是在
UIAbility 上声明，这里按官方文档走；**首次构建后请在 DevEco 里确认没有配置校验告警**。

## ⚠️ 首次构建后已核对（2026-10 修订）

本文件是在**没有鸿蒙工具链**的机器上按内置模板手写的，现在已在真机 DevEco 环境里
跑通并核对过产物 `unpackage/dist/dev/app-harmony/entry/src/main/module.json5`，确认
最终产物 = 本覆盖文件 + 注入的 `deviceTypes` + 末尾 `"metadata": []`，
`backgroundModes` 与 `requestPermissions` 都完整保留。

> 修正旧文档的两处错误结论（当时没读全源码）：
>
> 1. 模板 zip 不是 `project-x.zip`。uni-app x **vapor** 模式实际用的是
>    `plugins/launcher-harmony/base/project-dom2-dyn.zip`（23.7 MB；`project-x.zip`
>    只给非 vapor 用）。两者的 `entry/src/main/module.json5` 都只有 `phone`，
>    且 `requestPermissions` 只声明 `INTERNET`。
> 2. `deviceTypes` **是会**被注入的，不是"搜索不到、只有手写才有"。
>    `assembleCompiledManifest()` 里 `manifest["app-harmony"].distribute.deviceTypes`
>    长度 > 0 时执行 `ce.module.deviceTypes = Se` 并写回文件。本项目配了
>    `["phone","car","tablet"]`，所以这一项由 manifest 决定，覆盖层里**不用管**。

因此当前写法是安全的。**但升级 HBuilderX 后模板可能变化**，届时按下面核对：

1. 把本文件临时改名为 `module.json5.bak`，跑一次「运行到鸿蒙」；
2. 打开 `unpackage/dist/dev/app-harmony/entry/src/main/module.json5`，这是 HBuilderX 的完整产物；
3. 与备份比对，若模板有新增字段，把它们并进本文件，然后**只额外保留两处**：
   - `abilities[0]` 里的 `"backgroundModes": ["audioPlayback"]`；
   - `requestPermissions` 里的 `ohos.permission.KEEP_BACKGROUND_RUNNING`。
4. 再跑一次构建，确认 `.hap` 正常产出。

## 编译前置条件（本机已安装）

- **DevEco Studio**（含 HarmonyOS SDK、hvigor、ohpm、hdc）；本机装的是
  `F:\DevEco Studio\build.txt` = `DS-261.23567.138.36.2600851`，SDK 在
  `F:\DevEco Studio\sdk\default\openharmony`（`compatibleSdkVersion 6.0.0(20)` 可用）。
  HBuilderX 的鸿蒙运行/发行依赖本机 DevEco，鸿蒙**没有云打包**，必须本机构建 `.hap`。
- 在 HBuilderX「设置 → 运行配置 → 鸿蒙运行配置」里指定 DevEco 安装路径。
- 真机需要一次签名：DevEco 里登录华为开发者账号 → 自动生成调试证书，
  或在 HBuilderX 鸿蒙发行配置里配置签名证书；随后 `hdc` 连接设备。
  本项目的发行签名材料放在 `.harmony-csr/`（`quietMusic.p12` 含**私钥**），
  已在 `manifest.json` 的 `app-harmony.distribute.signingConfigs.release` 里配好，
  并且已被 `.gitignore` 排除——**不要把它提交到仓库**。
- 注意事项：Windows 下 hvigor 会给原生库输出目录追加哈希，路径总长上限 255 字符——
  工程路径与 `uni_modules` 目录名都要短（本项目路径 `F:\qtMusic\qt-uniappx` 没问题）。

## 鸿蒙端能力现状（第二轮）

自研播放器见 `uni_modules/qt-audio-player/utssdk/app-harmony/index.uts`，已实现
播放内核 + 后台保活 + 系统播控（锁屏/控制中心/蓝牙媒体键）+ 完整事件回调 + 队列无损同步 +
`qt-resolve://` 懒解析 + 封面元数据 + 桌面歌词（系统渲染）。**平台差异导致的降级**
（均为平台能力缺失，非实现缺陷）：

- **倍速只有五档**：AVPlayer 只支持 0.75/1.00/1.25/1.75/2.00，连续的 0.5–3.0 会被吸附到最近档位。
- **均衡器（EQ）无效**：鸿蒙没有应用可用的系统级音频效果器（安卓用 `android.media.audiofx.Equalizer`）。
- **桌面歌词由系统绘制**：走 AVSession（`enableDesktopLyric` / `setDesktopLyricVisible` /
  `AVMetadata.lyric` / `singleLyricText`），**不需要悬浮窗权限**——与安卓端「应用自绘悬浮窗」
  是两条完全不同的实现路径。代价是样式（字号/颜色/字体/宽度/描边/阴影/对齐/背景）由系统主题
  决定，应用侧无法调整，故桌面歌词设置页在鸿蒙上只保留开关与锁定，其余分组隐藏而不是假装生效。
- **无音频磁盘缓存**：AVPlayer 没有 media3 那样的可插拔 `CacheDataSource`；`audioClearCache()` 恒返回 false。
- **本地解码格式**：系统媒体栈不支持 flac/ape/wma/mp4（ogg 已支持），需要后续引入第三方 `.har` 解码器。