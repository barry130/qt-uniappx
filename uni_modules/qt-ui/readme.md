# Qt UI · Steam 宽屏设计系统

这是一个面向 uni-app x Vapor 模式的独立 UI 组件模块。

详细设计、CSS 约束、组件 API、换肤模型和宽屏策略请阅读：

- `docs/design.md`
- `components/qt-page-frame/qt-page-frame.uvue`
- `components/qt-button/qt-button.uvue`
- `components/qt-card/qt-card.uvue`
- `components/qt-icon/qt-icon.uvue`
- `composables/use-qt-layout.ts`
- `composables/use-qt-reveal.ts`
- `components/qt-skeleton-list/qt-skeleton-list.uvue`
- `stores/theme.ts`
- `stores/font-scale.ts`
- 以及当前项目中的播放、歌曲行、弹层、加载等业务 UI 组件

## 本地合辑

`components/qt-local-mixes/qt-local-mixes.uvue` 用于首页「为你整理」区块：展示本地统计生成的固定顺序合辑，提供紧凑/宽屏四封面 2x2 卡、详情 sheet 和全部播放。支持 `embedded`、`content-width`、`card-width` 属性嵌入已有内容列；组件不发在线请求，空合辑不占位，播放由宿主 player 的 `playReportSongs(songs, startIndex)` 处理。详情 sheet 高度竖屏 0.88 / 宽屏 0.92 倍窗口高，无底部「取消」条（只靠右上 ✕ 与遮罩关闭），列表用 `flex: 1` 铺满剩余高度。

**容器约定**：组件不自带卡片外壳，白底/描边/圆角/内边距由宿主给（首页竖屏用 `.section`、宽屏用 `.wide-panel`，与推荐歌单等区块同容器）；`embedded` 与宽屏下自身内边距为 0，`content-width` 必须传**卡片内宽**而非窗口宽，`card-width` 用于与同页其他横向架对齐卡面尺寸（未传才由组件估算）。


`components/qt-mini-player/qt-mini-player.uvue` 默认显示悬浮播放球；虽然各页面可复用该组件，运行时只显示栈顶页面的一个实例。点击一次会从当前吸附边缘展开迷你播放条，再点击播放条主体进入播放详情页；条内提供播放/暂停、下一首和进度反馈，点击页面其他位置会收缩且不会阻塞页面滚动。组件支持可选属性 `bottom-reserve`（rpx），用于为后续底部悬浮导航栏预留安全空间，当前默认值为 `0`。

## 听歌报告详情

`components/qt-listen-detail/qt-listen-detail.uvue` 是报告业务弹层。属性 `kind` 为 `songs` / `artists` / `sources` / `info`，`target` 为空时显示完整排行，否则为歌曲 `platform:id`、歌手原署名或音源 id；`loading-key` 为正在取链的歌曲标识。事件 `close` 由页面卸载弹层，`play(song)` 交给页面执行播放。竖屏底部展开、宽屏右侧抽屉，支持条目详情、相关歌曲、次数/时长排序及每批 50 项加载。页面通过 `v-if` 打开新实例，避免残留上次的详情层级。

## 页面外壳、导航与三栏设置

所有业务页面使用 `qt-page-frame`。页面只放自己的内容；背景、rail、toast、宽屏播放器底栏和窄屏返回栏都由 frame 统一宿主：

```vue
<qt-page-frame width-kind="list">
  <!-- 页面内容 -->
</qt-page-frame>
```

它负责：

