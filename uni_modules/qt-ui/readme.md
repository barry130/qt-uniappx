# Qt UI · 音乐 HD 设计系统

宽屏底栏的队列按钮发出 `queue` 事件，由当前 `qt-page-frame` 或 `qt-wide-workspace` 挂载
`qt-playback-queue`，在底栏右上方查看/播放/排序/移除队列，不导航到播放页。
它是特殊锚定抽屉业务组件：普通 `qt-sheet` 的宽屏居中位置不符合底栏入口，故保留独立定位外壳，
复用主题、字号、共享布局及播放器队列虚拟窗口。只在打开时挂载，关闭或换页即释放；返回键优先关闭队列。

这是一个面向 uni-app x Vapor 模式的独立 UI 组件模块。

**先查找、再复用**：[组件目录与复用契约](<docs/component-catalog.md>)覆盖全部组件及按场景选型。选择用共享红色状态，普通弹层、选项、多选、开关和分段复用公共族；页面不得私绘复制。新增组件必须同步目录、设计与 `check:ui-selection` 门禁。

升级弹窗 `qt-upgrade-popup` 保留强制更新的专用居中外壳，复用 `qt-rich-text` 与 `qt-button`。标题、版本、渠道与包大小合并为紧凑标题区；面板按可用窗口高度展开，正文独立滚动、操作区固定，避免长公告挤在 260rpx / 180px 小区域内。手机左右各留 24rpx，宽屏沿用 modal 宽度；顶部状态栏、底部导航区与矮横窗均参与高度预算。手机双下载入口并排，“以后再说”移至次行；宽屏操作保持一行，矮横窗再压缩标题和页脚留白。所有底色与文字跟随主题，强制更新、下载中关闭锁及失败退出路径不变。

收藏重复版本由 `qt-collect-choice-host` 承接：它是挂在页面 frame 的业务适配器，
复用 `qt-sheet`、`qt-option`、`qt-checkbox` 和 `qt-button`，不增加基础选择组件族。
面板展示歌名、歌手、音源、专辑、时长和已有/待收藏状态，默认保留已有版本，可多选。
取消不提交；未选中的已有项仅从当前歌单移除。长列表打开、字号和窗口变化时定位初始选择，
用户点击复选框时保留浏览位置。回归入口为 `check:source-collection`。

`qt-playlist-picker` 的单曲和批量模式均在列表上方提供新建歌单：宿主通过 `createPlaylist(name)` 返回新歌单或 null；成功清空输入，失败保留名称。单曲新建自动加入选择草稿，确定后保存歌曲；批量新建直接收藏当前选曲。空列表展示引导并收紧高度。目标歌单右侧使用 `qt-checkbox indicator="check"` 显示白勾，其他复选默认保持 dot。`qt-option` 提供 trailing slot 承载右侧控件。

`qt-sort-panel` 的“按歌曲名 / 按专辑名 / 按歌手名”横竖屏均独占一行，标题说明排序用途，不再用左侧重复标签挤压按钮。完整标签沿用共享 `qt-option` 字号，支持最大字号；方向仍独立一行，选中即生效，再点当前方式恢复默认顺序。

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

## 页面切换

横屏、竖屏的页面进入与返回统一无动画。`App.onLaunch` 最早调用 `installQtNavigationMotion()`，通过 `navigateTo` / `navigateBack` 拦截器将 `animationType` 设为 `none`，覆盖共享导航、业务直接调用与系统返回键，保留路由参数、回调和返回拦截。`switchTab` / `redirectTo` / `reLaunch` 沿用框架自身的无动画切换；宽屏工具仍就地托管。关闭转场不改变首次加载、弹层动画或列表滚动。

设置总览的“首页返回按键”复用全局 `qt-action-sheet` 单选：一次回到后台或两次退出 APP，`stores/home-back.ts` 用单一枚举立即保存，默认保持两次退出。Android / Harmony 展示入口，其他平台隐藏。仅首页系统返回生效，优先关闭选择弹层、播放队列和宽屏托管工具；程序返回、子页返回不改。两次退出窗口为2秒，离开/返回首页及更改模式均清除计时；后台模式不停止音乐，退出模式保留既有 `stopForExit` 的队列/进度保存。

## 宽屏导航选中状态

宽屏侧栏的选中底色始终由当前路由决定：当前项使用 `accentSoft`，其余项显式恢复透明；按压反馈只改变透明度，不能覆盖选中背景。发现、我的、全部工具和设置入口统一采用选中底色、强调色图标与文字，设置子页延续设置入口高亮。

## 首页音源选择器

`qt-source-switcher` 与搜索、通知采用相同的 `surface` 底色、`border` 描边和圆角：竖屏高 88rpx / 圆角 16rpx，宽屏高 40px / 圆角 10px。音源名称 23rpx / 13px 跟随全局字号，作为当前值使用正文色，下拉箭头使用弱图标色。三控件间距为竖屏 12rpx、宽屏 10px；音源选择继续复用全局来源选择面板。

首页宽屏精选卡的“打开歌单 / 更多歌单”同排、同为 44px 触达高度，主按钮用 22px 完整圆角与横向内边距。操作行不收缩，窄窗大字时允许自然换行，避免原生 flex 行按 `min-height` 度量后裁掉纵向 padding；竖屏保留现有精选卡入口。

## 短标签度量

