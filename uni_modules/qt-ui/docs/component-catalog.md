# Qt UI 组件目录与复用契约

> 新增或修改界面前，先查本目录、[模块说明](<../readme.md>)、[设计规范](<design.md>)和对应源码。已有能力优先复用；缺能力先扩公共族，再考虑新增族。页面不得复制选项、复选框、开关和选择弹层。

## 1. 按场景选组件

| 场景 | 首选 | 状态 / 事件 |
|---|---|---|
| 临时命令或单选列表 | qt-action-sheet / 全局 host | actions / selectedIndex；select(action,index)、close |
| 列表、短标签、选择卡片 | qt-option | label、description、selected、disabled、kind；select |
| 多选 / 全选 | qt-checkbox；歌曲行已有选择态 | checked、disabled、size；change(boolean) |
| 布尔设置 | qt-switch | modelValue、disabled；change(boolean)、update:modelValue |
| 单选分段 / 横向标签 | qt-segmented | list、modelValue、itemGap、scrollable；change、update:modelValue |
| 排序 | qt-sort-panel | sortKey、sortDesc；select、desc；再次点当前键回 none |
| 单曲 / 批量收藏 | qt-playlist-picker | selectedIds；单曲 confirm，批量 toggle；两个独立实例 |
| 普通弹层外壳 | qt-sheet | visible、title、subtitle、dismissible；close、update:visible；default/footer slots |
| 批量管理条 | qt-batch-bar | count / total；toggle / download / collect / cancel |

### 统一状态

- 选中标红：浅色 `#d93c43`，深色 `#ff7378`，由 [selection](<../composables/selection.ts>) 提供，与可自定义的皮肤 accent 无关。选中项不能拼 `✓`、`（当前）` 或“当前使用”；自定义 action color 不覆盖选中红。
- 成功回执、签名验证、签到、收藏、正在播放及路由导航是不同语义，保留原标识，不改成设置选择。
- 未知 ID / 越界 index 是无选中，不偷选第一项。动态音质清单若保留旧档，必须同步维护显示数组与值数组。
- 长清单打开、异步列表到货、外部选择变化、字号和窗口变化时自动露出选中项。横滚保真实内容宽与 `scroll-left`；原生纵滚使用 [useQtSelectionReveal](<../composables/use-qt-selection-reveal.ts>) 的实例唯一 ID / anchor、代次和卸载取消。
- 多选在打开或外部集合变化时定位首个列表顺序命中的选中项；用户点选不应每次抢走正在浏览的位置。
- 共享开关只接一次原业务更新：使用 `:model-value` + `@change`，或 `v-model`，不要同时双向绑定又调用反转函数。

### 弹层与服务

- 普通 QtSheet：手机底部、宽屏居中；主题 surface/scrim，窗口高度与安全区限制。必须挂在覆盖整窗的页面 / frame 层，放在 list-view 后；不能嵌进仅有触发按钮高度的小祖先。
- `dismissible=false` 在发送 model 更新之前禁止关闭；业务 busy、安装中、权限与验证流程仍由业务适配器负责。普通共享壳当前是显隐挂载，不声称保留旧延时关闭动画。
- 歌单 picker 保留 `anchorTop` 输入兼容，但普通选择改为统一 Sheet，不再跟随该坐标弹出小 popover。单曲草稿打开时恢复，取消不提交；batchMode 即时 toggle。不得合并两个业务实例。
- 强制升级、不可关闭公告 / 免责声明、确认框、右侧详情抽屉及连续颜色 / 进度控件保留专门业务契约；不能为了共壳静默改变关闭权限、位置或按钮语义。
- [action-sheet 服务](<../../../services/action-sheet.ts>) 捕获请求清单快照；取消、替换或空请求会兑现旧 Promise `-1` 并清空可见状态；有效 pick 返回下标。requestId 令连续相同清单也重建定位。组件外部值改变可触发定位，但服务不宣称追踪未传入的新业务状态。
- [播放设置选项](<../../../services/player-setting-options.ts>) 统一倍速与睡眠清单。90 是“播放完当前歌曲后”哨兵，非 90 分钟；选中由 player 保存的原 preset 判定，不能用变化中的倒计时余量。

## 2. 完整组件清单

目录与真实组件文件由 `check:ui-selection` 校验，新增、删除或改名时必须同步更新。业务适配器的完整 props / events 以链接源码和设计章节为准，不能将相似外观当成相同业务。

