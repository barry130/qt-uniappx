# 轻听音乐

本地音乐播放器（在线聚合为可选增强，支持多家音源平台）。基于 UniAppX 构建，一套代码可运行于 Android 与 iOS。

用音乐连接每一刻。

> **软件定位是本地音乐播放器**：完整支持本地音乐扫描 / 播放 / 歌词 / 桌面歌词 / 收藏同步，开箱即用、不依赖任何在线音源。
> 在线能力拆成两层，仓库里**只内置低风险的数据层**：
> - **数据包（meta-bundle.js，内置）**：搜索、歌单、歌词、封面等元数据入口，官方单一版本，随客户端分发；
> - **播放包（play-bundle.js，不内置）**：在线取链（播放地址解析）风险较高，由用户自行安装——可同时安装多份（官方 + 自定义直链），在设置页选择其一启用。
> 未安装播放包时在线播放不可用（本地音乐与在线搜索不受影响），仓库因此是纯客户端 + 自有元数据代码，可公开发布而不涉及第三方平台取链实现的分发问题。

## 功能特性

### 🎵 多平台聚合
- 聚合多家音乐平台（搜索 / 歌单等元数据走内置数据包；在线播放需再安装播放音源包）
- 各平台歌单广场、热门歌单、每日推荐一键切换
- 同歌多源：播放时可切换音源，当前源取链失败时自动聚合其他源匹配同一首歌；优先选择可用的高音质来源
- 排行榜、新歌速递、热门搜索词全覆盖
- 收藏歌单 / 歌单分享链接导入（粘贴链接、选平台解析）

### 🔌 播放音源包（play-bundle.js，不内置、可多包并存）
- 在线取链逻辑独立成「播放包」，由安卓端本地引擎（系统 WebView V8）执行；与 PC 端共用同一份产物，接口失效不发版即可修复。搜索 / 歌词 / 封面等元数据入口在**内置数据包**（meta-bundle.js，官方单版本）里，不随播放包变动
- 播放包两个来源：服务端清单（official，可检查更新 / 自动更新）与用户粘贴的 https 直链（custom，不自动更新）；**多包并存，设置页「音源包管理」选择其一启用**，切换即时热装载并做取链冒烟自检
- 官方包冒烟自检失败自动移除并拉黑该版本（服务端要求回退同理）；启动预热 + 4h 节流静默检查（仅对已装官方包的设备）
- 首页在未安装播放包时显示安装引导；在线播放取链时若无生效包，弹窗引导去设置安装

### ▶️ 播放与歌词
- 原生后台播放（media3 播放内核），锁屏 / 后台持续播放
- 唱片机动画 + 滚动歌词，支持歌词翻译、字号调节、全屏歌词、**歌词偏移校正**（全局默认 ±10s + 按曲目覆盖）
- **播放条自定义**：播放页工具按钮可开关，最多展示 5 个（关闭的按钮不再显示）
- **五段均衡器**：60Hz / 230Hz / 910Hz / 3.6kHz / 14kHz 五段调节 + 预设（media3 等化器）
- **桌面歌词**（Android）：系统悬浮窗歌词，跟随播放逐行更新、可拖动、可锁定（锁定后点击穿透不影响操作）；字号 / 颜色 / 字体可选并即时生效；开关为运行期状态，每次启动默认关闭。首次开启需授予「悬浮窗 / 显示在其他应用上层」权限——授权页按「厂商私有权限页 → AOSP 页 → 应用详情页」逐级降级（vivo / iQOO 的开关在 i管家 → 权限管理 → 悬浮窗），从设置页返回后已授权则自动开启
- **屏蔽规则**（不喜欢）：按歌手 / 关键词拆词匹配屏蔽（算法层与 PC 端共用同一份向量表，两端行为对齐由 `npm run check:dislike` 校验），规则统一在独立页管理
- **分享卡片**：歌曲卡片 / 歌词卡片两种模式截图导出
- **听歌年度报告**：累计播放 / 收藏 / 听过 / 活跃天数总览，最爱歌手与最爱歌曲排行

