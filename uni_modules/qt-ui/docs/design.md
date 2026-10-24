# Qt UI 设计文档

> 文档版本：0.1.0  
> 创建日期：2026-09-05  
> 目标框架：uni-app x + Vue 3 Composition API + UVue + Vapor 模式  
> 组件类型：`uni_modules/qt-ui` 独立 UI 组件模块

## 1. 背景与目标

Qt UI 是面向 qtMusic 的独立 UI 组件库，视觉基调参考 shadcn/ui 的设计方法，但不直接依赖 Web 端组件库。组件库需要同时满足移动端和 Steam 风格宽屏场景：

- 移动端保持单列、紧凑、易触控；
- 窗口宽度较大时，内容区域自动限制最大宽度并居中；
- 主题不仅能切换明暗，还能切换整套颜色、surface、边框、文字和遮罩令牌；
- 支持自定义背景图片，图片只作为底层氛围，不替代内容卡片层；
- 所有样式遵守 uni-app x UVue/Vapor 的 CSS 编译约束；
- 组件能够放在 `uni_modules` 中，以独立模块的方式被业务页面使用。

## 2. 模块类型说明

这里的“UTS 插件”按 uni_modules 插件来组织，但 UI 层本身应使用 `dcloudext.type: "component"`，因为 `.uvue` 文件属于 UI 组件资源，不是原生 `utssdk` 实现。这样 HBuilderX 才会正确识别并编译 `components/**/**/*.uvue`。

如果后续需要给 UI 库增加 Android / iOS / Harmony 的原生能力，可以在同一个 `uni_modules/qt-ui/` 下增加可选的 `utssdk/` 目录；原生能力放在 `utssdk`，UI 组件继续放在 `components`，不要把 `.uvue` 当成纯 UTS 原生插件入口。

当前 `package.json` 因此使用：

```json
{
  "dcloudext": {
    "type": "component",
    "darkmode": "x",
    "widescreen": "x"
  }
}
```

这仍然是一个可以独立安装、独立归档、独立复用的 `uni_modules/qt-ui` UI 组件库。
## 3. 模块位置与目录

```text
uni_modules/
└── qt-ui/
    ├── package.json
    ├── readme.md
    ├── composables/
    │   ├── use-qt-layout.ts        # 窗口尺寸 / sizeClass / isWide / rail / qtRpx
    │   ├── use-qt-widths.ts        # 内容形态宽度、列门限、设置右栏 cap
    │   ├── qt-page-chrome.ts       # 路由标题、设置页族与动态标题通道
    │   ├── qt-nav.ts               # 宽屏无动画页面跳转
    │   └── use-batch-select.ts     # 批量选择态（见 §6.11）
    ├── stores/
    │   └── theme.ts                # 运行时皮肤 / 明暗 / 壁纸令牌
    ├── services/
    │   └── icons.ts                # 全站图标定义（QtIcon 数据源）
    ├── docs/
    │   ├── design.md               # 本文档：设计系统
    │   └── ui-review.md            # UI 审查红线 / 整改进度 / 剩余问题（活文档）
    └── components/                 # 单文件、单目录，共 39 个组件
        ├── qt-page-frame/          # 页面外壳：rail / chrome / toast / player bar / 设置与我的三栏
        ├── qt-card/  qt-button/  qt-icon/  qt-loading/  qt-checkbox/
        ├── qt-action-sheet/  qt-segmented/  qt-source-switcher/  qt-tab-bar/
        ├── qt-side-nav/            # 宽屏左侧 rail（替代原生 tabbar）
        ├── qt-mini-player/         # 悬浮播放球（几乎全站可见）
        ├── qt-song-row/  qt-song-row-lite/  qt-local-row/
        ├── qt-notice-bar/  qt-notice-splash/  qt-notice-card/  qt-upgrade-popup/
        ├── qt-toast-host/          # 轻提示宿主（全站一个实例）
        ├── qt-confirm-host/        # 确认弹窗宿主（全站一个实例，替代 uni.showModal）
        ├── qt-action-sheet-host/   # 底部操作表宿主（全站一个实例，替代 uni.showActionSheet）
        ├── qt-first-run-disclaimer/ # 首次启动免责声明（正文/读秒由后台下发，带读秒门禁）
        ├── qt-skeleton/  qt-skeleton-list/  qt-skeleton-shine/
        ├── qt-meta-pack-guide/     # 数据包安装引导弹窗（业务组件：未装数据包时首页指路设置页）
        ├── qt-playlist-picker/  qt-back-to-top/  qt-rich-text/  qt-sort-panel/
        ├── qt-batch-bar/           # 批量管理条（不自带外框，必须放进宿主的横向行容器）
        ├── qt-listen-detail/  qt-local-mixes/  qt-feedback-card/
        ├── qt-settings-overview/  qt-profile-overview/  qt-player-bar/  qt-wide-workspace/
```

## 3.1 `qt-local-mixes` 本地合辑

`components/qt-local-mixes/qt-local-mixes.uvue` 是首页本地听歌推荐区块。页面传入按固定顺序生成的本地合辑，组件负责紧凑与宽屏卡片、四张封面 2x2 预览、合辑详情 sheet 和「全部播放」。它只消费本地统计与收藏结果，不发起在线请求；空合辑不占位。封面失败时回退到 `QtIcon`，详情播放交给 player 的 `playReportSongs(songs, startIndex)`。嵌入已有内容列时使用 `embedded` 和 `content-width`，让横向轨道与宿主内容边界一致。

**容器契约（与其他区块保持一致）**：本组件不自带卡片外壳，区块容器（白底/描边/圆角/内边距）由宿主提供——首页竖屏把它放进 `.section`、宽屏放进 `.wide-panel`，与「推荐歌单 / 热门榜单 / 新歌速递」共用同一个容器；`embedded` 与宽屏下组件自身内边距清零（`padding: 0`），宿主传 `content-width` 时必须是**卡片内宽**（竖屏 `portraitSectionInner` = 窗口 − 页面 24rpx×2 − 卡片 26rpx×2；宽屏 `widePanelInner` = 主列宽 − 32px），不是窗口宽。卡面尺度同理：宿主传 `card-width`（首页传「推荐歌单」同一个 `shelfCardWidth` / `widePlaylistCardWidth`），组件只在未传时回落到内部估算，这样两个区块的卡宽、间距（14rpx / 宽屏 12px）与架高口径完全一致。

**视觉规格**：四张封面在同一个方形里按 2x2 拼贴（`aspectFill` 各自裁满，缝隙 4rpx / 宽屏 3px；外层 `flex-wrap: wrap` + `align-content: flex-start`，第一列/第一行取 `floor((卡宽 - 缝)/2)`，第二列与第二行吃掉取整余数），不再是三张独立小图、也不再是三竖条——三竖条在窄卡上每格只有三十来像素、四张图挤成一条，用户反馈「太拥挤、很丑」（2026-10-20）；标题两行（32rpx/600，行高 42rpx）+ 副标题一行（23rpx），与 `.shelf-name` / `.shelf-count` 同规格；kicker 与标题字重分别取 800/800（竖屏）与 700/700（宽屏），与 `.section-kicker` / `.section-title`、`.wide-kicker` / `.wide-panel-title` 对齐；kicker 颜色也跟随宿主——竖屏用 accent（同 `.section-kicker` 的取色），宽屏用弱化灰（同 `.wide-kicker` 的取色），否则它会在一排白面板里唯一一个高饱和。标题区到内容区的间距竖屏取 22rpx（与 `.shelf-scroll` 的 `margin-top: 22rpx` 同值）、宽屏取 12px（与 `.wide-panel-head` 的 `margin-bottom: 12px` 同值）。组件内部不再给每张卡套描边小卡，避免「卡中卡」。封面张数由 `finish()` 收集上限决定，现为 4（`services/local-mixes.ts`），缺图时该格回落到 `QtIcon` 占位。

**合辑详情 sheet**：照 `qt-listen-detail` 的抽屉口径——竖屏高度取 `windowHeight * 0.88`（原来 0.82，用户反馈「展开下滑范围小了」）、宽屏 0.92 且宽度走 `qtSheetWidth("drawer")`；**不放底部「取消」条**，关闭只靠右上 ✕ 与点遮罩（同 `qt-listen-detail` 的 header ✕ + mask 点击）；歌曲列表不吃死像素高，改 `flex: 1; min-height: 0;` 铺满头部与「全部播放」之外的剩余空间，抽屉变高就多露几行、矮屏也不溢出。

组件使用 `useQtLayout()`，首页以运行时 px 计算横向架与 sheet 高度；新增的 UI 样式遵循 Vapor 的扁平选择器、显式边框样式和不继承文本样式规则。

## 4. 设计原则

### 4.1 视觉原则

- 使用低饱和背景和高对比文字；
- 使用细描边区分 surface，不依赖重阴影；
- 卡片圆角建议 `16rpx`、`20rpx`、`24rpx` 三档；
- accent 只用于主要操作、选中状态和重点信息；
- 支持半透明 surface，但必须提供不透明度足够的文字背景层；
- 壁纸必须位于内容层以下，并通过独立 overlay 保证可读性；
- 图标统一使用项目的 `QtIcon`，禁止使用文字符号充当图标。

### 4.2 组件原则

- 组件通过 props 接收外观配置，不直接读取业务数据；
- 业务状态由页面或 Pinia 管理，UI 组件只负责展示和事件；
- 同一组件同时提供移动端和宽屏布局，不复制两份页面；
- 组件根节点使用单一 class，外部状态通过 props、class 绑定和内联 style 注入；
- 不让业务页面依赖组件内部的嵌套 DOM 结构。

## 5. Vapor / UVue CSS 约束

uni-app x Vapor 模式下，不能把 Web CSS 的全部写法直接搬过来。Qt UI 采用“保守 CSS 子集”，所有新增组件必须先通过 UVue CSS 编译。

### 5.1 禁止后代选择器

以下写法会触发 `Invalid selector`：

```css
.footer-actions .qt-button {}
.qt-button-size-sm .qt-button-label {}
.qt-button .qt-icon {}
```

改为给目标节点直接绑定 class：

```vue
<qt-button class="footer-button-left" />
<text class="qt-button-label" :class="labelSizeClass" />
<view class="qt-button-icon"><QtIcon /></view>
```

```css
.footer-button-left {}
.qt-button-label-sm {}
.qt-button-icon {}
```

原则：**一个样式规则只描述一个节点自身，不依赖父子、祖先、兄弟或伪类关系。**

### 5.2 禁止 `max-width: 100%`

Vapor CSS 编译器不接受百分比形式的 `max-width`。不要写：

```css
.qt-content-wide {
  width: 1200px;
  max-width: 100%;
}
```

采用运行时计算后的 px 宽度：

```ts
const width = windowWidth.value < maxWidth.value
  ? windowWidth.value
  : maxWidth.value;
const contentStyle = "width:" + width + "px;";
```

这样既保留了最大宽度，又不会触发 `max-width` 的百分比校验。

### 5.3 其他保守规则

除非经过真机和目标平台验证，组件库不使用：

- `linear-gradient`、`radial-gradient`；
- `backdrop-filter`、`filter`；
- CSS 自定义变量 `var(--token)`；
- `:last-child`、`:first-child`、`:nth-child` 等伪类；
- 后代选择器、子选择器、相邻兄弟选择器；
- 依赖浏览器行为的 `calc()`、复杂 `background` 简写；
- 用百分比表达关键尺寸的 `max-width`、`min-width`；
- 不确定是否被 UVue 支持的组合选择器。

推荐使用：

- `flex`、`flex-direction`、`flex-grow`、`align-items`、`justify-content`；
- `position: relative/absolute/fixed`；
- `width`、`height` 使用 `rpx` 或计算后的 `px`；
- `background-color`、`rgba()`；
- `border-width`、`border-style`、`border-color`、`border-radius`；
- `opacity`；
- class 绑定和内联 style。

> ⚠️ **`border-width` 必须配 `border-style: solid`**：Vapor 下只写 `border-width` **不会画出任何边框**，
> 边框样式默认值是 `none`（编译产物 `uni-app-x-framework-dev.js` 的 `createTransformBorder` 中
> `defaultStyle → "none"`、`defaultColor → "#000000"`、`defaultWidth → "medium"` 可证）。
> 同时 `border-color` 默认是 `#000000`，所以**只有在该边确实有颜色时才补 `border-style`**，
> 否则会画出一条黑边。颜色经常来自内联 `:style` 的计算绑定（如 `groupStyle`、`cardStyle`、
> `cellStyle`、`railStyle`、`skinOptionStyle`），补 `border-style` 前先确认该边的颜色来源。
> 按边拆分时用 `border-<side>-style: solid` 对应 `border-<side>-width`。
> 值为 `0` 的宽度声明（如 `.cell-no-border { border-bottom-width: 0; }`）不需要补 style。
> 全仓库已于 2026-10 完成一次审计补齐（40 个文件、118 处）。

> ⚠️ **`box-shadow` 是禁用项**：uni-app x Android 上 shadow 落在可点击元素或其祖先上会导致点击穿透 /
> 命中丢失（`pages/settings`、`pages/search`、`pages/artist` 实证）。层级用 `border` + surface 色差表达，
> 详见 `docs/ui-review.md` §1。纯装饰不可点击容器可用极轻 shadow（半径 ≤ 4rpx、alpha ≤ 0.06）。

> ⚠️ **默认 `box-sizing: border-box`（与 Web 相反）**：官方 `docs/css/css_diff_web.md` 明确 uni-app x
> 默认 border-box——`width/height` 包含内边距与边框。**固定尺寸的盒子再叠动态 `padding` 时，总量必须
> 显式算出来**：`qt-page-frame-bar` 曾写 `height: 44px` + 内联 `padding-top: 状态栏高度`，真机内容区被
> 压成 44 − 状态栏（约 5px）的窄条、返回键与标题上下被裁（2026-10-19 真机截图实证），修法是把高度
> 改成内联 `height: (状态栏 + 44)px`（见 barStyle 注释）。同理推断：**不要给固定高度的盒子挂随设备
> 变化的 `padding-top/bottom`**；反过来说，`qt-side-nav`（rail 让位状态栏）这类「高度铺满 + 内部
> padding」的写法是安全的，因为 flex 子项会自适应收缩。

### 5.4 长文本截断规则

uni-app x 默认 `flex-direction: column`，`align-items` 控制水平轴。**不要**用 `align-items: center`
让文本子节点自己撑开（子节点按内容宽度收缩 → 溢出被裁、`text-overflow: ellipsis` 永不生效）。
正确写法：

```css
.row { flex-direction: row; align-items: stretch; }  /* 或默认 column 时也一样 */
.text { flex: 1; min-width: 0; text-overflow: ellipsis; }
```

字形居中用 `text-align: center`（元素仍占满整行，省略号才生效），不要靠 `align-items: center` 居中。

### 5.5 组件样式命名

使用带模块前缀的扁平 class：

```text
qt-ui
qt-ui-content
qt-ui-title
qt-card
qt-card-title
qt-button
qt-button-primary
qt-button-label-sm
```

不要使用需要依赖层级关系才能生效的命名方式。组件状态直接落在同一节点：

```vue
<view class="qt-button" :class="disabled ? 'qt-button-disabled' : ''" />
```

## 6. 核心组件设计

### 6.1 `qt-page-frame` 页面外壳

路径：`uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue`

`qt-page-frame` 是全站唯一的页面宿主，而不只是背景容器。它统一负责：

- `themeStore.skin.background`、可选壁纸 `<image>` 与遮罩；
- 宽屏 rail、toast host、宽屏常驻播放器底栏；
- `widthKind` 内容列宽度政策，以及 `maxWidth` 的额外收紧；
- 全站 `navigationStyle: "custom"` 后的 chrome：**宽屏只留状态栏留白、不画顶部标题**；窄屏自绘「返回 + 标题」功能栏；
- 设置子页的三栏：rail | 原设置总览 | 子页内容。中栏复用 `qt-settings-overview`，不是另一份精简菜单。
- 我的页族的三栏（2026-10-19 起，与设置族同一套机制）：rail | 「我的」总览 | 子页内容。中栏复用 `qt-profile-overview`（从「我的」页抽出的真实总览，含用户卡/五宫格/功能分组与实时数据），当前项高亮；「设置」cell 属设置族，仍走 `navigateTo` 进另一套三栏，不做 redirectTo 就地替换。总览里的音乐助手 cell 按权限显隐（`canUseMusicAssistant`，`services/music-api.ts`）：账号权限里没有 `user:ai:music:use`（超管 `*:*:*` / 前缀通配 `user:ai:*` 等价）或未登录时整个入口不显示，而不是点进去才看到「无权限」——判定与 qt-pc 侧边栏同一个权限码（后端 `/api/v1/app/ai/agents` 已按它过滤，无码账号拉到的就是空列表）；AI 页自身的空态/错误展示保留为第二道守卫。竖屏/中等宽度的 `pages/user` 账户组也有同一个入口（2026-10-24 起，「听歌统计」下方，`sparkles` 图标 + 同一 `canUseMusicAssistant` 门禁，隐藏时统计行补回 `cell-no-border`），AI 页本体是 `pages/ai-assistant/index.uvue` + `composables/use-ai-chat.ts` + `services/ai.ts` + `types/ai.ts`（与 qt-pc 的 useAiChat/lib/ai 同一套后端口径：短轮询事件、提交前自搜候选，无本地算法）。
- **设置总览新增 AI 分组（2026-10-24，qt-pc 设置页 AiSection 的移动端形态）**：`qt-settings-overview` 在「桌面歌词」组后新增 `ai` 组两行——「AI 模式」（值 = `AI_MODE_LABEL_*`，弹 action-sheet 三选一：纯规则/本地模型精选/服务端 AI，**服务端仅 `isQtAdmin()` 可见**，非管理员任何路径都存不进 server；选中后 toast 该档说明）与「接口配置」（值 = 生效供应商名 + 生效模型，或 未配置/未选生效档）。模式直接读写同步真源 `ai-mode.ts` 的 `readAiMode/saveAiMode`（存储键 `dailyRecommend.mode`，音乐助手与每日推荐全局共用）。**推荐口味行已按用户要求删除**（口味只在每日推荐页内切换）。「接口配置」进入新页 `pages/ai-providers/index.uvue`（qt-pc AiProvidersDialog 的移动端形态：供应商卡片列表 + 底部弹层编辑器——名称/接口地址/协议 action-sheet（openai/openai-responses/anthropic/gemini）/模型手填或「拉取列表」/密钥（明文只存本机，列表与占位只显 `maskKey` 掩码，编辑留空 = 保留旧值）/证书校验开关/测试连接（一条「你好」走全链路，回显 HTTP 状态 + 耗时 + 回复片段）），数据面在 `services/ai-providers.ts`（键 `qt-ai-providers`；`aiLocalChat` 按协议构造请求并解析回复，`listModels` 网关不支持时可手填模型）。`daily-recommend.ts` 的 `askModelForPicks` 已接真实 `aiLocalChat`（两轮温度 0.4/0.2 + JSON 纠正重试，失败仍自动退回规则推荐）。分组两列切分由 `qtSplitByHeight` 自动重算。
- **每日推荐页（2026-10-24，qt-pc DailyRecommendPage 全量对齐）**：`pages/daily-recommend/index.uvue`（与「每日新歌」`pages/daily` 是两个页面——后者是新歌流，前者是个性化推荐）。服务层 `services/daily-recommend.ts`（约 2840 行，qt-pc `src/lib/daily-recommend.ts` 的移植）+ `services/recommend-rank.ts` / `recommend-dimensions.ts` / `music-style.ts` / `recommend-types.ts` / `recommend-text.ts` / `ai-mode.ts` / `ai-server-picks.ts` 六件套；偏好数据源全走本地：收听统计 `stores/listen-stats`（effectiveCount 降序取 topTracks、聚合歌手）、收藏 `player.likedSongs`、本地歌单成员经 `pids` 反查、在线收藏歌单走 `musicApi.playlist` 详情、播放历史 `player.history`。模式三档**全局**（rule/local/server，真源 `ai-mode.ts`，每日推荐与音乐助手共用），页面上的「AI 模式设置」弹窗即写它；`server` 选项仅 `isQtAdmin()` 可见（qt-pc 同款门禁）。缓存按 `日期+模式+口味` 命中（`dailyRecommend.cache`，版本号 DAILY_RULE_VERSION），换一批同日合并 keys 供 7 天跨天去重。口味三档（心动/常听/探索）与冷启动风格种子（`dailyRecommend.seeds`，冷启动时展示平台分类 chips 让用户勾选）同 qt-pc。页面 UI 复用详情页骨架（qt-page-frame width-kind=detail + 宽屏左栏 whero + 窄屏 hero + list-view），行是自定义 `rc-row`（序号/封面/名称/`歌手 · 推荐理由`副行/更多），批量操作与排序走既有 useBatchSelect/useBatchActions。注意服务层导出多为 **async**（loadTodayResult/clearTodayResult/readMode/generateDailyRecommend），页面侧等待后再用；模式高亮等同步场景直接用 `ai-mode.ts` 的 readAiMode/saveAiMode。

API：

```ts
type Props = {
  widthKind?: "form" | "prose" | "flow" | "list" | "detail" | "grid" | "full";
  maxWidth?: number; // 只收紧当前内容形态的上限
  fullWidth?: boolean; // 沉浸媒体页：不挂 rail、不限内容列
  noRail?: boolean; // 少数沉浸页面主动关闭 rail
  insetTop?: boolean; // 兼容旧调用方；custom 后 rail 恒避开状态栏
  current?: string; // rail / 设置、我的中栏高亮路由；缺省时从页面栈读取
  title?: string; // 窄屏 chrome 标题覆盖
};
```