`qt-option` chip 的最小高度与字号同步；固定分行的短标签使用 [qtOptionChipWidthPx](<composables/qt-option-metrics.ts>)，度量包含当前字体和实际 padding/border，只覆盖无 leading/default slot 的标签。手机歌单「全部分类」等宽面板最多三列，大字或窄窗按最长标签减少列数；宽屏改用按内容宽度分行的锚定浮层。不能只加组件最小高度而让父行继续固定裁切。
页面不再给 chip/行写较小固定高度；歌单分类的宽屏预览/浮层使用 `qtOptionChipRows` 按该度量分行，字体或窗口变化会重新计算。
`check:ui-selection` 同时执行实际页面/组件 render seam 的五档字宽、行高及父容器裁切回归；设备结果必须在重建 custom-base 后另验。

完整单行标签可显式传 `QtOption :single-line="true"`，禁止文字折行及内部容器收缩，并配合 `qtOptionChipWidthPx(label, true)` 预留选中加粗的字宽。排行榜音源行横竖屏都使用这一组合，超出视口横向滚动；初次异步到货和切换选中项使用相同尺寸。正文不再显示重复的“排行榜”标题与缓存摘要，竖屏刷新使用 frame 标题栏动作，宽屏刷新位于顶部音源行右侧。

## 本地合辑

`components/qt-local-mixes/qt-local-mixes.uvue` 用于首页「为你整理」区块：展示本地统计生成的固定顺序合辑，提供紧凑/宽屏四封面 2x2 卡、详情 sheet 和全部播放。支持 `embedded`、`content-width`、`card-width` 属性嵌入已有内容列；组件不发在线请求，空合辑不占位，播放由宿主 player 的 `playReportSongs(songs, startIndex)` 处理。详情 sheet 高度竖屏 0.88 / 宽屏 0.92 倍窗口高，无底部「取消」条（只靠右上 ✕ 与遮罩关闭），列表用 `flex: 1` 铺满剩余高度。

**容器约定**：组件不自带卡片外壳，白底/描边/圆角/内边距由宿主给（首页竖屏用 `.section`、宽屏用 `.wide-panel`，与推荐歌单等区块同容器）；`embedded` 与宽屏下自身内边距为 0，`content-width` 必须传**卡片内宽**而非窗口宽，`card-width` 用于与同页其他横向架对齐卡面尺寸（未传才由组件估算）。


`stores/mini-player.ts` 保存「播放设置 → 迷你播放器」的四档偏好，竖屏与宽屏共用：`expandable` 默认点击球展开、再点条进入播放页；`ball` 仅球、点击进入；`bar` 仅长条、点击进入；`docked` 固定底栏、点击进入。前三档复用 `qt-mini-player` 与共享位置/旋转状态，支持拖动吸附；仅默认档会因页面点击或进入播放页收起。固定档在手机复用长条，在宽屏复用 `qt-player-bar`；手机 Tab 页的长条通过 `above-tab` 放到导航上方，二级页固定在安全底边。`mini-player-layout.ts` 统一底部尺寸与内容让位，无歌时不占播放栏空间。工具托管层统一接管播放入口，关闭时不会残留另一份。

## 听歌报告详情

`components/qt-listen-detail/qt-listen-detail.uvue` 是报告业务弹层。属性 `kind` 为 `songs` / `artists` / `sources` / `info`，`target` 为空时显示完整排行，否则为歌曲 `platform:id`、歌手原署名或音源 id；`loading-key` 为正在取链的歌曲标识。事件 `close` 由页面卸载弹层，`play(song)` 交给页面执行播放。竖屏底部展开、宽屏右侧抽屉，支持条目详情、相关歌曲、次数/时长排序及每批 50 项加载。页面通过 `v-if` 打开新实例，避免残留上次的详情层级。

## 页面外壳、导航与三栏设置

所有业务页面使用 `qt-page-frame`。页面只放自己的内容；背景、rail、toast、宽屏播放器底栏和窄屏返回栏都由 frame 统一宿主：

`full-width` 沉浸模式将顶部与底部安全区交给页面自身处理，frame 不重复添加状态栏或底部 padding。播放页的唱片/歌词和底部工具均使用同一份窗口快照；三键导航进入时，窗口 845/安全区42 与窗口803/安全区0 对应相同的可用底边，工具行不会被框架底色裁住。

播放页横竖屏的顶部、底部与歌词工具统一透明背景，图标和文字直接显示；保留原点击区域、功能状态色与中央圆形播放按钮。

```vue
<qt-page-frame width-kind="list">
  <!-- 页面内容 -->
</qt-page-frame>
```

它负责：

