# Qt UI 组件目录与复用契约

> 新增或修改界面前，先查本目录、[模块说明](<../readme.md>)、[设计规范](<design.md>)和对应源码。已有能力优先复用；缺能力先扩公共族，再考虑新增族。页面不得复制选项、复选框、开关和选择弹层。

## TV 接入约定（2026-11-15）

TV 继续复用下方全部组件族。共享布局 `isTv` 控制字体/尺寸，页面不另造电视组件库；[use-qt-tv](<../composables/use-qt-tv.ts>) 提供模式与焦点公开API，[use-qt-tv-modal](<../composables/use-qt-tv-modal.ts>) 绑定专用弹层的真实panel和原关闭守卫。焦点青色与设置选中红色分别表达位置和状态。

`QtButton` 的 `wrap?: boolean` 使TV长标签自然换行，`fullWidth?: boolean` 使根横向伸展；歌曲行族的 `tvId?: string` 为重复歌曲传稳定出现项身份。`data-qt-tv-id` 在当前原生页内唯一，QtSegmented自行加入挂载实例uid。容器 `qt-tv-skip` 排除自身空点击，实际只读滚动容器 `qt-tv-scroll` 支持逐屏浏览；两者保留合法子项。

共享尺寸和键位规则见 [模块说明](<../readme.md>)、[设计规范](<design.md>) 与 [Android TV 集成](<../../../docs/TV_NATIVE_INTEGRATION.md>)。执行 `npm run check:tv` 不替代原检查链或原生设备验证。

## 1. 按场景选组件

| 场景 | 首选 | 状态 / 事件 |
|---|---|---|
| 临时命令或单选列表 | qt-action-sheet / 全局 host | actions / selectedIndex；select(action,index)、close |
| 列表、短标签、选择卡片 | qt-option | label、description、selected、disabled、kind（row/chip/card/swatch）；select；singleLine 完整单行标签；rowMinHeightPx 原生行高下限；labelAlign（left/center）标签在整行内居中；preview 插槽与 indicator 可选勾 |
| 多选 / 全选 | qt-checkbox；歌曲行已有选择态 | checked、disabled、size、indicator（dot / check）；change(boolean) |
| 升降调调节 | qt-pitch-controls | visible、value(-12..12 整数)、supported；update:visible、change(integer)；原调0，实际服务与能力回读由页面负责 |
| 布尔设置 | qt-switch | modelValue、disabled；change(boolean)、update:modelValue |
| 单选分段 / 横向标签 | qt-segmented | list、modelValue、itemGap、scrollable；change、update:modelValue |
| 排序键 / 方向 | qt-sort-panel | sortKey、sortDesc；select、desc；再次点当前键回 none |
| 直接拖动卡片改顺序 | qt-reorder-list | items(id/disabled)、disabled；default slot 携带 id/index/handle；reorder(ids) 仅放手提交，active(boolean) 协调父滚动 |
| 单曲 / 批量收藏 | qt-playlist-picker | selectedIds、createPlaylist(name)；单曲 confirm，批量 toggle；两个独立实例 |
| 收藏中的重复版本 | qt-collect-choice-host | 分组多选；取消不提交，每组至少保留一个版本 |
| 普通弹层外壳 | qt-sheet | visible、title、subtitle、dismissible、footerFlush；close、update:visible；default/footer slots |
| 每日推荐 / 私人 FM 供给 | qt-recommendation-source-control | kind=daily/fm；两份来源独立；change(kind)，复用全局选择宿主 |
| 批量管理条 | qt-batch-bar | count / total；toggle / download / collect / cancel |

### 拖动顺序族的新增理由（2026-11-13）

`qt-sort-panel` 选择排序键和方向，不管理任意卡片的直接拖动、实测高度、触摸代次与临时预览；`qt-mini-player` 的拖动是单个浮球坐标和边缘吸附，不是列表持久顺序。因此新增无业务依赖的 `qt-reorder-list`，继续由既有 QtCard/QtSwitch/QtIcon 绘制平台内容，组件只接管几何和手势，保存留给页面及策略服务。完整组件 API 和已验证边界随实现同步，原生编译与设备触摸仍须独立验收。

### 统一状态