示例：

```vue
<template>
  <qt-page-frame width-kind="list">
    <!-- 页面内容 -->
  </qt-page-frame>
</template>

<script setup lang="ts">
import QtPageFrame from "@/uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue";
</script>
```

设计要求：

- 页面外壳是全站唯一背景层和宽屏 rail 挂载点；页面**不得**再自行 import / 挂载 `qt-side-nav`；
- 业务页面根节点保持透明，背景图使用 `<image>`，遮罩使用独立 `<view>`，顺序固定为背景色 → 壁纸 → 遮罩 → 内容；
- `use-qt-widths.ts` 的 `qtContentWidthRaw()` 仅供 frame 计算外层内容列；业务布局读 `qtContentWidth()`，它会在设置右栏中自动读到 cap；
- 宽屏页面跳转必须携带 `qtNavAnimation()`：宽屏用 `animationType: "none"` 保持 rail 视觉静止，窄屏回到默认动画。rail 的五个工具入口在宽屏下不跳页面，走 `qt-wide-workspace` 就地托管（§6.18）；`uni.preloadPage` 在 uni-app x 不支持，旧的 `qt-page-preload.ts` 已删除，托管后宽屏也不再需要预热；
- 壁纸加载失败时，页面仍必须用皮肤背景正常显示。
### 6.2 `qt-card`

建议 API：

```ts
title?: string;
description?: string;
variant?: "default" | "muted" | "outline";
elevated?: boolean;
```

卡片只管理 surface 和边框，业务内容通过 slot 注入。禁止卡片内部写死播放器或歌单数据。

**头部度量必须随窗口宽变化（2026-10-20 修）**：用户报「音源包页里数据包那些有些字体太小了」，根因就是本组件头部写死 `font-size:15px`/`12px`，而页内正文是 `27rpx`（720dp 窗口上 1rpx = 0.96dp）—— 卡片标题换算后只有 17dp，比它下面的行名（约 30dp）还小，层级直接反掉。宽屏（`layout.isWide`）本来就用 px，不受影响；窄屏改成脚本按 rpx 口径算 px 内联：

- 标题 `qtFontDual(30, 15)`、描述 `qtFontDual(24, 12)`（375dp 手机上 30rpx/24rpx 恰等于原来的 15px/12px，渲染逐像素不变）；
- 内边距 28rpx→px、圆角 24rpx→px、头部下间距 22rpx→px、描述上间距 8rpx→px，全部由 `cardStyle`/`headerStyle`/`descriptionStyle` 内联下发，`<style>` 里只留 `border-width`、`font-weight` 与无单位 `line-height`；
- 换算函数 `u(rpx) = rpx/750*windowWidth`，**不要用 `qtRpx()` 的老口径**，也不要假设大窗口封顶（uni-app x 不支持 `rpxCalcMaxDeviceWidth`，见 §6.x 的 qtRpx 条目）；
- 为什么不用 rpx 写在 `<style>` 里：本组件历史上就是为了规避「Vapor 只把 rpx 样式登记进待重算集合、布局回调遍历时新登记会并发修改异常」才全改 px，这个风险目前只在 `pages/desktop-lyric` 那段自测量循环里被实证过，`<style>` 里放 rpx 的其他组件（qt-notice-card、qt-tab-bar）都正常，但本组件仍保守走内联 px，避免再引一次回归；
- 描述的行高从写死 `17px` 改为无单位 `1.23`（= 17 ÷ (12 × 1.15)）：字号现在会随窗口与字号档位放大，固定行高会把多行描述压在一起。改字号必须回头核对这个比值。

### 6.3 `qt-button`

建议 API：

```ts
label: string;
icon?: string;
variant?: "primary" | "secondary" | "ghost" | "outline";
size?: "sm" | "md" | "lg";
disabled?: boolean;
```

事件：

```ts
click: []
```

按钮的 icon 用独立 wrapper 控制间距，不使用 `.qt-button .qt-icon` 这类后代选择器。

标签字号在 `labelStyle` computed 里一次算完（**不要**在模板上再内联 `qtFont`）：

```ts
let style = "color:" + labelColor.value + ";";
style += qtFontDual(size.value == "sm" ? 23 : 26, size.value == "sm" ? 14 : 16);
```

原因：`labelStyle` 本来就要为宽屏输出 `font-size`（sm 14px / md·lg 16px），而 sm 变体的
class `.qt-button-label-sm` 只有 23rpx。若模板再追加一个内联 `qtFont(26)`，同一串里会出现两条
`font-size`，后者覆盖前者，**同时压平「宽屏 px 覆盖」和「sm 变体」**。两档基准 + 全局倍率
一起交给 `qtFontDual`（§6.8）才是唯一正确写法；这是全项目唯一一处此类冲突（`tools/find-double-fontsize.mjs` 全量扫描结果）。

### 6.4 响应式行为

组件库通过 `use-qt-layout.ts` 统一读取窗口宽度。组件内部不能假设自己永远运行在移动端：

- 页面壳：按 `widthKind` 取内容形态上限，并在 rail 右侧居中；页面不能再自行计算 rail padding；
- `qt-action-sheet`：移动端从底部出现，宽屏改为右侧抽屉（`420px`）；
- `qt-side-nav`：只有 `qt-page-frame` 挂载。`medium`（600–899）是 64px 图标 rail；`wide` / `desktop` 是 208px 完整 rail；
- `qt-player-bar`：存在当前歌曲时由 frame 在宽屏统一挂 64px 常驻底栏，`qt-mini-player` 只在非宽屏出现；
- 列表、卡片、输入框等基础组件使用同一份 props 和 token，只在布局 class 上产生差异。

`qt-action-sheet` 已接入该逻辑，且**必须放在页面所有 `list-view` 节点之后**（原生组件层级问题，
见 `docs/ui-review.md` §1.3）。

### 6.5 宽屏布局组件

宽屏布局由 `qt-page-frame` 统一组合：frame 自己挂左侧 rail、toast 与宽屏底栏；业务页面只提供内容 slot。宽屏 tabBar 仍由 `useQtTabBarSync()` 隐藏。

```text
┌────────────────────────────────────────────────────────┐
│ rail（medium: 64px；wide/desktop: 208px）│ 内容列（frame） │
│ 品牌 + 菜单，可滚动                         │ 宽度按 kind 计算 │
├────────────────────────────────────────────────────────┤
│                 宽屏常驻 player bar（有歌曲时）           │
└────────────────────────────────────────────────────────┘
```

设置族与我的页族子页在可用内容列至少 `400 + 16 + 460px` 时进入三栏（常量 `QT_SPLIT_NAV_WIDTH / GAP / PANE_MIN` 与判据 `qtSplitActive(isWide)` 定义在 `use-qt-widths.ts`，页面与框架读同一份，不会再各算一套）：

```text
rail │ 设置总览 / 我的总览（400px，当前项高亮） │ 子页内容（右栏）
```

移动端降级为自绘的功能性「返回 + 标题」栏、主内容与底部 tab / mini player。断点统一：`compact <600`、`medium 600–899`、`wide 900–1279`、`desktop ≥1280`；`isWide = width >= 900 || (landscape && width >= 600)`。

### 6.6 多形态适配约定（竖屏手机 / 横屏 / 平板 / 车机，2026-09 定稿）

目标形态：`compact <600dp`（手机竖屏，底部 tab）、`medium 600–899dp`（仅横屏时 `isWide=true`，64px 图标 rail、单列）、`wide 900–1279dp`（208px rail，按可用宽决定单/双列）、`desktop ≥1280dp`（208px rail、允许多列与常驻底栏）。竖屏 720dp 设备必须保持 compact/medium 手机布局，不能因为历史 720 门限误进 rail。

**rpx 的残酷事实（2026-09 实测，HBuilderX alpha 5.25 / Android）**：

- `pages.json globalStyle` 的 `rpxCalcMaxDeviceWidth` / `rpxCalcBaseDeviceWidth` / `dynamicRpx` **在 uni-app x Android 运行时中未实现**（对基座 APK 的 dex 做字符串检索，无 `rpxCalcMaxDeviceWidth` / `dynamicRpx` 符号；编译产物 app-config.js 里虽然有这些键，但原生运行时不读）。保留在 pages.json 里无害，不要指望它。
- 因此 `rpx = windowWidth / 750` 恒成立：1138dp 窗口上 1rpx≈1.5dp，2560px 屏上字会大到 3 倍以上。**宽屏唯一的防御是逐节点 `-wide` px 覆盖**（§10.1 规则），新增任何会在 `isWide` 下渲染的节点都必须带 `xxx-wide` 绑定与 px 规则，否则就是下一次“面目全非”。

**宽屏导航 rail（`qt-side-nav`）**：

- `qt-side-nav` 只由 `qt-page-frame` 挂载；业务页面不得自行 import。rail 恒为状态栏让位，菜单区在 `qsn-scroll`（`scroll-view`，`flex:1`）内滚动，避免矮横屏里末尾「设置」不可达。
- 仅 `medium` 使用 64px 图标 rail；`wide` 与 `desktop` 使用 208px 完整 rail。工具入口（搜索/每日推荐/歌单广场/排行榜/设置）在宽屏下由 `qtRailNavigate()` **就地托管**进当前 tab 页（§6.18：不新建 Activity、不往页面栈里堆页面），栈顶不是宿主页时先 `navigateBack` 回宿主再托管，深链兜底才 `navigateTo`（宽屏同样 `animationType: "none"`，slide-in-right 的白带横扫已被真机实测否决）；窄屏保留系统整页导航。发现/我的切 tab 统一走 `qtSwitchTab()`（鸿蒙 `reLaunch`，见下条），该 API 不接受 `animationType`，不能把它误写成由 `qtNavAnimation()` 控制；切 tab 前先 `qtCloseWideTool()` 把托管工具页藏起来（已创建的工具页保活，重开瞬时恢复）。
- 全部 39 页使用 `navigationStyle: "custom"`。宽屏由 frame 省去顶部标题并留出状态栏空间；窄屏 frame 画功能性返回与标题，避免二级页失去返回路径。业务页面不再计算 rail padding。
- `qt-mini-player` 仅在非宽屏显示；宽屏统一由 `qt-player-bar` 占据 rail 右侧的常驻 64px 底栏。**全站共用一份实例状态（2026-10-24 改造，用户要求「全部页面共用一个悬浮播放器，页面返回或者进入页面不应该出现闪烁」）**：悬浮球的位置/展开/吸附侧/渲染尺寸/唱片旋转角全部收敛到 `uni_modules/qt-ui/services/mini-player-singleton.ts` 这一个模块级 store（`miniFabX/miniFabY/miniExpanded/miniEdgeSide/miniEdgeAnimating/miniRenderWidth/miniRenderHeight/miniRotateDeg` + `ensureMiniPositioned/miniSnapToNearestEdge/miniExpandFromFab/miniCollapse/onMiniWindowResize` 等 action），组件改为无状态消费者；挂载点收敛到 `qt-page-frame`（`<qt-mini-player v-if="!fullWidth" />`，全站 39 页一处生效），**业务页面一律不得再自行挂 `qt-mini-player`**（2026-10-24 起已从 10 个页面摘除）。废弃了旧的「显示权交接」协议（registerMiniPlayer/refreshMiniPlayerRoute/栈顶路由轮询）——每次 navigateTo/back 都要做一次球的消失→出现交接，交接空洞正是闪烁根源；现在被盖住的页面窗口本来就在下层、它的球不可见，转场期间新旧两页的球像素级一致地跟着页面动画运动，视觉上是同一个球；第 2 个页面起也没有「窗口尺寸不稳→重试定位」的初始化窗口期（定位状态全站共享，只有首个实例做 `ensureMiniPositioned()` 的 50ms×40 重试）。唱片旋转是全站共享的单 rAF（组件 mount 引用计数 + playing 标志驱动），换页后旋转角度连续。**注意 `position: fixed` 元素在鸿蒙上不会随页面栈被裁剪**——排查时别把下层页面残留的 fixed 层误判成当前页组件（2026-10-19 就误把榜单里「当前播放行」的大圆封面当成悬浮球查了半天）。
- **鸿蒙上 fixed 宿主里的 fixed 子节点收不到触摸，子级必须改 `absolute`**（2026-10-19 真机实测定稿，用户报「点击悬浮球无反应」）。现象：悬浮球看得见、`uitest dumpLayout` 里节点 `clickable=true`、z-index 998 也在最上层，但点它完全没反应，同一坐标下方的榜单行反而被点开（事件穿透）。根因：`.mini-player-host` 是 `position: fixed`，子级 `.fab-right` 也写 `position: fixed`——鸿蒙（uni-app x）在这种「fixed 套 fixed」下命中测试失效。**解法**：宿主保持 `fixed` 并按 `left/top` 定位，子级改 `position: absolute; left: 0; top: 0`，铺满宿主即可。**关键坑**：改 absolute 后子级的 `left/top` 必须固定为 `0`——若仍沿用宿主那套屏幕坐标（本组件原先把 `fabX/fabY` 内联到 `containerStyle`），就会在宿主偏移之上再偏移一次，球被推到屏幕外，`dumpLayout` 里该节点 `clickable` 会从 true 变 false。所以 `containerStyle` 现在只输出尺寸与圆角，位置完全由 `hostStyle` 负责，两者不要都写坐标。同一红线适用于任何「fixed 容器 + fixed 子级」的组合（`qt-playlist-picker` 的 mask/panel、`qt-action-sheet`、`qt-upgrade-popup`、`qt-notice-splash` 等），改样式时先按这条自检。

**竖屏底部导航（`qt-tab-bar`，2026-10-19 起悬浮胶囊化）**：

- 通栏 58px 改为悬浮 pill：左右各缩 20px、离地 12px、高 60px、圆角 30px，两个入口（发现 / 我的）各占一半，当前项的图标与文字一起包在 accentSoft 圆角 chip 里（参照用户给的悬浮导航设计稿；中间不放发布按钮，「暂时不需要」）。悬浮层次不用 box-shadow（可点击容器在 uni-app x Android 上会点击穿透，见 §5 红线），靠 border + tabSurface 色差与离地间隙表达。
- 总占位 = 离地 24rpx + 高 120rpx = **144rpx**（375dp 基准下等于 72px），写进 `QT_TAB_BAR_HEIGHT_RPX`，由 `qtTabBarHeightPx()` 折算成 px 给宿主用；`qt-toast-host` 的让位与 `qt-mini-player` 悬浮球初始边距（BOTTOM_MARGIN 190rpx）都按它取值，三处必须同源；`tools/check-toast.mjs` 有断言防漂移。
- **尺寸一律用 rpx，不写死 px**（2026-10-20 修，用户实测 720dp 模拟器报「底部tag显示太小」）：本组件只在 `!layout.isWide` 的手机档渲染，而手机档整页内容都是 rpx（随窗口宽度线性放大）。写死 px 的结果是「上面的内容巨大、底部导航还是手机大小」，在平板、折叠屏、大窗口模拟器上尤其刺眼。改用 rpx 后 375dp 手机上渲染结果与改动前逐像素一致（375/750 = 0.5，rpx 值 × 0.5 正好等于原 px 值），宽窗口上则跟整页一起放大。图标同理从 `:size="24"` 改 `48`（24rpx 在 375dp 手机上只有 12dp，正好是 28px 容器的一半 —— 那是「容器 px、图标 rpx」混排留下的老账）。
- 页面滚动区既有的 220rpx 底部内边距仍然够用（悬浮条只占 144rpx）；宽屏不渲染（v-if），rail 接管。
- **鸿蒙上不注册 tabBar，切 tab 走 `qtSwitchTab`（`reLaunch`）**（2026-10-19 真机实测定稿）。现象：点「我的」胶囊完全没反应，既没有 success 也没有 fail；更迷惑的是——加探针后发现 `uni.switchTab` **会**回调 success、`getCurrentPages()` 栈顶**也**变成了目标路由，但原生视图停在首页不动；换成 `uni.reLaunch` 到同一个 tab 页，结果一样。根因在 uni-app x 鸿蒙 runtime（`unpackage/dist/dev/app-harmony/.../@dcloudio/uni-app-x-vapor-runtime/src/main/ets/runtime/libs/uni-app-x-framework.js`）：`switchTab` 与 `reLaunch` 命中 tabBar 页时都收敛到同一个 `switchSelect()`，再往原生 Tabs 控制器 `tabBar0.appendItem()` 追加子页；而本应用每个页面都用 `uni.hideTabBar` 隐藏原生 tabBar（`use-qt-tab-bar.ts`），这套 Tabs 容器在追加第二个 tab 页时不会真正挂载子页——JS 侧状态全对，原生侧不动。**解法**：`pages.json` 的 `"tabBar"` 整块包进 `// #ifndef APP-HARMONY`（pages.json 支持条件编译，见 `uni-cli-shared/dist/json/json.js` 的 `preUVueJson`），鸿蒙上首页/我的退化成普通页面；调用点统一用 `qt-nav.ts` 的 `qtSwitchTab(url)`——鸿蒙分支 `reLaunch`、其它平台 `switchTab` 且 fail 时 `reLaunch` 兜底。**推论**：鸿蒙上 `uni.hideTabBar()` 会 reject（tabBar 不存在），`use-qt-tab-bar.ts` 已用 fail 吞掉；以后新增 tab 页必须同步改 `qtSwitchTab` 的调用点，别再直接写 `uni.switchTab`。**排查手法**：`hdc shell uitest dumpLayout -p /data/local/tmp/tree.json` 能导出真实的 ArkUI 无障碍树（含 bounds/clickable/hitTestBehavior），uni-app x 的自绘视图也在里面（但**不含文本**，中文关键字搜不到，只能看结构与坐标）；`uinput -T -c x y` 的坐标就是截图坐标（1:1，无状态栏偏移），可用来做命中测试。

**JS 侧尺寸换算（`qtRpx`）**：

- 脚本里不要写 `windowWidth / 750 * n`；用 `qtRpx(n)`（use-qt-layout.ts）。**它的口径必须与 CSS 的 rpx 逐位一致**：uni-app x 的 rpx 一律按 `windowWidth / 750` 折算，没有任何封顶。
- **不要指望 `pages.json` 的 `rpxCalcMaxDeviceWidth` / `rpxCalcBaseDeviceWidth`**（2026-10-20 实证）：官方 schema `pagesSchemaUniAppx.json` 对这两个键标的是 `uniPlatform.app.android.unixVer: "x"`、`harmony` 同样 `"x"` —— 即 uni-app x **完全不支持**（只有 vue 版 uni-app 支持）。`pages.json` 里那两行是无效配置。
- **曾经的错**：`qtRpx` 一度按「窗口 >500dp 后 CSS rpx 按 375 基准封顶」折算，即 `n * (win>500 ? 375 : win) / 750`，注释还写着「JS 若仍按 windowWidth/750 会大 2-3 倍」。方向恰好相反 —— 720dp 模拟器实测：`.home-bell` 的 `68rpx` 渲染成 96px = 64dp（= 68 × 720/750 × 1.5），而 `qtRpx(68)` 只给 34px。于是所有「JS 算容器 px + CSS 里放 rpx 内容」的地方，容器只有内容的一半大。用户报的五条症状同源：为你整理的卡名溢出 rail、推荐歌单封面被裁、悬浮球 60px 容器里塞 115px 内圈、页面标题与 TabBar 显得极小（后两条是写死 px 的 chrome 不随窗口放大）。
- 判据：**任何一处「JS 算 px + CSS 用 rpx」混排的布局，都要求这两套换算同源**。写之前可以用「该尺寸在 375dp 手机上应该是多少 px」反推 rpx 值（× 2），比直接写 px 安全。
- `qt-icon` 的 `size` 在 `isWide` 时单位从 rpx 切换为 px（组件内部处理），所以模板里 `:size="layout.isWide ? 16 : 30"` 是推荐写法。
- **手机档整页写死 px 的页面/弹层一律改成「base rpx + `-wide` px」成对写**（2026-10-21，同 §6.6 tab-bar 那条的同源补充）：`pages/equalizer/index` 与 `qt-playlist-picker` 原来通篇只有 px（0 处 rpx），在 720dp 窗口上正文 14px 只有 14dp，而同屏其他页面 26rpx ≈ 25dp —— 又是「字体太小」。换算规则固定：**base 取「375dp 手机上原来那个 px 值 × 2」写成 rpx**（375/750 = 0.5，标准档渲染逐像素不变），`-wide` 保留原 px。验收靠 `tools/verify-font-scale-args.mjs`（`qtFontDual(B,W)` 要求 base class rpx == B、`-wide` class px == W）。两个附带发现：① `pages/equalizer` 的 `card-wide` / `head-row-wide` / `chips-wide` 三个类被 `:class` 引用但 `<style>` 里根本不存在（宽屏一直吃到手机档的 16px/18px），本次补齐；② `qt-playlist-picker` 的 `panelStyle` 早就用 `screenW / 750` 算面板宽（rpx 口径），而面板内字号是 px —— 这类「JS 按 rpx 算容器 + CSS 写死 px 内容」的混排正是 §6.6「两套换算必须同源」那条的反例，改后 `Math.min(screenW - marginX, maxW)` 的 `marginX`/`maxW`/`anchorTop` 偏移也一起按 `layout.isWide` 分支。

