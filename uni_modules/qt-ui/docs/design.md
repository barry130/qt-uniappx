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
    │   └── use-qt-layout.ts        # 窗口尺寸 / isWide / qtRpx / qtStatusBarPx / qtSideNavPad
    ├── stores/
    │   └── theme.ts                # 运行时皮肤 / 明暗 / 壁纸令牌
    ├── services/
    │   └── icons.ts                # 全站图标定义（QtIcon 数据源）
    ├── docs/
    │   ├── design.md               # 本文档：设计系统
    │   └── ui-review.md            # UI 审查红线 / 整改进度 / 剩余问题（活文档）
    └── components/                 # 单文件、单目录，共 21 个组件
        ├── qt-page-frame/          # 页面外壳（全站唯一，maxWidth 默认 1280）
        ├── qt-page/                # 旧外壳，已废弃（无页面使用）
        ├── qt-ui/                  # 旧根组件，已废弃（无页面使用）
        ├── qt-card/  qt-button/  qt-icon/  qt-loading/
        ├── qt-action-sheet/  qt-segmented/  qt-source-switcher/
        ├── qt-side-nav/            # 宽屏左侧 rail（替代原生 tabbar）
        ├── qt-mini-player/         # 悬浮播放球（几乎全站可见）
        ├── qt-song-row/  qt-song-row-lite/
        ├── qt-notice-bar/  qt-notice-splash/  qt-upgrade-popup/
        ├── qt-meta-pack-guide/     # 数据包安装引导弹窗（业务组件：未装数据包时首页指路设置页）
        ├── qt-playlist-picker/  qt-back-to-top/  qt-rich-text/
```

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
- `border-width`、`border-color`、`border-radius`；
- `opacity`；
- class 绑定和内联 style。

> ⚠️ **`box-shadow` 是禁用项**：uni-app x Android 上 shadow 落在可点击元素或其祖先上会导致点击穿透 /
> 命中丢失（`pages/settings`、`pages/search`、`pages/artist` 实证）。层级用 `border` + surface 色差表达，
> 详见 `docs/ui-review.md` §1。纯装饰不可点击容器可用极轻 shadow（半径 ≤ 4rpx、alpha ≤ 0.06）。

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

职责：

- 读取 `themeStore.skin.background` 作为页面底色；
- 读取 `themeStore.skin.backgroundImage` 渲染底层壁纸；
- 读取 `themeStore.skin.overlay` 渲染壁纸遮罩，保证内容可读；
- 宽屏时按 `maxWidth` 计算内容列宽度并居中；
- 沉浸式页面可传 `fullWidth`，不启用内容限宽；
- 业务页面根节点保持透明，不再自行绘制不透明页面背景，避免遮住皮肤和壁纸。
- 只提供页面壳，不持有播放器、登录、网络等业务状态。

API：

```ts
type Props = {
  maxWidth?: number; // 默认 1280，宽屏内容列最大宽度
  fullWidth?: boolean; // 沉浸式页面使用
};
```

示例：

```vue
<template>
  <qt-page-frame :max-width="1320">
    <!-- 页面内容 -->
  </qt-page-frame>
</template>