- 读取主题皮肤背景色、渲染自定义背景图片与遮罩；
- 按 `width-kind`（`form` / `prose` / `flow` / `list` / `detail` / `grid` / `full`）计算宽屏内容列；`max-width` 只可额外收紧；
- 宽屏挂全局 rail；仅固定播放栏模式且有歌曲时显示常驻底栏；底栏按实际可用宽度分配左右等宽区和中央播放区，中央为上一首/播放/下一首与原生进度滑杆，模式和队列始终可达，空间足够时显示收藏和音量；总占位为 84px 加底部安全区（详见设计文档“2026-11-06 HD 布局”）；页面切换**一律不传 `animationType`**（默认动画；曾试过宽屏 `none` 保持 rail 静止，但新 Activity 起始窗在 none 下整窗裸闪，深色系统真机反馈「每次点击黑屏闪一下」，已全量回退——见 `composables/qt-nav.ts` 头注释）；rail 的五个工具入口在宽屏下由 `qt-wide-workspace` **就地托管**进当前 tab 页（不新建 Activity、没有起始窗白帧，也不再往页面栈里堆页面），工具页组件由发现/我的两个 tab 根页通过默认插槽传入（qt-ui 不反向 import 业务页面），单活动 pane——当前托管路由匹配才挂载、切换即换挂 16~300ms（详见 [`docs/design.md`](docs/design.md) §6.18）；
- 横屏矮窗（`layout.isShort`，`windowHeight < 520`）也会落进宽屏分支（手机横屏 / 车机），按 `windowHeight` 反算的宽屏尺寸必须**先扣掉本页固定的顶部与底部行占位**，不要写 `windowHeight - 常数`；播放页宽屏舞台已按此改造并追加 `-short` 收紧规则（详见 [`docs/design.md`](docs/design.md) §10.3）；
- 宽屏 Parity（对齐网易云 / QQ 音乐 Pad）落在五处：底栏分档控件（收藏 / 播放模式 / 队列 / 音量，见上一条）、播放页**宽屏**歌词工具行的「桌面歌词」按钮（原来只有设置页一条路径；竖屏那行本就三颗药丸，加第四颗会在 375dp 上溢出，故只加宽屏）、rail 补上「每日推荐」（原来只有首页竖屏快捷药丸能进）、artist/playlist/daily/daily-recommend 左栏宽度改由 `qtContentWidth("detail")` 反算（不再写死 272/296px）、宽屏触达尺寸下限 32–36px 与浮层 `rpx` 尺寸的 `-wide` px 夹紧；改这些位置前先读 [`docs/design.md`](docs/design.md) §10.4；
- rail 的“发现 / 我的”固定在顶部，设置入口固定在底部，只有中间工具菜单滚动；主入口始终可见，不对工具滚动区发揭示目标。工具通过 [useQtSelectionReveal](<composables/use-qt-selection-reveal.ts>) 和原生 `scroll-into-view` 定位当前可用路由；挂载、路由/音源能力到货、字号和窗口改变会取消旧目标后重定位。无效路由、个人页族与设置族不定位工具菜单。实例 ID 隔离、卸载取消，不改变导航颜色或 go/back 语义。完整生产 SFC / 真实 Qt 模块及公共点击回归见 [导航回归](<../../tools/check-side-nav-reveal.mjs>)；Native-host 对齐模型不代替重新部署自定义基座后的原生几何验证；
- 全站 `navigationStyle: "custom"`：宽屏不画顶部标题，窄屏画功能性「返回 + 标题」栏；
- 设置子页与我的页族（收藏/本地/下载/最近播放/听歌报告/音乐助手/反馈/关于/个人信息）在桌面可用宽度足够时自动变成 `rail | 总览 | 子页内容` 三栏，中栏分别复用真实的设置总览（`qt-settings-overview`）与「我的」总览（`qt-profile-overview`）并高亮当前项；总览里的音乐助手入口按权限码 `user:ai:music:use` 显隐（无权限/未登录不显示，与 qt-pc 同一判定）；
- 竖屏底部导航是 `qt-tab-bar` 悬浮胶囊：左右缩 40rpx、高 120rpx、圆角 60rpx，发现 / 我的两个入口，路由当前项仍用 accentSoft（不是设置选项）。`qtTabBarFloatGapPx()` 根据完整 `navigationInsetPx` 判断系统栏是否已提供间隔，不随本页剩余 `safeBottomPx` 变换而跳动；无系统栏且确认无导航键时额外间距最多 24rpx（375px 屏宽为 12px）。`qtTabBarHeightPx()` 按实际间距、高 120rpx 和剩余安全区计算总占位，toast 与固定播放栏共用。固定模式下 `frame-dock` 让导航挂在框架根部，避开内容预留区；有歌时 `joined` 使用 88rpx 横向图文导航，与上方固定播放行共用圆角底座。原生设备像素先换逻辑 px，页面不能重复叠底部避让；
- Android `safeBottomPx` 表示当前窗口尚未避让的高度：原生导航栏高度需减去 `screenHeight - screenTop - windowHeight` 已留在窗口外的部分。窗口缩短后即使原生栏高不变也重新计算，防止设置页底部和操作表“取消”下方重复留白；真实 edge-to-edge 的导航键/手势条仍正常避让。页面及 `qt-sheet` 继续只消费共享值。
- 切页安全区与窗口高来自同一次 `getWindowInfo()`，原生回调也更新整份几何；首帧零尺寸/读取失败保留上次完整快照，原生 `(0,-1)` 表示未知，不能当作无导航栏。Android 负值保留完整栏高，按窗口已消费高度计算剩余避让，不能先清零。框架 shell 显式使用快照高度且不参与 flex 收缩，再扣同快照的内容预留；不把原生根的即时缩短与上一帧 padding 拼在一起。手机/宽屏固定播放条、joined 底座和框架底部导航使用同快照的 `top`，避免切页短暂空白与二次下移；固定栏不继承悬浮球吸附动画。转屏、分屏、键盘 resize 与导航模式变化仍实时更新。
- 鸿蒙端四处平台差异已在组件内兜住：① 鸿蒙 **不注册 tabBar**（`pages.json` 的 `"tabBar"` 整块包进 `#ifndef APP-HARMONY`）——原生 Tabs 容器在追加第二个 tab 页时不生效，`switchTab` / `reLaunch` 到 tab 页都会回调 success、页面栈也变了，但原生视图不切换；切 tab 统一走 `qt-nav.ts` 的 `qtSwitchTab()`（鸿蒙 `reLaunch`，其它平台 `switchTab` + fail 兜底 `reLaunch`），不要再直接写 `uni.switchTab`；② 首页首帧 `getCurrentPages()` 可能还是空栈，`qt-mini-player` 改为 50ms 轮询补齐宿主注册（最多 1s）；③ 鸿蒙 **fixed 宿主里的 fixed 子节点收不到触摸**（点悬浮球没反应、事件穿透到下层），子级必须改 `position: absolute` 且 `left/top` 固定为 0（位置只由 fixed 宿主负责），否则会二次偏移、`clickable` 变 false；④ 鸿蒙 **`READ_WRITE_DOWNLOAD_DIRECTORY` 在手机上是 INVALID**（2in1 专属），系统 Download 目录写不进去，公共目录必须走 `DocumentViewPicker` 选目录 + `fileShare.persistPermission` 持久化 URI 授权，下载设置页「更改位置」与权限管理页对应条目都按此改写；
- 沉浸式页面可通过 `full-width` 保持全宽。