- **同类缺陷用 `tools/audit-px-units.mjs` 兜底，已进 `npm run check` 门禁**（2026-10-21 全仓清扫）：人工只找得到「整页写死 px」的显眼样本，漏掉的是「某个 `-wide` 类被模板引用、`<style>` 里却没定义」这类静默失效。脚本用 `@vue/compiler-sfc` 的 `parse()` 取模板 + 手写 `styleRules()` 取样式，对每条 `font-size: Npx` 找模板使用点，沿祖先链累积判断该节点是否「只可能出现在宽屏」，分四段报告：**A** 手机档会吃到 px（真缺陷）、**B** `-wide` 被 `:class` 引用但无定义（宽屏静默失效）、**D** `-wide` 有定义但模板从不引用（宽屏拿不到覆盖，base 的 rpx 顶上来）、**C** class 里的 px 已被内联 `qtFont*` 覆盖（死代码，仅提示）。`--strict` 模式下 A/B/D 任一非空即 exit 1。清扫结果（改动前 → 改动后）：A 2→0（剩下的 2 类是 `qt-batch-bar` 的 column 档，只在 `layout="column"` 时渲染且调用方都在宽屏左栏，已写成脚本内 `WHITELIST` 并注明理由）、B 15→0、D 43→0、C 33→28。B 段的修法几乎都是**删绑定而不是补样式**——那些 base 类只含 flex/position、没有任何 rpx 尺寸，宽屏变体本来就不必要。D 段 43 类里 32 类是页面迁到组件（`qt-feedback-card` / `qt-notice-card`）后遗留的整组死代码，base 与 `-wide` 一起删。**D 段最后一条 `qt-notice-splash` 的 `.nts-content-wide` 选择删规则而不是补绑定**：模板 :12 的内联 `:style` 已覆盖 `margin-top`，只剩 `margin-bottom:2px` 差异，补绑定会与内联打架，删规则并把 `margin-bottom:2px` 并进内联分支更干净。判据：**能被内联覆盖的尺寸就不要在 class 里留第二份**，否则「改了内联没改 class」的改动会静默不生效。

**页面骨架模式**：

- 首页 / 我的等 tab 页：只使用 `qt-page-frame width-kind="grid"`；frame 统一挂 rail，页面不再自行挂 `QtSideNav` 或写 rail padding。首页宽屏仍是 rail | 主列（feature + 推荐歌单网格 + 新歌） | 300px Trending 侧栏；主列可用宽不足时右栏内容下移。歌单网格列数由 `qtColumnCount()` 和真实内宽计算，禁止靠 flex-wrap 或历史固定列数。
- **首页头部不再有品牌块**（2026-10 用户定稿：「把首页最上面的轻听那一块内容全部删了吧，顺序换成音源-搜索-通知，否则显得太拥挤了」）：`.home-brand`（logo + 「轻听」+「你的私人音乐台」）连同它的 4 条 `*-wide` 覆盖一并删除，头部一行只剩三个控件，顺序 `SourceSwitcher`、搜索、通知（竖屏与宽屏同一顺序）。`.home-source` 的 `margin-left` 随之一并删掉——它成了行首，再留 12rpx 就比页面左右内边距多缩进一截。首页的品牌仍由宽屏的 `qt-side-nav` 承担，页内不再重复。
- **今日精选 hero 用歌单封面当底图**（2026-10 用户要求「把首页这个背景改为整个歌单的图片，可以适当裁剪然后背景颜色」）：竖屏 `.portrait-hero` 内最前面加两层绝对定位满铺兄弟节点——`<image class="hero-bg" mode="aspectFill">`（`playlists[0].picUrl`）+ `.hero-scrim`（`background-color: theme.skin.mediaScrim`，即 `rgba(0,0,0,0.52)`，与播放页底图遮罩同一个 token；换皮肤时一起变）。`heroStyle` 的 accent 底色 + 135° 渐变保留，作为封面未到货/加载失败时的兜底，也是图片透明区的垫底。两层各自写 `border-radius: 28rpx`（与卡片同值）：原生端绝对定位子节点不一定被父级 `overflow:hidden` 的圆角裁掉。**卡内不再放 `.hero-art` 缩略图**（2026-10 用户「右边这个图片不需要」）：底图就是同一张封面，再摆一个方块只是重复；hero 内的封面骨架块（`.hero-art-skel`）与 `QtSkeleton` 导入一并删掉，首屏未到货时靠 `heroStyle` 的 accent 底 + 文案占位撑住卡片。宽屏 `.wide-feature` 的 `.wide-feature-cover` 是另一套布局（不是满铺底图），保留，但图片同样走 `featuredPicUrl`。**底图铺满要「外层 view 四边 0 + image 100%×100%」两层**（2026-10 两次踩坑后的定稿；用户原话「这样太怪了，还是之前的一个容器，不要分成两个」与「每日推荐上面那个立即播放的背景图片没有占满整个屏幕」）：`<image>` 自己写绝对定位四边 0 不生效——`right: 0` 让底图只拿到行内剩余宽度（770 宽窗口实测约 518px），卡片右侧露一条 accent 底色（`#793032`，正是 accent `#ff6268` 被 `mediaScrim` 压掉 48% 的结果；顺带可用它反推皮肤 accent），整卡看着像被劈成两张；退一步改成「只写 left/top/bottom + 内联 px 宽度（`heroBgWidth = Math.round(win - win * 48 / 750)`）」只修好了横向，**纵向 `bottom: 0` 对 image 同样不生效**，高度退化成按宽高比推出来的方图（约 330px），「立即播放」那一带约 100px 露出被遮罩压暗的 accent 底色——这就是用户报的「背景图片没有占满整个屏幕」。定稿写法：外面套一层 `<view class="hero-bg-wrap">` 用四边 0 拉伸（view 的拉伸是可靠的，`.hero-scrim` 一直就是这么铺满的），`<image class="hero-bg">` 在外层里写 `width: 100%; height: 100%`，与 `pages/theme` 的 `.wallpaper-image`、`qt-page-frame` 的 `.qt-page-frame-wallpaper` 同源。结论一句话：**image 的绝对定位只认「左上 + 显式宽高」，不认 right/bottom 拉伸；要拉伸就套一层 view**。宽屏 `.wide-feature-bg` 一直是 `width/height:100%` 的写法所以没踩到。注意换算不能用 `qtRpx`：它在宽窗口按 375 基准折算，48rpx 会算成 24px、比真实卡宽差 25px。
- **今日精选每次加载随机挑一个歌单**（2026-10 用户「首页这个容器展示从下面推荐歌单里面随机选择一个，不要只选择第一个」）：`featuredIndex` 是 `ref<number>`，`featuredName` / `featuredPicUrl` / `playFeatured` 三处都读它（取不到时回落到 0）；随机只在推荐数据到货那一刻抽一次（`load()` 的 `recsTask` 里 `playlists.value = recs` 之后调 `pickFeatured(recs)`），抽取范围取 `Math.min(10, list.length)`——与下方歌单架 `playlists.slice(0, 10)` 同一区间，避免 hero 抽到架子上看不到的歌单。**不能写成 computed 里现抽**——否则每次重算（滚动、主题切换、任意响应式依赖变动）都会换一个歌单，封面、标题、点击目标会各跳各的。换源/重拉时 `pickFeatured` 重新抽并自然收敛到新数组范围，`ensureLoad` 清空 `playlists` 后 `featuredIndex` 无需手动复位。**「一次加载只抽一次」要靠两层保证**（2026-10 用户报「首页这条会加载两次不一样的」）：① `ensureLoad()` 必须先 `ensureLocalStateRestored()` 再比对 `packsFingerprint()`——冷启动时本地包态是异步从磁盘恢复的，恢复前指纹恒为空态，紧随 `onMounted` 的 `onShow` 会误判「包变了」而再拉一整轮（推荐数据到货两次 → hero 当场换一张）；② `pickFeatured` 记住「音源 + 抽中的歌单 id」（`featuredSource` / `featuredId`），同一音源下那个歌单还在前 10 里就直接沿用、不重抽（推荐走 `music-api` 的 60s 短缓存，重拉常拿到同一份列表，内容没变就不该换 hero），换源或它掉出前 10 才重抽。不要用「关掉 onShow 的 ensureLoad」代替——那会失去包变更/回前台的兜底。
- **「我的」页三块卡必须同宽**（2026-10 用户反馈「上面用户信息框和下面的宽度不一致」）：竖屏统一 `24rpx` 侧边距 + `24rpx` 圆角（`.profile` / `.tiles` / `.group` 三块都走这套），宽屏统一 `16px`。`.profile` 早期是「上直角下圆角」的通栏卡（没有侧边距、圆角 `0 0 28rpx 28rpx`），整卡比下面两张宽 48rpx；改宽度时圆角要一起改成四角 `24rpx`，否则方角卡片浮在页面里会显得残缺。内容左边距靠「卡片侧边距 + 卡片内边距」对齐（24 + 32 = 56rpx，与分组卡的 `padding: 0 32rpx` 一致）。三块卡与全部业务（头像/昵称/签到/计数/跳转）2026-10-19 起移入 `components/qt-profile-overview`：宽屏三栏下同一份总览还渲染在我的族子页中栏，两处实时数据必须同源，抄两份必然漂移。中栏变体（`inPane`）恒单列、隐藏行尾摘要与箭头、行高 52px（与设置中栏同规格），当前项高亮 accentSoft 底色 + 标题 accent 色。
- **听歌报告页（`pages/stats/index.uvue`）按「报告」排版**（2026-10 用户「把听歌报告页面美化一下，类似于这种」+「把 top5 歌曲，top5 歌手，top5 音源都展示出来，在一排，可以左右滑动」+「不是年度报告，就是听歌报告」）：① hero 用「最常播放那首的封面」当满铺底图 + `rgba(8,11,20,0.54)` 遮罩 + 白字，没有播放记录时退回 `skin.accent` 纯色卡；底图同样必须内联 `width`（`<image>` 的 `right:0` 在 app-uvue 不生效，见 §今日精选那条），文字外面包一层 `position: relative` 的 `.hero-body`；封面仅保留报告标题与功能入口，移除品牌标语和光斑。② 数据带是一排四格（`flex:1` 均分，**不要用 `width:50%` + padding**——app-uvue 没有全局 `box-sizing: border-box`，百分比宽度再叠内边距会溢出换行，旧版只能靠 `width:48%` 硬凑）。③ Top 5 歌曲 / 歌手 / 音源三张卡排成一行横向 `scroll-view`：卡宽 `topCardWidth`、行宽 `topRowWidth`、容器高 `topRowHeightPx` 三个都必须是脚本算好的 px（横向 scroll-view 在原生端不会按内容撑高，也不认百分比），竖屏卡宽 = 一屏内宽减 `52rpx`（露出下一张的头提示可滑）、宽屏卡片最小 300px，小横屏仍可横滑，大窗口三张并排，内容列限制为 `min(窗口宽, 1360)`；`.top-scroll` 要 `flex-grow: 0; flex-shrink: 0` 才不会被父级 flex 压扁。④ 新增独立的 `stores/listen-stats.ts` 报告存档，按 `platform:id` 保留歌曲元数据、起播次数和实际播放秒数，不受最近播放历史的长度上限影响；歌手/音源 Top 5 按起播次数加权。旧次数首次迁入，旧时长不补算；收藏歌曲仍读取本地歌单。累计播放时长单独成卡，未播完也只计实际秒数；原生进度增量受墙钟上限约束，暂停、缓冲、倒退、拖动冻结窗口和切歌基准不计入，不虚构完播率或活跃天数。⑤ Android 存档位于系统公共下载目录的 `QtMusic/listen-stats.json`，每 5 秒以及暂停/退后台时保存；同目录临时写入后改名替换。未授权「所有文件访问」或公共写入失败时用私有存储兜底，报告页明确展示状态并可进入权限页；授权后合并并迁出兜底。待合并增量跨重启保留，清空用时间标记防止旧存档复活。重装后重新授权可读回公共存档。旧 Android 自定义基座可能没有 `publicDataDir` 代理导出，服务通过复制插件命名空间做可选能力检测，缺少接口时返回空路径并保留私有兜底；说明面板提示更新基座及卸载丢失风险。不要命名导入该可选接口，否则旧基座在编译期就失败；更新原生基座后才能启用公共存档。⑥ 播放时尝试当前平台的歌手接口并按名字缓存头像 URL，平台失败不影响播放，换平台仍可补取；报告页补查已有 Top 5，图片缺失或加载失败才用首字占位。音源使用 `static/source/` 中随应用打包的五个平台真实图标，来源见该目录 README，未知或本地音源用通用图标。⑦ 删除底部「感谢每一首歌」卡。名次前三用 `skin.accent`、其余用 `skin.textSubtle`，全部走 `qtFontDual(base, widePx)` 内联，不写死颜色；时长数字行用原生支持的 `align-items:flex-end`，不能用 `baseline`。
- **听歌报告交互**：三个 Top 5 的「全部」入口打开完整排行，条目点击打开歌曲/歌手/音源详情。业务弹层 `qt-listen-detail` 竖屏为 88% 窗口高度的底部面板，宽屏为最大 560px 的右侧抽屉；使用 `useQtLayout`、主题色和 `qtFontDual`。详情展示次数、实际时长、播放占比；歌曲另含歌手/专辑/音源和播放操作，歌手/音源显示相关歌曲。完整排行及相关歌曲支持次数/时长排序，每批 50 项。聚合函数统一在 `services/listen-report.ts`，平台歌曲以 `platform:id` 区分，歌手按原署名归并；空记录不参与排行。头部「统计说明」承载计数口径、旧时长不补算、公共路径及权限入口，主页面只保留简短存档状态。所有播放操作均为显式点击，打开详情不触发播放。
- 歌单详情：宽屏左右布局（左 272px 歌单信息卡 + 右歌曲列表），竖屏保持上下堆叠；frame maxWidth 宽屏 1080 / 竖屏 860。
- **歌单详情排序入口两级化（2026-10-24，用户要求；同日再改为两行面板）**：右上三点由横排 `more` 改竖排 `more-vert`（图标新增在 `services/icons.ts`）；三点菜单只有「更改歌曲排序方式」一项，点它才弹排序面板（窄屏标题栏与宽屏左栏 `.whero-tools` 同语义；2026-10-24 用户进一步要求**去掉中间菜单层**：三点第一次点击直接弹出排序面板，面板开着时再点一次关闭——三页统一的 `toggleSortPanel()`）。排序弹窗首版是 7 行组合行（qt-action-sheet + `action.color` accent 标记 + 按下标映射），2026-10-24 用户改为**两行面板 `qt-sort-panel`**（`uni_modules/qt-ui/components/qt-sort-panel/qt-sort-panel.uvue`，歌单详情 / 每日新歌 / 每日推荐三页共用）：第一行「排序方式」三枚单选 chip（按歌曲名 / 按专辑名 / 按歌手名，再点一次取消勾选），第二行「方向」正序 / 倒序（未选排序方式时置灰不可点），**全不勾 = 默认顺序**；选中即生效不关面板（页面回调内先回顶再换血）。倒序实现 = 升序排完 `reverse()`（主键+歌名兜底已是全序）。弹层结构三个实证雷区（2026-10-24 真机截图逐个排出来的）：① **组件根节点必须自己就是全屏 fixed 蒙层**（`position:fixed` 四边贴满 + `justify-content:flex-end` 推面板到底 + `z-index:999`，qt-action-sheet 配方）——根是零尺寸普通视图、子节点 fixed/absolute 挂出去时，命中测试按零尺寸根算，「点击穿透到底下列表」（点胶囊把歌播了）且 chips 容器宽度量错挤成两行；② **蒙层色用带透明度的 `skin.scrim`，不要 `opacity` 动画**——面板是蒙层子节点，opacity 合成组把整个面板一起变半透明（列表从面板底下透出来）；③ **模板插值里不要 `Map[key]` 方括号查表**——UTS 运行时取不到值渲染成空（三枚排序胶囊只剩空底），标签走函数 if 查表。`pages/ai-providers/index.uvue` 的编辑弹层同配方（fixed 蒙层 + scrim 色）。
- **详情页一套模板（2026-10-22 收口）**：`pages/playlist`（歌单 / 专辑 / 排行榜三种 `type`）与 `pages/artist`（歌手）共用同一套结构——`<qt-page-frame width-kind="detail">` + 宽屏左栏 `.wide-left` 内 `.whero` 信息卡（封面 / 标题 / 简介 / 数量 / `.whero-actions` 操作区）+ 右栏 `list-view`，竖屏 `.hero` 卡片 + 吸顶 `.list-head` + `qt-song-row-lite` 行。差异只有三处：① 歌单页多一颗收藏红心（`canSavePlaylist`，用户要求「只有歌单详情页面可以进行收藏」），歌手页/专辑/排行榜都没有；② 歌单页多一条 `v-if="type == 'album'"` 的数量行；③ 歌手页是分页全量拉取（`ARTIST_PAGE_SIZE=30` / `maxPages:60`），保留底部进度行与「已加载全部 N 首」，歌单页一次拉全没有分页。**没有独立的 album / chart 页**——专辑与排行榜都是 `pages/playlist` 的 `type` 分支，改模板时不用另找文件。
- **列表页卡片的间距只能挂在 `list-item` 的 `padding` 上**（2026-10 用户报「公告栏显示有问题」）：`list-item` 不支持 `margin`。消息中心 `.n-item` 原本写 `margin: 20rpx 24rpx 0`，实机表现是「左边距生效、右边距和行距全丢」——卡片右侧顶到屏幕边、上下两卡黏成一片（截图上卡 1 在 y=131..340、卡 2 在 y=346..483，左内边距 26px 约合 24rpx，右边缘却到了屏宽 769）。正确写法与 `pages/download` 一致：`.n-row { padding: 20rpx 24rpx 0; flex-direction: row; align-items: stretch; }` 挂在 `list-item` 上，卡面（背景/描边/圆角/内边距）挪进里层 `.n-item { flex: 1; ... }`，宽屏同步 `.n-row-wide { padding: 14px 24px 0; }`。
- **同一张卡上的状态类与深色类不能互相嵌套**：消息中心原本写 `:class="item.read ? 'n-item-read' : (themeStore.dark ? 'n-item-dark' : '')"`，已读项在深色模式下永远拿不到 `n-item-dark`，半透明白卡面直接垫在深色页底上（实测卡面 `#7d7e81`），深色文字糊成一片。状态类与主题类必须是同级独立项：`[[item.read ? 'n-item-read' : ''], [themeStore.dark ? 'n-item-dark' : ''], [layout.isWide ? 'n-item-wide' : '']]`。
- **页面文字颜色优先用 `themeStore.skin.*` 内联绑定，而不是写死一组 `*-dark` 覆盖**：消息中心原来标题 `#191d26`、正文 `#596173`、时间与工具条 `#6b7385` 全是浅色写死值，深色模式只能靠 `-dark` 类一条条补，漏一条就是黑字黑底。现改为 `('color:' + themeStore.skin.text + ';') + qtFontDual(...)`（标题 `text`、正文 `textMuted`、时间 `textSubtle`，深浅次序与原值一致），换皮肤时一起变，与 `pages/download`、`pages/home`、`pages/profile` 的最新写法统一。骨架屏 `qt-skeleton-list` 的 `.qt-skl-nrow-notice` 用普通 `view` 撑行、`margin` 本就生效，且「24rpx 内缩 + 22rpx 内边距 + 20rpx 间距」与真实行一致（2026-10-22 卡片压缩时已同步，原来是 28rpx）。
- **两列切分层 `.pair` 必须在单列时也占满行宽**（2026-10-19 用户报消息中心「公告信息的宽度不一致」）：`useQtSongColumns` 的 `cellStyle` 单列时留空（注释说「单列走原布局的 flex:1」），但消息中心的 `.n-row`（list-item）是 `flex-direction: row` —— 行容器是横向主轴，中间层 `.pair` 不写 `flex: 1` 就会**按内容收缩**：卡片各宽各的（标题长的更宽）、时间戳被推出屏幕被裁。`history` / `local` / `feedback` 的行容器都是默认 `column`（`.pair` 落在交叉轴、被默认 `stretch` 拉满），所以只有消息中心中招。规则：**list-item 为 `row` 方向时，唯一的 `.pair` 子层必须 `flex: 1`**；两列不受影响（格子宽由脚本定宽内联下发）。
- **消息中心卡片压成单行：只留标题，不显示正文预览与时间**（2026-10-22 用户看到上一版截图说「好丑啊，不行就只展示标题，一行就行，也不要展示日期时间了」）：上一版卡片是「图标方块 + 类型标签 + 置顶徽标 + 标题 / 第二行正文 + 右侧时间」，两条卡并排时左栏是标签、右栏是时间，中间夹着长短不一的正文，视觉上碎成三块。改成**单行结构**：`qt-notice-card.uvue` 模板只留 `图标 → 类型标签 → 标题(flex:1, max-lines=1) → 置顶徽标 → 箭头`，删掉 `.n-bottom`（原正文行容器）、`.n-content`、`.n-time` 与整套 `contentHeightPx` 定高脚本（单行天然等高，不再需要按 `fontScale` 算高度）；`.n-item` padding 由 `22rpx 24rpx` 收到 `18rpx 24rpx`（宽屏 `12px 16px`），图标 `72rpx→56rpx`（宽屏 `44px→36px`）。同时 **`「公告」类型标签由宿主省略**（`pages/notice/list/index.uvue` 的 `cardType()` 对 `announce` 返回空串，组件 `v-if="typeText.length > 0"` 整块不渲染）——消息中心九成是公告，挂个灰标签纯属重复；反馈/需求是少数派且去向不同，标签保留。`pages/notice/list/index.uvue` 里随之删掉 `cardContent()` / `cardTime()` / `formatTime()` 与 `stripHtml` 的 import，`QtNoticeCard` 的 props 精简为 `title/typeText/typeColor/read/top`。骨架 `qt-skeleton-list` 的 notice 档同步只留一条文字线（删 `.qt-skl-nl2*`），内边距与图标尺寸对齐新卡。

- **消息中心每条通知必须等高**（2026-10-20 用户报「qt-uniappx的通知页面每个通知的高度不一样」；**2026-10-22 卡片压成单行后已不需要定高，本条留作历史与约束依据**）：卡片高度原先完全由内容撑，正文 `max-lines="2"` 只封顶不封底 —— 正文一行就矮一行、两行就高一行，这是高度不齐的**唯一**来源（标题已 `max-lines="1"`，图标是定宽方块，类型标签/置顶徽标/时间戳都在同一个 `.n-top` 行里）。修法：`qt-notice-card.uvue` 把正文包进一个定高行容器 `.n-bottom`（2026-10-22 前叫 `.n-content-box`），高度取 `:style="'height:' + contentHeightPx + 'px;'"`，`contentHeightPx = Math.ceil(字号px × 1.5) × CONTENT_LINES`（`CONTENT_LINES` 2026-10-22 由 2 改成 1，见下一条）。**不能在 `.n-item` 上写 min-height**，也不能把 `line-height` 换成固定 px 了事 —— `use-qt-song-columns` 的硬约束写着「list-item 靠行高预估总高，min-height 会让虚拟滚动抖动」，且正文字号是 `qtFontDual(25, 14)` 会乘 `fontScale.scale`（用户切「很大」1.5x 时行高一起放大，写死高度会把第二行裁掉）。所以高度必须在脚本里按 `基准字号 × fontScale.scale × line-height` 算，窄屏再乘 `layout.windowWidth / 750` 做 rpx→px 换算，与 `qt-segmented.uvue:84` 的 `rowHeightPx` 同构；`.n-content` 的 `line-height: 1.5` 改了两处必须同步（组件里有注释）。间距 `margin-top` 要写在占位盒上而非内层 `<text>` 上，写在 text 上文字会从盒子里往下溢、高度就不准了。
- **消息中心卡片再压缩一轮（2026-10-22 用户要求「高度可以少一点，日期只显示月日就行，正文和标题中间不需要一个空行，且需要把标题显示完整」）—— 本轮的「正文与时间同行」布局当天晚些时候已被上一条「压成单行」取代，此处保留记录理由与实测数据**：四件事一起做。① **时间戳从标题行挪到正文行右端**（`.n-top` 只剩类型标签 + 置顶徽标 + 标题）——原布局里 `.n-top` 是 `justify-content: space-between`，时间戳占着行尾宽度，标题 `flex: 1` 只剩「卡宽 − 图标 − 时间」，「Windows版本_更新公告」这种长标题就被 `max-lines="1"` 截断；挪走后标题拿到整行宽度，「显示完整」靠的是腾出空间而不是放开行数。② **正文与时间同行**：新容器 `.n-bottom`（`flex-direction: row; align-items: center`）= `.n-content`（`flex: 1`，`max-lines="1"`）+ `.n-time`（`flex-shrink: 0`），定高 `contentHeightPx` 从这一行上取。③ **`CONTENT_LINES` 2 → 1**：原来按两行定高，公告正文多半只有一句，第二行区域就成了标题与正文之间的「空行」（实测标题带 y=173..206、正文带 y=276..301，中间空 70 截图 px ≈ 116 设备 px），用户报的「不需要一个空行」就是它；改一行后既有内容都不裁也没有空白行。④ **`.n-item` 纵向内边距 28rpx → 22rpx**（宽屏 `20px` → `16px`）、`.n-bottom` 的 `margin-top` 8rpx（宽屏 5px）——配合 ③ 整卡矮了约四成。⑤ **日期只到月日**：`pages/notice/list/index.uvue` 的 `formatTime()` 从 `substring(5, 16)`（「10-08 15:06」）改成 `substring(5, 10)`（「10-08」）。骨架 `qt-skeleton-list` 的 notice 档同步收窄（`.qt-skl-nrow-notice` padding 22rpx / `-wide` 16px、`.qt-skl-nl2-notice` margin-top 8rpx / `-wide` 5px），否则加载态与真实态高度差一截。
- **富文本正文的颜色要按主题收编，不能让公告 HTML 里写死的浅色主题色直接上屏**（2026-10 用户报「公告详情也需要适配一下」）：服务端公告正文由富文本编辑器产出，正文 `<p style="color:#333333">`、各级标题 `<h3 ... color:#1f2329>` 都写死浅色配色，深色主题下落在卡片底（`skin.surface` 合成后的 `#20222b`）上对比度不到 1.5:1。实测用户截图里 `#1f2329` 像素成带出现在 y 349..377 / 559..580 / 838..859 / 1120..1139，正是 h2 + 3 个 h3 的位置——标题是「渲染了但看不见」，不是没渲染。修法在 `qt-rich-text` 收口：`runStyle` 逐 run 都写 `color`（app-uvue 文字样式不继承，段落 `<text>` 上的内联 `color` 传不到嵌套的 run `<text>`），且作者色先过 `isNeutralColor`——RGB 三通道极差 < 18（`#333333` / `#1f2329` / `#191d26` / `#ffffff` 一类编辑器默认正文色）或彩度（极差/最大值）< 0.35（`#666666`、应用调色板里的 `#6b7385` / `#737b8e` 一类带色灰）判为中性色，回落到 `props.color`；有彩度的原样保留（链接 `#1a73e8` 彩度 0.89、警示红橙 0.69/0.91）。页面自身的标题/时间/空态同理走 `themeStore.skin.text|textSubtle|textMuted` 内联（公告详情原来写死 `#191d26`/`#6b7385`，深色下标题与页底 `#15171d` 对比度只有 1.2:1）。公告弹窗 `qt-notice-splash`、更新弹窗 `qt-upgrade-popup` 仍是一整块浅色写死的白卡，它们传的 `props.color` 是 `#596173`，本次改动只会让它们的正文比原来（框架默认近黑色）更贴合各自的卡面，不会变差。
- **富文本里作者写死的 `font-size` 必须折回 rpx 再上屏，否则标题层级会翻过来**（2026-10-22 用户报「为什么公共详情的字体这么小」）：公告正文由富文本编辑器产出，`<h2>` 写死 `font-size:20px`、`<h3>` 写死 `font-size:16px`。原实现在 `runStyle` 里把 `r.fontSize` **原样以 px 拼进 run 的 `:style`**，而 run 嵌在段落容器 `<text :style="paraStyle(b)">` 内部 —— 内联样式优先级更高，容器算好的 rpx 字号被直接盖掉：770 宽窗口下正文走 `props.fontSize` 的 26rpx（≈26.7px），h3 却只有 16px、h2 只有 20px，**小标题比正文还小**（截图逐字实测：h2 汉字高 34-46px、正文 20-22px、h3 仅 13-17px），用户感知就是「正文小 + 层级乱」。修法三处：① 新增 `authorRpx(raw, base)` —— 作者写的 `rpx` 原样用；写 `px` 的按「相对网页正文 14px 的倍数」换算（`(base * n) / WEB_BODY_PX`，`WEB_BODY_PX = 14`），即 20px → base×1.43、16px → base×1.14、不写字号就是 base，夹在 12–72rpx。**不能用「1px = 2rpx」的硬折算**：`props.fontSize` 是 rpx（竖屏 750rpx = 窗口宽），366dp 机器上 26rpx 只有约 12.7dp，而作者写的是绝对 dp，两者不同源，硬折算会让标题在小屏上反而不够大；② 新增 `blockAuthorRpx(b, base)` 取该块所有 run 里 `authorRpx` 的最大值；③ `paraStyle`/`liStyle` 先看块级作者字号（有就整块用、不再叠加 `headingDelta`），`runStyle` 里改成 `"font-size:" + scaledSize(authored) + (isWide ? "px;" : "rpx;")`。这样作者的相对层级（h2 > h3 > 正文）保留，同时**统一经过 `scaledSize`**，宽屏 0.7 折算与 `fontScale.scale`（设置页「文字大小」）都对富文本生效。另外**长文阅读页（公告详情）的 `:font-size` 基准抬到 30rpx**（其余三个弹层调用点仍 26rpx）：26rpx 在 366dp 机器上只有约 12.7dp，抬基准后标题随倍数一起等比放大，不用逐条改公告内容。
- 表单/阅读类子页维持 §10 的限宽模式。
- **子页不重复导航栏标题**（2026-09 用户定稿「通用的，把红色方框里的歌单广场删掉」）：原生导航栏已显示 `navigationBarTitleText`，页内不得再放同名大标题（歌单广场/最近播放/MV 的 `.title`、排行榜页头整块已删）。页头只保留有信息量的部分：计数/副标题（最近播放的「共 N 首」）、右侧操作（MV 的音源切换）、筛选 tag（排行榜音源 segmented）。播放器/<MV 播放>这类 `navigationStyle: custom` 页面的自绘导航不算重复。
- **排行榜 QQ 音乐式榜单卡 + 音源 tab 进标题栏（2026-10-24 用户「把排行榜换成这种展示，tag 放到标题栏，内容展示前几首歌曲」，参照 QQ 音乐截图）**：`pages/chart` 整页重排——① **音源 segmented 移出页头**，改走 `qt-page-frame` 新能力：`headerChipTexts` 非空时非搜索态标题栏的 `.qt-page-frame-mid` 改画**可横滑的药丸行**（`.qt-page-frame-chip-row`，复用搜索态的 chip 样式），此时标题让位不画（返回键 + N 个药丸放不下再放标题）；药丸行实际是**文字 tab**（用户定稿，QQ 音乐那种：容器无底无框内联 `background-color:transparent;border-width:0`，`barChipTextStyle()` 给文字上色——选中 = 主题色 + 600 加粗，未选中 = `textMuted`，字号走 `qtFont(30)`；搜索框里的药丸仍是药丸样式，两套外观）；药丸行是**可横滑 scroll-view，宽度必须由脚本实测后显式给 px**（`measureChipRow()`：`flex:1` 在标题栏这种自适应宽容器里解析不出，实测整条 0 宽；且 scroll-view 默认 `flex-direction: column`，必须显式改 `row` 否则药丸竖着摞只露出第一颗），并在选中项变化/旋转后把选中药丸滚到行中央（`centerActiveChip()` 用 selectAll 的药丸矩形算中心偏移，用户手动滑过的偏移由 `@scroll` 记进普通变量做基准、不回写 ref 免得跟用户抢滚动）。页面传 `:header-chip-actives` + `@headerChipTap` 完成选中。② **内容由「单行榜单条目」换成 QQ 式榜单卡** `.rank-card`：卡头 = 榜单名 + 右侧「共 N 首」（N 取自该卡 `chartDetail` 的全量条数，用户定稿替换掉原来的榜单描述长文案）；卡身 = 左侧 148rpx 封面（半透明遮罩 + play 图标，点它进榜单详情）+ 右侧**前三名**（序号 + 「歌名 - 歌手」，点行 `playUrl → player.playSingle` 直接播）。③ **前三名逐卡异步取**：每卡一次 `musicApi.chartDetail`（全量接口，取前 3 条 + 总数），并发 3 个排队，结果按「平台:id@包态指纹」缓存（切音源/回来不重发），固定渲染 3 行、未到画 `···` 占位避免卡高跳动。④ 宽屏 `qtColumnCount(inner, 380, 12, 3)` 最多 3 列（卡比旧条目宽），其余沿用实测 scroll-view 宽 + 显式 px 卡宽的老机制。⑦ **切音源 tab = 页内切换，配方「先回顶、再整组换数据」**（2026-10-24 三度定稿）：先试过四种页内做法全被真机否决（keyed v-for 整组换、卸 key 原地换、每源常驻 scroll-view + v-show、同 + 内联 display——共同症状是数据全到位但整块不渲染）；再试整页 `redirectTo` 重载（渲染可靠但每次切换闪黑，且该自定义基座不认 animationType/Duration 参数，盖不住「旧页销毁→新页首帧」的重建间隙）。**最终配方来自搜索页实证**（pages/search/index.uvue L871/L977 注释）：整组替换数组丢渲染的前提是**停在滚动深处**——先把滚动位置归零（scroll-top 绑定 0/1 交替写入强制生效），约 80ms 落定后再改 `sourceIndex` 让 `filteredCharts` 整组换血，**回顶后的整组替换从未失败**。滚动位置由 `services/chart-tabs.ts` 按**音源 id**（不是下标）记忆，换源/重进后 `restoreScroll()`（120/260ms 重试）落位。**教训（Vapor 渲染雷区，全仓库通用）**：对象返回值方法绑定 + `!` 断言会中断行内渲染；v-if/v-else 分支文本可能两支都不出；**写在 v-if/v-for 指令里的方法调用不会随依赖重算**（必须用直接下标读 + 保证数组等长）；keyed v-for 整组替换、深滚位置整组替换数组都会丢渲染；重建过的子树逐次劣化；v-for 项上的 v-show 与内联 display 都不可靠。⑤ **文字 tab 的行高/盒高必须跟着字号算**（用户「上下没显示全，不是左右」实证）：`.qt-page-frame-chip-text` 类里的 `line-height: 30rpx` 是给搜索态药丸的固定值，而 tab 字号走 `qtFont(chipFontRpx)`（标准档 30rpx × 1.15 ≈ 34.5rpx），**行高小于字号时字形上下会被行盒裁掉**；同时固定 `height` 的 chip(52rpx)/行(64rpx) 在「大/很大」字号档（1.3/1.5 倍）也装不下。现在三个量全部由脚本按字号算：`chipLineRpx = 字号×倍率×1.35`、`chipBoxRpx = max(行高+8, 52)`、`chipRowRpx = max(盒高+12, 64)`，分别经 `barChipTextStyle()` / `chipBoxInline` / `chipRowInline` 内联下发。⑥ **字号档必须首帧预测、不能「先大后降」**（用户「为什么进去和最终的效果不一样，我只要最终效果的那样」）：最早是 mount 后 `measureChipRow()` 实测超宽才降一档，于是进页面第一帧按 30 档只露出 3 颗 tab，约 200ms 后降档跳到 5 颗一行 —— 肉眼可见的跳变。现在 `chipFontPredictedRpx` 用**首帧全部可知**的量直接预测最终档：可用宽 `chipRowAvailPx = windowWidth − (返回键+栏内边距+右侧动作数) × windowWidth/750`，内容宽按「CJK ≈ 1em、ASCII ≈ 0.56em + padding/margin」逐字累加 × 1.05 安全余量，从 30 往下降取第一档装得下的；`chipFontRpx` 是 computed = `min(预测档, 实测兜底档)`，实测兜底 `chipFontMeasuredRpx` 只在估算仍失准时再降一档且**只降不升**（不会跳回去），所以正常路径下第一帧就是最终样子。估算函数 `chipEstWidthAt(label, baseRpx)` 的每字宽随 `fontScale.scale` 与 `windowWidth/750` 一起算，换字号档/旋转后预测值自动重算。另：`measureChipRow()` 实测 tab 内容坐标时**必须加回当前 scrollLeft**（`boundingClientRect` 给的是屏幕坐标，滚动后 chip 屏幕位置整体左移，直接 `rect.left − row.left` 会少算一个 scrollLeft，居中越滚越偏、表现为选中第一项时左边被裁半个 tab）；`centerChipIndex()` 里也删掉了「用户手滑过头不往回拽」的否决逻辑（它让点左侧 tab 永远滚不回去）。⑧ **卡内前三名文本不要用 v-if/v-else 分支**——Vapor 下两分支文本都不渲染（序号能出、歌名和「···」占位都不出），占位逻辑收进返回 string 的纯函数里，单文本节点绑定。

