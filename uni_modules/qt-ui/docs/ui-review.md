# qt-uniappx UI 审查结论与整改清单（活文档）

> 初版审查：2026-09-10（只读代码审查，12 个业务页面 + 17 个 qt-ui 组件 + stores/theme.ts + uni.scss）。
> 本文档是**活文档**：记录平台红线、整改进度与剩余问题。逐行号清单会随代码漂移失效，因此只保留
> 「按文件 + class 定位」的条目；精确行号以当前代码为准（grep 复核）。
> 2026-10 复核：P0 高危项已基本清零，剩余问题见 §3。

---

## 1. 平台红线（已实证，违反即回退）

1. **`box-shadow` 在 uni-app x Android 上导致点击穿透 / 命中丢失**。
   实证：`pages/settings`（`.group` 移除 shadow 后点击恢复）、`pages/search`（`.bar` 的 shadow 使音源切换器 ActionSheet 无响应，删除后恢复）、`pages/artist`（hero 内音源切换器、list-head 内播放全部按钮）。
   shadow 落在可点击元素**或其祖先**上即可能失效。已带 `border` 的元素直接删 shadow 即可（无视觉回退）。
   **禁止为视觉层级把 shadow 加回可点击区域**；纯装饰、不可点击的容器可用极轻 shadow（半径 ≤ 4rpx、alpha ≤ 0.06）。
2. **uni-app x 默认 `flex-direction: column`**：`align-items` 控制的是**水平（交叉）轴**。
   `align-items: center` 会让子节点按内容宽度收缩并居中 —— 长文本子节点因此溢出被两端裁掉，且
   `text-overflow: ellipsis` **永不生效**（没有宽度约束）。正确链：父级 `align-items: stretch` +
   子级 `flex: 1; min-width: 0`；要让字形居中用 `text-align: center`（元素仍占满整行，ellipsis 才生效）。
   实证：播放页导航标题/副标题（长标题被裁、省略号失效）。
3. **`QtActionSheet` 必须放在所有 `list-view` 节点之后**（原生组件层级问题，3/3 页面约定：
   artist / playlist / search）。放前面会被 list-view 盖住无法弹出。
4. **Vapor CSS 约束**（详见 `AGENTS.md` 与 `docs/design.md` §5）：扁平单 class、禁后代/子选择器、
   禁 `max-width: 100%`（脚本算 px 绑定 `width: Npx`）、禁未验证的 `linear-gradient` / `backdrop-filter` /
   CSS 变量 / `aria-*`。`uni.scss` 的 SCSS 变量**只在 uni.scss 自身**生效，页面/组件样式必须写字面量。
5. **宽屏唯一防御是逐节点 `-wide` px 覆盖**：宽屏下 1rpx ≈ 1.42dp（1600×900 实测），
   `rpxCalcMaxDeviceWidth` 在 Android 运行时未实现，任何会在 `isWide` 下渲染的节点都必须有
   `xxx-wide` class + px 规则（见 design.md §11.1）。
6. **所有页面必须用 `qt-page-frame`**（`max-width` 默认 1280，沉浸页传 `full-width`）。
7. **改 UI/CSS 后必须真机构建验证**：`npm run check`（47 个 .uvue 静态检查）不能替代 Vapor CSS 编译。

---

## 2. 整改进度（2026-10 复核）

### 已完成

| 项 | 内容 |
|---|---|
| P0-1 高危 shadow | 8 处高危全清：`qt-mini-player`（fab-inner）、`qt-segmented`（seg-item-active）、`pages/theme`（skin-option-active）、`pages/feedback/index`（tab-active）、`pages/mv`（card）、`pages/library`（pl-cover-wrap）、登录/找回密码/资料编辑/反馈提交表单容器、`pages/stats` + `pages/playlist` 列表头。另删：`pages/search` 4 处（bar/type-row 及 dark 变体）、`pages/artist` 6 处（hero/list-head 及 dark/whero 变体） |
| P0-4 `@tap`→`@click` | `pages/settings` 7 个 cell、`pages/login` 2 处、`pages/forget-password` 3 处全部改完（Vapor 下 `@tap` 不可靠，统一 `@click`） |
| P0-5 零散问题 | download `linear-gradient` 改纯色；theme 页删手写 isWide（改用 `layout.isWide`）；back-to-top `z-index` 100→950；playlist-picker `z-index` 9999→999；side-nav 用 `qtStatusBarPx()` 让位状态栏 |
| P0-2 部分 | `pages/library` / `pages/artist` / `pages/mv` 已补 `useThemeStore` 绑定 dark 类（其余 6 页见 §3.2） |
| P1-1 | 登录/找回密码/资料编辑/反馈提交表单按钮改用 `qt-button`；`qt-card-elevated` 已标 `@deprecated` |
| P1-3 部分 | history `.sub` 副标题色 `#6d8fd6`→`#6b7385`；library 三个 metric 图标底色统一为中性色；`uni.scss` 的 `$muted` 改为 `#6b7385`（4.75:1 达标）并新增 `$muted-dark: #a6adbc` |
| 触控目标部分 | library 导入/新建按钮 56→64rpx、daily 播放/更多 56→58rpx、`qt-back-to-top` 补 `-wide` px 尺寸（原 JS 定位 40px vs CSS 80rpx 溢出错位） |
| 歌单广场网格 | 竖屏 3 列阈值从 `>=420px` 降到 `>=340px`（主流机型 360~412px 从 2 列 → 3 列，封面约 92~109px），并删除 1024/768 两档死代码（`isWide` 已先返回 5 列） |
| 播放页 | 导航标题长文本 ellipsis 修复（stretch + flex:1 + min-width:0）；副标题歌手居中（`text-align: center`，保留宽度约束）；歌词预览区不再左右滑切歌（红框区滑动只保留下滑返回） |