- 读取主题皮肤背景色、渲染自定义背景图片与遮罩；
- 按 `width-kind`（`form` / `prose` / `flow` / `list` / `detail` / `grid` / `full`）计算宽屏内容列；`max-width` 只可额外收紧；
- 宽屏挂全局 rail 与有歌曲时的常驻播放器底栏；底栏按 rail 右侧可用宽度分档追加控件（`>=740px` 出收藏/播放模式/队列，`>=840px` 出静音+音量条，窄平板横屏只保留封面信息/三键/进度条），左块随之 168/240/300px 收缩，全部固定 px（详见 [`docs/design.md`](docs/design.md) §6.4）；页面切换**一律不传 `animationType`**（默认动画；曾试过宽屏 `none` 保持 rail 静止，但新 Activity 起始窗在 none 下整窗裸闪，深色系统真机反馈「每次点击黑屏闪一下」，已全量回退——见 `composables/qt-nav.ts` 头注释）；rail 的五个工具入口在宽屏下由 `qt-wide-workspace` **就地托管**进当前 tab 页（不新建 Activity、没有起始窗白帧，也不再往页面栈里堆页面），每个工具页首次打开后保活、切换/关闭只动 `visibility`，没有重建闪动，重开瞬时恢复（详见 [`docs/design.md`](docs/design.md) §6.18）；
- 横屏矮窗（`layout.isShort`，`windowHeight < 520`）也会落进宽屏分支（手机横屏 / 车机），按 `windowHeight` 反算的宽屏尺寸必须**先扣掉本页固定的顶部与底部行占位**，不要写 `windowHeight - 常数`；播放页宽屏舞台已按此改造并追加 `-short` 收紧规则（详见 [`docs/design.md`](docs/design.md) §10.3）；
- 宽屏 Parity（对齐网易云 / QQ 音乐 Pad）落在五处：底栏分档控件（收藏 / 播放模式 / 队列 / 音量，见上一条）、播放页**宽屏**歌词工具行的「桌面歌词」按钮（原来只有设置页一条路径；竖屏那行本就三颗药丸，加第四颗会在 375dp 上溢出，故只加宽屏）、rail 补上「每日推荐」（原来只有首页竖屏快捷药丸能进）、artist/playlist/daily/daily-recommend 左栏宽度改由 `qtContentWidth("detail")` 反算（不再写死 272/296px）、宽屏触达尺寸下限 32–36px 与浮层 `rpx` 尺寸的 `-wide` px 夹紧；改这些位置前先读 [`docs/design.md`](docs/design.md) §10.4；
- 全站 `navigationStyle: "custom"`：宽屏不画顶部标题，窄屏画功能性「返回 + 标题」栏；
- 设置子页与我的页族（收藏/本地/下载/最近播放/听歌报告/音乐助手/反馈/关于/个人信息）在桌面可用宽度足够时自动变成 `rail | 总览 | 子页内容` 三栏，中栏分别复用真实的设置总览（`qt-settings-overview`）与「我的」总览（`qt-profile-overview`）并高亮当前项；总览里的音乐助手入口按权限码 `user:ai:music:use` 显隐（无权限/未登录不显示，与 qt-pc 同一判定）；
- 竖屏底部导航是 `qt-tab-bar` 悬浮胶囊：左右各缩 40rpx、离地 24rpx、高 120rpx、圆角 60rpx（375dp 基准下正好等于 20px / 12px / 60px / 30px），发现 / 我的 两个入口，当前项 accentSoft 圆角 chip 高亮；**尺寸一律用 rpx**，随窗口宽度与整页内容同步放大（写死 px 会在平板 / 折叠屏 / 大窗口模拟器上显得极小）；总占位是 `QT_TAB_BAR_HEIGHT_RPX`（144rpx），由 `qtTabBarHeightPx()` 折算成 px，toast 让位与悬浮球初始边距都按它取值；
- 鸿蒙端四处平台差异已在组件内兜住：① 鸿蒙 **不注册 tabBar**（`pages.json` 的 `"tabBar"` 整块包进 `#ifndef APP-HARMONY`）——原生 Tabs 容器在追加第二个 tab 页时不生效，`switchTab` / `reLaunch` 到 tab 页都会回调 success、页面栈也变了，但原生视图不切换；切 tab 统一走 `qt-nav.ts` 的 `qtSwitchTab()`（鸿蒙 `reLaunch`，其它平台 `switchTab` + fail 兜底 `reLaunch`），不要再直接写 `uni.switchTab`；② 首页首帧 `getCurrentPages()` 可能还是空栈，`qt-mini-player` 改为 50ms 轮询补齐宿主注册（最多 1s）；③ 鸿蒙 **fixed 宿主里的 fixed 子节点收不到触摸**（点悬浮球没反应、事件穿透到下层），子级必须改 `position: absolute` 且 `left/top` 固定为 0（位置只由 fixed 宿主负责），否则会二次偏移、`clickable` 变 false；④ 鸿蒙 **`READ_WRITE_DOWNLOAD_DIRECTORY` 在手机上是 INVALID**（2in1 专属），系统 Download 目录写不进去，公共目录必须走 `DocumentViewPicker` 选目录 + `fileShare.persistPermission` 持久化 URI 授权，下载设置页「更改位置」与权限管理页对应条目都按此改写；
- 沉浸式页面可通过 `full-width` 保持全宽。