- **列表「整组换血」的通用规则（2026-10-24 全站收口，用户令「所有切换有这个问题的全部都这样修复」）**：任何用户操作会让滚动容器（list-view/scroll-view）里 v-for 的数组**整组换新**时，必须**先回顶、再换数据**——回顶用 scroll-top 绑定 0/1 交替写入（同值不触发）；停在滚动深处整组替换会让容器整段丢渲染（大块空白带，list-view 与 scroll-view 均实证）。已按此收口的位置：搜索页（`resetListScroll`，新搜索/切 tab/切聚合模式）、排行榜页（切音源 tab，见上⑦）、歌单广场页（切分类/切排序/换音源，`load()` 起手回顶）、反馈页（我的/公开 tab 切换前回顶，scroll-view 补了 scroll-top 绑定）、歌单详情与每日新歌（选排序前回顶；列表内搜索实时过滤是逐键整组换血，`onSearchInput`/`onHeaderSearchInput` 包装成先回顶再写词）、歌手详情（列表内搜索同上）。未处理但低风险：消息中心 onShow 静默刷新整组替换（列表短、极少深滚）。**新增此类交互时照抄此配方**，不要再发明「常驻多容器切可见性」「整页重载」之类的旁路。

### 6.7 骨架屏与全页扫光带（2026-10 新增 `qt-skeleton` / `qt-skeleton-shine`）

**需求（用户原话）**：先显示和真实内容形状一致的骨架屏，每个页面所有骨架公用一道柔和的
斜向光带，每 1.5 秒从左往右扫过；数据到了之后，从上往下每块错开 60ms 依次浮现（淡入），
骨架同步淡出，整页不跳动、不闪白。

**三个组件/工具的分工**：

| 文件 | 职责 |
| --- | --- |
| `services/skeleton-shine.ts` | 扫光贴图 `SHINE_SRC`（内嵌 128×8 PNG） |
| `components/qt-skeleton/` | 单个骨架块原语（`tone` = cover/line/block/circle），页面可选用 |
| `components/qt-skeleton-list/` | **整层骨架（推荐直接用）**：`kind` 形状枚举 + 行数，内建错峰与唯一光带，见 §6.17 |
| `components/qt-skeleton-shine/` | 整页共用的一条光带，靠 `UniElement.animate()` 扫动 |
| `composables/use-qt-reveal.ts` | 60ms 错峰浮现 + 骨架同步淡出的时间轴 |

**为什么光带是一张内嵌 PNG 而不是 CSS 渐变**：`AGENTS.md` 禁止 `linear-gradient`
（未经真机验证），仓库里唯一一处 `linear-gradient` 在 `pages/home/index.uvue` 的
`heroStyle`，且它的两层色被不透明底色吃掉，不能作为依据；`filter` / `blur` / `mask`
在 uni-app x 文档里没有对应条目，属明确不支持。所以「柔和的边」只能靠贴图自带的 alpha
渐变。`services/icons.ts` 的真机探针已证明 `data:image/png;base64,` 在鸿蒙上正常渲染，
故沿用同一管线。贴图横向是升余弦 alpha 曲线（两端全透明、峰值 0.95），纵向无变化，
纵向拉伸不会失真；「斜向」由组件侧 `transform: rotate()` 提供。

**贴图峰值定标（2026-10 实测回调）**：峰值最初是 0.70，真机截图量化后发现光带压在半透明
白卡片上，对比度只有 17/255（约 6.7%），用户的原话反馈是「完全没有看出来骨架屏」。
贴图峰值是这条链路上唯一能提亮的旋钮，故提到 0.95；剩下的对比度由各页面骨架块底色
（`.sk-cover` / `.sk-line`）负责——目前定为 `rgba(25,29,38,0.18)`。改这两个值时要在
真机上截图量化，不能凭肉眼。

**扫光强度分两段定标（2026-10 用户反馈「扫光感觉太亮」）**：贴图峰值只作为**全主题上限**
保留 0.95，主题差异由 `.qt-skeleton-shine-track` 的 opacity 表达——浅色 `0.78`、深色 `0.48`
（`qt-skeleton-shine.uvue` 的 `SHINE_OPACITY_LIGHT` / `SHINE_OPACITY_DARK`）。原因是光带
永远是白色：压在深色块底上对比度 68%，压在浅色块底上只有 16%，两者差 4.3 倍，同一份贴图
压到深色够暗时浅色就回到了「完全看不出来」那一档。回调后浅色 12.4%、深色 32.7%，浅色仍
是历史基线（6.7% / 5.6%）的 2.2 倍。合成模型与数值见 `shots/contrast-model.py`，改这两个
值前先跑一遍模型，别凭肉眼调。

**为什么 rotate 和 translateX 分在两个节点上**：`UniElement.animate()` 的 transform
关键帧会**整体覆盖**元素的 `transform` 样式。所以 `rotate` 留在子节点
`.qt-skeleton-shine-band` 上、`translateX` 打在父节点 `.qt-skeleton-shine-track` 上，
两者不会互相顶掉。先例是 `qt-notice-bar.uvue` 的 `startMarquee()`。

**为什么用 `animate()` 而不是 CSS `@keyframes`**：仓库里 `@keyframes` / `animation`
属性的使用数为 0，没有可参照的真机结论；`animate()` 是渲染线程驱动的原生动画，
`qt-loading` / `qt-notice-bar` 都是这套机制。位移距离在运行时用
`getBoundingClientRect()` 量出来换算成 px（不用百分比：关键帧里的百分比位移没有真机先例，
px 位移有两个已验证的调用点）。不用 `fill:"backwards"`——`IUniElement.d.ts:3022` 的
`UniAnimationOptionFill` 里它在 android / ios 上都是 `unixVer "x"`，即 App 端未支持；
这里用 `iterations: Infinity`，本来也不需要 fill。