外观页（`pages/theme`）的自定义配色取色器：行内只展示色块 + 色码（整行可点），面板内三根色带（色相 24 / 饱和 16 / 明度 16 段纯色块）只做参照，精确取值用原生 `<slider>`（色相 `0–359`、饱和与明度 `0–100`，拖动实时预览），并支持直接输入 `#RRGGBB` 色码（省略 `#` 也接受，手输值不经 HSV 往返取整）。预置皮肤里的 `rgba()` 半透明令牌（卡片、描边）也照常可编辑：色块按原值显示、面板从实色起步、应用后保留原不透明度。契约见 [`docs/design.md`](docs/design.md) §7.5。

业务页面根节点不要再写不透明背景色，也不要自行挂 `qt-side-nav`，否则会盖住皮肤背景、造成重复导航。

导航请求统一由 `composables/qt-nav.ts` 协调：竖屏底栏、宽屏侧栏与工具入口只允许一条原生请求在途，等待期间合并为最后一次点击。组件不能用旧 `current` 属性吞掉回点当前 tab。切 tab 直接定位目标，由运行时回收非 tab 页；托管工具保持到目标成功后才卸载，按打开代次防止旧回调误关新工具。缺失回执的超时只释放导航锁，不自动重跳旧目的地。Android/iOS 保留 `switchTab`（有效失败才降级 `reLaunch`），Harmony 保留 `reLaunch`。延迟回执与连续点击回归见 `tools/check-navigation.mjs`。

## 歌名与歌手跑马灯

`components/qt-marquee/qt-marquee.uvue` 是单文本往返跑马灯：必填 `text`、`size-rpx`、`size-px`、`color`、`width-px`（视口最大逻辑像素宽，不含兄弟按钮）；可选 `weight`、`active`（默认开，页面隐藏时必须传 false）。外层由原生布局按文字自然宽度收拢，只用计算好的 px `max-width` 限制长文：短文本完整静止，旁边的平台签和歌手箭头紧跟文字，不钉在行右侧；长文本按溢出距离往返，两端各停 1.2 秒。不渲染第二份文本，也不在首次测量、切歌或页面恢复后回写外层宽度造成横向拉动。组件随文字、可用宽、字号倍率和宽窄档重测，卸载取消定时器与动画。旧 `gap-rpx` / `gap-px` 属性已删除。

手机播放页使用两个独立实例，歌名与歌手各占一行；行高随全局字号同步，唱片尺寸先扣掉两行、状态栏、安全区和底部控件预算，不能反过来挤掉歌手。纯几何回归由 `tools/check-player-presentation.mjs` 校验，视觉效果仍须设备验收。

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

- `layout` 两档（2026-10-19 起）：默认 `bar`（横向单行）按下面的契约走；`column` 竖排两行档**宽屏左栏专用**——全选行 + 三颗等分按钮（40px / 20px 圆角），自然高度，在详情页左栏封面块里原地替换常规按钮组，宽屏列表顶可保留搜索、排序与批量入口，选择态下载/收藏/取消仍在左栏（见 [`docs/design.md`](docs/design.md) §6.11）；
- `bar` 档**不自带外框/背景/外边距**，且**必须放进横向 row 容器**（根节点 `flex:1` 撑满宿主行）；`column` 档是独立块，不要放 row 容器；
- `md` = 96rpx / 60px（对齐列表页头），`lg` = 132rpx / 76px（暂无调用方，保留备用），只对 `bar` 档生效——**必须与宿主行等高**，否则切换选择态整页会跳；
- `total` 传**可见集合**条数（有筛选时传全量会让「全选」勾上看不见的歌）；
- `qt-song-row-lite` 已内置选择态，宿主直接绑 `:selecting` / `:selected` / `@select`，不要再自己加复选框；宿主 `list-item` 最好不绑外层 `@click`、单靠组件事件（每日页模式），若保留双层绑定（歌单详情页模式）处理里必须 `if (selecting) return;` 早退，否则一次点击既勾选又播放；
- 批量收藏复用 `qt-playlist-picker` 的 `batchMode`（`:song="null"` + `@toggle` + `:create-playlist`，见 §6.12），**批量场景要挂载第二个 picker 实例**，不要和单曲 picker 共用；
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

