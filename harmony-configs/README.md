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
在 `assembleCompiledManifest` 之前）。就本项目而言没有影响：`assembleCompiledManifest`
只在 manifest 配了 `uni-map`/`uni-push`/`uni-verify` 模块时才会重写 `module.json5`
（用来注入 `metadata`），本项目一个都没配，所以本覆盖文件不会被盖掉。**一旦以后配了
这三个模块之一，就要按下一节的办法重新生成。**

另有一条硬约束：覆盖层里**不能**覆盖 `entry/src/main/ets/entryability/EntryAbility.ets`
等 4 个文件——它们在 `HARMONY_TEMPLATE_RESERVED_FILES` 里被标为 `false`（跳过），
写进来也会被忽略。

也就是说本目录是「覆盖层」，同名文件以本目录为准。源码依据见
`E:\HBuilderX\plugins\launcher\out\export\HarmonyLauncher.js`（`harmonyConfigsPath` +
`copyDirectoryEx(...)` + `HARMONY_TEMPLATE_RESERVED_FILES`）。若本目录不存在，
HBuilderX 会用纯模板工程编译。

## 为什么必须有 `entry/src/main/module.json5`

鸿蒙的后台音频（长时任务）必须在**应用入口 ability** 上声明 `backgroundModes: ["audioPlayback"]`，
而应用入口 ability 属于 `entry` 模块——uts 插件自己是一个 har 模块（`type: "har"`），
har 里没有 ability，因此这条声明**没法在插件内配置**，只能靠本覆盖文件加。

同时权限也在这里声明。**两处都写是刻意的冗余**：插件 `utssdk/app-harmony/module.json5`
声明后权限在整个应用生效（官方文档《如何通过 uts 插件配置鸿蒙权限》明确说子模块申请的权限
无需在主项目重复），而 `backgroundModes` 只能写在 entry 模块的 ability 上，没法放进插件，
所以这个覆盖文件必须存在。

| 权限 | 授权方式 | 用途 |
| --- | --- | --- |
| `ohos.permission.KEEP_BACKGROUND_RUNNING` | system_grant | 启动 AUDIO_PLAYBACK 长时任务（退到后台继续播）的前置条件 |
| `ohos.permission.INTERNET` | system_grant | 在线音频流与封面下载 |

两者都是 system_grant（安装即授予），不需要 `reason` 字符串资源，也不需要用户手动授权。
因此**不需要** `utssdk/app-harmony/resources/base/element/string.json`。

`backgroundModes: ["audioPlayback"]` 的枚举值已对着本机 DevEco 模块 schema 核对过：
`hbuilderx-language-services/jsservice/src/schemas/devEco/sdk/default/hms/toolchains/modulecheck/module.json`
里 `backgroundModes.items.enum` 含 `audioPlayback`（驼峰，不是 `AUDIO_PLAYBACK`）。
该 schema 的 description 写的是「dedicated to the abilities using the Service template」，
而模板工程的 `EntryAbility` 是 UIAbility —— 鸿蒙官方《长时任务》文档要求的就是在
UIAbility 上声明，这里按官方文档走；**首次构建后请在 DevEco 里确认没有配置校验告警**。

## ⚠️ 首次构建后请核对本文件

本文件是在**没有鸿蒙工具链**的机器上按内置模板（`plugins/launcher-harmony/base/project-x.zip`
的 `entry/src/main/module.json5`）手写的。已逐行比对过模板，本文件 = 模板 + 三处改动
（`backgroundModes`、两个权限、以及补回模板本来就有但我拆行后位置变化的逗号）。

关于「manifest 会不会注入别的字段把本文件盖掉」——已读源码确认**不会**：

- `assembleCompiledManifest()` 对 `entry/src/main/module.json5` 的**唯一**写操作是
  「配了 `app-harmony.distribute.modules` 里的 `uni-map`/`uni-push`/`uni-verify` 时注入
  `module.metadata`」。本项目这三个模块一个都没配，所以该函数完全不碰这个文件。
- `deviceTypes`、`querySchemes` 等字段在 `HarmonyLauncher.js` 里**全文搜索不到**，
  即 HBuilderX 根本不会往 `module.json5` 注入它们（示例工程里的那些值是人家手写的）。
- 覆盖发生在 `prepareHarmonyProjectPath()`，是 `run()` 的第一步，早于 manifest 注入。

因此当前写法是安全的。**但升级 HBuilderX 后模板可能变化**，届时按下面核对：

1. 把本文件临时改名为 `module.json5.bak`，跑一次「运行到鸿蒙」；
2. 打开 `unpackage/dist/dev/app-harmony/entry/src/main/module.json5`，这是 HBuilderX 的完整产物；
3. 与备份比对，若模板有新增字段，把它们并进本文件，然后**只额外保留两处**：
   - `abilities[0]` 里的 `"backgroundModes": ["audioPlayback"]`；
   - `requestPermissions` 里的 `ohos.permission.KEEP_BACKGROUND_RUNNING`。
4. 再跑一次构建，确认 `.hap` 正常产出。

## 编译前置条件（本机尚未安装）

- **DevEco Studio 5.0.7.210 及以上**（含 HarmonyOS SDK、hvigor、ohpm、hdc）；
  HBuilderX 的鸿蒙运行/发行依赖本机 DevEco，鸿蒙**没有云打包**，必须本机构建 `.hap`。
- 在 HBuilderX「设置 → 运行配置 → 鸿蒙运行配置」里指定 DevEco 安装路径。
- 真机需要一次签名：DevEco 里登录华为开发者账号 → 自动生成调试证书，
  或在 HBuilderX 鸿蒙发行配置里配置签名证书；随后 `hdc` 连接设备。
- 注意事项：Windows 下 hvigor 会给原生库输出目录追加哈希，路径总长上限 255 字符——
  工程路径与 `uni_modules` 目录名都要短（本项目路径 `F:\qtMusic\qt-uniappx` 没问题）。

## 鸿蒙端能力现状（第一轮）

自研播放器见 `uni_modules/qt-audio-player/utssdk/app-harmony/index.uts`，已实现
播放内核 + 后台保活 + 系统播控（锁屏/控制中心/蓝牙媒体键）+ 完整事件回调 + 队列无损同步 +
`qt-resolve://` 懒解析 + 封面元数据。**平台差异导致的降级**（均为平台能力缺失，非实现缺陷）：

- **倍速只有五档**：AVPlayer 只支持 0.75/1.00/1.25/1.75/2.00，连续的 0.5–3.0 会被吸附到最近档位。
- **均衡器（EQ）无效**：鸿蒙没有应用可用的系统级音频效果器（安卓用 `android.media.audiofx.Equalizer`）。
- **桌面歌词不可用**：鸿蒙的悬浮窗权限只对系统应用开放，普通应用无法跨应用绘制。
- **无音频磁盘缓存**：AVPlayer 没有 media3 那样的可插拔 `CacheDataSource`；`audioClearCache()` 恒返回 false。
- **本地解码格式**：系统媒体栈不支持 flac/ape/wma/mp4（ogg 已支持），需要后续引入第三方 `.har` 解码器。