<script setup lang="ts">
import QtPageFrame from "@/uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue";
</script>
```

设计要求：

- 页面外壳是全站唯一页面背景层，业务页面不得再用固定背景色覆盖它；
- 背景图使用 `<image>` 而不是 CSS `background-image`；
- overlay 使用单独 `<view>`，顺序固定为背景色 → 壁纸 → 遮罩 → 内容；
- 壁纸加载失败时，页面仍然使用皮肤背景色正常显示；
- 宽屏断点固定使用 `useQtLayout(720)`，与页面响应式规则保持一致。
### 6.2 `qt-card`

建议 API：

```ts
title?: string;
description?: string;
variant?: "default" | "muted" | "outline";
elevated?: boolean;
```

卡片只管理 surface 和边框，业务内容通过 slot 注入。禁止卡片内部写死播放器或歌单数据。

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

### 6.4 响应式行为

组件库通过 `use-qt-layout.ts` 统一读取窗口宽度。组件内部不能假设自己永远运行在移动端：

- 页面壳：宽屏时限制内容宽度并居中；
- `qt-action-sheet`：移动端从底部出现，宽屏改为右侧抽屉（`420px`）；
- `qt-side-nav`：宽屏下取代原生 tabbar，作为固定左侧 rail（`windowWidth>=860` 为 208px 完整 rail，否则 64px 图标栏）；
- `qt-mini-player`：宽屏下悬浮球默认落在 rail 右侧（`qtSideNavWidth()+16`），拖动位置会被 clamp 到 rail 之后；
- 列表、卡片、输入框等基础组件使用同一份 props 和 token，只在布局 class 上产生差异。

`qt-action-sheet` 已接入该逻辑，且**必须放在页面所有 `list-view` 节点之后**（原生组件层级问题，
见 `docs/ui-review.md` §1.3）。

### 6.5 宽屏布局组件

宽屏布局由 `qt-page-frame`（内容限宽）+ `qt-side-nav`（左侧 rail）+ `qt-mini-player`（悬浮播放球）
组合实现，tab 页在 `isWide` 时 `uni.hideTabBar()`：

```text
┌─────────────────────────────────────────────┐
│ 左侧 rail (208px / 64px)   │  主内容区        │
│  (品牌 + 菜单，可滚动)       │  (frame 限宽居中) │
├─────────────────────────────────────────────┤
│                 迷你播放球（rail 右侧）        │
└─────────────────────────────────────────────┘
```

移动端降级为：

```text
┌──────────────────────┐
│ 主内容                 │
│ 底部 tab / mini player │
└──────────────────────┘
```

布局断点默认为 `720px`（`useQtLayout`），页面根节点宽屏让位用 `qtSideNavPad(windowWidth, contentMaxWidth)`。

### 6.6 多形态适配约定（竖屏手机 / 横屏 / 平板 / 车机，2026-09 定稿）

目标形态：竖屏手机（≤500dp）、横屏手机/小平板（500–720dp，竖版布局 + 原生 tabbar）、宽屏平板/车机（≥720dp，`isWide=true`，rail + 内容）。

**rpx 的残酷事实（2026-09 实测，HBuilderX alpha 5.25 / Android）**：

- `pages.json globalStyle` 的 `rpxCalcMaxDeviceWidth` / `rpxCalcBaseDeviceWidth` / `dynamicRpx` **在 uni-app x Android 运行时中未实现**（对基座 APK 的 dex 做字符串检索，无 `rpxCalcMaxDeviceWidth` / `dynamicRpx` 符号；编译产物 app-config.js 里虽然有这些键，但原生运行时不读）。保留在 pages.json 里无害，不要指望它。
- 因此 `rpx = windowWidth / 750` 恒成立：1138dp 窗口上 1rpx≈1.5dp，2560px 屏上字会大到 3 倍以上。**宽屏唯一的防御是逐节点 `-wide` px 覆盖**（§10.1 规则），新增任何会在 `isWide` 下渲染的节点都必须带 `xxx-wide` 绑定与 px 规则，否则就是下一次“面目全非”。

**宽屏导航 rail（`qt-side-nav`）**：

- 三条 tab 页（发现/音乐库/我的）在 `isWide` 时隐藏原生 tabbar（`uni.hideTabBar`），由 fixed 左侧 rail 取代：`windowWidth>=860` 为 208px 完整 rail，否则 64px 图标栏；工具入口（搜索/每日推荐/歌单广场/排行榜/MV/设置）走 `uni.navigateTo`。rail 品牌区固定在顶部，菜单区包在 `qsn-scroll`（`scroll-view`，flex:1）里——矮窗口（横屏手机/车机 480dp 高）下 9 个菜单项放不下，必须可滚动，否则末尾的“设置”永远点不到。
- 音乐库/我的两个 tab 页已改为 `navigationStyle: custom`（用户要求去掉原生“我的音乐/我的”标题栏），页面根部用 `padding-top: qtStatusBarPx()+12px` 给状态栏让位（`qtStatusBarPx()` 在 use-qt-layout.ts）；竖屏原生 tabbar 不受影响。
- 页面让位用 `qtSideNavPad(windowWidth, contentMaxWidth)`（自动扣除 frame 居中偏移），返回应加在页面根上的 `padding-left` px 值；`useQtTabBarSync()` 负责显隐 tabbar（可传 forceHide，如弹窗全屏遮挡时）。
- `qt-mini-player` 悬浮球宽屏默认落在 rail 右侧（`qtSideNavWidth()+16`），拖动位置记忆也会被 clamp 到 rail 之后。

**JS 侧尺寸换算（`qtRpx`）**：

- 脚本里不要写 `windowWidth / 750 * n`；用 `qtRpx(n)`（use-qt-layout.ts）：窗口 ≤500dp 按实际宽度换算，>500dp 固定按 375 基准（即宽屏 0.5px/rpx），与 `-wide` px 覆盖同思路。
- `qt-icon` 的 `size` 在 `isWide` 时单位从 rpx 切换为 px（组件内部处理），所以模板里 `:size="layout.isWide ? 16 : 30"` 是推荐写法。

**页面骨架模式**：

- tab 页（首页/音乐库/我的）：`qt-page-frame(:max-width="1360")` + `QtSideNav v-if="isWide"` + 根节点 `:style="qtSideNavPad(...)"`；首页宽屏为 rail | 主列（feature + 推荐歌单网格 + 新歌） | 300px Trending 侧栏，主列 <720dp 时侧栏内容下移为单列。首页推荐歌单卡：宽屏目标卡宽约 130px（4–6 列，为旧 260px 两列方案的一半，避免单卡时右侧大片留白）；竖屏一行三列（约为原两列方案的 2/3，卡宽 <92dp 的窄窗退化两列）；列宽计算须把每卡的 margin-right（含末卡）计入，否则最后一列会被挤换行。
- 歌单详情：宽屏左右布局（左 272px 歌单信息卡 + 右歌曲列表），竖屏保持上下堆叠；frame maxWidth 宽屏 1080 / 竖屏 860。
- 表单/阅读类子页维持 §10 的限宽模式。
- **子页不重复导航栏标题**（2026-09 用户定稿「通用的，把红色方框里的歌单广场删掉」）：原生导航栏已显示 `navigationBarTitleText`，页内不得再放同名大标题（歌单广场/最近播放/MV 的 `.title`、排行榜页头整块已删）。页头只保留有信息量的部分：计数/副标题（最近播放的「共 N 首」）、右侧操作（MV 的音源切换）、筛选 tag（排行榜音源 segmented）。播放器/<MV 播放>这类 `navigationStyle: custom` 页面的自绘导航不算重复。

### 6.7 `qt-segmented` 标签间隔（2026-09 新增 `itemGap`）

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
  <qt-page-frame :max-width="1320">
    <!-- 页面内容 -->
  </qt-page-frame>
</template>
```