## 窗口同步与跨断点状态（2026-11）

- `use-qt-layout.ts` 仍是唯一窗口快照与断点来源：compact `<600`、medium `600–899`、wide `900–1279`、desktop `>=1280`；`isWide` 仍为宽度 `>=900` 或横屏且宽度 `>=600`。
- `qt-page-frame` 通过页面 `onResize` 立即调用 `refreshQtLayout()`；托管工具框架不重复注册宿主生命周期，前台每秒轮询仍作为平台兜底，后台暂停。无效/零尺寸中间态不覆盖最后有效快照，`sizeEpoch` 仅在有效宽高变化时递增。
- `qtRpx(n)` 始终订阅响应式 `layout.windowWidth`，同一档位内缩放也会作废 computed 缓存；比例仍是原生 `windowWidth / 750`，不得封顶。初始化前保留真实窗口查询兜底，但早于 `useQtLayout()` 求值的 computed 也会订阅更新；初始化后只读共享快照。
- `qt-wide-workspace` 只保留**当前活动 pane**。跨宽窄断点不清 `route`、不递增 `openSeq`、不重新挂载；窄屏继续全屏展示同一工具，撤掉停靠 rail/播放栏，框架标题返回先关闭可见工具。窄屏新入口和深页仍走原生导航，不在 resize 中自动导航，不恢复多个隐藏 pane 保活。
- 自动回归运行 `npm run check:responsive`；共享窗口和工作区测试使用合成 `uni` / 生命周期边界，不能代替 HBuilderX Vapor 编译、旋转后实际滚动与触控验证。

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
- 倍速 / 原生设置仍从播放层读；睡眠状态在 player，记录原请求 `sleepRequestedMinutes`，播放页与设置页共用 `services/player-setting-options.ts` 的清单和选中判定（90 为播完当前歌曲，不是 90 分钟）。各页只保展示 / 弹层状态，设置主页不复制副本；
- 每次 `onShow` 都与原生层重新对账（`audioPlayer.rate` / `getConcurrentMode()` / `getCacheLimitMb()` / `getGapless()`），所以「清除全部缓存与数据」复位后进页面看到的是真实值；
- 音质档位按当前音源收敛（`registry.sourceQualities`），切音源后重进页面自动生效；
- 自定义缓存上限用页内输入弹层，不用 `uni.showModal({ editable: true })`（该输入框在 App 端不渲染）；
- **无缝播放**（默认关闭，与 qt-pc 同名设置对齐）：只做「提前把下一首的播放地址取好」（写 `musicApi` 的 urlCache，切歌时取链直接命中），不改 current/时间线、不调原生 `resolveDone`（无挂起请求时会被丢弃）。Android 的 media3 时间线本就预缓冲下一条目，取链一快就无缝；鸿蒙是「一次只解析一首」的串行模型，只能缩短取链时间。开关只落 `qt-playback-gapless`，原生无对应配置；行内开关复用 `qt-switch` 的统一红色状态，不再复制 `.toggle`。绑定 `:model-value` + `@change` 原更新函数，避免 `v-model` 后再反转造成双翻。

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
## 2026-11-06 音乐 HD 布局

首页宽屏采用通栏横向歌单架、精选与推荐/FM/播客入口，以及按可用宽和字号变化的 1–3 列歌曲/榜单；不再让榜单独占右侧列。首页快捷入口走 `qtRailNavigate`，宽屏宿主内使用现有单活动工具 pane。普通手机布局继续使用原模板。

`composables/hd-layout.ts` 只接收有效内容宽与字号倍率，提供 `qtHdHomeMetrics` / `qtHdPlayerMetrics`。封面控制在 136–180px，几何计算不依赖屏幕物理像素。底栏主控 40px 触达区，进度使用原生 slider，并核验拖动所属歌曲与播放代次。`qtPlayerBarHeightPx()` 是底栏、frame 和浮层让位的唯一来源，含一次安全底边。

左侧 rail 保持 64/96px，设置固定在底部，菜单可滚动，字号增大时行高同步增长。首页、本地合辑、播放栏继续使用 runtime theme 与全局字号；不额外叠加品牌标题栏。
## 2026-11-06 渲染与交互性能