- 选中标红：浅色 `#d93c43`，深色 `#ff7378`，由 [selection](<../composables/selection.ts>) 提供，与可自定义的皮肤 accent 无关。普通选项不能拼 `✓`、`（当前）` 或“当前使用”；收藏歌单通过共享 `qt-checkbox indicator="check"` 明示多选，自定义 action color 不覆盖选中红。
- 成功回执、签名验证、签到、收藏、正在播放及路由导航是不同语义，保留原标识，不改成设置选择。
- 未知 ID / 越界 index 是无选中，不偷选第一项。动态音质清单若保留旧档，必须同步维护显示数组与值数组。
- 短标签 chip 的单行最小高度随当前字体同步；固定分行使用 [qtOptionChipWidthPx](<../composables/qt-option-metrics.ts>) 的真实 border-box 度量（无 leading/default slot），父行不得用小固定高度裁掉标签。手机等宽类别面板按最大标签和实时字体减少列数（最多三列）；宽屏分类浮层用 `qtOptionChipRows` 按内容宽度分行，普通字号保留原密度；不复制组件标签/padding常数。
- 不允许折行的横向标签使用 `singleLine=true` 和 `qtOptionChipWidthPx(label, true)`；预留加粗及字体差异，选中前后宽度不变，超宽由外部横向 scroll-view 承接。默认关闭，不改变普通列表或卡片的换行行为。
- 长清单打开、异步列表到货、外部选择变化、字号和窗口变化时自动露出选中项。横滚保真实内容宽与 `scroll-left`；原生纵滚使用 [useQtSelectionReveal](<../composables/use-qt-selection-reveal.ts>) 的实例唯一 ID / anchor、代次和卸载取消。
- 多选在打开或外部集合变化时定位首个列表顺序命中的选中项；用户点选不应每次抢走正在浏览的位置。
- 共享开关只接一次原业务更新：使用 `:model-value` + `@change`，或 `v-model`，不要同时双向绑定又调用反转函数。

### 弹层与服务

- 普通 QtSheet：手机底部、宽屏居中；主题 surface/scrim，窗口高度与安全区限制。必须挂在覆盖整窗的页面 / frame 层，放在 list-view 后；不能嵌进仅有触发按钮高度的小祖先。
- `dismissible=false` 在发送 model 更新之前禁止关闭；业务 busy、安装中、权限与验证流程仍由业务适配器负责。普通共享壳当前是显隐挂载，不声称保留旧延时关闭动画。
- 歌单 picker 保留 `anchorTop` 输入兼容，但普通选择改为统一 Sheet，不再跟随该坐标弹出小 popover。单曲草稿打开时恢复，取消不提交歌曲；新建入口两种模式均可用，createPlaylist 成功返回新歌单后才清空名称。单曲新建自动选中草稿，batchMode 即时 toggle / 新建收藏。不得合并两个业务实例。
- 歌单分类保留专用锚定面板：宽屏在单行预览下方悬浮（全部分类入口同行靠右），手机标题栏下方打开，内部限定高度独立滚动；选中/点外部收起。复用 qt-option 和共享 chip 度量，不改用普通居中/底部 Sheet。
- 强制升级、不可关闭公告 / 免责声明、确认框、右侧详情抽屉及连续颜色 / 进度控件保留专门业务契约；不能为了共壳静默改变关闭权限、位置或按钮语义。
- [action-sheet 服务](<../../../services/action-sheet.ts>) 捕获请求清单快照；取消、替换或空请求会兑现旧 Promise `-1` 并清空可见状态；有效 pick 返回下标。requestId 令连续相同清单也重建定位。组件外部值改变可触发定位，但服务不宣称追踪未传入的新业务状态。
- [播放设置选项](<../../../services/player-setting-options.ts>) 统一倍速与睡眠清单。90 是“播放完当前歌曲后”哨兵，非 90 分钟；选中由 player 保存的原 preset 判定，不能用变化中的倒计时余量。

## 2. 完整组件清单

目录与真实组件文件由 `check:ui-selection` 校验，新增、删除或改名时必须同步更新。业务适配器的完整 props / events 以链接源码和设计章节为准，不能将相似外观当成相同业务。