**为什么错峰浮现用 JS 定时器而不是 `transition-delay`**：`transition-delay` 在仓库里
使用数为 0，且在 `app-harmony` 的 Vapor 运行时类型树里没有声明。所以
`use-qt-reveal.ts` 用 CSS 基线 `opacity:0` + `transition:opacity` 配 JS `setTimeout`
排时间轴：第 i 块在 `32 + i×60` ms 时置为可见，最后一块之后再过 320ms（等于 transition
时长）才把 `revealing` 置 false，保证骨架淡出期间不被提前卸载。

**页面接入要点（`pages/playlists/index.uvue` 是首个接入页）**：

- 骨架层与真实首屏行放在**同一个 `list-item`** 里：① 高度由同一处撑起，骨架行数与真实
  首屏行数都取 `HEAD_ROWS`，形状一致，数据到达时头部高度不变；② 骨架是后写的兄弟节点，
  天然画在真实行之上，交叉淡出时不会被后面的 `list-item` 盖住（跨 `list-item` 的层级
  无法保证）。
- **骨架整层只挂一处，光带也只挂这一处**，绝不每块骨架各挂一条——那样每条光带相位各自
  独立，看起来是一堆闪烁的碎片。
- `HEAD_ROWS` 要等于竖屏首屏实际能放下的行数。歌单广场一开始取 2，真机实测首屏能放
  4 行（3 列 + 1:1 封面），骨架只铺到首屏上四成、下面一大片空白，看上去不像「正在加载」
  而像「加载坏了」，这也是用户说「看不出来」的原因之一。改这个常量时必须同步改
  `skeletonRowCount`，并保留「真实行数少于 `HEAD_ROWS` 时骨架跟着收窄」的分支，
  否则冷门分类下多出来的骨架行会盖在「已加载全部」上。

### 6.8 全局字号缩放（2026-09 新增 `stores/font-scale.ts`）

**需求**：让用户在设置里整体切换应用文字大小（很小 / 小 / 标准 / 大 / 很大），全部页面文字统一跟随。
2026-10 用户重定标：把原先的 1.15「大」提升为新的**标准**档，两端各补一档，形成 5 档
`0.85 / 1.0 / 1.15 / 1.3 / 1.5`。**默认档从 1.0 变为 1.15**，即开箱字号比历史上大 15%；
`scale = 1.0` 不再是标准档，而是「小」档。

**为什么只能用「逐 `<text>` 内联 style」**（三条红线叠加，无更省事的办法）：

1. Vapor **禁用 CSS 变量**，无法在根节点挂 `--font-scale` 再让子节点 `calc()`；
2. app-uvue **文字样式不继承**——父 `<view>` 上的 `font-size` 不会传到子 `<text>`，
   且 `inherit` / `unset` 都不支持（§6.6 实测）；
3. `rpx = windowWidth / 750`，它响应窗口宽度但**不响应运行时状态**，
   改不了「同一个窗口内整体变大」。

因此唯一可行路径是：每个 `<text>` 自己绑一个读全局倍率的响应式内联字号。

**API**（`uni_modules/qt-ui/stores/font-scale.ts`）：

```ts
export type QtFontTier = "tiny" | "small" | "normal" | "large" | "huge";
export const QT_FONT_TIERS: QtFontTierPreset[]; // 0.85 / 1.0 / 1.15 / 1.3 / 1.5（normal 为默认）
export const fontScale: FontScaleStore;          // reactive 单例
export function useFontScaleStore(): FontScaleStore;

export function qtFont(baseRpx: number): string;             // rpx 基准
export function qtFontPx(basePx: number): string;            // px 基准
export function qtFontRpx(baseRpx: number): string;          // qtFont 别名
export function qtFontDual(baseRpx: number, widePx: number): string;
export function qtFontDualPx(basePx: number, widePx: number): string;
export function qtFontDualRpx(baseRpx: number, wideRpx: number): string;
```

用法：

```vue
<text :style="('color:' + theme.skin.text + ';') + qtFont(25)">标题</text>
<text :style="qtFontDual(26, 15)">紧凑 26rpx / 宽屏 15px</text>
```

**`qtFontDual` 为什么必须存在（最容易踩的坑）**：内联 `:style` 优先级高于 class，
一旦给某个 `<text>` 写了内联 `font-size`，它原本靠 `-wide` class 做的宽屏 px 覆盖就**整体失效**
——宽屏会退回按 rpx 缩放的小字号（实测 40rpx 在宽屏只有 20px，而 `-wide` 要的是 28px）。
所以凡是有 `-wide` 分支的节点，必须把「紧凑基准 + 宽屏基准」两个值一起交给 `qtFontDual`，
由它内部按 `layout.isWide` 分支。`qtFontDual` 自己读模块级单例布局
（`composables/use-qt-layout.ts` 的 `qtIsWide()`），因此调用点不需要再 import 布局 composable。

**改法（codemod）**：项目用 `tools/font-scale-codemod.mjs` 一次性把 580 个 `<text>`
的 class 字号转成内联 helper，并在每个文件补 import。约束与验收：

- **纯增量**：只往模板加内联 `:style`，**从不改样式表**（内联本就压过 class，改样式表只会制造分歧）；
- **倍率即全部差异**：helper 输出 = class 原值 x 当前档位倍率。`scale = 1.0`（现「小」档）
  时与 class 原值数值完全相同，`tools/verify-font-scale-args.mjs` 校验 579 个节点的参数与
  class 原值 0 不一致 —— 这条校验**只比对 class 与 helper 参数，不读 `fontScale.scale`**，
  所以重定标倍率不会让它失败；它证明的是「helper 的数学没变」。
- **幂等**：`:style` 里已含 `qtFont` 的节点跳过，重复跑不会叠两层；
- **冲突检测**：`tools/find-double-fontsize.mjs` 找出「模板内联了 `qtFont*`，但同一 `:style`
  表达式还引用了自己会输出 `font-size` 的 JS 函数/computed」的节点（两条 `font-size` 后者覆盖前者）。
  全项目仅 `qt-button` 一处，已改为在 JS 里用 `qtFontDual` 一次算完（见 §6.3）。

**有意不参与缩放的节点**（都写了注释说明，不是遗漏）：

- `pages/desktop-lyric/index.uvue` 的 4 个预览节点：那是原生悬浮歌词窗的等比缩影，
  字号由该页自己的「字号」滑杆（`liveSize` → `desktopLyric.setFontSp`）单独控制，
  是原生窗口的真实取值；再乘一次全局倍率会让预览与真实悬浮窗对不上，破坏所见即所得。
  全局倍率只作用于**应用内页面文字**。
- 播放页歌词 / 卡拉 OK、`qt-rich-text`：字号在 JS 里算（宽屏还要先做 0.7 折算），
  已在这些函数里乘 `fontScale.scale`，模板无法也不应再内联。

### 6.9 `qt-segmented` 标签间隔（2026-09 新增 `itemGap`）

`qt-segmented` 默认是两段紧贴的胶囊，短标签（如分享卡片页的「歌曲卡片 / 歌词卡片」）会挤在一起。为此新增可选 prop：

```ts
type Props = {
  list: string[];
  modelValue: number;
  itemGap?: number; // 相邻 tag 之间的水平间隔（px），默认 0 = 原紧凑样式
};
```

```vue
<QtSegmented v-model="mode" :list="['歌曲卡片', '歌词卡片']" :item-gap="16" />
```

实现与约束：

- 间隔用**每个选项内联 `padding-left` / `padding-right = itemGap / 2`** 表达：相邻两项之间正好是 `itemGap`，胶囊两端也不再贴着文字；
- Vapor 下不能写 `:first-child` / 兄弟选择器，无法只给非末项加 `margin-right`，所以沿用组件里已有的「按 index 绑内联 style」写法（同 `-wide` px 覆盖思路）；
- 默认值 0，登录、排行榜、歌单广场、播放页等既有调用点样式完全不变，只有显式传值的页面才变宽；
- 单位用 `px` 而不是 `rpx`：`rpx` 会随窗口放大（§6.6），宽屏下同一个值会膨胀数倍。

### 6.10 `qt-segmented` 横向滚动（2026-10 新增 `scrollable`）

排行榜页的音源 tag 数量由数据包决定（官方包 6 个，v3 老包 4 个）。均分模式下 tag 一多，每个都被压到放不下文字；改成自适应宽度后又放不进一行。为此新增可选 prop：

```ts
type Props = {
  list: string[];
  modelValue: number;
  itemGap?: number;
  scrollable?: boolean; // 默认 false = 各 tag 均分整行（flex:1）
};
```

```vue
<!-- scrollable：音源数量随数据包变化，标签多了要能横向滑，不能让文字被压扁 -->
<qt-segmented :list="sourceLabels" v-model="sourceIndex" scrollable @change="onSourceChange" />
```

实现与约束：

- `scrollable=false`（默认）保持原样：`.seg-flex` + `.seg-item{flex:1}` 均分整行，适合 2-4 个固定短标签，登录/搜索/分享卡片等调用点完全不变；
- `scrollable=true` 换成 `.seg-scrolllist`（横向 `scroll-view`）+ `.seg-auto`（`flex-direction: row; flex: none`）+ `.seg-item-auto`（`flex: none` + 左右内边距），每项按内容宽度铺开；
- **横向 `scroll-view` 的内容在原生端不会自动撑开**，必须给内容行一个显式 px 宽度（同 `pages/playlists` 的 `cat-rows`、`pages/theme` 的 `skin-row`）。不显式给宽度的实测后果：`flex:none` 的子项被压回可视区宽度内，6 个音源只渲染出 4 个，第 5 个被裁在卡片右边缘 —— 看起来像「数据包只给了 4 个音源」，实则是布局裁切。内容总宽由 `autoRowWidth` 按「每字宽度 + 内边距 + itemGap」估算累加（Vapor 下拿不到真实文本测量，口径同 `pages/playlists` 的 `textWidthRpx`）；
- 宽度估算的系数要**取略大的值**（中文 1.06 em、非中文 0.82 em，由真机实测反推：`fontPx=44.37` 时「网易云音乐」5 字实测 233px、「QQ音乐」扣掉汉字后每字母 0.81 em）。估小了内容行比真实文字窄，滚到最右时最后一个 tag 仍会被裁掉，等于没修；
- 同时给 `scroll-view` 绑定显式 `height`：交叉轴没有确定尺寸时原生端同样不参与手势处理，横向拖动会被外层纵向列表吃掉；
- 文字宽度估算要乘 `fontScale.scale`（§6.6 全局字号）：用户把字号调到「大」时 tag 会变宽，不乘就会在尾部裁掉最后一个音源；
- 宽屏走 `.seg-item-auto-wide`（`padding: 12px`）与 `.seg-item-wide`（`height: 36px`），`autoPadPx` / `rowHeightPx` 内部按 `layout.isWide` 分支，与 CSS 覆盖保持同源；
- **外部改选中项时要把选中 tag 对位进来**：绑定 `:scroll-left="scrollLeftPx"`，值由 `selectedOffset`（选中项左边缘在内容行中的偏移）算出。不做这一步时，进页面从 `sourceStore` 恢复上次音源、或异步换包后重算选中项，内容行都停在起点 —— 选中第 5/6 个音源时**整行看不到任何选中态**，用户看到的仍然只有前 4 个，观感与 §6.10 开头那个「数据包只给了 4 个音源」的误判完全一致；
  - 用 `scroll-left` 而不是 `scroll-into-view`：后者在原生端不可靠（`pages/player` 已记录 list-item 复用会滚错位置、动画中途冻结），`scroll-left` / `scroll-top` 才是 1:1 生效的机制；
  - `watch(selectedOffset, ..., { immediate: true })`：恢复选中项发生在首帧之前，不是响应式变更，不加 `immediate` 就永远不会对位；
  - 用户点击选中项**不**对位（能点到的 tag 必然已可见，滚过去只会让可见标签无谓跳走）：`select()` 记下 `userSelectedIndex`，`watch` 回调里与 `modelValue` 比对后跳过。用 index 比对而不是布尔标志，是为了在父组件没接 `v-model`（非受控、`selectedOffset` 不变）时自愈，不把之后真正需要的外部对位一起吞掉；
  - 目标值超过最大滚动量时由原生 `scroll-view` 自动夹到末端，选中最后一项也不会在右侧留出空白。

### 6.11 批量选择与批量管理条（2026-10 新增 `use-batch-select.ts` + `qt-batch-bar`）

从 PC 端 `qt-pc/src/components/discovery/BatchBar.tsx` 移植的批量管理能力：进入选择态后整页勾选，一次性批量下载 / 批量收藏。

选择态本身是纯 UI 状态，与业务无关，抽在 `composables/use-batch-select.ts`：

```ts
export function qtSongKey(song: Song): string; // platform + ":" + id

const {
  selecting,  // Ref<boolean>
  keys,       // Ref<string[]>
  count,      // ComputedRef<number>
  enter, exit, clear,
  isSelected, toggle, toggleAll, allSelected,
} = useBatchSelect();
```

- **key 必须带 platform**：各音源 id 空间独立，只用 `song.id` 会让「网易云的 12345」和「QQ音乐的 12345」互相顶掉；同一约定已用于 `pages/playlist` 的 `list-item :key`；
- **`exit()` 必须清空 keys**：只把 `selecting` 置 false 会让上次的勾选在下次进入时复活（观感是「一进来就选中一片」）；
- **`toggleAll(allKeys)` 的入参是「当前可见集合」**：页面若有筛选/搜索，传全量会让「全选」勾上屏幕上看不见的歌，回执里的条数也对不上；
- `allSelected(allKeys)` 在 `allKeys.length == 0` 时返回 false，空列表不会显示成「已全选」。

管理条 `qt-batch-bar`：

```ts
type Props = {
  count: number;              // 已选条数
  total: number;              // 可见集合总数（全选的基数）
  size?: "md" | "lg";         // 默认 md，只对 bar 档生效
  layout?: "bar" | "column";  // 默认 bar（横向单行）；column = 竖排两行档（2026-10-19 新增，宽屏左栏专用）
};
// emits: toggle / download / collect / cancel（单小写单词，同全仓库事件命名约定）
```

```vue
<view class="list-head">
  <qt-batch-bar
    v-if="selecting"
    :count="selectedCount"
    :total="tracks.length"
    size="md"
    @toggle="toggleSelectAll"
    @download="onBatchDownload"
    @collect="openBatchCollect"
    @cancel="exitSelect"
  />
  <template v-else> ...常规页头... </template>
</view>
```

宽屏不再是这条吸顶 bar：详情页左栏封面块里原地换档（详见下面接线要点）：

```vue
<view class="whero-actions">
  <qt-batch-bar
    v-if="selecting"
    layout="column"
    :count="selectedCount"
    :total="tracks.length"
    @toggle="toggleSelectAll"
    @download="onBatchDownload"
    @collect="openBatchCollect"
    @cancel="exitSelect"
  />
  <template v-else> ...播放全部 / 加入队列 / 批量按钮组... </template>
</view>
```

布局契约（**用错就会错位或塌陷**；`layout` 两档，2026-10-19 起默认 `bar`）：

- **bar 档（横向单行，窄屏吸顶用）**：不自带外框、背景、外边距，边框由宿主给 —— 它要和宿主原来的页头/hero 共用同一层容器；**必须放进横向 row 容器**，根节点是 `flex: 1`，靠撑满宿主行来占位，直接塞进纵向容器会得到一条宽度塌陷的条。`md` 高度 96rpx / 60px，与列表页头 `.list-head` 同值；`lg` 高度 132rpx / 76px（随每日推荐页并入歌单详情模板后**暂无调用方**，保留档位备用）。**两档都必须与宿主行等高**，否则切换选择态时整页会上下跳一下；
- **column 档（竖排两行，宽屏左栏专用）**：全选行（复选框 + 已选计数，整行都是命中区）+ 下载 / 收藏 / 取消三颗等分按钮（各 `flex:1`、40px 高、20px 圆角，禁用态 `opacity:0.4`），整体自然高度 —— 供宽屏详情页在左栏封面块内原地替换常规按钮组，**不要**放进 row 容器、也没有「与宿主行等高」的约束（它是独立块，不是行内替换）；
- `size` 只影响 bar 档的高度与按钮内边距；`layout` 不改变事件与内部语义（`toggle` / `download` / `collect` / `cancel` 两档一致，勾选命中区 → 已选计数 → 下载 / 收藏 / 取消的顺序也不变）。

宿主页接线要点（`pages/playlist`、`pages/daily`、`pages/artist` 三个调用点；2026-10-19 起每日页、2026-10-22 起歌手页与歌单详情页同一套模板，接线一致）：

- 行组件 `qt-song-row-lite` **已内置选择态**（`:selecting` / `:selected` / `@select`），宿主不要再自己加复选框。旧每日页的自绘卡片曾需要 `view.song-check` 占位（勾选框出现/消失会顶动右侧信息），并入 `qt-song-row-lite` 后这条不再需要；
- **行点击只留一条通路**：`qt-song-row-lite` 自己发 `@play` / `@select`，宿主 `list-item` 再绑 `@click` 会让一次点击触发两遍（组件发一次、冒泡到外层又一次），选择态还会「勾上又播放」。歌单详情页保留双层绑定，靠宿主点击处理里的 `if (selecting.value) return;` 早退兜底；每日页（2026-10-19 重写）不绑外层 `@click`，单靠组件事件，无此守卫；
- 选择态下隐藏单曲动作（红心 / 更多 / 播放圆）——与 `qt-song-row-lite` 内部行为一致，避免误触，也避免「批量整理时还能单曲收藏」的语义混乱；
- **宽窄屏操作条分家（2026-10-19）**：窄屏管理条照旧吸顶 `.list-head`（`md` 档）；宽屏的操作（播放全部 / 加入队列 / 批量入口，含选择态批量条 `column` 档）全收进左栏封面块 `.whero-actions`，列表顶不再有任何操作条 —— 对齐 qt-pc 的页头管理（批量条嵌在封面下方），悬浮操作条要么全收要么全留，避免「去掉一些保留一些」的混搭观感。宽屏常规态规格：播放全部 44px 高 / 22px 圆角、accentSoft 底 accent 字 13px；加入队列与批量 40px 高 / 20px 圆角、surfaceMuted 底两等分；图标 16。左栏加载骨架（`wsk-l5` 收藏钮 / `wsk-l6` 播放全部 / `wsk-l7` 两等分，歌单页多一层收藏）逐项同尺寸对齐；
- **外框不随选择态切换变化（两屏同原则）**：窄屏批量条切进切出只换 `.list-head` 的内容（外框 = 中性面 `surfaceStrong` + 边框），宽屏 column 批量条在 `.whero-actions` 原地替换按钮组（外框 = 左栏信息卡 `.whero`），页面都不跳。旧每日页「强调色 hero、进选择态换中性底」的做法（**只换底色、不补 `border`**——hero 定高 + 默认 `content-box`，加边框整条高出 2px）随 hero 移除一并成为历史。
- **`<sticky-section>` 只能有两个直接子节点（鸿蒙端硬约束，2026-10-19 首编实证）**：恰好一个 `<sticky-header>` + 一个 `<list-item v-for>`。Android 端编译不检查，app-harmony 会直接报 `error: <sticky-section> must contain exactly one direct <sticky-header> and one direct <list-item v-for>.`（当时每日页把空态 `list-item` 塞进了 section，鸿蒙首编即失败）。空态 / 骨架 / 加载更多等杂项 `list-item` 一律作为 section 的兄弟节点放在同一层 `list-view` 里，不要塞进 section。
- **搜索页标题栏常驻搜索态（2026-10-24，用户要求「搜索这行放到标题栏，聚合也放到标题栏」）**：手机档搜索页把输入框 + 音源 + 聚合开关整体收进 `qt-page-frame` 标题栏，正文直接从分类条开始。框架的搜索态因此扩展出三个可选能力（都是加 prop，不传零影响）：①搜索框左侧放大镜与键盘「搜索」键都可提交（`headerSearchConfirm` 事件）；②搜索框右侧**文字药丸** `headerChipTexts` / `headerChipActives`（下标对应），点击发 `headerChipTap(index)`——搜索页用 [当前音源, 聚合搜索] 两个药丸，音源药丸点开与 `qt-source-switcher` 同一份注册表清单（页内自带 qt-action-sheet，选完 `setSource` + `ensureSource` 重搜），聚合药丸 = 开关，选中态 accent 底 onAccent 字。搜索页传 `header-searching` 常驻，关闭图标只清词不关态。宽屏不画标题栏（框架约定），所以宽屏保留原页内搜索行 + 聚合行（`v-if="layout.isWide"`）；`qt-source-switcher` 组件保留（首页仍用）。
- **每日页与歌单详情页同款标题栏 + 搜索 + 排序（2026-10-24 对齐）**：每日页接入与歌单详情完全相同的框架标题栏接线（`title` 固定「每日推荐」、`headerActions = ["search","more-vert"]`、`header-searching` 原地换搜索框、`header-title-visible` 滚过吸顶操作条后才露标题——`#pl-head` + `#daily-scroll` 量阈值，`measureHeadOffset` 重试结构照抄）。列表内搜索行从「常驻」改为**只在宽屏点左栏 `.whero-tools` 搜索图标后出现**（与歌单详情同款：窄屏搜索走标题栏，宽屏入口在封面块）；`.whero-tools` 同时带三点入口，打开与歌单详情同一套「更改歌曲排序方式」两级菜单 + 键与方向组合排序弹窗，纯前端排序作用在过滤后的可见集合上。每日页保留的差异只有三处：不提供收藏红心、封面取第一首歌的图（`displayPicUrl`）、信息卡数量行「共 N 首」恒显（歌单详情仅专辑态显示）。