- 悬浮唱片的角度与位置仍跨页面共享；`miniPlayerMount()` 返回实例 token，显隐通过 `miniPlayerSetVisible()` 登记，卸载按 token 注销。可见、前台、竖屏且正在播放时才调度一个 rAF；角度最多约 30 次/秒提交，播放时钟和音频进度不降频。隐藏页面保留最后帧并取消对旋转值的订阅，重新显示时直接读取最新角度。
- `miniPlayerSetForeground()` 由 App 的 onShow/onHide 驱动。窗口观察在模块层注册一次，不跟随第一个页面的组件作用域销毁；一轮窗口变化只执行一次悬浮播放器定位和坐标保存。
- 内容宽度 cap 栈以最后一个 active owner 为准，而不是最后存活的页面。`qtPushContentWidthCap(px, active = true)` / `qtUpdateContentWidthCap(token, px, active = true)` 同时登记宽度与可见性；frame 在 onShow/onHide、工具切换与工作区刷新时核对身份，隐藏页更新宽度不会收窄发现页。仅有效宽度变化时通知，相同宽度、被覆盖更新及等宽 push/pop 的零重算契约保留。
- `QtWideWorkspaceState.hostRoute` 固定记录打开工具时的宿主；`qtPaneOn(route, hostRoute)` 只给该宿主挂活动 pane，工作区根节点同步过滤归属。深页覆盖及宽窄切换保留同一工具实例，关闭才清空归属。发现页与我的页各传自己的显式 host，避免两个保留的 tab 重复挂工具。新增 `check:responsive` 的内容宽度生命周期回归（冷启/返回/双宿主/隐藏 resize/真实路由族），仍需 Android Vapor 编译和设备验收。
- 图标 SVG 缓存限制为 384 条，避免连续自定义颜色预览导致会话内存增长；清理只移除缓存，已渲染 image 使用的字符串不变。
- 搜索结果只挂载当前分类，其他分类保留数据。去重采用 Set，保持首次出现顺序；综合预览只构造 20 首歌曲、6 个歌单、8 位歌手、6 张专辑的行，不先构建全部已翻页结果。
- 回到顶部只读取共享窗口快照；宽屏固定 40px 容器、28px 图标，竖屏避让底部导航与安全区，图标跟随皮肤。

新增 `check:ui-performance` 验证以上实际源码行为，属于模拟边界下的工作量计数，不是设备 FPS/功耗实测。手机首页精选按钮为“打开歌单”；首页标题、横向歌单架行高随全局字号增长。
## 蓝牙车载歌词兼容模式（2026-11-06）

入口：设置 → 播放设置 → 蓝牙车载歌词。复用 `qt-action-sheet` 单选，三项为打开、歌手栏（保留歌名）、标题栏（兼容部分车机）。默认“打开”（模式 0）保留整首歌词到扩展元数据，不替换歌手或标题，能否显示取决于车机兼容性；模式 1/2 才启用对应字段替换。设置按 `qt-car-lyric-mode` 持久化，重置设置恢复默认模式。Android 支持，其他平台明确显示暂不支持。

该功能不是通用 AVRCP 歌词协议，也不保证进入车机专用歌词区域。检测到已连接的蓝牙 A2DP 音频设备时，原生按播放进度把当前歌词行写入所选标准媒体字段。无法区分车机与蓝牙耳机，也不保证该设备就是此刻音频路由；系统通知、锁屏等媒体控制器可能一起看到替换文字。部分接收器缓存元数据而不刷新。

歌词行跟随不依赖桌面歌词开关或播放页存活。选回默认“打开”、断开蓝牙、空行和无时间轴歌词恢复普通歌曲信息，扩展歌词仍保留；切歌的原生代次阻止旧歌词异步写入，停止和服务销毁清理轮询。兼容模式使用既有播放器位置，500ms 检查、非空行更新限频约 1 次/秒、相同行不重复发；不用音频网络流传输歌词。解析普通 LRC、多时间戳与归一化逐字行，使用播放页的歌词偏移。播放 URI、封面、评分与其他 extras 保留。

新增原生接口后必须重建自定义基座或完整安装包。`check:car-lyric` 使用实际实现及模拟 Media3/蓝牙边界验证，不能替代真实手机、车机和锁屏后台验收。

## 2026-11-07 托管侧栏滚动

宽屏托管导航补充（2026-11-07）：打开工具页时，`qt-page-frame` 卸载宿主页的 fixed 侧栏，由 `qt-wide-workspace` 独占导航。仅用不透明覆盖层遮住旧侧栏会保留其原生 ScrollView 触摸命中，导致每日新歌等页面的可见工具区无法手动滑动；关闭工具页后重新挂载宿主页侧栏，发现/我的与底部设置仍保持固定。

## 2026-11-06 本地优先与私人 FM 会话

本地优先始终生效，播放设置不再展示对应说明行或开关。所有歌曲统一按显式本机地址、下载身份、本地曲库身份、元数据护栏匹配查找，存在且可读才播放；未命中才取在线地址。收藏保留本机 URI，旧收藏在播放时回填；不把在线身份改成本地身份。封面和歌词共用延后执行的内嵌检查，再读本地缓存，缺失时联网；歌词跨启动缓存有界，封面保存私有缓存。通知封面也等待内嵌结果。无缝播放的在线预取只在 Wi-Fi 发起，移动网络仍可按需播放在线歌曲、补齐缺失资源。

私人 FM 保留画像排序、分批补歌和不喜欢反馈；普通队列快照与 FM 状态同键持久化，进入前无队列也保存空快照。退出恢复原队列/位置/模式；冷启动结束旧 FM 会话、恢复普通队列且暂停。外部点歌、播放歌单、手动入队立即退出 FM；FM 页点“接下来”保持会话。异步开始被取消或用户换歌后不能重新接管；队尾暂停而非循环旧推荐。页面说明明确此行为，不将未公开的竞品重启策略称为已验证实现。

## 2026-11-06 DLNA 投屏

