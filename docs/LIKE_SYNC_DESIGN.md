# 收藏（喜欢）与多端同步实现逻辑

> 代码入口：`stores/player.ts`（编排与本地缓存）、`services/like.ts`（接口层）、`services/music-api.ts`（封面兜底查询）。
> 后端接口：`/api/v1/app/user/like/**`（astral-plugin-qt）。

## 1. 数据模型

### 1.1 服务器建模

服务器把收藏建模为两类记录，全部挂在用户账号下：

| 记录 | 键 | 说明 |
|---|---|---|
| 歌单 | `pid` | 一个歌单一条记录，按 pid upsert。`pid` 是歌单的全局唯一键（UUID v4 形态，≤64 字符） |
| 歌曲 | `sid + pid` | 一首歌在 N 个歌单里就有 N 条记录；不归属任何歌单时 pid 为空（一条默认归属记录） |

每条记录带 `updatedSeq`（账号内单调递增版本号）与 `deleted` 标记（删除是软删除）。

### 1.2 本地缓存（uni storage）

| 键 | 内容 |
|---|---|
| `qt-liked-songs` | 收藏总表（Song[]），每首歌带 `pids: string[]` 表示归属哪些歌单 |
| `qt-saved-playlists` | 收藏的在线歌单 + 同步回来的自建歌单（Playlist[]） |
| `qt-local-playlists` | 本机创建的自建歌单（Playlist[]，`platform: "local"`，建单时生成 pid） |
| `qt-like-cursor` | 增量拉取游标（服务器已同步到的 maxSeq） |
| `qt-like-pending-ops` | 待推送操作队列（断网暂存，联网后按序重放） |

关键点：**歌单的成员关系不单独存储**。`qt-liked-songs` 里每首歌的 `pids` 含哪个歌单的 pid，它就属于哪个歌单（`songsOfPid()` 是查询歌单内容的唯一入口），歌单之间因此不会串歌。

### 1.3 关键标识

- **歌单 pid**：多端同步的唯一键。不能用平台歌单号（各平台只在自己域内唯一、多端含义不同），自建歌单建单时即生成 UUID（`generateGlobalPid()`）。
- **likeSeq**：单条收藏记录「在服务器上的版本号」。推送成功后由服务器分配并回写本地条目，用于增量变更的 last-write-wins 比较，**不是**「已同步」的存在性凭证（见 §5 对账）。

## 2. 本地操作与实时推送

所有收藏动作先落本地缓存、立即入队推送（`enqueueLikeOp` → `flushPendingOps`，断网时留存在 pendingOps，联网自动重放）：

| 动作 | 本地行为 | 推送 |
|---|---|---|
| 新建歌单 | `localPlaylists.push`（生成 pid） | `playlist add`（元数据） |
| 删除歌单 | 移出 localPlaylists | `playlist remove` |
| 重命名歌单 | 改 localPlaylists 名字 | `playlist add`（元数据 upsert，name 非空覆盖） |
| 收进歌单 | 收藏总表登记 + `pids` 加该歌单 pid | `song add`（带 pid） |
| 移出歌单 | `pids` 摘掉该 pid；摘完为空则整条移除 | `song remove`（带 pid，服务器只删 (sid,pid) 这一条，不影响其他歌单里的记录） |
| 收藏在线歌单 | savedPlaylists 登记 | `playlist add` |

歌曲 add/remove **都带 pid**：后端按 (sid, pid) 定位，从 A 歌单移除才不会误删 B 歌单里的同一首。

**重命名同步**（v2 补充）：歌单名是云端 `qt_like_playlist.name` 的元数据，改名端补推一次 `playlist add`（后端按 pid upsert、name 非空覆盖），其他端经增量变更的 playlist 行感知新名。移动端暂无改名入口，规则先由 PC 端落地，两侧语义一致。

## 3. 推送链路与兜底

```
enqueueLikeOp(op) ──▶ pendingOps 持久化 ──▶ flushPendingOps（likeSyncBusy 防并发）
                                               └─ doFlushPendingOps：逐条 pushLikeOp → 成功 shift + 回写 likeSeq → 失败中断保留队列
```