批量收藏复用 `qt-playlist-picker` 的 `batchMode`（见 §6.12）：面板里每一行是一个歌单，整批歌**全在里面**时该行显示已勾，点下去是取消收藏（`removeSongsFromPlaylist`），否则只补缺的那些（`importSongsToPlaylist`），已在里面的静默跳过 —— 与单曲红心「点一下加、再点一下删」完全同构，因此**不设单独的「批量取消收藏」按钮**。同名不同音源冲突先弹确认（复用 `services/collect-dup.ts` 的 `collectDupMessage`），确认后才写。

宿主侧的列表刷新必须走 `toggleCollect` 的 `onChanged` 回调，不能在该调用之后直接调：同名冲突时真正的写库发生在 `uni.showModal` 的确认回调里，`toggleCollect` 那时已经返回，紧接着刷新拿到的是写之前的旧快照。歌单详情页的本地歌单列表是 `player.songsOfPid(pid)` 的快照（不是 store 上的活引用），批量增删后必须重取；每日新歌页不是任何歌单的详情页，不需要刷新，也不需要在「从当前歌单摘歌」时退出选择态。

回执统一走 `qt-toast-host` + `stores/toast.ts`，在**屏幕底部水平居中**显示（成功/普通 3s、出错 6s 自动消失，`bottom` 让开底部 TabBar；宽屏无 TabBar 时贴底留 24px）。全站入口只有一个：`services/toast.uts` 的 `qtShowToast()`，**不要再调 `uni.showToast`**（原生 Toast 的位置/字号/黑底由各家 ROM 决定，安卓与鸿蒙长得不一样；2026-10 已把 249 处调用一次性迁过来）。**回执不写进页头行**：文案长度会改变页头宽度，把右侧按钮推来推去、标题跟着抖（PC 端同款决定）。

批量写库必须避免 O(N²)：`player.ts` 的单曲方法（`addSongToPid` / `removeSongFromPlaylist` / `enqueueLikeOp`）每次都会 `persist()` + `saveLikeSync()` + `flushPendingOps()`，逐首循环 40 首就是 80 次全量存储写入（含整个待推送队列重写），实测卡到秒级。因此批量路径直接 `this.pendingOps.push(...)` 累积，循环结束后统一 `persist()` / `saveLikeSync()` / `flushPendingOps()` 各一次，并返回真实生效条数用于回执（`importSongsToPlaylist` / `removeSongsFromPlaylist` 都是这个结构）。

批量下载**不提高并发**：音源 CDN 按 IP 限流，50 个并发取 URL 会被判定为爬虫（PC 端 `DOWNLOAD_CONCURRENCY = 3` 同款结论），所以批量只是把歌一次性塞进下载队列，仍由 `stores/downloads.ts` 的并发闸门逐首跑；本地歌曲（`platform == "local"`）跳过不下载。

**断点续传的清理契约**（`stores/downloads.ts`，2026-10-20 用户报「下载管理里显示已完成、私有目录还留着 150MB `.part`」后定稿）：`.part` + `.part.meta` 落在 `USER_DATA_PATH/qt-download-parts/`，`partKey = platform__id`。五条铁律：① **暂停→继续（`resume`）保留断点续传**，这是唯一保留残留的路径，否则一首 150MB 的无损每暂停一次就要重下；② **手动重试（`retry` / `retryAllFailed`）丢弃残留重下**——上次可能是换了音源或换了音质（320k 与无损总长不同），接着续传只会把两种编码拼进一个文件；③ **取消（`removeTask` / `cancelAll`）与终态失败（自动重试耗尽）也要清残留**，失败任务不会自动重启，留着只是白占空间；④ **`clearPart` 删完必须 `statSync` 复查**，同步 `unlinkSync` 失败一律 `catch (_) {}` 吞掉，不复查就分不清「删失败」和「本来没有」——复查到还在改异步 `unlink` 补刀并写 `qtDiag`（2026-10-20 的现场就是删失败被吞、记录照样写「已完成」）；⑤ **成品与断点同路径时不许清残留**：续传路径的 `tempPath` 就是 `.part`，若某平台 `saveFile` 原地留下文件且 `savedFilePath` 指回同一路径，一刀就把刚下完的文件删了、只留一条指向空文件的「已完成」，所以 `plainPath(savedPath) != plainPath(tempPath)` 才 `clearPart`。

### 6.12 `qt-playlist-picker` 批量模式（2026-10 新增 `batchMode` / `subtitle` / `toggle` / `create`）

同一套批量流程要复用「选歌单」面板，但单曲语义与批量语义不能共存：单曲面板本地维护一份勾选、按「确定」整份提交（`applyPickerSelection`），批量面板每点一行就要立刻落库、勾选态由宿主算出来回灌。**因此批量场景挂载第二个 picker 实例，而不是给同一个实例加模式开关** —— 两套状态机（本地 `selectedPlaylistIds` 的 splice 提交 vs props 单向回灌）混在一起会互相污染。

```ts
type Props = {
  visible: boolean;
  song: any;                  // 批量模式传 null
  playlists: Playlist[];
  selectedIds: string[];      // 勾选态的唯一来源
  title?: string;             // 默认「选择歌单」
  subtitle?: string;          // 默认「选择歌单」，批量模式传「已选 N 首」
  anchorTop?: number;         // px，来自触发元素；<0 则居中偏上
  batchMode?: boolean;        // 默认 false
};
// emits（新增两个，原 update:visible / confirm 不变）
//   (e: 'toggle', playlistId: string)
//   (e: 'create', name: string)
```

- `subtitle` 是为批量模式开的：面板头部原来写死「选择歌单」，批量时这里要显示已选条数。默认值保持原样，既有调用点渲染结果不变；
- `batchMode` 下 `togglePlaylist` 只 `emit('toggle', playlist.id)` 后早退：**不在本地改勾选、也不关面板**。本地先改会和宿主回灌的值打架（宿主的判据是「这批歌是否已整批在该歌单里」，只有拿得到 songs 的那一层算得出来），面板在批量模式下是纯受控的；
- `batchMode` 下 footer 换成「新建歌单输入行 + 新建 + 完成」，去掉 取消/确定（没有「整份提交」这个动作了）；
- 新建输入行做在面板内，不用 `uni.showModal({ editable: true })`：该输入框在 App 端不渲染（`pages/source-pack`、`pages/settings` 均已记录并改成页内输入层）；
- `submitCreate()` 按下即 `newName.value = ''` 再 `emit('create', name)`：按钮语义是「建这一个」。空名直接 return（不发事件）；重名由宿主 `createLocalPlaylist` 返回 null，宿主弹红字回执，用户重打 —— 面板内不回传失败原因，避免多一条状态通路。

### 6.13 下载设置页与自定义下载目录（2026-10 新增 `pages/download-settings`）

下载设置从设置页里拆成独立一页（`pages/download-settings/index`，`:max-width="640"`），因为它现在有 5 个选项 + 2 个开关，塞在设置页里既长又和「清除数据」等危险项挤在一起。

**保存位置三态**（`stores/downloads.ts` 的 `customDir`）：

| 状态 | 设置页显示 | 落盘参数 |
| --- | --- | --- |
| 默认 | 第一行值 = `/Download/QtDownload/Music`，无第二行 | `dirType="download"`, `subDir="QtDownload/Music"` |
| 自定义 | 第一行值 = 绝对路径，第二行「恢复默认位置」出现 | 只传 `absDir`，`dirType`/`subDir` 被原生忽略 |

点第一行直接进系统文件管理器（PC 端同款交互：**行即入口，不再套一层 ActionSheet**）。三条前置判断，顺序不能换：

1. **鸿蒙先走自己的路** —— `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` / `..._DOCUMENTS_DIRECTORY` 是 **2in1（PC/平板）专属权限**，在 phone 上系统直接判 INVALID（2026-10-19 真机实证：hilog `[SPC][PermissionDialog][Model]: ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY not support.` + `terminate session with result, resultCode: 0, reqPerms: [...], result: [2].`，`2 = PermissionStatus.INVALID`）。所以手机上**不能**指望「授权 + 直写系统 Download」，那条路必然失败（旧实现的「公共目录写入失败，已存私有目录」就是这么来的）。正确做法是 `DocumentViewPicker.select({ selectMode: DocumentSelectMode.FOLDER })` + `fileShare.persistPermission([{ uri, READ|WRITE|CREATE }])`：系统选择器选目录、持久化 URI 授权，之后往该 URI 直写。该链路依赖 `FolderSelection` / `FolderAuthorization` 两个 syscap，真机实测均为 `true`（API 11 文档里「仅 2-in-1」的旧说法已被当前 ROM 推翻，以 `param get const.SystemCapability.*` 实测为准）。
2. Android 再查写权限 —— 原生落盘走 `java.io.File` 直写（自定义目录可能在 `Download` 之外，MediaStore 的 `RELATIVE_PATH` 只认 Download/DCIM/Music 白名单），没有「所有文件访问」必然写失败。**先查权限再选目录**：让用户选完再失败是更差的体验；
3. 权限就绪才 `pickDirectory()`。

鸿蒙的「权限管理 → 下载目录 / 文档目录」两条在 phone 上点不出授权弹窗（同上 INVALID），页面里保留条目只为 2in1 设备，phone 上点它会直接弹「请用应用内选择目录」并跳到本页（`pages/permissions/index.uvue` 的 `onPermTap` 短路）。鸿蒙自定义目录存的是**目录 URI**（不是普通路径），原生变量不跨进程，所以 App 启动时由 `stores/downloads.ts` 读 storage 后调 `restoreCustomDir(uri)` 喂回原生、原生再用 `fileShare.activatePermission` 激活持久化授权，否则重启后写入会抛 13900012。

`hasAllFilesAccess()` 的口径必须与原生 `queryPermissionStates` 一致：Android 11+（API 30+）看 `MANAGE_EXTERNAL_STORAGE`，更低版本看 `WRITE_EXTERNAL_STORAGE`（manifest 里 `maxSdkVersion=28`），两个都查、任一满足即可，页面不用再判系统版本。`unknown`（窗口未就绪）按已授权处理 —— 让原生侧去拦，比误拦用户更合适。

`ACTION_OPEN_DOCUMENT_TREE` **只用来反查真实路径**：`DocumentsContract.getTreeDocumentId` 把 `primary:Download/QtMusic` 还原成 `/storage/emulated/0/Download/QtMusic`。因为写文件用的是 `java.io.File` 而不是 SAF 流，所以**不需要** `takePersistableUriPermission`，代价是必须持有 `MANAGE_EXTERNAL_STORAGE`。写完后补插一行 `MediaStore.Audio.Media.EXTERNAL_CONTENT_URI`，让其它应用能看到这首歌。

用户在选择器里按返回（`message == "已取消选择"`）不弹 toast。改目录**只影响之后的新下载**：已下载记录里的 `path` 是落盘时的真实路径，不会失效。

### 6.14 播放设置页（2026-10 新增 `pages/play-settings`）

播放设置从设置页里拆成独立一页（`pages/play-settings/index`，`:max-width="640"`），把原来散在设置主页两组里的六行整体搬过来：默认倍速、定时关闭、均衡器、同时播放、播放默认音质、音乐缓存上限（含「自定义…」页内输入弹层）。

拆分理由与 6.13 相同：设置主页已有 9 组，这六行既不属于「数据/账号」也不属于「危险操作」，混在里面既长又难找。设置主页现在只留一行「播放设置」入口，行尾摘要 `playSummaryText()` 显示 `倍速 1x · 音质 无损`（定时关闭为「播完本曲关闭」时前置一段）。

**唯一数据源**：这六项的 ref（`currentRate` / `sleepMinutes` / `concurrentMode` / `cacheLimitMb`）与弹层状态只存在于 `pages/play-settings/index.uvue`，设置主页不再保留任何副本。设置主页的 `clearAll()` 仍会 `audioPlayer.setConcurrentMode(0)` 复位原生层，但**不再同步那个响应式副本**——播放设置页每次 `onShow` 都会重新对账（`audioPlayer.rate` / `getConcurrentMode()` / `getCacheLimitMb()` / `getGapless()`），所以清除数据后进页面看到的一定是真实值。

音质档位同理走 `registry.sourceQualities(sourceStore.current)`，`onShow` 里 `sourceStore.restore()` + `registry.ensure()`，切音源后重进页面自动收敛。

「自定义缓存上限」沿用页内输入弹层（不用 `uni.showModal({ editable: true })`，该输入框在 App 端不渲染——见 6.13 与 `pages/source-pack`）。弹层从设置主页整体搬来，样式类名保持 `cache-*` 不变，便于两处对照。

**无缝播放（2026-10 新增第七行）**：「播放行为」组末尾（同时播放之后）加一行「无缝播放」，与 qt-pc 的同名设置对齐（文案逐字相同：`提前加载下一首，缩短连续播放时的间隔。默认关闭；在线歌曲的衔接效果取决于网络和音源响应。`）。四条要点：

- **行内用自绘开关，不用 `<switch>`**：全仓没有用过 `switch` 组件、qt-ui 也没有开关组件，唯一范本是 `pages/equalizer` 的 `.toggle` / `.toggle-knob` + `knobClass` computed（`:class` 只能绑一个表达式，Vapor 后者覆盖前者，所以旋钮的 on/wide 组合拼在一个字符串里返回）。开关尺寸与 equalizer 一致（竖屏 92×52rpx、宽屏 46×26px），开关块放在 `.cell-right` 里。
- **带副标题的行**照 `pages/permissions` 的写法：`QtIcon + .cell-main(<text .cell-title> + <text .cell-desc>) + .cell-right`，`.cell-main{flex:1}`；`gapless-cell` 覆盖固定行高（`height:auto` + 上下 16rpx / 宽屏 10px 内边距），否则两行文字会被 96rpx 固定高度裁掉。
- **宽窄屏两处模板都要加**：本页两列分支与竖屏单列分支是模板双写（见文件头注释），同时播放行原本的 `cell-no-border` 移到新行上，否则组内会多出一条分隔线。
- **开关只落 storage，不下发原生**：`services/audio-player.uts` 的 `GAPLESS_KEY = "qt-playback-gapless"`（`"1"`/`"0"`，默认关闭）+ `getGapless()` / `setGapless()`，写法照 `getConcurrentMode/setConcurrentMode` 但不调任何 `audioSetXxx`——原生播放器没有「无缝」开关可配。

**「无缝」在 qt-uniappx 的真实语义 = 提前取链，不是接流**（与 qt-pc 的实现层次不同，别照 qt-pc 的 `maybe_preload` / `append_preloaded` 理解）：

- qt-pc（Rust）是「提前把下一首解码好并 `sink.append` 进同一条输出流」，边界处不 clear、不新建 Player、不淡入淡出（`src-tauri/src/audio/engine.rs` 的 `maybe_preload` / `append_preloaded`）。
- Android（media3）这边时间线本来就由 `LoadControl` 预缓冲下一条目，**缺口只在 JS 取链时机**：条目是 `qt-resolve://` 占位，真正加载那一刻才向 JS 要地址。所以提前把地址取好，无缝拼接天然生效。
- 鸿蒙原生侧是「一次只解析一首」的串行模型（单值 `gPendingMid`），没有时间线预缓冲，因此只能缩短取链时间，做不到真正接流。
- **提前调 `audioPlayer.resolveDone` 无效**：Android 的 `audioResolveDone` 在 `gPendingResolves` 没有该 mediaId 的挂起请求时直接丢弃（`uni_modules/qt-audio-player/utssdk/app-android/index.uts`），鸿蒙侧同样按 `gPendingMid` 单值判定。唯一有效的预热手段是**把地址写进 `musicApi` 的 urlCache**。

落点是 `stores/player.ts` 的私有方法 `preloadNextUrl()`：守卫 `getGapless()` / `playing` / `timelineIds.length >= 2` / 非 `sleepStopAfterCurrent` / 非单曲循环 / 非本地歌（本地歌直接推 `content://`，不走取链）；候选取时间线当前曲的下一项（`timelineIndexOf(current)+1`，越界环绕回 0，与 `next()` 的队列环绕一致）；用 `preloadMid` + `preloadAt`（`PRELOAD_TTL_MS = 5 分钟`，地址 TTL 10 分钟的一半）避免同一首反复取链；最后 `musicApi.playUrl(next, quality).catch(...)` 静默失败——只填 urlCache，不改 current / playing / 历史 / 时间线。调用点两处：`play()` 末尾（起播即预热）与 `onNativeTrackChanged()` 换歌成功后（链式预热，长播不断）。

### 6.15 本地音乐扫描范围与系统音过滤（2026-10 修复）

用户反馈「本地音乐只扫到几个文件夹，能不能整个手机存储都扫」。排查结论：**扫描范围从来不是问题**，MediaStore 本来就覆盖整块共享存储（实测 30 行），丢歌全在过滤环节。三处根因：

1. `app-android/index.uts` 的 `doScanAudio()` 用了 `MediaStore.Audio.Media.IS_MUSIC + " != 0"` 作为 selection。SQL 三值逻辑下 `NULL != 0` 求值为 NULL（假），媒体库里 `is_music` 为 NULL 的行——手工插入的、标签尚未补全的——被整行丢掉。
2. 紧接着的 `if (title.length == 0 || durationMs <= 0) continue;` 会把这些行再丢一次（它们的 TITLE 和 DURATION 都是 NULL）。
3. 真正制造出这些 NULL 行的源头是 `saveAbsolute()`：自定义下载目录走 `java.io.File` 直写后，它手工 `insert` 了一条只带 `DISPLAY_NAME` / `MIME_TYPE` / `DATA` 的 MediaStore 记录。记录一旦存在，媒体扫描器就不会再去解析文件头补标签，于是 TITLE、ARTIST、DURATION、IS_MUSIC 永远是 NULL。

**修法**：

- `doScanAudio()` 不再传 selection（`null`），返回完整音频池，并顺带把 `IS_MUSIC` 作为附加信息读进 `LocalAudioItem.isMusic`（`-1` 表示该列不存在或为 NULL，即「未知」）。它**不参与过滤**：我们自己的下载记录就是 NULL，当成「非歌曲」会立刻误伤。
- `TITLE` 为空时退回 `DISPLAY_NAME` 并去掉扩展名；时长缺失的行照常列出（显示 0 秒）。只对「连文件名都取不到」的行 `continue`——否则列表里会出现点不动的空白行。
- `saveAbsolute()` 与 `saveLegacy()` 的媒体库登记改走 `MediaScannerConnection.scanFile()`，由扫描器真正解析文件头。UTS 侧数组要用 `paths.toKotlinList().toTypedArray()`（`[...]` / `arrayOf()` 都不行，原因同 5.3 里 projection 那条）。

**系统音怎么判**：不看 `is_music`，只看路径。`Ringtones/` 下 34–48 秒、标题完整的歌同样是 `is_music=0`，而 392 毫秒的应用按钮音效是 1——这个标记衡量的是目录名，不是内容。所以页面层 `isSystemSound()` 按路径标记（`/ringtones/`、`/notifications/`、`/alarms/`、`/recordings/`、`/cache/`、`/kugouring/`、`/android/data/`、`/android/obb/`）判定，默认排除。

**过滤放在页面层**（`applyRule()`），不在原生层：开关一切立刻重算，不用重新扫描；原生层始终返回完整池子。开关状态存 `qt-local-include-system`，入口有两个——导入配置页的扫描规则卡片（该卡片由单行改为上下两行：数值行 + 开关行），以及列表页右上三点菜单（勾选标记用 `QtIcon name="check"` 而非 ✓ 字符，静态检查器禁止把符号字形当图标；`margin-left: auto` + 固定尺寸容器保证菜单宽度不跳动）。

### 6.16 歌单详情的收藏红心统一（2026-10 修复）

**用户原话**：「把本地歌单详情的删除和在线歌单收藏保持一致为红心收藏」。追问后定稿：**本地歌单的「取消收藏」就是删除**，但必须二次确认。

改前本地歌单详情页 hero 里是一颗红色垃圾桶按钮（窄屏圆钮内是 `font-size:12px` 的「删除」二字，宽屏是整条「删除歌单」胶囊），与在线歌单的红心并排两套语义。现在两处都只剩**一颗红心**：

| 场景 | 红心状态 | 点击 |
| --- | --- | --- |
| 在线歌单 | `player.isPlaylistSaved(pl)` | `toggleSavePlaylist` → 「已收藏歌单」/「已取消收藏」 |
| 本地歌单（`platform === 'local'`） | 恒为实心 `heart-fill` | 弹确认框，确认后 `deleteLocalPlaylist` |

**为什么本地歌单红心恒为实心**：`isPlaylistSaved()` 只扫 `savedPlaylists`，而本机建的歌单在 `localPlaylists` 里——照原样调用它，本机自建歌单的红心永远不亮。语义上「自己的歌单」按定义就在收藏里，不存在「未收藏」这个状态，所以在 `playlistSaved` 计算属性里对 `platform === 'local'` 直接 `return true`，不去改 store 的判定（那会影响收藏列表页的其它调用点）。

**为什么本地歌单不走 `toggleSavePlaylist`**：它做的是「从 `savedPlaylists` 增删一条元数据 + 推一条 likePlaylist 增量」，而删本地歌单要摘掉整个歌单（`deleteLocalPlaylist` 会同时清理 `localPlaylists`/`savedPlaylists` 并按 pid 移除歌曲归属）。两者不可互换，所以 `toggleSave()` 在开头按平台分流。

**确认文案必须说清后果**：标题从「确认删除」改为「取消收藏」，正文点明「本地歌单取消收藏即删除：该歌单内的歌曲收藏将一并移除；其他歌单中的收藏不受影响」——否则用户会以为只是从收藏列表摘掉、回头还能再加回来。