Android 播放页和 HD 播放栏增加投屏入口，`qt-dlna-sheet` 作为业务适配器复用 `qt-sheet`、`qt-option`、`qt-button`，提供设备搜索、选择、断开和切回本机。宽窄屏与当前选择定位复用共享布局和 selection-reveal；接收端不支持的拖动/音量控制禁用。其余平台暂时隐藏入口。

原生网络与媒体代理位于 `qt-audio-player/utssdk/app-android/dlna.uts`，系统媒体控制由独立 `DlnaSessionPlayer` 路由到远端，本地播放器停止解码。电视使用自身播放器界面；音乐及私有封面通过当前会话的令牌 URL 提供，支持单段 Range；切歌/设备切换使用代次隔离。改动原生插件需要重建自定义基座。


固定播放栏的手机控制区为上一首 / 播放暂停 / 下一首，上一首复用 player.previous，拖动手势结束不会误触。封面展示统一走 player.coverOf：内嵌优先，其次磁盘缓存，再由歌曲原平台或歌手歌名搜索联网补齐。图片加载失败走有节流与并发去重的 recoverCover，不会重取音频。封面缓存使用 URI 安全的 v2 文件名，旧百分号文件名经 FS 迁移；空本地标签的诊断不再声称只能显示默认图。回归入口 check:cover-recovery。

本地封面搜索忽略文件名末尾的重复下载编号（如 `自由的你 (1)`），保留 Live 等版本标签；在每个来源的前五项中核对歌名、歌手和已知时长，避免拿到翻唱或演唱会图。异步封面回填替换响应式歌曲记录，保证已挂载的播放栏立即更新。

## 2026-11-07 歌词中心聚焦

[lyric-presentation](<composables/lyric-presentation.ts>) 提供 `lyricFocusAt(distancePx, viewportPx)` 与 `lyricTextFocusStyle(color, blurPx)`：歌词在实际视口中心清晰，邻近行可读，远行逐渐淡出并柔焦。手机主句基准为 44rpx、行间留白为上下各 28rpx；宽屏沿用原 px 字号与布局。高亮只变字重/颜色，不放大，因此已测行高不会随播放位置改变。浅/深皮肤与封面态共用原有前景/背景，不额外叠深色遮罩。

主句、罗马音、译文及逐字底层/填充层都直接设置文本样式。柔焦使用有明确颜色的原生 `text-shadow`，清晰态恢复文本颜色并清除阴影；不引入 `filter:blur`、Web 裁字、原生插件或新的播放时钟。几何未实测时保持可见清晰；实际 `@scroll`、80ms 合并尾帧、4 秒手动浏览窗口、点行 seek 与偏移逻辑保持原契约。

`check:player-presentation` 同时运行原播放器检查、公开展示函数回归与既有歌词视口回归。函数/静态检查不代表原生绘制、逐字柔焦裁边、长双语及五档字号的设备验收；仍需真实 HBuilderX 编译，并在可用设备上核对紧凑与宽屏。


## 2026-11-07 侧栏导航位置保持

侧栏改用 `useQtNavScroll`：发现、我的和托管工具页共享本次运行的工具区滚动位置，固定/停靠侧栏换挂及原生 tab 返回都恢复。点击已完整可见的私人 FM 等入口仅更新高亮；从其他入口打开不可见工具时，实测当前视口并最小滚动露出。手动滑动不会被选中项拉回；隐藏页面的回执不能覆盖位置，字号/窗口/能力变化重新测量并夹住偏移。继续卸载被覆盖的宿主侧栏，避免原生触摸重叠。`check:responsive` 覆盖真实 SFC 换挂、最近边缘、保活返回、隐藏回执及 20 个窗口/字号组合；原生触摸另行设备验证。


## 2026-11-07 歌单分类悬浮面板

歌单广场宽屏只展示一行分类，全部分类入口放在同一行右侧并预留字号自适应宽度，行高按 `qt-option` 共享字号度量加 8px 间距计算，不继承手机的 72rpx 固定高度。全部分类复用已有专用锚定面板与 `qt-option`：在工具条下方浮起，圆角、主题实色底、细描边与轻阴影，透明外层点击收起，不推挤歌单列表。`qtOptionChipRows(items, available, gap)` 共享标签度量并保持分类顺序。面板独立纵向滚动，高度不超过半屏并受实测页面剩余空间限制，避开固定播放栏；打开定位已选分类，选中立即收起。手机保持标题栏入口，面板与全宽 page-frame 对齐（不再扣宽屏 gutter）；扣除边框与内边距后按实时字号分成最多三列。显式原生行/单元格承载等宽 `qt-option`，行内不再依赖组件自动折行；排序选项也通过原生外层统一间距。


## 2026-11-07 歌单详情工具布局

歌单/专辑/榜单详情的宽屏左栏封面居中且最大 220px，下方保留标题、最多三行简介、歌曲计数；主操作复用 `qt-button`，播放与小型收藏按钮同行、加入队列用 ghost。窄左栏遇大字时主操作纵排。搜索框与“排序 / 批量”入口放入右侧原生 sticky-header（主题实色底，避免歌曲透出）；排序直接打开现有 `qt-sort-panel`，批量仍复用左栏 `qt-batch-bar`。有效列表列宽不足时工具栏分两行，手机继续使用标题栏搜索和原吸顶操作条。没有新增组件族。

### 每日新歌与每日推荐（2026-11-07）