`pushLikeOp` 是所有推送的总漏斗（实时收藏、离线重放、启动对账补推都经过），在这里做三类兜底：

1. **歌曲 pid 兜底**：payload 没带 pid（旧版本入队的存量数据）时，按这首歌的 `pids` 找到对应歌单（`resolveSongPidFallback`），绑定该歌单的 pid 上送；歌单自己缺 pid 则先生成并写回本地缓存（歌曲的 pids 引用同步替换）。找不到对应歌单才按无归属推送。
2. **歌曲封面兜底**：add 时本地没封面，先调 `musicApi.songCover()`（原平台按歌名+歌手搜图，失败回退网易云，结果有内存缓存）查询，查到后写回 `qt-liked-songs` 再携带 picUrl 推送。remove 不查图（无图片语义，避免覆盖云端已有图）。
3. **歌单 pid 兜底**：构造 payload 时（`likePlaylistPayloadJson` → `ensurePlaylistPid`）自建歌单缺 pid 就生成 UUID 并写回 `qt-local-playlists`；在线歌单沿用平台歌单号、同步回来的自建歌单 id 即 pid，不另造（否则多端对不上）。推送侧仍留一道保险：异常数据 pid 为空时现场生成，保证 upsert 键永远有值。

## 4. 拉取同步（服务器 → 本地）

### 4.1 触发时机

- **冷启动**（App.uvue onLaunch）：`syncLikesOnLaunch()` = 增量拉取 + 存在对账（§5）
- **回前台**（onShow）：`pullChanges()` 增量拉取
- **登录后**：同冷启动路径

### 4.2 增量拉取 `pullChanges`

1. 先 `doFlushPendingOps()` 把积压操作推完（本地先发生的事优先落库，避免被拉下来的旧状态覆盖）；
2. 游标 ≤ 0（首次登录/游标丢失）转全量分页拉取 `doFullPull`；
3. 否则按 `fetchChanges(cursor)` 循环拉取（上限 50 轮防死循环），逐条 `applyLikeChange`：
   - 删除：本地 seq ≤ 服务器 seq 才删（LWW）；
   - 更新/新增：本地 seq ≤ 服务器 seq 才覆盖；新增时补 pid 归属；
   - 本地有待推送操作的条目跳过（防止「拉下来 → 又推上去」回环）；
   - **song 删除按 pid 摘归属**：变更里带 pid 的删除只摘掉那一个归属（后端删歌单时级联软删成员行，每行各自下发删除事件）；歌在别的歌单里还留着。不带 pid 的删除才是整首下线；
   - **playlist 删除（platform=local）级联清理**：自建歌单在两个存储（本机建的 + 同步回来的）里都查、摘成员归属并落盘；
4. 服务器 maxSeq 小于本地游标（数据库重建，seq 从 1 重新计数）时，只把游标对齐到新库 maxSeq，缺失数据交给启动对账补推。

> 增量必须**循环拉到没有新变更**（游标取本轮最后一条 seq / maxSeq）：后端单页上限 500 条，
> 只拉一轮就把游标推到 maxSeq 的话，第 501 条之后的变更（删大歌单时同 seq 级联软删的
> 全部成员行）会永久丢失。PC 端曾踩过这个坑。

### 4.3 全量拉取 `doFullPull`

分页拉全量（`fetchAllLikes`，每页 500，上限 100 页），**先收齐全部页再应用**（两阶段）：
歌曲行的 pid 归属依赖歌单先落地，DESC 分页里歌常在歌单前面的页 —— 逐页应用会因
「歌单不存在」跳过歌曲，且导入标记置位后永不再重试。先应用全部歌单、再应用歌曲。

歌曲按 id+platform 合并多 pid 行为一条（封面取非空），再与本地做 last-write-wins 合并：
本地「有待推送操作」或「seq 更新」的条目保留本地版本。

## 5. 启动对账（存在性 diff）

> 背景：likeSeq 只能表达版本先后，表达不了「服务器上根本没有这条」。服务器整库重建（seq 从 1 重计）或只删了几条数据（seq 不倒退）时，版本号对比都发现不了缺失。

每次冷启动在增量拉取之后执行 `reconcileLikesWithServer()`：