**同时删掉的死代码**：`isDeletableLocal` 计算属性、`.delete-btn` / `.delete-btn-text(-wide)` / `.whero-del` 三个样式类，以及随之不再使用的 `qtFontDualPx` 导入。静态检查器不查未使用的 CSS 类和导入，所以这类残留只能靠人工清理——改动后 grep 一遍类名确认无引用。

### 6.17 全站加载态统一为骨架屏（2026-10 `qt-skeleton-list`）

**需求（用户原话）**：「你帮我把全部页面的加载都需要使用【骨架屏】」——所有页面的转圈
（`qt-loading`）和「加载中...」文案都要换成骨架屏。

**为什么新增 `components/qt-skeleton-list/` 而不是每页手写骨架**：§6.7 的接法是「页面自己把
真实行复制一份、逐节点写骨架几何 + 自己挂光带 + 自己排错峰时间轴」。全站十几个页面照抄一遍，
每个页面 ≈32 条内联 `style` 字符串，几何还会各自漂移。把「形状」抽成一个组件后，页面只剩
`kind` + `rows` 两个必填 prop。

**为什么形状是个 `kind` 枚举而不是基于 `qt-skeleton` 拼**：`qt-skeleton` 是单块原语，一行
媒体行要 4 个块（封面 + 两行文字 + 尾部控件），一屏 6 行 = 24 次内联样式计算 + 24 个组件实例；
`kind` 方案下这些是静态扁平 class，且每个形状的尺寸都逐条对齐一个真实行类：

| `kind` | 对齐的真实行 | 竖屏 / 宽屏 行高 |
| --- | --- | --- |
| `song` | `qt-song-row-lite`、`pages/search` `.row`、`pages/playlist` `.song-item`、`pages/daily` `.song-item`（2026-10-19 起） | `128rpx` / `82px` |
| `row` | 首页 `.song-row`、`.wide-song-row`、`.wide-chart-row`（封面 + 两行文本 + 尾部播放钮，**无** 右侧箭头） | `136rpx` / `54px` |
| `tile` | 首页 `.shelf-card`、`.wide-playlist-card`（竖卡：方形封面 + 两行文字） | 封面 = 卡宽 |
| `card` | 列表卡：两行文本 + 播放钮 + 更多（原 `pages/daily` `.song-card`；该页 2026-10-19 并入歌单详情模板后**已无调用方**，形状保留备用） | `124rpx` / `62px` |
| `chart` | `pages/chart` `.chart-row`（+ 右侧箭头；**已无调用方**，2026-10-24 起排行榜改用 `rank`，形状保留备用） | `116rpx` / `54px` |
| `rank` | `pages/chart` `.rank-card`（QQ 式榜单卡：卡头标题 + 左封面右三行歌） | `≈296rpx` / `≈156px` |
| `notice` | `pages/notice/list` `.n-item`（图标 + 标题 + 摘要 + 箭头） | 自适应 |
| `feedback` | `pages/feedback` `.fb-item`（徽标 + 标题 + 正文 + 时间/发布） | 自适应 |
| `text` | 公告详情 / 歌词这类纯段落 | 单行 `26rpx` / `15px` |

**`row` 与 `song` 的区别**：`song` 对齐的是「曲库/搜索/歌单详情」那种带红心与更多按钮的行，
行尾要留两个控件位；首页的行尾只有一个播放钮，右侧也没有箭头，用 `song` 会多出两块占位、
`chart` 会多出一个箭头，所以补一个 `row`。它的分隔线在竖屏走 `border-bottom`、宽屏走
`border-top`（真实行 `.wide-song-row` / `.wide-chart-row` 就是上边框），两个色都写进 `cardSurface`，
避免宽屏下每条分隔线错位一格。

**`tile` 的三个专属 prop**：`cardWidth` 同时决定卡宽与方形封面边长（真实卡面就是「封面 = 卡宽」）；
`gap` 覆盖形状自带的横向间距——首页歌单架的间距是按窗口宽算出来的（`shelfGapPx`），
组件里算不出来；`nowrap` 决定单行横滑还是换行网格（首页竖屏歌单架 vs 宽屏歌单网格）。

**`columns`**：`>1` 时每块按 `100/columns%` 切分并换行，用于首页宽屏两列歌曲行那种「`width:50%` 定宽」
的真实行（旧每日推荐页的宽屏两列随 2026-10-19 模板合并消失）。骨架单列铺满时用不上。

**三种接入形态（页面按容器类型三选一）**：

1. **`scroll-view` / 非虚拟列表 → 整层覆盖 + 错峰浮现**：外层 `.sk-host{position:relative}`
   同时包住真实行与骨架层，真实行 `:style="reveal.itemStyle(i)"`，骨架层后写（天然画在上层），
   传 `:revealed="reveal.revealedCount.value"` / `:lifted` / `:shining`。`pages/chart`、
   `pages/search`（综合 Tab）走这条。
2. **原生 `list-view`/`list-item` → 骨架独占一条 `list-item`**：`v-if="loading && items.length == 0"`
   包一个 `QtSkeletonList`，全部用默认值（`revealed=0` 即所有骨架行常显、`lifted=false`、
   `shining=true`），数据到了整条 `list-item` 被真实行替换。`pages/artist`、`pages/daily`（2026-10-19 起）、`pages/notice/list`、
   `pages/playlist`、`pages/search`（四个分 Tab）走这条。
3. **首页（多块独立数据源、逐块上屏）→ 逐块 `v-if`，不进 overlay、不做错峰**：
   每块各自 `v-if="loading && <该块数组>.length == 0"`，骨架写在真实 `v-for` 前面，
   全部默认值。`pages/home` 走这条。

**为什么 `list-item` 方案要放弃错峰浮现**：仓库里 `<list-item[^>]*:style` 的匹配数是 **0**——
从来没有哪个 `list-item` 带过内联样式。要按行错峰就得把 `:style` 绑到原生单元格上，风险大于
收益；而骨架层与真实行的高度相同（`list-item` 是固定高度），整条替换不会留白闪。因此这四页
不引入 `use-qt-reveal`。

**`list-item` 方案的三条硬约束**（照抄同页 `empty-item` 的既有写法）：

- 骨架条目**恒只有一个子节点**（`QtSkeletonList` 本身）；
- 高度**写死**（`pages/search` 的 `.sk-item` 是 `640rpx`/`410px` = 5 行 × 行高），
  因为 §6.7 注释里的同一条教训：`list-view` 虚拟滚动按可变高度预估会抖动；
- 位置放在 `v-for` **之前**（尾部状态条目仍在最后），不要夹在 `v-for` 与尾部之间。

**为什么首页用第三种**：首页没有 `list-view`，但它是三路并发（推荐歌单 / 榜单 / 新歌）且
**各自到达即上屏**——用第一种的整层覆盖，任一源晚到就得让整页骨架陪着等；用逐块 `v-if`，
先到的块立刻换成真实行，晚到的块继续扫光。又因为 `v-if` 每次加载都重挂新实例，
`revealed`/`resetReveal()` 那套记账在首页纯属开销（组件重新挂载时 `revealedCount` 天然回到 0），
所以不引 `use-qt-reveal`、不传 `lifted`。骨架是非 lifted 的 `position:relative` 正常流，
正好占住真实行的位置，不会盖住内容。

**骨架组件不能直接当 `flex-direction:row` 容器的子节点**：组件根节点是 flex item，塞进
`row` 或 `row+wrap` 网格里会被压成内容宽，`width:50%`、`100/columns%` 的基准全错、换行也失效。
首页因此在 `.wide-song-grid` / `.wide-playlist-grid` 里各包一层 `.sk-fill{width:100%}`。

**`revealed` 的语义与 `reveal.resetReveal()` 的强制性**：`revealed` 之下的行 `opacity:0`、
之上的行 `opacity:1`（与真实行互补）。`revealedCount` 在一轮结束时停在 `QT_REVEAL_ALL(999999)`，
所以**每一轮加载开头都必须 `reveal.resetReveal()`**，否则第二轮 `i >= 999999` 恒不成立、骨架
行永远透明。同理 `startReveal(n)` 的 `n` 要取 `Math.min(真实行数, SKELETON_ROWS)`——榜单/每日
推荐可能几十行，逐行错峰要好几秒。

**页面另需两个初值修正**：

- `loading` 初值必须是 `true`（原先多为 `false`）：加载在 `onMounted`/`onShow` 里发起，
  首帧若按 `false` 渲染会先闪一下「暂无数据」空态，再跳到骨架；
- 骨架容器**不要复用页面的 `.empty`**：那里通常带 `padding:140rpx 0` + 居中，会把骨架压窄。
  新建 `.sk` / `.sk-item`，`padding:0` + 与真实行相同的左右内边距。

**`pages/chart` 骨架三处修正（2026-10，用户反馈「排行榜的骨架屏不全」）**：

1. 骨架层原先直接挂在 `.sk-host`（`row+wrap`）下，正中上面「骨架组件不能直接当
   `flex-direction:row` 容器的子节点」那条禁忌，被压成内容宽 → 按首页接法包一层
   `.sk-fill{width:100%}`；
2. 竖屏下骨架行**自己没有宽度**：`.qt-skl-mrow-chart` 只在 `cardWidth > 0` 时才有行内 px 宽，
   而真实 `.chart-row` 是 `width:100%`，于是灰色条只有「封面 + 两行文案」那么宽 →
   页面按实测 `scroll-view` 宽减去 `.chart-grid` 的左右 `24rpx` 内边距，把 px 行宽传给
   `cardWidth`（宽屏照旧传网格卡宽；Vapor 下百分比宽度要有定宽父级，不能用 `width:100%` 糊）；
3. 块数由写死 6 块改为按「一屏能铺多少块」算：`实测可视高 ÷ 单块步长` 向上取整、再 +1 块
   兜住折行边缘，宽屏再乘列数（2/3/4），并保留「真实行更少时骨架跟着收窄」的分支——
   写死 6 块时竖屏只盖住半屏、宽屏 4 列只盖住一行半，下面一大片空白。错峰 tick 数**单独**
   封顶 16 块：宽屏 4 列时块数可达 40+，逐块 60ms 要两秒多，真实内容会迟迟不亮。

**故意保留转圈的场景（不算「页面加载」）**：

| 场景 | 位置 |
| --- | --- |
| 列表底部「加载更多」 | `pages/playlists:140`、`pages/artist:151`、`pages/feedback:67`、`pages/search` 四个分 Tab 的 foot-item |
| 长耗时操作遮罩（扫描/导入/下载/打卡） | `pages/playlist-import`、`pages/collection`、`pages/source-pack`、`pages/profile`、`pages/download` 的 `beginLoading` |
| 分享卡内的歌词占位 | `pages/share-card`（用 `kind="text"`，但 `:shining="false"`——那块会被截图导出） |

**已知取舍（2026-10-22 已收口）**：`pages/artist` 曾有自己的 `.row-item-wide`(20px) 套 `.lite-row-wide`(24px) = 44px 缩进，
与 `.list-head-wide` 的 24px 不一致，靠骨架侧 `.sk-item-wide` 补 20px 勉强对齐。歌手页并入歌单详情模板后
真实行改为 `.song-item-wide { height: 82px }`（缩进完全交给 `qt-song-row-lite` 的 `.lite-row-wide` 24px），
`.row-item-wide` / `.sk-item-wide` 一并删除，`pages/playlist` 与 `pages/artist` 两页现在逐项同值。

### 6.18 宽屏工具页就地托管与保活（2026-10 新增 `qt-wide-workspace`）

宽屏 rail 的五个工具入口（搜索/每日推荐/歌单广场/排行榜/设置）不再「导航到页面」，而是把目标页作为**组件**挂进当前 tab 页（官方 page-as-component，HBuilderX 4.71+，`docs/page.md`、`docs/adapt.md`）。

**为什么必须这么做（真机取证，MuMu 1920x1200）**：uni-app x 在 app-android 上一页一个 Activity——tab 根页驻留 `UniAppActivity`，其余页面各起一个 `UniPageActivity`。新 Activity 内容首帧之前 Android 先画系统起始窗，而 `UniPageActivity` 的主题没覆写 `android:windowBackground`，每点一次工具入口必然有约 4 帧 / 133ms 的整窗近白（屏录逐帧实测 near-white 99.94%）。`animationType` 只能改形态关不掉它：`none`＝整窗白闪，`slide-in-right`＝白带横扫全屏还把常驻 rail 一起推走，`fade-in`＝与原生白底合成后更亮（均真机实测否决）；39 条路由全配 `backgroundColor` 也无效（起始窗是窗口背景，不是页面绘制内容）；`uni.preloadPage` 在 uni-app x 不支持。就地托管是同 Activity、同帧换内容，起始窗根本不会出现。

**机制**（状态在 `composables/qt-wide-workspace.ts`，渲染层是 `components/qt-wide-workspace/qt-wide-workspace.uvue`）：

- 状态只有 `route`（当前托管的工具路由）与 `openSeq`（每次打开都递增的序号）。`qtOpenWideTool(url)` 在「宽屏 + 栈顶是宿主 tab 页」时写状态并返回 true；`qtCloseWideTool()` 清路由（返回是否真的关了东西）。宿主只有发现/我的两个 tab 根页——覆盖层由它们各挂一份、传 `host-route` 互斥，栈顶是谁谁那份可见。
- `qt-nav.ts` 的 `qtRailNavigate()` 三层降级：① 栈顶就是宿主，直接托管；② 栈里有宿主但栈顶不是它（歌曲页/歌单页/设置子页里点 rail），先 `navigateBack(delta, "none")` 一次退回已画好的宿主窗口、成功后再托管；③ 深链直达子页（栈里没有宿主），才 `navigateTo`（宽屏同样 `none`）。
- 宿主页 `onBackPress` 先 `qtCloseWideTool()`：返回键先收掉托管工具页，再走原逻辑（发现页的双击退出）。切 tab（`qtRailSwitchTab`）同样先关托管。
- 托管中的工具页是 page-as-component 形态，`getCurrentPages()` 读到的是宿主路由：`qt-page-frame` 在 setup 阶段读一次托管状态固化成 `hostedRoute` 常量（只有「托管中 + 栈顶是宿主」那一刻创建的框架层才认领工具路由），rail 高亮、设置三栏、宽度档位由此恢复正确。

**保活（2026-10-19 定稿）**：第一版用 `v-if` 分支互换实现「切换」，真机反馈「每点必频闪」——旧工具页整棵树（含 rail/底栏/内容）先被拆掉，新页建好前的一两帧露出覆盖层纯背景，且每次重挂载都重跑加载（骨架屏又来一遍）。改为**每个工具页只在首次打开时创建一次，之后切换/关闭只动 `visibility: hidden`**：App 平台不绘制、不响应交互但仍占布局（Android 3.9+ 支持，`docs/css/visibility.md`），官方多子页保活建议正是这个写法（`docs/collocation/pagesjson.md`）；`v-show` 在 Android(Vapor) 本身就不支持。收益：切换＝同帧改一个 CSS 属性，无重建闪动；滚动位置、输入内容、已加载数据全部保留，第二次打开瞬时恢复。代价：用过的工具页常驻内存（宽屏目标设备可接受）；页面作为组件保活后其 `onShow` 挂在宿主页上、随宿主页一起触发，但各页加载都是幂等 ensureLoad，只有多余请求、没有正确性问题。

**边界**：窄屏、深链、栈顶不是宿主页时 `qtOpenWideTool` 返回 false，调用方回落原生导航（行为与旧版一致）；设置总览中栏点子页仍走 `uni.navigateTo`（宽屏起新 Activity，保留原行为——起始窗问题超出了 rail 入口的范围）；宽屏失效（转竖屏）时组件监听 `isWide` 自动 `qtCloseWideTool()`，防止宿主页返回键被白吞一次。

### 6.19 歌单数字口径：详情不显示播放量，列表统一「万/亿」（2026-10 修复）

**用户原话**：「所有歌单详情里面都不需要显示xxx播放，全部去掉，列表展示需要换算成xxx万这种」。

- **歌单详情**（`pages/playlist/index.uvue`）：宽屏左栏 `.whero-count` 与竖屏 hero `.playcount` 的「xxx 播放」行整体移除——两处均改为 `v-if="type == 'album'"`（专辑详情的「N 首」数量行保留，歌单态不再渲染），对应骨架行（`.wsk-l4` / `.hsk-l3`）同样仅专辑态渲染，避免歌单加载完成后数量行凭空消失。
- **列表与统计的播放量统一换算**：`services/format.ts` 的 `formatBigCount()`（≥1 亿显示「x.x亿」、≥1 万显示「x.x万」、其余原样）为全站唯一实现。此前 `pages/home` 歌单卡与 `pages/stats` 大数字各持一份同语义的本地 `formatCount`，而 `pages/search` 歌单结果卡的播放量是裸数字从未换算——三处口径已收口到同一实现（home/stats 以 `const formatCount = formatBigCount` 别名保持模板调用不变）。
- 新增播放量/计数展示一律 import `formatBigCount`，不要再写本地换算。

### 6.20 首次启动免责声明由后台下发（2026-10 新增 `qt-first-run-disclaimer`）

**用户原话**：「将qt-uniappx也支持该功能」（qt-pc 已先把这份声明从代码硬编码改成后端下发，这里对齐）。

**数据流**：后台「消息管理」发一条开屏公告（展示位含开屏 + 填「条款版本号」`terms_version` + 可选「读秒」`read_seconds`）→ 客户端 `App.uvue` 启动第 3 步 `useDisclaimerStore().init()` → `stores/disclaimer.ts` 的 `pickDisclaimer` 从 `app/message/active` 里认出它 → `qt-first-run-disclaimer` 展示。**代码里不存正文**，改文案不用发版。

- **判定唯一依据：开屏位 + `termsVersion` 非空。** 服务端不认这个字段（它只负责把带版本号的公告渠道改写成 App 六端并强制 `dialog_closable=1`），认领完全在客户端。这个判据有两个消费方必须共用一份 `isDisclaimerNotice()`（`stores/disclaimer.ts`）：① `pickDisclaimer` 认领；② `stores/notice.ts` 的 `buildSplashQueue` 把它从普通开屏队列里摘掉。两处写岔会出现「同一条公告弹两次」或「声明被当成普通开屏公告弹出来，用户勾了『今天不显示』就把声明跳过了」。
- **普通公告千万别填条款版本号**，否则会被判成声明、从开屏队列消失。
- **读秒门禁**：`readSeconds`（0 = 不读秒，客户端夹在 0..60，与后台表单 `max=60`、astral `FeedbackNoticeService.clampReadSeconds` 三处同口径）。这个弹窗遮罩不可点、没有关闭键，读秒是唯一能锁住用户的开关，也是唯一可能把用户锁住的风险点，所以上限必须存在。
- **不与 `qt-notice-splash` 混用的理由**：普通开屏弹窗有「今天不显示」复选框、可点遮罩关闭、`dialog_closable=0` 时点「我知道了」直接 `exitApp()` —— 这三条对免责声明都是错的（能被顺手点掉 / 会退出 App）。声明要的是「必须读完、必须点确认、每次都重新读满」。
- **挂载点**：`qt-page-frame`（与 `qt-toast-host` / `qt-player-bar` 同一处），挂在 slot 之后、z-index 999。宽屏工具页托管层（`qt-wide-workspace`，z-index 1000）里每个工具页各有一份框架层，因此组件可能同时存在多个实例，可见的只有最上面那份 —— 与 toast 宿主的既有结论一致。
- **接受记录**：`uni storage` 的 `qt-disclaimer-accepted`，存 `{ termsVersion, acceptedAt }`。同版本不再弹；**版本号变了重弹一次**；记录里版本号为空（早期裸写 ISO 时刻的旧格式，或本机存储读不出来）按「已接受」处理 —— 宁可漏弹一次，不要每次启动都拦一道。读坏了当没接受过（重弹一次比永久漏弹安全）。
- **设置/关于页入口**：`pages/about` 的「应用与服务」组加「使用前请先阅读」，走 `stores/disclaimer.ts` 的 `reopen()`（只展示、不写接受记录、要重新读满秒数）。取不到声明时 `reopen()` 返回 false，界面提示一句「暂时取不到声明内容，请检查网络后重试」—— 正文在服务端，离线时点「查看」毫无反应，用户只会以为按钮坏了。
- **配色不许写死**：遮罩取 `skin.scrim`、卡片底取 `skin.sheetSurface`、正文取 `skin.text`（都内联），`<style>` 里不写颜色。`qt-notice-splash` / `qt-upgrade-popup` 那种写死 `#ffffff` 白卡的写法在深色皮肤下会得到一张白卡片压在暗界面上，新组件不要再沿袭。

### 6.21 确认弹窗与操作表的全局宿主（替代原生 showModal / showActionSheet）

原生 `uni.showModal` / `uni.showActionSheet` 是系统弹窗：**不跟随 App 全局字号缩放**（§6.8），深色主题下还是系统灰底/白底，所以一律自绘：

- **确认弹窗**：`services/confirm.ts` 的 `qtConfirm({ title, content, confirmText, cancelText, danger, showCancel })` → `Promise<boolean>`，由 `qt-confirm-host` 渲染。
- **底部操作表**：`services/action-sheet.ts` 的 `qtShowActionSheet({ itemList, title?, selectedIndex? })` → `Promise<number>`（点蒙层/取消键兑现 **-1**，空 `itemList` 直接兑现 -1 不弹），由 `qt-action-sheet-host` 复用 `qt-action-sheet` 组件渲染（滚动定位、宽屏抽屉宽度全部同源）。