两页与歌单详情共用 `detailLayoutMetrics`：有效内宽足够才分栏，封面居中、最大 220px；宽度不足保持宽屏字号的单列。宽屏左栏播放动作复用 `qt-button`，每日新歌保留“加入队列”，每日推荐保留“换一批”和有文字的“推荐设置”。搜索框、“排序 / 批量”统一进入歌曲列表的原生 sticky-header；排序直接打开 `qt-sort-panel`，批量管理仍复用 `qt-batch-bar`。手机保留标题栏搜索与吸顶操作条，推荐理由、口味与生成方式不变。


### 播放设置行高（2026-11-07）

播放设置单列和双列统一用内容高度加上下留白，移除固定行高与 height:auto 的覆盖依赖。横排标题单独使用 flex，副说明上方的标题保持自然高度；宽屏图标 22px、箭头 18px，说明行高 1.5，开关不收缩并与正文预留 16px 间距。普通宽屏行内容最小 32px 加上下各 16px 内边距，说明项上下各 18px，长文案与大字号自然撑高。本地优先已是固定播放规则，设置中移除说明行及废弃的本地开关状态，不改资源查找逻辑。

### 播放风格（2026-11-07）

`qt-playing-style-sheet` 是复用 QtSheet/QtOption/QtButton 的业务适配器，不另造选择控件。`stores/playing-style` 只保存呈现偏好；经典唱片、歌词律动、专辑画廊、纯净歌词在横竖屏共享。`qt-focus-lyrics` 负责三行与律动呈现，输入 lines/activeIndex/position（已减歌词偏移）、ink/muted/heightPx/loading，仅输出长按 copy；普通点击不跳转播放进度。长句溢出仍可滑动阅读。经典滚动歌词继续使用原有逐字、滚动测量与手动浏览逻辑，手动滚动后点击目标行才定位播放。

竖屏唱机与专辑画廊共用 `portraitPlayerMetrics`：先保证状态栏、安全区、三行歌曲信息与底部触控区，再按宽度限制主视觉。长屏额外高度分散到主视觉上方、歌曲信息上下，唱机与歌名间距最多92rpx；短屏和大字号优先压缩主视觉，不压缩控件。`check:player-presentation` 覆盖短屏、长屏及平板竖屏五档字号的几何预算与歌词点击行为。

### 播放风格预览卡片

按 qt-pc 参考图使用两列缩略预览：经典是唱片与三条歌词线，律动是错落的“随心而动”，画廊是方形封面与歌词，纯净是三行居中歌词。颜色依次为 #e8e5ee / #542638 / #3b414d / #1d2b43，正文仍用主题墨色与系统无衬线。下方背景改一排色块并显示所选名称，减少文字按钮。大字体改单列，内容高度随实际行数预算，超出可滚动。

QtOption 新增 `preview` 布尔与 `preview` 插槽，用于竖向图文卡；新增 `kind="swatch"`，默认插槽提供色块或图片；`indicator` 默认 false，仅本次预览选择显式开启勾，选中仍由 qtSelectionColor 控制，已有菜单/标签外观不变。播放风格面板增加可选 `cover` 用于封面背景缩略图，不调用播放器。预览全部使用原生 view/text/image，无 CSS 渐变、独立动画或新图片依赖。

### 内容卡片与唱机图层（2026-11-08）

普通卡片、歌曲列表及其工具条统一取 `skin.surface`（内置浅色为白色），次级控件和输入框分别用 `surfaceMuted`、`surfaceInset`；选中/播放状态保留语义色，深色与自定义皮肤跟随令牌。页面内复用同一内容列，列间距仅在分栏时启用，避免竖屏卡片左右边缘不齐。每日推荐歌曲行对齐 `qt-song-row-lite` 的封面、留白和分隔线，保留推荐理由与序号。

`composables/turntable-presentation.ts` 的 `turntableStyles(metrics, unit)` 为竖屏唱机输出底座/唱臂画布、唱片与旋转容器、中心封面的明确 px 尺寸和位置，避免原生绝对定位子图层依赖百分比高度。播放页沿用原有材质和旋转逻辑，底盘圆形占位保障图片加载期间的轮廓；几何检查覆盖窄屏、长屏、平板及不同字号，不代替原生绘制验收。

### 头像与首帧布局（2026-11-08）

`useQtAvatar()` 为“我的”、个人信息和头像预览提供 `avatarSource`、`refreshAvatar()`、`onAvatarError()`。展示同步优先读取账号所属的持久化图片，后台更新通过同一事件通知，卸载自动取消监听。网络和文件缓存归 `services/avatar-cache.ts` 管理，资料保存仍用远程 URL；登录/换号/登出、旧请求回执与上传后的本机回显均遵守会话身份，不能把本机路径提交到服务器。

`qtContentWidthRaw()` / `qtContentWidth()` 在紧凑布局返回窗口全宽，与 page-frame 一致；仅宽屏扣 rail/gutter 并应用分栏上限。排行榜测量前后使用同一宽度预算，不先以窄48px的卡片渲染。`useQtSelectionReveal` 可传第四参 `shouldReveal(index)`，有明确尺寸的横向组可跳过已完整可见项；排行榜跟踪真实 scrollLeft，只揭示越界选中项，保留异步列表、字体和窗口变化后的可达性，滚动不使用动画。默认三参行为不变。