`qt-page-frame` 读取 `themeStore.skin.background` / `backgroundImage` / `overlay` 渲染底色、壁纸与遮罩，
宽屏按 `maxWidth` 限宽居中；沉浸式页面（播放页 / MV 播放页）传 `full-width`。业务页面根节点保持透明，
不要再写不透明背景色，否则会盖住皮肤背景和壁纸。

### 8.2 在业务页面中组合

```vue
<template>
  <qt-page-frame :max-width="1320">
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
- 歌单详情、歌单广场、MV、公告、反馈；
- 登录、注册、找回密码、资料编辑、统计、关于和主题设置。

**全站页面均已具备宽屏覆盖**（2026-09 补齐第二批：公告列表/详情、反馈列表/详情/提交、统计、排行榜、每日推荐、歌手、歌单广场/详情、下载、历史、MV、主题、登录、找回密码、资料编辑、关于、播放页）。规则统一：

- 每页引入 `useQtLayout()`，`layout.isWide` 为唯一宽窄屏判据；
- 节点绑定 `xxx-wide` class（与 dark/active 态共存时用数组 `:class`），`<style>` 末尾追加同名单条 px 规则；
- 表单类卡片（登录/注册/找回密码/资料编辑/反馈提交）限宽 `420px` 居中；阅读类（公告详情/反馈详情）限宽 `640px`；
- 播放页为全屏沉浸页（`full-width`）。宽屏骨架（2026-09 定稿）：上部 `wide-body` 左封面（**纯展示，无点击事件**，长按查看大图只在竖屏保留）+ 右信息面板（track-head 标题/歌手 + 歌词区常驻，队列预览已移除）；进度条与播放控制条移出右栏、改为页面底部通栏，主播放键为白圆底 + 深色图标；收藏/下载/换源/音质/队列五个工具按钮全部收进底部控制条右侧的 `control-tools-wide` 组（顶部不放大工具，队列面板仍为居中悬浮 `560px`）。封面**不做旋转动画**（方形封面旋转会露出对角、越出卡片边界）；
- 播放页导航 `navStyle` 高度必须 = 状态栏(padding-top) + 内容高（宽屏 `sb+52px`、竖屏 `statusBarRpx+96rpx`）——固定高度会让按钮上下溢出被 Android `clipChildren` 裁平；竖屏封面/歌词为两态切换（点封面进歌词页并隐藏封面，点歌词返回封面），切换靠 `@click`（uni-app x Vapor 下 `@tap` 不可靠）；
- 歌曲行/迷你播放器/音源切换器/ActionSheet 的宽屏尺寸由 `uni_modules/qt-ui` 组件内部处理，页面不重复覆盖。
- 歌单广场竖屏网格：**3 列阈值 `>=340px`**（主流机型 360~412px 均为 3 列，封面约 92~109px）；`>=560px` 4 列；`isWide` 5 列。列宽 = `floor((screenWidth − 48 − gap×列数) / 列数)`，末卡 margin-right 计入防换行。
- 播放页导航标题/副标题：**长文本 ellipsis 依赖宽度约束**（area `align-items: stretch` + 文本 `flex:1; min-width:0`），字形居中用 `text-align: center`，不可用 `align-items: center`（子节点会缩回内容宽度 → 溢出被裁、省略号失效）。歌词预览区左右滑动不切歌（仅保留下滑返回）。
- 榜单/专辑详情页 hero 由 URL 参数构建：入口页必须把 `name` / `desc` / `pic` 随 `uni.navigateTo` 传入（依赖接口回填可能拿到空，版权受限专辑即返回空数据）。

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
3. **不要用 `pages.json` 的 rpx 上限配置救场**——见 §6.6：Android 运行时未实现 `rpxCalcMaxDeviceWidth`，已用 dex 字符串检索证实。fixed 左侧 rail 会压住 frame 居中后的空白，宽屏页面根部的让位 padding 必须用 `qtSideNavPad(windowWidth, frameMaxWidth)` 计算，内容列宽度也要按“frame 实宽 − rail 占位”推导（首页 `wideHomeWidth` 的教训：少减 rail 会把右栏推出屏幕被裁掉）。

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