外观页（`pages/theme`）的自定义配色取色器：行内只展示色块 + 色码（整行可点），面板内三根色带（色相 24 / 饱和 16 / 明度 16 段纯色块）只做参照，精确取值用原生 `<slider>`（色相 `0–359`、饱和与明度 `0–100`，拖动实时预览），并支持直接输入 `#RRGGBB` 色码（省略 `#` 也接受，手输值不经 HSV 往返取整）。预置皮肤里的 `rgba()` 半透明令牌（卡片、描边）也照常可编辑：色块按原值显示、面板从实色起步、应用后保留原不透明度。契约见 [`docs/design.md`](docs/design.md) §7.5。

业务页面根节点不要再写不透明背景色，也不要自行挂 `qt-side-nav`，否则会盖住皮肤背景、造成重复导航。

## 约束

该模块严格避免 uni-app x Vapor 不支持或容易触发编译错误的 CSS 写法，尤其是：

- 后代选择器、子选择器、兄弟选择器；
- `:first-child`、`:last-child` 等伪类；
- `max-width: 100%`；
- 未经验证的 Web-only 样式；
- **只写 `border-width` 不写 `border-style`**：Vapor 下不会画出任何边框（样式默认 `none`），而 `border-color` 默认是 `#000000`，所以必须在该边确实有颜色时才补 `border-style: solid`，否则会画出一条黑边（见 [`docs/design.md`](docs/design.md) §5.3）；
- **`box-shadow`**（uni-app x Android 上会导致点击穿透 / 命中丢失，实证见 `docs/ui-review.md` §1）——层级一律用 `border` + surface 色差表达，纯装饰不可点击容器可用极轻 shadow。

宽屏尺寸优先使用运行时计算的 `px`，手机端固定尺寸可以使用 `rpx`。

标签组 `qt-segmented` 的间距由可选 prop `item-gap`（px，默认 0）控制：短标签紧贴时页面显式传值拉开，未传值的既有页面样式不变（见 [`docs/design.md`](docs/design.md) §6.9）。

标签组 `qt-segmented` 的标签数量不定时用可选 prop `scrollable`（默认 false）改成横向滚动：每项按内容自适应宽度，超出部分左右滑动查看；选中项被外部改动（进页面恢复、换包重算）时组件会自己把该标签滚进可视区，不需要页面额外处理（排行榜音源 tag 随数据包增减，见 [`docs/design.md`](docs/design.md) §6.10）。

## 批量选择与批量管理条

从 PC 端 `BatchBar.tsx` 移植的批量下载 / 批量收藏，选择态在 `composables/use-batch-select.ts`，管理条是 `components/qt-batch-bar`（见 [`docs/design.md`](docs/design.md) §6.11）：

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
  <template v-else><!-- 常规页头 --></template>