### 💾 本地与下载
- 歌曲下载到本地离线播放，下载进度实时显示
- 下载音质可选，支持后台持续下载
- 本地音乐库与最近播放集中管理
- 本地音乐右上角 ⋮ → 删除设置：弹窗二选一「仅从列表移除，保留文件 / 删除时同时删除本地文件」（持久化，默认仅移除，当前项带 ✓）。开启后单曲移除 / 批量删除会尽力删除手机上的源文件：Android 端 `qt-app-native.deleteLocalMedia` 优先按 content URI 删 MediaStore 条目（应用自有的文件会连磁盘一起删），再按绝对路径 `File.delete()` 兜底；**第三方公共媒体受分区存储限制（`ContentResolver.delete` 抛 `RecoverableSecurityException`）无法直接删，需 `MANAGE_EXTERNAL_STORAGE`「所有文件访问」权限**——未授权时界面会引导去系统设置开启「所有文件访问」，开启后即可删除。改 `qt-app-native` 需自定义/云端重新打包

### ❤️ 收藏与同步
- 收藏歌曲、收藏歌单、自建歌单，本地即时生效；收藏「同名不同源」自动查重提示（收藏表按平台+ID 唯一，同一首歌不同源是两条记录，收藏前由用户决定）
- 登录账号后自动与服务器同步收藏，多设备不丢失；断网收藏自动暂存、联网补推
- 推送前自动兜底：歌单缺 pid 生成补上并写回本地，歌曲缺封面自动查询图片地址再上传
- 每次启动与服务器做存在性对账：服务器缺失的收藏（整库重建、部分删数据）自动补推恢复
- 详细设计见 [docs/LIKE_SYNC_DESIGN.md](docs/LIKE_SYNC_DESIGN.md)

### 👤 账号体系
- 邮箱 / 用户名登录：账号栏仅允许英文字母、数字及邮箱所需 `@`、`.`，密码支持明文切换
- 注册：用户名、邮箱均必填，密码 + 确认密码前端校验（6-18 位、两次一致）
- 登录后自动同步收藏，Token 自动刷新，登录状态长期保持，免反复登录
- 邮箱验证码找回密码（忘记密码）：6 位验证码、10 分钟有效、发送 60s 倒计时
- 编辑个人资料：昵称 / 邮箱 / 可选修改密码，保存后强制退出重新登录
- 个人中心头像统一显示默认用户图标，不再使用用户上传的头像（也不再支持上传/更换）
- 个人中心：资料展示、签到（连续天数 / 积分）、退出登录

### 📢 应用服务
- 启动自动检查更新，弹窗提示新版本
- 正式版 / 测试版双渠道发布，直链下载自动安装或跳转浏览器
- 启动校验官方版本：非官方版本提示后 3 秒自动退出
- **首屏守卫**：启动探针检测首页卡死（白屏）自动 reLaunch 兜底
- 应用公告、意见反馈、关于页；官网地址统一由 `services/official-site.ts` 单一来源管理（用户协议 / 隐私政策 / 意见反馈 / 音源设置教程等链接全部指向官网，不硬编码）
- 权限管理页：集中查看与申请系统权限（存储 / 悬浮窗 / 电池优化等授权状态）

### 📣 公告与通知
- 开屏弹窗：富文本内容、置顶优先、今日不显示、可关闭 / 不可关闭（退出 APP）、点击跳转
- 首页通告栏：无缝跑马灯滚动、会话内关闭
- 消息中心：置顶标识、已读 / 未读红点、富文本详情、未读角标
- 富文本同步渲染（QtRichText），避免原生 rich-text 异步导致的「标题先出、内容后到」闪现

## 技术栈