### 未完成（详见 §3）

- P0-1 尾巴：约 38 处 shadow 仍在（§3.1）
- P0-2：6 页 dark 死代码未绑定（§3.2）
- P0-3：皮肤×深色未合成 + 3 处 accent 硬编码（§3.3）
- P1-2：action-sheet 未消费 skin token（§3.4）
- P1-3：settings 7 个 cell 图标颜色不统一（§3.5）
- P1-4 / P1-5 / P1-6 / P2：见 §3.6 ~ §3.10

---

## 3. 剩余问题

### 3.1 P0-1 尾巴：剩余 box-shadow（约 38 处，按文件分组，多为容器/卡片级）

> 风险分级：落在可点击元素或其祖先上 = 高危；纯装饰容器 = 低危。整改 = 已带 border 直接删，否则改用 border。

| 文件 | class（风险） |
|---|---|
| `pages/about/index.uvue` | `.logo` / `.group` 系列（含 `-dark` / `-wide` 变体，共 7 处，容器级低危） |
| `pages/daily/index.uvue` | `.song-play` / `.song-more`（+-dark，4 处，**可点击**中危） |
| `pages/download/index.uvue` | `.row` / `.scroll-dark` 附近 2 处（列表行，**可点击**中危） |
| `pages/feedback/detail.uvue` | 2 处（`.card` 系列） |
| `pages/history/index.uvue` | `.summary` / `.scroll` 系列 4 处 |
| `pages/home/index.uvue` | `.play-btn`（+-dark，2 处）—— ⚠️ **home 由用户手工恢复，不在整改范围** |
| `pages/library/index.uvue` | 2 处（`.summary` / `.list` 附近） |
| `pages/notice/list/index.uvue` | 2 处（`.n-item-dark` 等） |
| `pages/player/index.uvue` | `.cover-card` / `.sheet-wide` 2 处（封面装饰低危 + 抽屉容器） |
| `pages/playlist/index.uvue` | `.list-head-dark` / `.hero-dark` 2 处（**含播放全部按钮**高危） |
| `pages/playlists/index.uvue` | `.bar` / `.card` 系列 4 处（**整卡可点击**高危） |
| `pages/profile/index.uvue` | 2 处（`.profile-dark` 等） |
| `pages/search/index.uvue` | `.cover-load` 1 处（`z-index:10` 悬浮层；本身不可点但**可能盖住列表**，见 §4.3） |
| `uni_modules/qt-ui/components/qt-card/qt-card.uvue` | `.qt-card` / `.qt-card-elevated` 2 处（elevated 已标 deprecated） |
| `pages/artist/index.uvue` | `.avatar` 红晕 1 处 —— **有意保留**（纯装饰，不可点击） |

### 3.2 P0-2：6 页 dark 类仍是死代码

以下页面 `<style>` 声明了 `-dark` 类但**模板未绑定、未 import `useThemeStore`**：

`pages/search`（bar-dark/input-dark/type-row-dark/history-item-dark/tag-dark/row-dark）、
`pages/history`（summary-dark/scroll-dark）、`pages/download`（scroll-dark/row-dark）、
`pages/settings`（group-dark）、`pages/playlists`（bar-dark/card-dark）、`pages/about`（logo-dark/group-dark）。

> 注意：`page-dark` 目前是空操作 —— 多个页面模板引用了它但全项目没有定义。补定义或删引用二选一。

### 3.3 P0-3：`theme.dark` 与 `theme.skin` 未合成 + accent 硬编码

- `stores/theme.ts` 的 `setDark()` 只置布尔 + `applyAppTheme()`，**不切换 skin**；linen/aurora（亮色皮肤）+ 深色 = 亮底深卡视觉断裂；115 个 `-dark` 类全硬编码、绕开 skin token。
- accent 硬编码 `#e5484d`：`qt-side-nav.uvue`（图标 `:color` 三元、`.qsn-label-active`）、`qt-source-switcher.uvue`（当前音源）。应改 `theme.skin.accent`。

### 3.4 P1-2：`qt-action-sheet` 零 token 消费

`.as-sheet` 背景 `#f7f8fa` 不在任何 `QtSkin` 字段里；`.as-cancel` `#ffffff` 无 dark 变体；深色模式下弹浅色面板。另 `:89-90` 重复 `padding-bottom`（`env(safe-area-inset-bottom)` 覆盖前者，且 `env()` 未验证）。