</view>
```

- `layout` 两档（2026-10-19 起）：默认 `bar`（横向单行）按下面的契约走；`column` 竖排两行档**宽屏左栏专用**——全选行 + 三颗等分按钮（40px / 20px 圆角），自然高度，在详情页左栏封面块里原地替换常规按钮组，宽屏列表顶不再有操作条（对齐 qt-pc 的页头管理，见 [`docs/design.md`](docs/design.md) §6.11）；
- `bar` 档**不自带外框/背景/外边距**，且**必须放进横向 row 容器**（根节点 `flex:1` 撑满宿主行）；`column` 档是独立块，不要放 row 容器；
- `md` = 96rpx / 60px（对齐列表页头），`lg` = 132rpx / 76px（暂无调用方，保留备用），只对 `bar` 档生效——**必须与宿主行等高**，否则切换选择态整页会跳；
- `total` 传**可见集合**条数（有筛选时传全量会让「全选」勾上看不见的歌）；
- `qt-song-row-lite` 已内置选择态，宿主直接绑 `:selecting` / `:selected` / `@select`，不要再自己加复选框；宿主 `list-item` 最好不绑外层 `@click`、单靠组件事件（每日页模式），若保留双层绑定（歌单详情页模式）处理里必须 `if (selecting) return;` 早退，否则一次点击既勾选又播放；
- 批量收藏复用 `qt-playlist-picker` 的 `batchMode`（`:song="null"` + `@toggle` + `@create`，见 §6.12），**批量场景要挂载第二个 picker 实例**，不要和单曲 picker 共用；
- 回执走**底部居中**轻提示（`stores/toast.ts` 的 `qtToast` / `qtToastSuccess` / `qtToastError`），**不要写进页头行**（文案长度会把页头右侧按钮推来推去）。

## 临时提示（toast）

全站临时提示只有一条路：`services/toast.uts` 的 `qtShowToast(options)`（页面/.ts/.uts 都能 import），落到 `stores/toast.ts` + `qt-toast-host`，在**屏幕底部水平居中**渲染，位置让开底部 TabBar。

```ts
import { qtShowToast } from "@/services/toast";
qtShowToast({ title: "已加入下载队列", icon: "success" });
qtShowToast({ title: "网络较慢，请稍后重试", icon: "error" });
```

- **不要再调 `uni.showToast`**：原生 Toast 的位置/字号/直角黑底由各家 ROM 决定，安卓与鸿蒙长得不一样。全站 249 处调用已在 2026-10 一次性迁到 `qtShowToast`。
- `icon` 决定档位：`success` 绿勾、`error`/`fail`/`exception` 红色感叹号（停 6 秒）、`none` 与缺省是普通档（蓝信息图标，停 3 秒）；`loading` 不弹提示（转圈用 `qt-loading` 自己表达）。
- `duration` 已不生效，只为兼容老调用点保留。
- 图标 `alert` 是给出错档用的，别删（`tools/check-uvue.mjs` 会因 UNUSED 报错）。
- 需要用户动手处理的错误仍要写在页面里 —— 浮层几秒就走，只适合「知道一下就行」的回执。

## 全局字号缩放

`stores/font-scale.ts` 提供应用级文字大小切换（很小 / 小 / 标准 / 大 / 很大，倍率 0.85 / 1.0 / 1.15 / 1.3 / 1.5，**默认标准档 = 1.15**）。
Vapor 禁用 CSS 变量且文字样式不继承，所以缩放只能逐 `<text>` 绑内联样式：

```vue
<text :style="('color:' + theme.skin.text + ';') + qtFont(25)">标题</text>
<text :style="qtFontDual(26, 15)">紧凑 26rpx / 宽屏 15px</text>
```

- `qtFont(baseRpx)` / `qtFontPx(basePx)`：单一基准；
- `qtFontDual(baseRpx, widePx)`：**凡是有 `-wide` px 覆盖的节点必须用它**——内联 `font-size`
  会压掉 `-wide` class 的宽屏覆盖，必须把两个基准一起交给它按 `layout.isWide` 分支；
- helper 输出与 class 原值的关系只由倍率决定（`scale = 1.0` 时逐位一致）；
  默认档已从 1.0 上调为 **1.15**，即开箱渲染比历史上大 15%，`scale = 1.0` 现在是「小」档。

设置入口在「主题」页的「文字大小」卡片。完整说明见 [`docs/design.md`](docs/design.md) §6.8。

平台红线、整改进度与剩余问题清单见 [`docs/ui-review.md`](docs/ui-review.md)。

## 骨架屏与扫光带

加载态统一用「骨架屏 + 全页共用一条斜向扫光带 + 60ms 错峰浮现」：

```vue
<view class="sk-host">
  <!-- 真实首屏行与骨架同形同位 -->
  <view v-for="(row, i) in headRows" :style="reveal.itemStyle(i)">…</view>
  <!-- 骨架整层只挂一处，光带也只挂这一处 -->
  <view v-if="skeletonOn" class="sk-layer">
    <view v-for="ri in skeletonRowCount" :style="reveal.skeletonStyle(ri - 1)">…</view>
    <QtSkeletonShine :visible="shining" />
  </view>