- **框架**：UniAppX（Vue3 组合式 API、UVue 页面、UTS 服务、Vapor 模式）
- **状态管理**：Pinia（播放器、下载、主题等全局状态）
- **网络**：统一请求封装，支持 Token 自动刷新、请求队列重试；API 地址由 `services/config.ts` 按 dev / prod 提供；JSON.parse 响应用 parseJsonToUtso 转为 UTSJSONObject（uni-app x JS 运行时 JSON.parse 返回普通对象，无 .get 方法）
- **图标**：自绘 SVG 图标体系，全局统一风格，位于 `uni_modules/qt-ui/services/icons.ts`；桌面图标与启动图见下文「图标与启动图」
- **原生能力**：UTS 原生插件（uni_modules/qt-app-native：系统浏览器、退出应用、APK 安装、公共媒体库写入 / 扫描 / 删除、文件选择、权限查询与跳转；qt-audio-player：media3 播放内核、音频缓存清理、倍速、音量、五段均衡器、媒体通知；qt-js-engine：WebView V8 引擎本地执行音源包；qt-stat：匿名使用统计采集上报）

## 图标与启动图

- **应用内图标**：`uni_modules/qt-ui/services/icons.ts` 自绘 SVG，全局统一风格（24 视图框 / 2px 描边 / 圆角端点）；`npm run check` 会校验图标定义与引用一一对应——**定义了却没人引用的图标会判失败**，所以删掉最后一个引用时要同时删掉定义。品牌 Logo 不走图标体系：`logo` 图标已删除，关于页 / 忘记密码 / 侧边栏（含矮窗紧凑档）/ 升级弹窗一律直接用真图 `/static/icon/xxxhdpi.png`（与登录页同一做法），不再保留任何手绘近似图形。
- **品牌 Logo（定稿）**：AI 出图的「黑色圆角方块 + 白色 Q+尾巴波浪」。源图 `tools/qt-logo-src.png`（2048×2048；右下角「豆包AI生成」水印在黑 tile 包围盒之外，按暗色包围盒裁剪即被排除）。`tools/gen-app-logo.py` 的 `build_brand_masters()` 从源图提取两张母版（均在 `tools/` 下、不进包）：`brand-tile-master.png`（完整图标，圆角半径从源图暗蒙版逐行扫描拟合）与 `brand-glyph-master.png`（白色图形本体，给 Android 12 启动 Logo 用）。
- **桌面图标**：`static/icon/{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}.png`，在 `manifest.json` 的 `app-android.distribute.icons` 里配置；由 `python tools/gen-app-logo.py --apply brand --launcher` 用 tile 母版整体缩放生成（保真 AI 原设计的圆角比例与留白；xxxhdpi.png 同时是 iOS appstore 图标）。
- **通知栏小图标**：使用专用的 `ic_qt_notification_glyph.png` 单色透明图标；由 `python tools/gen-app-logo.py --apply brand --notif` 从当前 `static/icon` 品牌 Logo 提取图形并生成 Android 各密度资源。`QtAudioService.onCreate` 用 `DefaultMediaNotificationProvider`（media3 标准媒体通知模板）+ `provider.setSmallIcon(...)` 显式指定该资源，避免 Media3 默认 small icon 继续显示旧图标。
  - **通知按钮**（上一首/播放暂停/下一首 + 桌面歌词）由 media3 生成：前三键来自 `DefaultMediaNotificationProvider.getMediaButtons`（按播放器可用命令 + media3 内置图标常量，不依赖应用资源），桌面歌词按钮来自会话的 `mediaButtonPreferences`（`SLOT_OVERFLOW`）。**不要自绘 RemoteViews 通知布局**——Android 13 起系统媒体卡片由 SystemUI 按 MediaSession 的 PlaybackState 自己渲染，自绘布局拿不到卡片上的按钮位（真机表现：四个按钮全不见）。`onConnect` 里必须显式 `setAvailablePlayerCommands(DEFAULT_PLAYER_COMMANDS)`：1.11 对「不受信任控制器」默认只给只读命令，平台侧 PlaybackState 因此缺 `ACTION_SKIP_TO_NEXT`/`ACTION_PLAY_PAUSE` 位，卡片会「有标题封面、没按钮」。自定义 `CommandButton` 的 `iconResId` 必须非 0，否则 `MediaSessionLegacyStub.createPlaybackStateCompat` 抛 `You must specify an icon resource id to build a CustomAction` 并让整条 PlaybackState 构建失败。