### 3.5 P1-3：settings 7 个 cell 图标各一种色

`#6d8fd6` / `#7c6cf2` / `#d99b3f` / `#9b82d9` / `#4fb186` … 仅清缓存的 `#e5484d` 符合锚点。建议功能图标统一 `#5f6775`（次要文字色），危险操作用 `#e5484d`。

### 3.6 P1-4：圆角 / 字号 / 间距未形成节奏

圆角混用 14~48rpx 九档、字号 20~44rpx 九档。建议收敛到圆角 `16/20/24/32` 四档、字号六档，写进 `uni.scss` 作文档基准（页面仍需写字面量，见红线 4）。

### 3.7 P1-5：触控目标偏小（< 88rpx / 44dp）

`qt-segmented`（60rpx）、`qt-source-switcher`（64rpx）、`qt-notice-bar` `.bar-close`（56rpx）、
`pages/daily` 播放/更多按钮（58rpx）、`pages/search` `QtIcon size=22`（约 12dp，最严重）。
原则：图标视觉尺寸与可点区域解耦 —— 图标 22~44rpx，外层包 padding 撑到 ≥ 88rpx。

### 3.8 P1-6：`qt-page` / `qt-ui` 根组件闲置

`qt-page-frame` 是全站唯一页面外壳；`qt-page.uvue` / `qt-ui.uvue`（默认 maxWidth 1200 vs frame 1280）
无人使用，建议废弃或内部包装 frame（README 已改为指向 `qt-page-frame`）。

### 3.9 P1-4 延伸：次要文字色统一

页面混用 `#9aa1b2` / `#9aa2b0` / `#a2a9b7` / `#6b7385` / `#5f6775`。锚点：浅底 `#6b7385`（4.75:1），
深底 `#a6adbc`。`#9aa1b2` 白底仅 2.6:1，已废弃（深底 5.9:1，`-dark` 变体可保留）。

### 3.10 P2 打磨

- 全站无按压态（`:active` / touchstart 反馈）—— 至少给主 CTA 加压暗 8%
- toast 时长/类型不统一（1500/2000/2500/3000ms 混用）
- `pages/download` 删除/重下无反馈（无 toast）
- 空/加载态两套范式（`qt-loading` vs 纯文字），空状态文案各写各的 → 建议 `qt-empty` 收敛
- `qt-notice-bar` `onTap()` 定义但模板从未绑定（死代码）
- 宽屏圆角比例错位：`qt-notice-splash`/`qt-upgrade-popup` 32rpx→wide 应为 22px，`qt-notice-bar` 18rpx→14px
- `pages/library` `.create-btn-plus` 用文本 `+` 充当图标（design.md §4.1 禁止）→ 改 `<QtIcon name="plus">`
- `setCustomSkin` 8 个位置参数 → 改对象参数；未暴露 `accentSoft`/`surfaceStrong`
- `cloneSkin` 整体替换 reactive → 全页 computed 重算，改 `Object.assign`
- `JSON.parse(savedSkin) as QtSkin` 不安全断言 → 加 `isSkin()` 守卫补默认值
- `QtSkin` 缺语义 token：`scrim`（遮罩统一）/ `importAccent` / `success` / `warning` / `danger`

---

## 4. 2026-10 新增已验证结论（非 UI 但也影响体验）

1. **163（网易云）版权受限专辑返回 HTTP 200 + `{"resourceState":false,"code":404}`**：
   `services/http.ts` 的 `directRequest` 只按 HTTP 状态码（200~299）判断成败，因此这类失败是**静默成功**、
   返回空数据。调用方（如 `albumDetail`）拿到空结果时应有兜底（专辑页已加「该专辑曲目暂无授权」提示）。
2. **异步竞态**：切音源/切分类时用单调递增 generation token（`searchSeq` / `hotSeq`），
   每个 `await` 之后、写响应式数组**之前**校验 token，过期结果直接丢弃。
3. **榜单/专辑入口必须把 `name` / `desc` / `pic` 随 URL 传给详情页**：详情页的 hero 由 query 参数构建，
   依赖接口回填可能拿到空（版权专辑即如此）。
4. **`pages/search` 的 `.cover-load`**（`position:absolute; z-index:10`，位于所有 list-view 之前）疑似
   与红线 3 同类层级隐患，暂无用户报告，留意即可。

---

## 5. 验证清单（每次 UI 改动后）

- [ ] `npm run check`（47 个 .uvue 静态检查，0 error）
- [ ] HBuilderX 真机构建通过（静态检查不替代 Vapor CSS 编译）
- [ ] 竖屏 + 宽屏（≥720px 或横屏）双视口验证
- [ ] light + dark + 皮肤组合验证
- [ ] 点击穿透回归（重点：mini-player FAB、分段控件、皮肤选项卡、表单按钮、MV 卡片、设置 cell、ActionSheet）
- [ ] 更新 `docs/design.md` / `readme.md`（若改了 UI 模块结构或公共组件 API）