</view>
```

- `composables/use-qt-reveal.ts`：`startReveal(n)` 排 60ms 错峰时间轴，`itemStyle` /
  `skeletonStyle` 给出成对的反相透明度；**光带每页只挂一条**，每块骨架各挂一条会变成一堆
  各自闪烁的碎片；
- `qt-skeleton-shine`：`visible` 控制显隐，`duration` 默认 1500ms，`angle` 默认 20°，
  扫光强度按主题给（浅色 0.78 / 深色 0.48）；
  放在 `position:relative` 的骨架容器最后一个子节点；
- 骨架块底色是光带对比度的另一半：贴图峰值 0.95 + 底色 `rgba(25,29,38,0.18)` 是 2026-10
  真机截图量化后的定标值（早先 0.70 + 0.08 实测只有 6.7% 对比度，用户「完全看不出来」）；
  贴图峰值是全主题上限，主题差异由光带自己的 opacity 表达——白色光带压在深色底上的
  对比度是浅色的 4.3 倍，用户 2026-10 反馈「扫光太亮」后定为浅色 0.78 / 深色 0.48
  （浅色 12.4% / 深色 32.7%，模型见 `shots/contrast-model.py`）；
- 骨架行数必须等于真实首屏行数，否则数据到达时整页会跳。

### qt-skeleton-list：整层骨架（推荐直接用这个）

`components/qt-skeleton-list/qt-skeleton-list.uvue` 把上面那套「同形骨架 + 一条光带 + 错峰浮现」
封装成一个组件，页面只需要给形状和行数，不用再逐节点写骨架几何：

```vue
<!-- 曲库 / 搜索这类 scroll-view：真实行先渲染，骨架整层盖在上面 -->
<view class="sk-host">
  <view v-for="(row, i) in rows" :style="reveal.itemStyle(i)">…</view>
  <QtSkeletonList v-if="skeletonOn" kind="song" :rows="SKELETON_ROWS"
    :revealed="reveal.revealedCount.value" :lifted="skeletonLifted" :shining="shining" />
</view>

<!-- list-view / list-item 这类原生虚拟列表：骨架独占一个 list-item，数据到了整条换掉 -->
<list-item v-if="loading && items.length == 0" class="sk-item">
  <QtSkeletonList kind="notice" :rows="SKELETON_ROWS" />
</list-item>

<!-- 首页这种「多块独立数据源、逐块上屏」的页面：不进 overlay、不做错峰，直接 v-if -->
<view v-if="loading && songs.length == 0" class="sk-fill">
  <QtSkeletonList kind="row" :rows="8" :columns="2" />