1. 全量分页拉取服务器收藏，收集歌单键集合 `platform|pid` 与歌曲键集合 `platform|sid`；
2. **歌单按「云端确认点」三分**（见下）：缺的补推 `playlist add`、他端删的本地跟随移除；
3. 本地歌曲不在服务器键集合里 → 补推 `song add`（歌曲按 sid 整档判断；主归属歌单刚被跟随删除的成员跳过，防止连歌一起复活）；
4. 补推走 pendingOps 队列，复用断网重试链路；服务器按 sid/pid upsert，重复执行幂等。

### 5.1 机制 B：对账的「删除复活」死循环与云端确认点

原方案「本地有而云端没有 → 无条件补推」在**本机建、他端删**的场景会死循环：

```
本机建单 → 上送 add → 他端删单 → 云端软删
→ 本机对账：本地有、云端没有 → 补推 add → 云端复活（deleted_at 置空）
→ 他端拉取：歌单又回来了（删不掉）
```

删除变更走增量通道时不会触发（本地先应用了删除），但增量拉取一旦截断（后端单页 500 条上限）
或游标丢失，删除事件丢失后对账就成了复活器。

**修复：云端确认点**——歌单在本地记录「云端确认过它存在」的最后 seq：

- 移动端：`likeSeq`（推送成功时服务器分配回写，`markPlaylistLikedSeq`；他端建的同步回来天然带值）；
- PC 端：`playlists.cloud_seq`（v8 迁移加列；推送 add 成功 / 拉取见到它时记录，单调推进）。

对账对「云端没有」的歌单按确认点分流：

| 确认点 | 判定 | 动作 |
|---|---|---|
| 无（NULL / 0） | 从未上送 | 补推 add（老版本存量、漏推自愈） |
| 有，且删除已尘埃落定* | 他端已删 | **本地跟随删除**（自建行 + 成员归属 + 云端卡片一起清） |
| 有，删除未尘埃落定 | 增量通道可能还没消费删除事件 | 本轮不动，等增量 |

\* 尘埃落定 = 本地同步游标已推进到本次全量快照的 maxSeq（增量通道消费完毕，云端确实没有它）。
PC 端在 likeSeq 之外用游标判断；移动端对账固定跑在增量拉取之后（`syncLikesOnLaunch` 保证顺序），
直接按确认点判定。

「跟随删除」不回推 remove（云端已经删了，再推 remove 是空操作；后端 softRemove 幂等无害但不必要）。
云端卡片（收藏的在线歌单）缺失同理：他端取消收藏 → 本地跟随移除，否则卡片永远残留在「我的歌单」里。

## 6. 登录/退出与账号切换

- **退出登录**：先尽力 `flushPendingOps()`（仍带原账号身份，断网期间积压的操作不丢），再 `resetLikeSync()` 清空游标与待推送队列。本地收藏缓存与账号归属标记（`qt-user-id`）**保留**——同账号重登无缝恢复。
- **登录**：响应里的 `user.id` 与本地归属标记比对：
  - 一致（同账号重登）→ 什么都不动，走正常增量同步；
  - 不一致或首次登录（无标记）→ 换号登录：`clearLocalLikeData()` 清空本地收藏三表（likedSongs / savedPlaylists / localPlaylists）+ 重置同步状态，随后 `syncLikedFromServer()` 游标为 0 自动全量拉取本账号数据恢复本地。
- **设计要点**：服务器是数据源，本地缓存可丢弃。A 的数据留在 A 的服务器账号里，换到 B 后本地从 B 全量拉取；切回 A 再拉一次即恢复。播放历史、下载等设备级数据不受换号影响。
- **换号登录**：游标为 0 → 触发全量拉取，以服务器为准重建本地收藏。

## 7. 时序图（冷启动）

```
App onLaunch
  └─ syncLikedFromServer()
       ├─ backfillLocalPlaylistsSync()   # 自建歌单从未上送的补入队
       └─ pullChanges()
            ├─ doFlushPendingOps()        # 先推积压（含兜底：pid/封面）
            └─ 增量/全量拉取并应用（LWW）
  └─ reconcileLikesWithServer()           # 存在对账，缺的补推（含兜底）
```