两个 service 是同一配方：模块级 `ref` 状态 + 单一 resolver，**连续弹窗时上一个未决 promise 按取消收场**（不悬挂）；宿主都挂在 `qt-page-frame`（全站一个实例、一处覆盖），`tools/check-toast.mjs` 断言宿主存在且全仓不得再出现三个原生 API 的调用。调用方拿 promise 后**必须自己判下标/布尔**，取消路径（-1 / false）一律静默返回。

## 7. 主题与皮肤系统

### 7.1 令牌模型

皮肤对象不只包含背景色：

```ts
type QtSkin = {
  id: string;
  name: string;
  accent: string;
  accentSoft: string;
  background: string;
  surface: string;
  surfaceStrong: string;
  text: string;
  textMuted: string;
  border: string;
  backgroundImage: string;
  overlay: string;
};
```

### 7.2 预置皮肤

首批预置：

- `linen`：暖白、珊瑚红、轻量卡片；
- `graphite`：深灰、红色 accent、Steam 风格；
- `aurora`：蓝紫、半透明 surface、音乐氛围；
- `custom`：由用户配置的颜色和壁纸。

### 7.3 主题持久化

UI 库内部的运行时皮肤状态统一放在 `uni_modules/qt-ui/stores/theme.ts`；业务侧只通过该 store 的公开 API 使用，不再在页面中维护第二套主题状态。存储内容必须是 JSON 可序列化的纯数据，不能将组件实例、函数或平台对象写入 storage。

建议 key：

```text
qt-ui-skin
qt-theme-dark
```

### 7.4 背景图片策略

背景图片支持：

- `/static/...` 本地资源；
- 平台允许的远程 URL；
- 业务层经过下载或缓存后的本地路径。

显示层次必须固定为：

```text
页面背景色
  ↓
背景图片
  ↓
遮罩层
  ↓
内容 surface / 卡片 / 控件
```

背景图片加载失败时，页面仍然必须使用背景色正常显示。

### 7.5 自定义配色取色器（2026-10 升级：滑动条 + 色码直输）

`pages/theme` 的「自定义配色」卡把 6 个颜色令牌（accent / background / surface / text / textMuted / border；overlay 故意不给编辑，预置是 `rgba()` 半透明写法，换成纯色会把壁纸整块盖住）暴露给用户。取色入口与精度契约：

- **行内只显示结果**：每行 = 色块 + 名称 + 当前色码（`monospace`）+ 右箭头，整行可点开取色面板，当前行加 `custom-row-on` 底色。**行内不放可点色带**——原来是 24 段色相带，一档 15 度，用户点不准。
- **面板内三根色带只做参照**：色相 24 段 / 饱和度 16 段 / 明度 16 段纯色块（Vapor 禁 `linear-gradient`，只能用一排纯色 view 拼），仍可点选做粗调。
  **分段之间不画任何描边、不留缝**——给每段加 `border` 会把整条色带碎成一格一格的方格，颜色不再连贯（2026-10-20 用户反馈「我不想看到这种方框的，很难看，一点都不连贯」）。圆角只由外层 `.picker-rail` 的 `border-radius` + `overflow:hidden` 裁出，中间段是直角拼贴。
  当前值不靠色带上的选中框表示，只由**下方滑动条的滑块** + **标题右侧的数值读数**表示（两者已经足够，再叠一层框反而是噪声）。
- **精确取值用原生 `<slider>`**：色相 `0–359`（`HUE_MAX=359`，0 与 360 同色避免重复值）、饱和度与明度 `0–100`、`step=1`；`@changing` 与 `@change` 都落到 `applyRailValue()`，拖动过程中面板顶部的预览色块与色码读数实时更新（皮肤本身要等点「使用此颜色」才落值）；数值读数（`43°` / `80%`）显示在色带标题右侧。
- **滑动条不会抢纵向滚动**：runtime 的 touchmove 只在横向位移大于 4px 且大于纵向位移时才 `preventDefault`（`uni-app-x-framework-dev.js` slider 组件的 `B2()`），所以面板放在 `scroll-view` 里上下滑仍然正常。
- **支持色码直输**：面板底部单独一行「色码 + input + 应用」，接受 `#RRGGBB` 与省略 `#` 的 6 位写法，回车（`@confirm`）或点「应用」生效。用户手输的色码原样保留在 `pickerTypedHex` 里，**不经过 HSV 往返取整**（`#3f6fd8` 往返会变成邻近色）；一旦拖动滑动条或点色带/预置就清掉 `pickerTypedHex`，回到 HSV 派生。
- **输入框文本独立于 HSV**：`pickerHexInput` 与 `pickerHex` 分开，拖动时用 `syncHexInput()` 回填，避免用户正在打字时被拖动结果改写。
- **面板仍在卡片内普通文档流**：卡片 `overflow:hidden`，绝对定位浮层会被裁掉，不做弹窗。
- **非 hex 值也要能开局与落值**（2026-10-20 修复）：预置皮肤里有 `rgba()` 半透明令牌（卡片 `rgba(255,255,255,0.78)`、描边 `rgba(25,29,38,0.08)`），旧实现只认 `#RRGGBB`，导致这些行点开是「预览纯黑 + 滑块全 0」的假起始状态，应用后还会把半透明悄悄变成实色。现在：
  · `swatchOf()` 只要求「渲染层认得」（hex / `rgb()` / `rgba()`）就原样显示，不再回落；
  · `parseColorRgb()` 统一解析 hex 与 `rgb()/rgba()` 三通道，`hexToHsv()` / `inkOf()` 都走它；
  · 应用时用 `alphaOf()` 读该字段原本的不透明度、`withAlphaOf()` 还原成 `rgba()`，于是「卡片」调成紫色后落值是 `rgba(128,0,255,0.78)` 而不是纯 `#8000ff`；用户手输色码时按输入原样落值（不受此影响）。
- `slider` 的写法规格同 `pages/equalizer`：`:block-size` 用 kebab-case、`track-class` / `track-active-class` / `thumb-class` 走 `externalClasses`；滑块尺寸宽屏 18、竖屏 24（`pickerBlockSize`）。
- 校验：`npm run check` 全绿（76 files / 0 errors）。

## 8. 使用方式

### 8.1 页面外壳（全站统一）

所有业务页面使用 `qt-page-frame`（旧 `qt-page` / `qt-ui` 根组件已废弃，无页面使用）：

```vue
<script setup lang="ts">
import QtPageFrame from "@/uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue";
</script>
```

```vue
<template>
  <qt-page-frame width-kind="flow">
    <!-- 页面内容 -->
  </qt-page-frame>
</template>
```

`qt-page-frame` 读取 `themeStore.skin.background` / `backgroundImage` / `overlay` 渲染底色、壁纸与遮罩，
宽屏按 `width-kind` 选择内容形态与上限，`max-width` 只可进一步收紧；沉浸式页面（播放页 / MV 播放页）传 `full-width`。业务页面根节点保持透明，不要再写不透明背景色，否则会盖住皮肤背景和壁纸。设置族 / 我的页族子页在三栏模式下由 frame 复用各自的总览（`qt-settings-overview` / `qt-profile-overview`）作为中栏，并把内容宽度 cap 到右栏；页面自身仍只负责 slot 内容。

### 8.2 在业务页面中组合

```vue
<template>
  <qt-page-frame width-kind="flow">
    <view class="page-grid">
      <qt-card title="最近播放" />
      <qt-card title="推荐歌单" />
    </view>
  </qt-page-frame>
</template>
```

业务页面的 class 必须保持扁平，不要依赖 Qt UI 内部 DOM：

```css
.page-grid {
  flex-direction: row;
}
.page-grid-item {
  flex: 1;
  margin-right: 16rpx;
}
```

## 9. 编译与验收清单

每次新增或修改组件必须完成：

1. HBuilderX 真正运行一次 Android 或 iOS App；
2. 检查 Vapor CSS 编译日志；
3. 检查移动端 375px 左右宽度；
4. 检查宽屏至少 1024px 宽度；
5. 检查深色、浅色、预置皮肤和自定义壁纸；
6. 检查背景图失效时的降级显示；
7. 执行项目自检：

```text
npm run check
```

8. 对以下字符串进行扫描，发现业务代码新增时必须处理：

```text
. .
max-width: 100%
:last-child
:first-child
linear-gradient
backdrop-filter
```

## 10. 页面适配状态

所有业务页面都必须使用 `qt-page-frame`，基础响应式外壳已经覆盖：

- 首页、音乐库、搜索、我的、设置；
- 歌手、排行榜、每日推荐、下载、历史记录；
- 下载设置、日志、缓存管理；
- 歌单详情、歌单广场、MV、公告、反馈；
- 登录、注册、找回密码、资料编辑、统计、关于和主题设置。

**全站页面均已具备宽屏覆盖**（2026-09 补齐第二批：公告列表/详情、反馈列表/详情/提交、统计、排行榜、每日推荐、歌手、歌单广场/详情、下载、历史、MV、主题、登录、找回密码、资料编辑、关于、播放页）。规则统一：

- 每页引入 `useQtLayout()`，`layout.isWide` 为唯一宽窄屏判据；
- 节点绑定 `xxx-wide` class（与 dark/active 态共存时用数组 `:class`），`<style>` 末尾追加同名单条 px 规则；
- 表单类卡片（登录/注册/找回密码/资料编辑/反馈提交）限宽 `420px` 居中；阅读类（公告详情/反馈详情）限宽 `640px`；
- 播放页为全屏沉浸页（`full-width`）。宽屏骨架（2026-09 定稿）：上部 `wide-body` 左封面（**纯展示，无点击事件**，长按查看大图只在竖屏保留）+ 右信息面板（track-head 标题/歌手 + 歌词区常驻，队列预览已移除）；进度条与播放控制条移出右栏、改为页面底部通栏，主播放键为白圆底 + 深色图标；收藏/下载/换源/音质/队列五个工具按钮全部收进底部控制条右侧的 `control-tools-wide` 组（顶部不放大工具，队列面板仍为居中悬浮 `560px`）。封面**不做旋转动画**（方形封面旋转会露出对角、越出卡片边界）；
- 播放页导航 `navStyle` 高度必须 = 状态栏(padding-top) + 内容高（宽屏 `sb+52px`、竖屏 `statusBarRpx+96rpx`）——固定高度会让按钮上下溢出被 Android `clipChildren` 裁平；竖屏封面/歌词为两态切换（点封面进歌词页并隐藏封面，点歌词返回封面），切换靠 `@click`（uni-app x Vapor 下 `@tap` 不可靠）；
- 歌曲行/迷你播放器/音源切换器/ActionSheet 的宽屏尺寸由 `uni_modules/qt-ui` 组件内部处理，页面不重复覆盖。
- 歌单广场竖屏网格：**3 列阈值 `>=340px`**（主流机型 360~412px 均为 3 列，封面约 92~109px）；`>=560px` 4 列；`isWide` 5 列。列宽 = `floor((screenWidth − 48 − gap×列数) / 列数)`，末卡 margin-right 计入防换行。**卡片形态（2026-10-24 用户定稿「歌单列表改为这种样式」，QQ 音乐同款扁平卡）**：`.card` 无底无框（原白半透明底 + 边框 + 圆角整卡包裹已删），方形封面 `border-radius: 12rpx` 即卡面，歌单名裸排在封面下方（颜色走 `theme.skin.text` 内联，不再写死深色）；封面左上角叠播放量徽标（`headset` 图标 + `formatBigCount(playCount)` 换算「x.x万/亿」，`rgba(0,0,0,0.35)` 圆角胶囊、白字，绝对定位只给 left/top——image 的 absolute 不认 right/bottom 拉伸，所以徽标套在 `.cover-wrap` 里）。骨架卡保持「方图 + 两行」同形。**错峰透明度只挂首屏头部条目**：尾部行走原生复用池滚动中不断重建，透明度挂上去会出现「占位但透明」的空白行（真机实测），`tailItemStyle` 只回尺寸。手机档（含 >=560 的平板竖屏）统一最多 **3 列**（用户反馈 4 列拥挤），极窄屏 <340px 才 2 列。分类入口（2026-10-24）：**手机档标签两行与排序条均已删**（用户要求「排序也应该放到那个里面，而不是单独在外面」），改为标题栏右侧宫格图标（`icons.ts` 新增 `grid`）→ **自上而下展开的排序+分类面板**（用户明确不要底部弹窗：`.cat-mask` 淡入 + `.cat-panel` `translateY(-101%)→0` 过渡，遮罩点击关闭；排序 chips 常驻面板顶部、点选即时生效**不关面板**，分类三列等宽格子 `catCellWidth = floor((内容宽 − padding − 2×gap)/3)`，间距走内联且**每行末列去掉右间距**否则 3 列被挤成 2 列；选中格 accent 底 + onAccent 字，超一屏内部滚动、打开时 `scroll-into-view` 滚到当前分类；开面板先挂载再下一帧置 `.cat-panel-open`，才有 transform 过渡）；宽屏排序条 + 分类折行平铺照旧留在页首（空间够、无需收纳）。`tools/check-uvue.mjs` 的 indirectIcons 相应扩展了 `headerActions = [...]` 数组字面量识别。**面板数据健壮性（2026-10-24 二轮真机反馈）**：排序 chips 全灰的根因是 `selectedSort` 在注册表就绪前赋了空串、之后再没人纠正——`watch(sorts, immediate)` 兜底，选中值不在选项里就回落到第一项；分类列表里的「全部/全部歌单」同名项跳过（空 id 合成项是唯一「全部」，否则出现两个）；分类名过 `decodeHtmlEntities`（数据包里见过「R&#38;B」，手写实体扫描：命名表 + 数字/十六进制码点，UTS 的 replace 回调替换不稳）。
- 播放页导航标题/副标题：**长文本 ellipsis 依赖宽度约束**（area `align-items: stretch` + 文本 `flex:1; min-width:0`），字形居中用 `text-align: center`，不可用 `align-items: center`（子节点会缩回内容宽度 → 溢出被裁、省略号失效）。歌词预览区左右滑动不切歌（仅保留下滑返回）。
- 播放页背景层**不再用封面满铺底图**（2026-10 用户要求「播放详情里面的背景不要用封面的背景图片，改为无背景图片」）：删掉 `<image class="bg" mode="aspectFill">` 与平台色薄层 `.bg-tint`（后者由 `platformTint(platformKey(), 0.14)` 算色相），页面里只剩一层 `.shade`（`background-color: theme.skin.mediaScrim`，即 `rgba(0,0,0,0.52)`）。**保留 `.shade` 的理由**：播放页全部文字/图标走 `mediaText`（恒 `#ffffff`）/`mediaMuted`（恒白 70%），而浅色皮肤（linen `background ≈ #f6f7f8`）下不压暗会直接糊在浅底上；要彻底去掉这层，必须把整套 `media*` token 换成随皮肤明暗切换的 foreground 色，回归面大得多。封面图本身仍在宽屏 `.cover-img`、竖屏 `.disc-img`、队列与弹窗里正常展示，删的只是「铺满整页当背景」这一层。
- 榜单/专辑详情页 hero 由 URL 参数构建：入口页必须把 `name` / `desc` / `pic` 随 `uni.navigateTo` 传入（依赖接口回填可能拿到空，版权受限专辑即返回空数据）。
- 批量选择（§6.11）已接入歌单详情页、每日推荐页与歌手详情页：三页都复用 `use-batch-select.ts` + `qt-batch-bar` + `use-batch-actions.ts`，回执走底部居中的 `qt-toast-host`。2026-10-19 起歌单/每日两页接线一致、2026-10-22 歌手页并入：**窄屏**管理条放进吸顶 `.list-head`（`md` 档）；**宽屏**操作（含选择态批量条 `column` 档）全收进左栏封面块，列表顶不再有操作条。**选择态切换时不要给容器加/去 `border`**：`.list-head` 是定高 + 默认 `content-box`，补一条边框会让整条高出 2px，切进切出页面会跳。**只有歌单详情页显示收藏红心**（`canSavePlaylist = type != 'chart' && type != 'album'`；歌手页从无收藏钮），专辑/排行榜/歌手详情都不收藏——用户 2026-10-22 明确要求「只有歌单详情页面可以进行收藏，其他都不可以」。
- 搜索页聚合搜索（2026-10-24，对齐 qt-pc SearchPage 的聚合形态）：歌曲分 Tab 下新增「聚合搜索」开关 chip（`.agg-row`，默认关、持久化 `qt-search-aggregate-mode`），开启后并发打全部音源合并成一条按相关性排序的列表（数据包 v7 走包内 `searchMerged` 入口；旧包降级为 `searchAll` 批次 + `services/aggregate-merge.ts` 本地合并——打分/去重/垃圾词规则与 qt-pc/src/lib/aggregate-merge.ts、qt-sources/src/actions/merge-search.ts 三方逐字一致，改一处必须三处同步）。歌曲分 Tab 行恒显音源徽标（`qt-song-row-lite :show-badge="true"`），翻页按 `aggregateSongKey` 跨页去重、包侧 `full=false` 即收尾；聚合模式每页条数 = 各源 `searchPageMax` 最小值，单源模式改为 `searchPageMaxOf(当前源)`（原写死 30）。「聚合只用哪几个音源」白名单（`services/aggregate-sources.ts`，空=全部）：设置入口在音源包管理页「聚合搜索音源」卡片（全部音源行 + 各源参与/不参与行，全不选归一为全部），改动后广播 `AGGREGATE_SOURCES_CHANGED_EVENT`，搜索页监听并自动刷新进行中的聚合搜索。

播放器和 MV 播放页使用 `fullWidth` 沉浸式模式；其他内容页使用居中限宽模式。页面改动后需要重新运行自定义基座，不能只依赖旧页面热刷新验证宽屏效果。

### 10.1 宽屏实测结论（1600×900 模拟器，HBuilderX 5.24 实测）

以下数据是 2026-09 在 `1600×900 / 240dpi` 模拟器上用探针节点 + `createSelectorQuery` 实测得到的，是宽屏适配的**事实依据**，改布局前先读一遍：

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| `uni.getSystemInfoSync().windowWidth` | `1067`（dpr 1.5） | 已经是 **dp/CSS px**，不是物理像素；`screen=1067x600`，物理像素 `1600x900` |
| CSS `100px` | 实测 `100` | **px 是绝对单位**，不随窗口宽度缩放 |
| CSS `100rpx` | 实测 `142` | **rpx = windowWidth / 750**，随窗口宽度缩放 |

因此宽屏下 `1rpx ≈ 1.42dp`，手机竖屏（`windowWidth≈400`）下 `1rpx ≈ 0.53dp`，**同一份 rpx 样式在 1600×900 上会被放大 2.7 倍**。这就是“宽屏不适配”的根因，也决定了宽屏覆盖必须用 `px` 写（现有 `*-wide` class 的做法）。

由此推出的两条硬规则：

1. **`qt-page-frame` 的 `max-width` 只在窗口比它宽时才有意义。** `width = min(windowWidth, maxWidth)`，`windowWidth` 本身就是整个窗口宽度，所以 1600×900（1067dp）小于默认 `maxWidth=1280` 时内容就是全宽 —— 这是预期行为，不是 bug；只有 `>1280dp` 的窗口（桌面浏览器、大屏平板分屏）才会真正限宽居中。想让内容在中等宽度窗口就收窄，给页面传更小的 `:max-width`。
2. **凡是按 rpx 写的尺寸都会随窗口放大。** 页面要么像首页/音乐库/搜索/我的/设置那样给每个尺寸节点补 `*-wide` 的 px 覆盖，要么接受等比放大。横向滚动行如果用脚本按 rpx 换算行宽（如首页 `chartsRowWidth`），行宽同样会被放大数倍，必须和 `*-wide` 一起切换成 px。
3. **不要用 `pages.json` 的 rpx 上限配置救场**——见 §6.6：Android 运行时未实现 `rpxCalcMaxDeviceWidth`，已用 dex 字符串检索证实。rail 占位与内容列位置必须交给 `qt-page-frame` + `qtContentWidthRaw()` / `qtContentPadLeft()`；业务页面不得再手算 `qtSideNavPad` 或 rail 左内边距。页面内部的列数、卡宽和行宽只读 `qtContentWidth()`，这样设置右栏 cap 也能自动生效。

### 10.2 窗口尺寸变化监听

`uni-app x` 没有可被组件订阅的全局 `onWindowResize` / `onResize`（`@dcloudio/uni-app` 只在页面里提供生命周期），所以 `use-qt-layout.ts` 用「低频轮询 + 变化检测」兜底：

- 首次 `useQtLayout()` 时启动 1s 间隔的监听；
- 只有 `windowWidth/windowHeight` 真的变了才写 reactive 状态（旋转、分屏、自由窗口都能触发重排）；
- `App.uvue` 的 `onShow`/`onHide` 调用 `resumeQtLayoutWatcher()` / `pauseQtLayoutWatcher()`，避免后台空转；
- 每次 `useQtLayout()` 都会先 `syncQtLayout()` 同步一次，保证跨页面导航后拿到的是最新尺寸。

## 11. 演进方向

组件清单以 §3 为准（20 个组件已实现）。后续演进按优先级：

- **表单组件**：`qt-input`、`qt-switch` 等，收敛登录/注册/反馈表单的裸 `<input>`；
- **弹层收敛**：统一 `scrim` 遮罩 token（action-sheet / notice-splash / upgrade-popup 三处遮罩不透明度目前不一致）；
- **主题生态**：用户导入 JSON 皮肤、皮肤预览/导出、壁纸裁剪与本地缓存、动态 accent 计算；
- **打磨**：按压态反馈、`qt-empty` 空状态组件、toast 统一（详见 `docs/ui-review.md` §3.10）。