</view>
```

| prop | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | `tile` \| `row` \| `song` \| `card` \| `chart` \| `notice` \| `feedback` \| `text` | `song` | 骨架形状，每个形状的尺寸都对齐一个真实行类（见组件头注释里的对应表） |
| `rows` | `number` | `6` | 骨架行数，必须等于真实首屏行数 |
| `revealed` | `number` | `0` | 已浮现行数，传 `reveal.revealedCount.value`；用 list-item / v-if 方案时不传 |
| `lifted` | `boolean` | `false` | 盖在已渲染的真实行上（`position:absolute`），真实行数为 0 时传 `false` |
| `shining` | `boolean` | `true` | 是否挂扫光带；骨架已盖住内容、或这块会被截图导出时关掉 |
| `cardWidth` | `number` | `0` | `card` / `chart` / `tile` 每块宽度（px），`>0` 时套到骨架上；`tile` 的方形封面边长也跟随它 |
| `gap` | `number` | `0` | 仅 `tile`：块间横向间距（px）；`0` 用形状自带间距。首页歌单架的间距按窗口宽算，所以由页面给 |
| `nowrap` | `boolean` | `false` | 仅 `tile`：单行不换行（横向滑动的歌单架）；默认换行网格（宽屏歌单网格） |
| `columns` | `number` | `0` | `>1` 时每块按 `100/columns%` 切分并换行（宽屏新歌是 50% 定宽两列） |

三个使用红线：

- **页面只能传 prop，不要给 `QtSkeletonList` 传 `class` / `:style`**：组件根节点自己绑了 `:style`，
  透传合并不可靠（同 `qt-skeleton` 的警告）；
- **骨架容器不要复用页面的 `.empty`**：那里通常带 `padding:140rpx 0` + 居中，会把骨架压窄。
  用独立的 `.sk-item` / `.sk`，`padding:0` + 与真实行相同的内边距；
- **放进 `flex-direction:row` 的容器里要包一层满宽容器**：骨架组件根节点是 flex item，
  直接塞进 `row` / `row+wrap` 网格会被压成内容宽，百分比宽度和换行全部失准
  （首页的 `.sk-fill{width:100%}` 就是干这个的）。

`use-qt-reveal.ts` 的 `resetReveal()` 是每轮加载的必调项：`revealedCount` 结束后停在
`QT_REVEAL_ALL(999999)`，不重置的话第二轮的骨架行会一直透明。

完整说明见 [`docs/design.md`](docs/design.md) §6.7。

## 下载设置与自定义下载目录

下载设置是独立一页（`pages/download-settings/index`），包含保存位置、默认音质、文件名格式、同时下载数、同时下载封面 / 歌词。

「下载保存位置」在 Android 上可以改成任意目录：

- 点该行直接拉起系统文件管理器选文件夹（PC 端同款交互，行即入口）；
- **先查权限再选目录**：写自定义目录走 `java.io.File` 直写，必须先拿到「所有文件访问」（Android 11+）或 `WRITE_EXTERNAL_STORAGE`（Android 10-），否则一定写失败；
- 鸿蒙手机的系统选择器不支持选文件夹（`FolderSelection` syscap 仅 2-in-1 可用），该端保持 `/Download/QtDownload/Music` 并给说明；
- 选了自定义目录后设置页多出「恢复默认位置」一行；改目录只影响之后的新下载。

完整说明见 [`docs/design.md`](docs/design.md) §6.13。

## 播放设置

播放设置是独立一页（`pages/play-settings/index`），包含默认倍速、定时关闭、均衡器、同时播放、无缝播放、播放默认音质、音乐缓存上限（含「自定义…」页内输入弹层）。

- 这六项原来散在设置主页的两组里，现已整体搬走，设置主页只留一行入口（行尾摘要显示当前倍速与音质）；
- 状态只有这一份：`currentRate` / `sleepMinutes` / `concurrentMode` / `cacheLimitMb` / `gapless` 与弹层状态都只在本页，设置主页不再保留副本；
- 每次 `onShow` 都与原生层重新对账（`audioPlayer.rate` / `getConcurrentMode()` / `getCacheLimitMb()` / `getGapless()`），所以「清除全部缓存与数据」复位后进页面看到的是真实值；
- 音质档位按当前音源收敛（`registry.sourceQualities`），切音源后重进页面自动生效；
- 自定义缓存上限用页内输入弹层，不用 `uni.showModal({ editable: true })`（该输入框在 App 端不渲染）；
- **无缝播放**（默认关闭，与 qt-pc 同名设置对齐）：只做「提前把下一首的播放地址取好」（写 `musicApi` 的 urlCache，切歌时取链直接命中），不改 current/时间线、不调原生 `resolveDone`（无挂起请求时会被丢弃）。Android 的 media3 时间线本就预缓冲下一条目，取链一快就无缝；鸿蒙是「一次只解析一首」的串行模型，只能缩短取链时间。开关只落 `qt-playback-gapless`，原生无对应配置；行内开关是自绘 `.toggle`（全仓未用过 `switch` 组件，范本 `pages/equalizer`）。

完整说明见 [`docs/design.md`](docs/design.md) §6.14。

## 本地音乐扫描

本地页（`pages/local/index`）的扫描范围是整块共享存储：原生层 `scanLocalAudio` 直接查 MediaStore 音频库，不做 `IS_MUSIC` 过滤，返回的就是系统认定的全部音频行。

- **不按 `is_music` 过滤**。Android 的 `is_music` 是「目录启发式」的产物——文件落在 `Ringtones/` 名下就是 0，哪怕它是首完整的歌；应用自己的按钮音效反而常常是 1。更要命的是 SQL 三值逻辑：手工插入或标签未补全的行 `is_music` 为 NULL，`IS_MUSIC != 0` 求值为 NULL（假），整行被静默丢弃，用户自己放进下载目录的歌就是这么消失的。
- **默认排除系统音，并提供开关**。`Ringtones/`、`Notifications/`、`Alarms/`、`Recordings/`、`Cache/`、`Android/data|obb/` 这些目录下的音频默认不显示；勾上「包含系统音」（导入配置页的扫描规则卡片，或列表页右上三点菜单）即可放出来。判断只看路径，不看 `is_music`。
- **过滤在页面层**，所以开关一开立刻重算，不需要重新扫描；原生层始终返回完整音频池。
- **TITLE 为空时退回文件名**（去掉扩展名），时长缺失的行照常列出（显示 0），不再像以前那样直接跳过。

完整说明见 [`docs/design.md`](docs/design.md) §6.15。

## 歌单详情红心

歌单详情页（`pages/playlist/index`）hero 里只有一颗红心，本地歌单和在线歌单共用同一个外观与同一个处理函数：

- **在线歌单**：点一下收藏 / 取消收藏，状态来自 `player.isPlaylistSaved(pl)`。
- **本地歌单**（`platform === 'local'`）：红心恒为实心——自己的歌单按定义就在收藏里，没有「未收藏」状态；点一下弹二次确认，确认后即删除歌单。本地歌单的「取消收藏」就是删除，所以确认文案必须写清后果。
- 排行榜与专辑不显示这颗红心（榜单无本地实体，专辑收藏无意义）。

**详情页一套模板**（2026-10-22）：`pages/playlist`（歌单 / 专辑 / 排行榜）与 `pages/artist`（歌手）共用同一套结构——宽屏左栏 272px 信息卡（封面 + 标题 + 简介 + 数量 + 播放全部/加入队列/批量）+ 右栏歌曲列表，竖屏信息卡 + 吸顶操作条 + `qt-song-row-lite` 行。差异只有：歌单页多一颗收藏红心、专辑页多一条数量行、歌手页保留分页进度行（作品可能几千首）。**专辑与排行榜没有独立页面**，都是 `pages/playlist` 的 `type` 分支。

完整说明见 [`docs/design.md`](docs/design.md) §6.16。