| 组件 | 用途 / 复用边界 |
|---|---|
| [qt-option](<../components/qt-option/qt-option.uvue>) | row / chip / card 选项，leading/default/trailing slot；可选 rowMinHeightPx 将最小触控高度放在原生行根节点，文本留白内置 |
| [qt-sheet](<../components/qt-sheet/qt-sheet.uvue>) | 普通弹层、header / footer、关闭权限 |
| [qt-switch](<../components/qt-switch/qt-switch.uvue>) | 布尔设置，红轨与主题 thumb |
| [qt-checkbox](<../components/qt-checkbox/qt-checkbox.uvue>) | 默认红环点，indicator="check" 显示红底白勾；保持 change 与点击隔离 |
| [qt-action-sheet](<../components/qt-action-sheet/qt-action-sheet.uvue>) | Sheet + Option + Reveal 的兼容适配器；SheetAction.description 副信息、完整多行标签及实测内容高度 |
| [qt-action-sheet-host](<../components/qt-action-sheet-host/qt-action-sheet-host.uvue>) | 全局服务渲染出口 |
| [qt-app-update-host](<../components/qt-app-update-host/qt-app-update-host.uvue>) | 应用更新弹窗的框架层宿主；读 services/app-update.ts 状态渲染 qt-upgrade-popup，与播放条 / tab-bar 同层；可见期间不替换版本，关闭统一清全局状态 |
| [qt-segmented](<../components/qt-segmented/qt-segmented.uvue>) | 均分 / 横滚标签，真实几何揭示 |
| [qt-source-switcher](<../components/qt-source-switcher/qt-source-switcher.uvue>) | 音源业务入口，使用全局 host |
| [qt-recommendation-source-control](<../components/qt-recommendation-source-control/qt-recommendation-source-control.uvue>) | 日推 / FM 的独立业务来源入口；kind=daily/fm，复用 Option / 全局 action-sheet，严格包能力、账号提示和失效快照取消；change(kind) |
| [qt-sort-panel](<../components/qt-sort-panel/qt-sort-panel.uvue>) | 排序键 / 方向，none 可取消 |
| [qt-reorder-list](<../components/qt-reorder-list/qt-reorder-list.uvue>) | 任意卡片直接拖动的几何 / 手势容器；变高行实测、临时跟手预览，放手仅发一次 reorder(ids)，取消不保存；active 协调父滚动；不持有业务策略 |
| [qt-playing-style-sheet](<../components/qt-playing-style-sheet/qt-playing-style-sheet.uvue>) | 播放风格业务适配器；复用 QtSheet / QtOption / QtButton，四风格与独立背景偏好、选图保存 |
| [qt-pitch-controls](<../components/qt-pitch-controls/qt-pitch-controls.uvue>) | 升降调展示控件；复用 QtSheet / QtButton，visible、value(-12..12)、supported；update:visible、change(整数)，原调为0；读服务和能力门控由页面处理，关闭后不发出change |
| [qt-playing-track](<../components/qt-playing-track/qt-playing-track.uvue>) | 播放歌曲标题、歌手、音源与收藏动作；compact/cover 提供歌词态小封面信息栏，普通态最多两行标题；宽度与字号由 playing-track-metrics 预算 |
| [qt-playback-source-sheet](<../components/qt-playback-source-sheet/qt-playback-source-sheet.uvue>) | 当前播放来源与音质业务适配器；复用 QtSheet / QtOption / Reveal，读取包的启用顺序与生效档位，区分本地/播客，仅发出选择事件 |
| [qt-focus-lyrics](<../components/qt-focus-lyrics/qt-focus-lyrics.uvue>) | 纯净/律动歌词呈现；接收时间轴、配色、alignStart 左对齐与 sizeScale 歌词字号倍率（与全局字号缩放相乘，缺省 1），仅长按发出 copy；画廊使用页面已有完整歌词列表 |
| [qt-playlist-picker](<../components/qt-playlist-picker/qt-playlist-picker.uvue>) | 收藏目标，草稿 / 即时多选分离 |
| [qt-collect-choice-host](<../components/qt-collect-choice-host/qt-collect-choice-host.uvue>) | 收藏业务出口，复用 Sheet / Option / Checkbox / Button，展示新旧重复版本 |
| [qt-batch-bar](<../components/qt-batch-bar/qt-batch-bar.uvue>) | 批量动作，尺寸对齐宿主 |
| [qt-local-row](<../components/qt-local-row/qt-local-row.uvue>) | 本地歌曲，选择与播放 current 分离 |
| [qt-song-row](<../components/qt-song-row/qt-song-row.uvue>) | 歌曲行，保原 play 事件 |
| [qt-song-row-lite](<../components/qt-song-row-lite/qt-song-row-lite.uvue>) | 轻行、平台签、选择事件与收藏 |
| [qt-confirm-host](<../components/qt-confirm-host/qt-confirm-host.uvue>) | 危险确认 true / false 服务 |
| [qt-first-run-disclaimer](<../components/qt-first-run-disclaimer/qt-first-run-disclaimer.uvue>) | 首启读秒门禁，非普通可取消 sheet |
| [qt-notice-splash](<../components/qt-notice-splash/qt-notice-splash.uvue>) | 公告关闭 / exit 与今日隐藏选择 |
| [qt-upgrade-popup](<../components/qt-upgrade-popup/qt-upgrade-popup.uvue>) | 升级专用居中外壳；窗口自适应长正文、固定操作区；复用 RichText / Button，保留强制模式与下载状态 |
| [qt-meta-pack-guide](<../components/qt-meta-pack-guide/qt-meta-pack-guide.uvue>) | 缺包引导，仅 go / dismiss |
| [qt-pack-install-sheet](<../components/qt-pack-install-sheet/qt-pack-install-sheet.uvue>) | 安装确认 / 安装中关闭锁 |
| [qt-listen-detail](<../components/qt-listen-detail/qt-listen-detail.uvue>) | 报告详情、trail、排序与每批 50 项 |
| [qt-page-frame](<../components/qt-page-frame/qt-page-frame.uvue>) | 页面宿主、顶栏多 active 音源标签；shell 高度与底部预留同快照，避免原生导航避让二次缩短；full-width 由页面独立处理顶部和底部安全区；原生宿主 onResize 同步共享快照，托管工具窄屏返回先关闭当前 pane |
| [qt-side-nav](<../components/qt-side-nav/qt-side-nav.uvue>) | 路由 rail；64/96px，主入口与设置固定；切页/重挂/返回保留工具滚动位置，实际视口内不移动，越界按最近边缘露出；跟随能力/字号/窗口重测，隐藏回执隔离、卸载取消 |
| [qt-tab-bar](<../components/qt-tab-bar/qt-tab-bar.uvue>) | 底部路由导航、安全区让位；joined 将固定播放栏与 88rpx 横向导航合并底座 |
| [qt-wide-workspace](<../components/qt-wide-workspace/qt-wide-workspace.uvue>) | 宽屏就地托管子页 |
| [qt-settings-overview](<../components/qt-settings-overview/qt-settings-overview.uvue>) | 设置总览业务导航 |
| [qt-profile-overview](<../components/qt-profile-overview/qt-profile-overview.uvue>) | 我的总览、签到与业务导航 |
| [qt-mini-player](<../components/qt-mini-player/qt-mini-player.uvue>) | 四模式迷你播放器（expandable / ball / bar / docked），above-tab 决定手机固定栏避让；固定栏三键、可见实例共用旋转；持续挂载的封面、文字和控件按共享窗口重新绑定 px |
| [qt-player-bar](<../components/qt-player-bar/qt-player-bar.uvue>) | HD 播放栏；等宽两翼、中央原生进度、模式/队列常驻、歌曲代次守卫 |
| [qt-playback-queue](<../components/qt-playback-queue/qt-playback-queue.uvue>) | 底栏就地队列；frame/workspace 响应 player-bar 的 queue 事件按需挂载，close 关闭，宽屏右下抽屉/窄屏底部面板，虚拟列表和原生时间线同步 |
| [qt-dlna-sheet](<../components/qt-dlna-sheet/qt-dlna-sheet.uvue>) | Android、HarmonyOS、iOS 普通 DLNA 设备搜索、选择、断开与切回本机；业务适配器复用 qt-sheet / qt-option / qt-button |
| [qt-local-mixes](<../components/qt-local-mixes/qt-local-mixes.uvue>) | 本地合辑与详情，非勾选清单 |
| [qt-notice-bar](<../components/qt-notice-bar/qt-notice-bar.uvue>) | 横向公告展示 |
| [qt-notice-card](<../components/qt-notice-card/qt-notice-card.uvue>) | 公告卡片 |
| [qt-feedback-card](<../components/qt-feedback-card/qt-feedback-card.uvue>) | 反馈卡片 |
| [qt-rich-text](<../components/qt-rich-text/qt-rich-text.uvue>) | 原生富文本显示 |
| [qt-marquee](<../components/qt-marquee/qt-marquee.uvue>) | 单文本自然贴文、溢出无缝循环 |
| [qt-button](<../components/qt-button/qt-button.uvue>) | action 按钮，不强当 selection |
| [qt-card](<../components/qt-card/qt-card.uvue>) | 卡片 surface |
| [qt-icon](<../components/qt-icon/qt-icon.uvue>) | 全站图标出口；size 仍为紧凑 rpx / 宽屏 px，内部换算当前 px，避免缩窗后保留旧比例 |
| [qt-loading](<../components/qt-loading/qt-loading.uvue>) | 加载反馈 |
| [qt-empty](<../components/qt-empty/qt-empty.uvue>) | 空态 / 可操作错误态 |
| [qt-back-to-top](<../components/qt-back-to-top/qt-back-to-top.uvue>) | 返回顶部与底部让位；共享窗口纯计算、宽屏固定尺寸、跟随皮肤 |
| [qt-toast-host](<../components/qt-toast-host/qt-toast-host.uvue>) | 成功 / 失败 / 普通轻提示，保留成功勾 |
| [qt-skeleton](<../components/qt-skeleton/qt-skeleton.uvue>) | 单块骨架 |
| [qt-skeleton-list](<../components/qt-skeleton-list/qt-skeleton-list.uvue>) | 整层骨架，参数传形状 |
| [qt-skeleton-shine](<../components/qt-skeleton-shine/qt-skeleton-shine.uvue>) | 共用扫光，不给每行重复挂 |