- **启动图**：`static/icon/qt-start.9.png` 九宫格图（1080×1920，PNG8 调色板编码），由 `tools/gen-start-9png.py` 从母版 `tools/splash-master.9.png` 生成；母版只作中间件、不进安装包。母版里的 logo 已换成品牌 tile：`tools/swap-splash-logo.py` 先备份旧母版为 `splash-master-old.9.png`，再用局部自适应阈值擦掉旧白色 logo（含散落音符）、扩散修补成平滑渐变、贴上品牌 tile（440×440），y>1470 的「轻听」标题与标语文字不动。**只配 xxhdpi 一桶**：低密度屏由系统缩小、高密度屏放大 1.33 倍，柔和渐变上看不出差别，而每多一桶就多约 2.2MB（启动图在安装包里存两份：`www/static` 一份 + 原生 `res` 一份）。要加密度见脚本头部说明。
- **启动图的生效范围**：只在「会显示启动图」的设备上生效——Android 12 以下，以及 Android 12+ 中关闭了系统 SplashScreen 的 Rom（官方文档称国内 Rom 大多关闭、海外 Rom 大多支持）。所以它不能删，但桶数只影响这条路径。
- **Android 12+ 启动界面**：Android 12 起系统强制使用 SplashScreen，**只认「背景色 + 居中 Logo + 底部品牌图」，不会显示全屏启动图**（不配置就是白底 + 应用图标，见 uni-app x 文档 `collocation/manifest-android.md`）。所以 `manifest.json` 里另配了 `splashScreens.background`（深绿 `#0e2418`，与白色图形强对比、暗色模式 `#15171d` 同样成立）与 `splashScreens.android12.icon`；Logo 用品牌**图形本体**（整个 tile 会被系统裁进 192 dp 圆、切掉圆角，所以只放图形），由 `python tools/gen-app-logo.py --apply brand` 写 `static/icon/qt-splash12-{xhdpi,xxhdpi,xxxhdpi}.png`（按蒙版实际像素到圆心的最大距离缩放，保证内容落在直径 192 dp 的圆内）。几何候选（声波条 / 耳机 / 音符 / Q 波浪 / 圆环声波）保留在 `gen-app-logo.py` 里作备选；已弃用的旧路径 `tools/extract-splash-logo.py` + `tools/gen-splash12-icon.py` 也保留。改动这些后必须**云端打包**才生效。

## 运行

1. 使用 HBuilderX（推荐 5.x 或更高版本）打开本目录
2. 确认 `manifest.json` 已启用相应配置
3. 运行到 Android 或 iOS 真机 / 模拟器

> **Android 版本要求**：最低 **Android 8.0（API 26）**，目标 **Android 14（API 34）**，且仅支持 **`arm64-v8a`** 架构（32 位设备无法安装）。对应 `manifest.json` 中的 `minSdkVersion` / `targetSdkVersion` / `abiFilters`。

首次运行前，可在终端执行 `npm install` 安装 Pinia 等依赖。

> ⚠️ 本项目含多个 UTS 原生插件（播放内核、悬浮窗歌词、音源包引擎等），**必须使用自定义基座或云端打包**运行；
> HBuilderX 标准基座不含这些插件，会出现「找不到悬浮窗授权入口」这类假故障。改动 UTS 后需重新编译插件并重建基座。

## 环境配置（API 基地址）

API 基地址在 `services/config.ts` 中按 dev / prod 分离管理：

- `API_BASE_URL_DEV`：开发环境地址（可提交到仓库）。
- `USE_DEV`：环境开关，`true` 用开发地址，`false` 用生产地址（发布生产前改成 `false`）。
- `API_BASE_URL`：实际生效的地址，`services/http.ts` 从这里取值，个人中心等页面同样引用。