| 组件 | 用途 / 复用边界 |
|---|---|
| [qt-option](<../components/qt-option/qt-option.uvue>) | row / chip / card 选项，leading/default slot |
| [qt-sheet](<../components/qt-sheet/qt-sheet.uvue>) | 普通弹层、header / footer、关闭权限 |
| [qt-switch](<../components/qt-switch/qt-switch.uvue>) | 布尔设置，红轨与主题 thumb |
| [qt-checkbox](<../components/qt-checkbox/qt-checkbox.uvue>) | 红环点复选；保持 change 与点击隔离 |
| [qt-action-sheet](<../components/qt-action-sheet/qt-action-sheet.uvue>) | Sheet + Option + Reveal 的兼容适配器 |
| [qt-action-sheet-host](<../components/qt-action-sheet-host/qt-action-sheet-host.uvue>) | 全局服务渲染出口 |
| [qt-segmented](<../components/qt-segmented/qt-segmented.uvue>) | 均分 / 横滚标签，真实几何揭示 |
| [qt-source-switcher](<../components/qt-source-switcher/qt-source-switcher.uvue>) | 音源业务入口，使用全局 host |
| [qt-sort-panel](<../components/qt-sort-panel/qt-sort-panel.uvue>) | 排序键 / 方向，none 可取消 |
| [qt-playlist-picker](<../components/qt-playlist-picker/qt-playlist-picker.uvue>) | 收藏目标，草稿 / 即时多选分离 |
| [qt-batch-bar](<../components/qt-batch-bar/qt-batch-bar.uvue>) | 批量动作，尺寸对齐宿主 |
| [qt-local-row](<../components/qt-local-row/qt-local-row.uvue>) | 本地歌曲，选择与播放 current 分离 |
| [qt-song-row](<../components/qt-song-row/qt-song-row.uvue>) | 歌曲行，保原 play 事件 |
| [qt-song-row-lite](<../components/qt-song-row-lite/qt-song-row-lite.uvue>) | 轻行、平台签、选择事件与收藏 |
| [qt-confirm-host](<../components/qt-confirm-host/qt-confirm-host.uvue>) | 危险确认 true / false 服务 |
| [qt-first-run-disclaimer](<../components/qt-first-run-disclaimer/qt-first-run-disclaimer.uvue>) | 首启读秒门禁，非普通可取消 sheet |
| [qt-notice-splash](<../components/qt-notice-splash/qt-notice-splash.uvue>) | 公告关闭 / exit 与今日隐藏选择 |
| [qt-upgrade-popup](<../components/qt-upgrade-popup/qt-upgrade-popup.uvue>) | 升级、强制模式与下载状态 |
| [qt-meta-pack-guide](<../components/qt-meta-pack-guide/qt-meta-pack-guide.uvue>) | 缺包引导，仅 go / dismiss |
| [qt-pack-install-sheet](<../components/qt-pack-install-sheet/qt-pack-install-sheet.uvue>) | 安装确认 / 安装中关闭锁 |
| [qt-listen-detail](<../components/qt-listen-detail/qt-listen-detail.uvue>) | 报告详情、trail、排序与每批 50 项 |
| [qt-page-frame](<../components/qt-page-frame/qt-page-frame.uvue>) | 页面宿主、顶栏多 active 音源标签 |
| [qt-side-nav](<../components/qt-side-nav/qt-side-nav.uvue>) | 路由 rail，非设置选择 |
| [qt-tab-bar](<../components/qt-tab-bar/qt-tab-bar.uvue>) | 底部路由导航、安全区让位 |
| [qt-wide-workspace](<../components/qt-wide-workspace/qt-wide-workspace.uvue>) | 宽屏就地托管子页 |
| [qt-settings-overview](<../components/qt-settings-overview/qt-settings-overview.uvue>) | 设置总览业务导航 |
| [qt-profile-overview](<../components/qt-profile-overview/qt-profile-overview.uvue>) | 我的总览、签到与业务导航 |
| [qt-mini-player](<../components/qt-mini-player/qt-mini-player.uvue>) | 单例悬浮球 / 迷你播放条 |
| [qt-player-bar](<../components/qt-player-bar/qt-player-bar.uvue>) | 宽屏播放栏分档 |
| [qt-local-mixes](<../components/qt-local-mixes/qt-local-mixes.uvue>) | 本地合辑与详情，非勾选清单 |
| [qt-notice-bar](<../components/qt-notice-bar/qt-notice-bar.uvue>) | 横向公告展示 |
| [qt-notice-card](<../components/qt-notice-card/qt-notice-card.uvue>) | 公告卡片 |
| [qt-feedback-card](<../components/qt-feedback-card/qt-feedback-card.uvue>) | 反馈卡片 |
| [qt-rich-text](<../components/qt-rich-text/qt-rich-text.uvue>) | 原生富文本显示 |
| [qt-marquee](<../components/qt-marquee/qt-marquee.uvue>) | 单文本自然贴文、独立往返运动 |
| [qt-button](<../components/qt-button/qt-button.uvue>) | action 按钮，不强当 selection |
| [qt-card](<../components/qt-card/qt-card.uvue>) | 卡片 surface |
| [qt-icon](<../components/qt-icon/qt-icon.uvue>) | 全站图标出口 |
| [qt-loading](<../components/qt-loading/qt-loading.uvue>) | 加载反馈 |
| [qt-empty](<../components/qt-empty/qt-empty.uvue>) | 空态 / 可操作错误态 |
| [qt-back-to-top](<../components/qt-back-to-top/qt-back-to-top.uvue>) | 返回顶部与底部让位 |
| [qt-toast-host](<../components/qt-toast-host/qt-toast-host.uvue>) | 成功 / 失败 / 普通轻提示，保留成功勾 |
| [qt-skeleton](<../components/qt-skeleton/qt-skeleton.uvue>) | 单块骨架 |
| [qt-skeleton-list](<../components/qt-skeleton-list/qt-skeleton-list.uvue>) | 整层骨架，参数传形状 |
| [qt-skeleton-shine](<../components/qt-skeleton-shine/qt-skeleton-shine.uvue>) | 共用扫光，不给每行重复挂 |

## 3. 开发流程与门禁

1. 查目录和相邻源码；确认业务语义、props / emits / slots、紧凑与宽屏、安全区、字号和长列表。
2. 使用现有组件；缺能力在基础族扩展，保原业务适配器契约。新增族写明与现有族不同的职责。
3. 普通页面只传状态并接一次事件。复杂点击 / 多选不得一次既播放又切选择。
4. 更新目录、模块说明、设计规范和必要回归；运行 `npm run check`（含 `check:ui-selection`）。门禁比对目录与文件、选择语义、纯几何及真实服务状态机，并拦新增私选择指示器。
5. 真 Android / Harmony 串行编译，必须检查“编译成功 / 运行包制作成功”，不以 CLI exit 0 代替结果。原生滚动和视觉仍需设备验收；32ms 等待是实现机制，不是全设备成功证明。