### 布局纯函数与共享状态

- [use-qt-layout](<../composables/use-qt-layout.ts>)：唯一窗口/断点快照，响应式 rpx、有效尺寸代次、页面 resize 与前台轮询。逻辑 px 安全区不得乘 rpx 比例。
- [detail-layout](<../composables/detail-layout.ts>)：歌单有效内宽分栏与设置宽密度双列判据；只接共享 isWide / 内容宽，不查询窗口、导入业务 store 或修改导航。
- [player-presentation](<../composables/player-presentation.ts>)：紧凑/宽屏页脚与封面预算、播放队列 stride / viewport / 滚动锚点；实际页面 CSS 与模板必须接同一尺寸来源。
- [playing-track-metrics](<../composables/playing-track-metrics.ts>)：两行歌曲标题、44px 收藏/来源触控区、长包名换行与来源面板视口预算；同时接实际 pane 宽度与整窗 rpx 比例，不查询窗口或发请求。
- [lyric-presentation](<../composables/lyric-presentation.ts>)：实际视口距离到歌词渐淡/柔焦的纯展示曲线，原生 `text-shadow` 显式着色与清晰态复位；不读播放器、网络或窗口，不改变行高、逐字时钟与 seek。
- [use-qt-widths](<../composables/use-qt-widths.ts>)：内容档位与可见 owner 的宽度 cap 栈；frame 的 onShow/onHide 及工具身份同步 active，隐藏的设置/我的三栏不限制发现页，只有有效宽度变化才广播。
- [use-qt-avatar](<../composables/use-qt-avatar.ts>)：账号头像的本地图片展示、后台更新与错误恢复；远程 URL / 文件 / 会话归属由 avatar-cache 服务管理。
- [qt-wide-workspace](<../composables/qt-wide-workspace.ts>)：单活动工具状态，记录固定 hostRoute；pane 与工作区根按显式宿主归属过滤，避免两份 tab 挂同一工具。已打开工具跨宽窄及深页返回保持实例，显式关闭/切换才卸载，compact 新打开仍走原生导航，不恢复多隐藏 pane 保活。

## 3. 开发流程与门禁

1. 查目录和相邻源码；确认业务语义、props / emits / slots、紧凑与宽屏、安全区、字号和长列表。
2. 使用现有组件；缺能力在基础族扩展，保原业务适配器契约。新增族写明与现有族不同的职责。
3. 普通页面只传状态并接一次事件。复杂点击 / 多选不得一次既播放又切选择。
4. 更新目录、模块说明、设计规范和必要回归；运行 `npm run check`（含 `check:ui-selection`）。门禁比对目录与文件、选择语义、纯几何及真实服务状态机，并拦新增私选择指示器。
5. 真 Android / Harmony 串行编译，必须检查“编译成功 / 运行包制作成功”，不以 CLI exit 0 代替结果。原生滚动和视觉仍需设备验收；32ms 等待是实现机制，不是全设备成功证明。