生产地址存放在**不提交**的 `services/config.local.ts`（已加入 `.gitignore`，不会上传 GitHub）。发布生产前，把 `USE_DEV` 设为 `false`、并在 `config.local.ts` 填入真实生产地址即可。

> 首次克隆项目时，请将 `services/config.local.example.ts` 复制为 `services/config.local.ts`，再填入你的真实生产地址。

## 目录结构

```
├── uni_modules/qt-ui/  # 全部 Qt UI 组件（基础组件、业务组件、宽屏组件）
├── pages/             # 34 个页面（发现、搜索、音乐库、播放、均衡器、屏蔽规则、分享卡片、年度报告、歌单导入、权限管理、消息中心等）
├── services/          # 服务层（网络、播放器、桌面歌词、音源包与引擎、换源、收藏查重、歌手真实 ID、升级、公告、收藏同步、Token、官网链接等）
├── stores/            # Pinia 全局状态（播放、屏蔽规则、歌词偏移、播放条、分享卡片、数据包注册等 11 个）
├── static/            # 静态资源（tab 图标等；不含音源包）
├── styles/            # 全局样式
├── types/             # 类型定义
├── docs/              # 设计文档（LIKE_SYNC_DESIGN.md / USER_GUIDE.md 用户指南）
├── uni_modules/       # UTS 原生插件（qt-app-native / qt-audio-player / qt-js-engine / qt-stat / qt-ui）
└── manifest.json      # 应用配置
```

## 说明

- 本项目为个人开发作品，定位**本地音乐播放器**（在线聚合为可选增强），仓库只含客户端代码
- 仓库内置自有的元数据入口（数据包）；在线**取链**实现（播放包）不在本仓库分发、由用户自行安装
- 更详细的功能说明见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)（用户指南）
- 请勿用于商业用途，尊重各平台版权

## Qt UI Library（Steam / 宽屏视觉模式）

项目现在内置一套可复用的 Qt UI 基础层，视觉取向接近 shadcn/ui：低饱和背景、细描边、层级化 surface、明确的 accent 和克制的圆角。它不是只切换深浅色，而是以 `ThemeStore` 的设计令牌驱动整套组件。

### 已提供

- `uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue`：页面外壳（全站唯一）：页面背景层、壁纸层、遮罩层和内容最大宽度容器；窗口宽度达到 `720px` 自动切换宽屏容器。
- `uni_modules/qt-ui/components/qt-card/qt-card.uvue`：default / muted / outline 三种卡片表面，适合设置项、统计块和播放信息。
- `uni_modules/qt-ui/components/qt-button/qt-button.uvue`：primary / secondary / ghost / outline，以及 sm / md / lg 尺寸。
- `uni_modules/qt-ui/stores/theme.ts`：明暗模式、预置皮肤、自定义颜色令牌、背景图片持久化。
- `pages/theme/index.uvue`：外观与皮肤设置页，支持 Linen / Graphite / Aurora 预置皮肤、背景图片 URL 和宽屏布局预览。

### 换肤 API

```ts
import { useThemeStore } from "@/uni_modules/qt-ui/stores/theme";

const theme = useThemeStore();
theme.setSkin("graphite");
theme.setBackgroundImage("https://example.com/your-wallpaper.jpg");
theme.setCustomSkin(
  "Night Drive",
  "#f97316",                 // accent
  "#101114",                 // background
  "rgba(24,25,30,0.82)",    // surface
  "#f6f7f9",                 // text
  "#a7adba",                 // textMuted
  "rgba(255,255,255,0.12)", // border
  "rgba(16,17,20,0.62)",    // wallpaper overlay
);
```

背景图片只作为最底层氛围，不会替代卡片表面；遮罩层保证文本对比度，组件仍然使用统一的间距、圆角、描边和交互态。后续在同一套令牌上扩展新组件（表单、空状态等）无需重写现有业务页面；完整组件清单见 `uni_modules/qt-ui/docs/design.md` §3。
