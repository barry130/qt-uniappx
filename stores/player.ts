import { reactive } from "vue";
import { useListenStatsStore } from "@/stores/listen-stats";
import { ListenSession } from "@/services/listen-session";
import { listenClockNow } from "@/services/listen-clock";
import type { ListenDelta } from "@/services/listen-session";
import { audioPlayer } from "@/services/audio-player";
import { desktopLyric } from "@/services/desktop-lyric";
import { exitApp } from "@/services/app-native";
import { isContentFailError, musicApi } from "@/services/music-api";
import { findSubstituteSong, localFileFor, localFirstEnabled } from "@/services/local-first";
import type { AudioPlaylistItem } from "@/uni_modules/qt-audio-player";
import type { LocalAudioItem } from "@/uni_modules/qt-app-native";
import { readEmbeddedTags, statLocalFile } from "@/uni_modules/qt-app-native";
import type { EmbeddedReadResult } from "@/uni_modules/qt-app-native";
import { likeBatch, fetchChanges, fetchAllLikes } from "@/services/like";
import { parseJsonToUtso } from "@/services/http";
import { songToJson, songFromJson, playlistToJson, playlistFromJson } from "@/stores/persist-codec";
import { LikeSyncEngine } from "@/services/like-sync";
import { generateGlobalPid } from "@/services/global-pid";
import type { Song, Playlist, LikeChange, PendingLikeOp } from "@/types/music";
import { getAccessToken } from "@/services/auth";
import { DEFAULT_PLAYLIST_COVER_ASSET } from "@/services/media";
import { qtDiag } from "@/services/diag";
import { logMsg, logMsgErr, logMsgWarn } from "@/services/logger";
import { beginLoading, finishLoading } from "@/services/ui-loading";
import { useDislikesStore, DISLIKES_CHANGED_EVENT } from "@/stores/dislikes";
import { findCrossSourceDup, collectDupMessage, type CollectDupConflict } from "@/services/collect-dup";
import { qtShowToast } from "@/services/toast";
import { qtConfirm } from "@/services/confirm";
import { qtShowActionSheet } from "@/services/action-sheet";
import { setSourcePlayQuality, sourcePlayQualityOf, sourceDownloadQualityOf } from "@/services/source-quality";
import { useDownloadsStore } from "@/stores/downloads";

const LIKED_KEY = "qt-liked-songs";
const HISTORY_KEY = "qt-history-songs";
const STATE_KEY = "qt-player-state";
/** 轻量进度键：进度时钟每 ~5 秒只写当前曲+进度，不拖着整条队列做全量序列化 */
const PROGRESS_KEY = "qt-player-progress";
const PLAYLIST_KEY = "qt-saved-playlists";
const LOCAL_PLAYLIST_KEY = "qt-local-playlists";
/** 默认收藏歌单 id（通知栏/车机 ♡ 的收藏目标）：空 = 未显式设置，按「第一个自建歌单」解析 */
const DEFAULT_FAV_KEY = "qt-default-fav-playlist";
const LIKE_BATCH_LIMIT = 200;
/** 切歌时等待播放地址解析的上限（毫秒）：多音源回退链最坏几十秒，超时按失败处理。
 *
 *  取链链的真实预算是 `CHAIN_BUDGET_MS = 9s` + 整链宽限 250ms = 9250ms
 *  （qt-sources/src/budget.ts，用户要求「原源搜索 5s + 换源兜底 4s」），
 *  引擎侧 invoke 上限 `PLAY_TIMEOUT_MS = 12s`。这里取 **10s**：9250ms 链预算
 *  + 750ms 调度余量，既覆盖最坏情况，又不会在外层白等到 12s。
 *
 *  为什么收紧（2026-10-03 弱网修复）：链跑满说明档内和跨源都试过了，多等的
 *  每一秒都是纯白等——用户看到「每首卡十几秒才失败」，连挂 5 首就凑满熔断。
 *  失败快落地 + 「超时不计熔断、原地重试」才是正确组合。
 */
const URL_FETCH_BUDGET_MS = 10000;

/** 无缝播放预热的记账有效期（毫秒）：musicApi 的地址 TTL 是 10 分钟，
 *  这里留一半余量，同一首在 5 分钟内不重复预热，切歌来回也不空转取链。 */
const PRELOAD_TTL_MS = 5 * 60 * 1000;

/** 弱网原地重试：首次失败后等这么久再试**同一首**（指数退避） */
const STALLED_RETRY_BASE_MS = 3000;
/** 弱网连续重试上限（超过就停手等用户，不再空转） */
const STALLED_RETRY_LIMIT = 3;
/** 弱网重试退避封顶 */
const STALLED_RETRY_MAX_MS = 20000;

/** 熔断恢复探测：首次探测前的等待，之后指数退避 */
const RECOVERY_PROBE_BASE_MS = 15000;
const RECOVERY_PROBE_MAX_MS = 120000;
/** 恢复探测尝试上限：超过就彻底交给用户（避免长期不可用时反复取链） */
const RECOVERY_PROBE_LIMIT = 8;

/** 播放意图落地后的「原生尚未起播」宽限窗（毫秒）。冷启动/播放器重建后首次点播放，
 *  底层要走 ensurePlayer→loadIndex→requestResolve→startLoad→prepared 一整套，gIntendPlay
 *  到 prepared 后才置 true；这段窗口（约 1s）内 down-reconcile 探针会误判成「真暂停」，
 *  把 playing 拉平成 false（「先暂停」），随后原生起播、状态同步又把 playing 拉回 true
 *  （「再播放」）——先暂停再播放的闪动。窗口内放行（native 尚未起播不算真暂停）。 */
const PLAY_START_GRACE_MS = 3000;


class PlayerStore {
  current: Song | null = null;
  queue: Song[] = [];
  playing = false;
  progress = 0;
  duration = 0;
  mode = "sequence";
  playCounts: Map<string, number> = new Map<string, number>();
  likedSongs: Song[] = [];
  history: Song[] = [];
  savedPlaylists: Playlist[] = [];
  localPlaylists: Playlist[] = [];
  /** 默认收藏歌单 id（歌单页长按设置）。空串 = 未设置，运行时回落「第一个自建歌单」 */
  defaultFavPlaylistId = "";
  sleepStopAfterCurrent = false;
  sleepEndTime = 0;
  /** Display the selected preset, not a changing countdown remainder, in both settings sheets. */
  sleepRequestedMinutes = 0;
  quality = "320";
  private sleepTimer: number | null = null;
  /** 已因链接失效重取过地址的歌曲（platform:id）与重取时刻，避免「失败→重取」死循环 */
  private urlRetryKey = "";
  private urlRetryAt = 0;
  /** 本地优先：mediaId -> 已交付原生层的本地文件地址（「当前播放地址」展示与
   *  失败降级判定用；本地文件 prepare 失败时把它拉黑，重取走在线取链） */
  private localFirstUsed = new Map<string, string>();
  /** 本地优先已拉黑过的 mediaId（本地文件起播失败，本会话内不再用它顶在线歌） */
  private localFirstFailed = new Map<string, boolean>();
  /** 本地优先「直推时间线」索引：mediaId -> 磁盘上确认在盘的下载成品路径。
   *  构建时间线条目（pushTimeline/syncTimeline）前先刷这张表：命中的在线歌把
   *  本地路径直接当条目地址推给原生（DefaultDataSource 按路径路由到
   *  FileDataSource），绕开懒解析层（其上游是 HTTP 数据源，喂本地路径会起播
   *  失败→拉黑→回退在线，2026-11-02 真机定位），也不进音频缓存（下载文件不必
   *  再拷一份）。没命中的照旧推 qt-resolve 占位地址。 */
  private localPathByMid = new Map<string, string>();
  /** 本地优先命中版本号：localFirstUsed 每次写入/删除都 +1。Map 本身不是响应式
   *  依赖，播放页「本地文件」标签的 computed 追踪不到它的变动，靠这个版本号重算
   *  （本地优先命中发生在取链回调里，比切歌那一帧晚，必须由 tick 触发二次刷新） */
  localFirstTick = 0;
  /** 当前歌曲**在播本地文件**的内嵌封面（空串=文件里没有封面；key 不匹配自动作废，
   *  防止切歌瞬间旧图串到新歌上）。内嵌优先于在线封面，见 coverOf */
  embeddedCover = "";
  embeddedCoverKey = "";
  /** 当前歌曲**在播本地文件**的内嵌歌词（空串=文件里没有词，调用方退回在线取词） */
  embeddedLyric = "";
  embeddedLyricKey = "";
  /** 上一次内嵌标签读取的诊断文本（「本地文件地址」弹窗里展示，现场排查封面/歌词
   *  到底卡在哪一步：没读到文件 / 读到但无封面 / 封面被截断）。空串=没读过 */
  embeddedDiag = "";
  embeddedDiagKey = "";
  /** 上一次内嵌读取耗时（毫秒，0=命中缓存），拼进诊断文本用 */
  private embeddedDiagCost = 0;
  /**
   * 内嵌标签读取结果缓存（文件地址 → 结果）。
   *
   * 为什么必须有：一次解析要读 1MiB 起、封面不够再按 2 的倍数放大重读（上限
   * 8MiB），而且同一首本地文件在切歌路径上会被 `syncLocalFileMedia` 与
   * `syncSongExtras` 各读完一遍 —— 双份几 MB 的同步 IO（2026-11-02 真机
   * 「本地歌起播反而比在线慢 5 秒」的主要来源）。缓存按文件地址，会话级。
   */
  private embeddedCache: Map<string, EmbeddedReadResult> = new Map();
  /** 用户点播/切歌的时刻（起播耗时诊断用；playing=true 时报一次并清零） */
  private playKickAt = 0;
  // 播放请求序号：play() 的快路上有一次 await（localFileFor 本地复查），期间用户
  // 可能又点了另一首。await 回来必须确认自己仍是最新请求，否则会把旧歌顶回
  // （this.current = 旧歌）或把新歌进度清掉（seek(0)）——2026-11-02 审阅实测。
  private playSeq = 0;
  /** 本地歌替身链已替过的歌（platform:id）与时刻，口径对齐 urlRetryKey：
   *  同一首一分钟内只替一次，防止「替身也失效→再替→再失效」无限拉锯 */
  private substituteKey = "";
  private substituteAt = 0;
  /** 「提前结束」自愈已重试过的歌曲（platform:id）：流被截断/缓存内容异常时
   *  media3 会把条目当成正常播完并无缝切下一首（全程无错误事件）。每首只
   *  自愈重试一次，防止试听片段类内容反复拉回原地；重放仍提前结束就放行衔接 */
  private earlyEosKey = "";
  /** 上次进度持久化时间点（用于节流 saveState，避免每帧写存储） */
  private lastPersistAt = 0;
  /**
   * 三个「重键」的脏标记：收藏总表 / 收藏歌单 / 自建歌单。
   *
   * 这三张表的整表序列化（逐条 songToJson/playlistToJson + 跨桥 setStorageSync）
   * 是 persist() 里最贵的部分，而播放热路径（play/pause/toggle/进度时钟/通知栏
   * 状态同步…）只动 history 与播放态，这三张表根本没变。用脏标记把它们从
   * persist() 里摘掉，热路径就只剩两个小键的写入。
   *
   * 默认 true（首次 persist 必全量写一次）；标记只在对应键**写成功后**清除，
   * 写失败保持脏、下次重试 —— 出错方向永远是「多写一次」，绝不漏写。
   * 任何改动这三张表的地方（整体赋值 / push / splice / 原地改 pids|likeSeq|picUrl）
   * 都必须把对应标记置 true。
   */
  /** @internal 收藏同步引擎（services/like-sync.ts）跨文件读写；页面勿动 */
  likedDirty = true;
  playlistsDirty = true;
  localPlaylistsDirty = true;
  /** 进度时钟：播放期间每 100ms 直接向播放器要一次真实进度（见 startProgressClock） */
  private progressTimer: number | null = null;
  /** 上一次进度时钟 tick 的时刻（真实位置读不到时按墙钟外推用） */
  private lastTickAt = 0;
  /** 外推基准：最近一次权威进度的值与时刻（原生回调 / 时钟轮询 / seek） */
  private markValue = 0;
  private markAt = 0;
  /** seek 后的一小段窗口：播放器位置还没跟上，进度按外推走，避免来回跳 */
  private seekFreezeUntil = 0;
  /** 上一次原生时间回调报来的位置：判断「位置是否真的在前进」（见 onTime 里的熔断复位） */
  private lastNativeTime = -1;
  /** 统计用独立采样基准，避免 seek 后旧回调/切歌位置被登记为播放时长。 */
  private listenSession = new ListenSession();
  /** 连续「位置真在前进」的累计秒数：只有累计到 3 秒才算这首歌真的播起来了（见 onTime） */
  private healthyRun = 0;
  /** 重推时间线（切歌/重取地址）后的抑制窗口：位置会跳到新起播点，这段窗口内的位移不算「在前进」 */
  private healthyIgnoreUntil = 0;
  /**
   * 取链成功拿到的最新播放地址（mediaId → url，**仅内存不持久化**）。
   * musicApi.playUrl 出于「不带病续播」的考虑只写 urlFetchedAt、不把地址写进歌单，
   * 于是管理端「当前播放地址」读 song.url 永远是空 -> 显示「暂无播放地址」，但歌其实
   * 正常在播。这里在懒解析应答取到地址那一刻留一份展示副本，只给调试入口看，
   * 不参与播放、不落盘。
   */
  private resolvedUrlMap = new Map<string, string>();
  /** 桌面歌词进度钩子（onTime 回调里转发一次；服务层换行才推原生） */
  private desktopLyricHook: ((progress: number) => void) | null = null;
  /** 播完兜底：进度冻在末尾时补自动切歌用的采样状态（见 startProgressClock） */
  private stuckPos = -1;
  private stuckSince = 0;
  /** 播完兜底是否可用：补过一次后解除，等位置真正离开末尾（换歌/重头播）再武装，
      否则切歌期间旧位置仍冻在末尾，会连着触发一串自动切歌 */
  private endGuardArmed = true;
  /** 暂停态自愈探测：上次探测时刻与读到的底层位置（见进度时钟 !playing 分支） */
  private idleProbeAt = 0;
  private idleProbePos = -1;
  /** 播放态向下对账：连续命中计数（见进度时钟 playing 分支） */
  private activeProbeMisses = 0;
  /** 最近一次「用户/系统请求起播」的时间戳（0 = 无未消化意图）。
      冷启动/播放器重建后首次点播放，原生要经过懒解析→prepared 才真正置起播意图，
      down-reconcile 探针在该窗口内会看到「底层未意图播放」而误判成真暂停，把
      playing 拉平；宽限窗内放行，等原生 prepared→playInternal 或状态同步回调给出
      权威结果。真实暂停（pause/toggle 停）会清掉它，因此不会掩盖用户暂停。 */
  private playRequestedAt = 0;
  /** 正在向 JS 请求地址的 mediaId（空 = 没有解析在飞）。懒解析窗口内原生必然
      尚未置起播意图，向下对账探针必须放行；用「在飞」而不是纯时间窗判定，
      弱网取链超过固定宽限窗也不会把首播误拉平成暂停。 */
  private resolveInFlightMid = "";
  /** media3 时间线里的条目顺序（mediaId 列表）：时间线下标 ≠ 展示队列下标，定位用 */
  private timelineIds: string[] = [];
  /** 「下一首播放」在随机模式下锁定的曲目 mediaId（空 = 没锁，2026-10-30）。
      随机模式的播放顺序是洗好的乱序时间线，队列里插到当前曲后面并不等于接下来
      真会播它（原生按时间线顺序衔接）。所以锁一个 mediaId：pushTimeline 洗牌后
      把它固定排到当前曲之后，手动「下一首」也优先走它，真起播就消费清零。 */
  private lockedNextMid = "";
  /** 无缝播放预热记账：上一次预热的 mediaId 与时间戳（避免同一首反复取链） */
  private preloadMid = "";
  private preloadAt = 0;
  /** 自动下一首标识：播放失败且为 true 时自动切下一首；连续失败 5 首自动关闭
      （熔断，防止死歌队列无限空转）并通知栏提示。任一成功播放（进度>3秒）或
      用户手动发起播放时重新打开 */
  private autoNext = true;
  /** 连续播放失败计数（切歌成功或手动播放时清零） */
  private failStreak = 0;
  /** 每个 mediaId 上次取链失败是否只是「网络慢/引擎卡」（2026-10-03 弱网修复）。
      true = 环境问题（等网络就好），false = 引擎明确说没地址（内容问题）。
      handlePlaybackError 读它决定是原地重试还是换下一首。 */
  private stalledMap = new Map<string, boolean>();
  /** 弱网连续重试同一首的次数（成功播放/换歌/手动播放时清零）。
      与 failStreak 分开：前者是「网络还没好，再等等」，后者是「歌有问题，换下一首」。 */
  private stallRetry = 0;
  /** 熔断自愈的探测计时器（null = 没有在探测） */
  private recoverTimer: number | null = null;
  /** 最近一次「用户主动暂停」的时间戳（0 = 没有未消化的暂停意图）。
      弱网退避重试与熔断自愈靠它区分「系统自动停下」与「用户明确不想听」：
      用户暂停后到点不强行拉起播放。恢复播放（play/ensurePlayback/toggle）时清零。
      通知栏暂停走原生状态同步回调，无法与本方暂停区分，不在此记（已知边界）。 */
  private pauseIntentAt = 0;
  /** 恢复探测开始的时间戳：probeDone 用它判断探测期间用户是否又按了暂停 */
  private probeStartedAt = 0;
  /** 最近一次用户手动点歌/切歌的时间戳：onNativeTrackChanged 用它丢弃
      紧随其后迟到的旧时间线对账事件（见该处注释） */
  private explicitPlayAt = 0;
  /** ended 与 natural trackChanged 只允许一个入口结算；两个标记分别覆盖两种到达顺序。 */
  private skipNextNativeTransitionAt = 0;
  private skipNextEndedAt = 0;

  /** 记录一次权威进度（原生回调、seek、切歌），同时重置外推基准 */
  private markProgress(value: number): void {
    this.markValue = value;
    this.markAt = Date.now();
    this.progress = value;
  }

  /**
   * 播放期间每 100ms 直接向播放器要一次真实进度，驱动进度条/歌词高亮/桌面歌词。
   *
   * 进度显示此前完全依赖原生 onTime 回调（原 1 秒一次、后改 200ms）：回调链路一旦
   * 中断，整个进度显示就冻住，只有重开播放页靠 syncProgressNow 跳一次。这里自己轮询
   * 同一个权威值（audioPlayer.currentTime()），原生回调退化为兜底，两边谁在都能走。
   * 读不到位置（播放器未就绪）或刚 seek 完时按时间外推，上限 0.5 秒，
   * 宁可少走一点，也不让显示跑到音频前面。
   */
  /**
   * 停掉进度时钟。
   * 原来只有 start 没有 stop：100ms 的 setInterval 一旦起来就永不停止，而它的回调每 tick
   * 都要过桥去问原生播放器（currentMediaId/currentTime/isNativeIntendingToPlay）。真机上
   * 这条是「迟到的定时器回调打在已反注册的 UTS 实例上」的高频路径之一（报错形如
   * `java.lang.IllegalStateException: UTS instance 65 is not registered`，堆栈
   * Bridge.onJSTimerFired ← Bridge$scheduleJSTimer$runnable$1.run ← Handler.handleCallback）。
   * 所以这里补上停止入口，生命周期/退出流程能真正把它关掉。
   */
  private stopProgressClock(): void {
    const timer = this.progressTimer;
    if (timer != null) {
      clearInterval(timer);
      this.progressTimer = null;
    }
  }

  private startProgressClock(): void {
    if (this.progressTimer != null) return;
    this.lastTickAt = Date.now();
    this.progressTimer = setInterval(() => {
      try {
        const now = Date.now();
        // 本次 tick 与上次的间隔（真实位置读不到时按它推进显示）
        let tickElapsed = (now - this.lastTickAt) / 1000;
        this.lastTickAt = now;
        if (!this.playing) {
          // 自愈探测：store 认为暂停、底层却还在走（播放事件丢失/状态竞争会让两边
          // 脱钩，表现就是「通知栏在播、播放页暂停且进度冻结在 0」）。每秒读一次
          // 底层位置，位置在前进且底层加载的正是当前这首歌，就按底层为准拉回状态。
          // 真暂停时位置不走，不会误判；stop 之后 loadedUrl 为空，探测自然失效。
          if (now - this.idleProbeAt >= 1000) {
            this.idleProbeAt = now;
            // 身份对账用 mediaId：队列在 media3 上，条目地址是懒解析的占位符，
            // 比地址没有意义，比「时间线当前条目是不是这首歌」（stop 后为空串，探测自然失效）
            const cur = this.current;
            const curMid = cur != null ? this.mediaIdOf(cur) : "";
            if (curMid.length > 0 && audioPlayer.currentMediaId() == curMid) {
              const t = audioPlayer.currentTime();
              if (t > 0 && Math.abs(t - this.idleProbePos) > 0.3) {
                this.idleProbePos = t;
                // 只有底层「意图播放」（playWhenReady）才自愈。刚显式暂停时底层意图
                // 已是 false，位置残余前移只是缓冲余量/暂停未落地——若拉回在播，会跟
                // 下方「向下对账」打架，造成「暂停图标 → 播放 → 暂停」来回跳。
                if (!audioPlayer.isNativeIntendingToPlay()) {
                  return;
                }
                logMsg("[QT Player] 状态自愈：底层在播而 store 认为暂停，位置 " + t.toFixed(1));
                this.playing = true;
                this.markProgress(t);
                this.persist();
                return;
              }
              this.idleProbePos = t;
            }
          }
          return;
        }
        // 向下对账：store 认为在播、底层却已处于暂停意图（通知栏暂停/焦点丢失等
        // 播放状态事件偶发不送达，表现是通知栏和实际声音都暂停了，播放页/迷你条
        // 还显示播放态）。每个时钟 tick 查一次，连续 3 次（约 300ms）命中才拉平，
        // 视觉上几乎无感又能滤掉单次瞬时读数。用 playWhenReady 而非 isPlaying
        // 判别：缓冲中 isPlaying 同样为 false 但播放意图仍是 true，不会误判。
        // 身份对账用 mediaId（懒解析占位地址没有比较意义）；原生自动衔接的取链窗口
        // 里 playWhenReady 仍是 true，天然不会误判成暂停。
        const cur = this.current;
        const curMid = cur != null ? this.mediaIdOf(cur) : "";
        // 起播宽限：刚请求过播放、原生还在懒解析/准备（gIntendPlay 未置位），此刻
        // 「底层未意图播放」不是真暂停，不能据此拉平（否则冷启动首播会「先暂停再
        // 播放」）。两条判据取或：① 距最近一次起播请求不足 PLAY_START_GRACE_MS；
        // ② 当前曲的取链还在飞 —— 地址没回来底层根本不可能起播，弱网取链超过固定
        // 窗口也不能算真暂停。宽限结束后仍未起播才按真暂停处理。
        const resolving = this.resolveInFlightMid.length > 0 && this.resolveInFlightMid == curMid;
        const inPlayGrace =
          resolving ||
          (this.playRequestedAt > 0 && now - this.playRequestedAt < PLAY_START_GRACE_MS);
        if (audioPlayer.isNativeIntendingToPlay()) {
          // 底层已经真正置起播意图：宽限使命完成，清掉以免长期压制对账
          this.playRequestedAt = 0;
          this.resolveInFlightMid = "";
        }
        if (
          !inPlayGrace &&
          curMid.length > 0 &&
          audioPlayer.currentMediaId() == curMid &&
          !audioPlayer.isNativeIntendingToPlay()
        ) {
          this.activeProbeMisses++;
          if (this.activeProbeMisses >= 3) {
            this.activeProbeMisses = 0;
            this.playRequestedAt = 0;
            this.resolveInFlightMid = "";
            logMsg("[QT Player] 状态对账：底层已暂停而 store 认为在播，按底层拉平");
            this.playing = false;
            this.persist();
            return;
          }
        } else {
          this.activeProbeMisses = 0;
        }
        if (now >= this.seekFreezeUntil) {
          const t = audioPlayer.currentTime();
          // 单曲循环由原生 REPEAT_ONE 完成：循环重启那一刻位置从末尾跳回 0，
          // 而「已在歌里（markValue>0）读到 0 视为无效」的兜底会把进度永久冻在
          // 上一轮的末尾 —— 循环回跳是合法回退，重置基准放行
          const loopRestart =
            this.mode == "single" && t == 0 && this.markValue > 2;
          // 播放器未就绪时底层返回 0：已经在歌里（markValue>0）却读到 0 视为无效，改用外推
          if (t > 0 || this.markValue == 0 || loopRestart) {
            if (loopRestart) {
              this.markProgress(0);
              this.stuckPos = 0;
            }
            // 外推可能略微超前：真实位置追上之前 UI 不退，外推基准照常刷新
            if (t >= this.progress - 0.3) this.progress = t;
            this.markValue = t;
            this.markAt = now;
            if (this.desktopLyricHook != null) this.desktopLyricHook(t);
            // 节流持久化进度（约每 5 秒一次），原生回调不送达时也能记住位置
            // 与原生 onTime 分支同口径：只写轻量进度键。这里原来写全量 saveState，
            // 大队列下每 5 秒一次 O(N) 逐首 songToJson + 整体 stringify 跨桥，
            // 而这一支正是原生回调不送达时的兜底，反倒成了最热的那条路径。
            if (t >= this.lastPersistAt + 5) {
              this.lastPersistAt = t;
              this.saveProgressLight();
            }
            // 播完兜底：原生 ENDED 偶尔不送达（ExoPlayer 卡在末尾 / 缓存片段截断），
            // 位置冻在末尾 2.5 秒就补一次自动切歌，否则会停在那儿一动不动
            if (Math.abs(t - this.stuckPos) >= 0.05) {
              this.stuckPos = t;
              this.stuckSince = now;
              // 位置离开末尾（换歌成功、单曲循环重头播）才重新武装兜底
              if (this.duration <= 5 || t < this.duration - 5) this.endGuardArmed = true;
            } else if (
              this.endGuardArmed &&
              this.stuckSince > 0 &&
              now - this.stuckSince > 2500 &&
              this.duration > 0 &&
              t >= this.duration - 1.5
            ) {
              this.endGuardArmed = false;
              this.stuckSince = 0;
              logMsg("[QT Player] 进度在末尾停住，补一次自动切歌");
              this.finishListenSession();
        this.next(true);
              return;
            }
            return;
          }
        } else {
          // 外推：真实位置读不到时按**墙钟增量**推进（单次 tick 上限 0.25 秒）。
        }
        // 基准必须是「当前 UI 进度」而不能只是 markValue：原来 est = markValue + min(elapsed, 0.5)
        // 被钳死在 markValue+0.5，一旦 this.progress 已经超过它，下面那句「只进不退」就把进度
        // 永久冻住 —— 进度条不动、当前句不再高亮、列表不滚动、桌面歌词也不换行（真机复现：微光）。
        if (tickElapsed > 0.25) tickElapsed = 0.25;
        let elapsed = (now - this.markAt) / 1000;
        if (elapsed > 0.5) elapsed = 0.5;
        let est = this.markValue + elapsed;
        if (est < this.progress + tickElapsed) est = this.progress + tickElapsed;
        if (this.duration > 0 && est > this.duration) est = this.duration;
        // 外推只进不退：读到下一个真实位置之前，显示不允许回退
        if (est < this.progress) est = this.progress;
        this.progress = est;
        // 外推同样要喂桌面歌词：否则真实位置读不到时只有浮窗冻住（用户反馈的「两处都不跟随」）
        if (this.desktopLyricHook != null) this.desktopLyricHook(est);
      } catch (_) {
        // 静默：进度外推失败时保持上一帧显示值，进度条轻微滞后优于打断播放
      }
    }, 100) as number;
  }

  restore(): void {
    this.likedSongs = this.loadSongList(LIKED_KEY);
    // 历史列表会被多个页面直接遍历（:key 读 song.id 等），加载时先剔除空/缺关键字段的脏条目
    const loadedHistory = this.loadSongList(HISTORY_KEY);
    const cleanHistory: Song[] = [];
    for (let i = 0; i < loadedHistory.length; i++) {
      const s = loadedHistory[i];
      if (s == null || s.id == null || s.id.length == 0) continue;
      if (s.platform == null || s.platform.length == 0) continue;
      cleanHistory.push(s);
    }
    this.history = cleanHistory;
    this.savedPlaylists = this.loadPlaylistList();
    this.localPlaylists = this.loadLocalPlaylistList();
    this.loadLikeSync();
    // 不再预置任何默认歌单：需要歌单由用户自己创建，避免凭空多出一个没见过的“我的收藏”。
    // 老用户数据里已经存在的歌单（含旧版自动建的“我的收藏”）保留不动，
    // 只做两件兼容：补齐后加的全局唯一 pid、把旧封面路径矫正到真实图标。
    let migrated = false;
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const pl = this.localPlaylists[i];
      if (
        pl.picUrl == null ||
        pl.picUrl.length === 0 ||
        pl.picUrl === '/static/logo.png' ||
        // 旧默认封面（qt-media 占位图）迁回应用图标：默认封面已改为复用 icon 资源，
        // 占位图文件已删除，不迁移会渲染成裂图
        pl.picUrl === '/static/qt-media/default-playlist-cover.png'
      ) {
        pl.picUrl = DEFAULT_PLAYLIST_COVER_ASSET;
        migrated = true;
      }
      if (pl.pid == null || pl.pid.length === 0) {
        pl.pid = generateGlobalPid();
        migrated = true;
      }
      // 迁移：旧版本把歌曲存在 localPlaylists[].tracks 里，现在统一进收藏总表，
      // 按 pid 标记归属（一首歌在几个歌单里就有几个 pid），之后不再用 tracks。
      if (pl.tracks != null && pl.tracks.length > 0) {
        const pid = pl.pid!;
        for (let j = 0; j < pl.tracks.length; j++) {
          this.collectSongInto(pl.tracks[j], pid);
        }
        pl.tracks = [];
        migrated = true;
      }
    }
    if (migrated) this.saveLocalPlaylistList();
    this.loadState();
    useListenStatsStore().load(this.history, this.playCounts);
    // 不喜欢列表变化 → 无损重推原生时间线（syncTimeline 内部会按新规则过滤）：
    // 屏蔽必须立即对 media3 自动衔接生效——自动衔接走的是时间线，
    // 只改 JS 侧队列的话原生层还会把被屏蔽的歌带回来
    uni.$on(DISLIKES_CHANGED_EVENT, () => {
      this.syncTimeline();
    });
    audioPlayer.bind(
      (time: number, duration: number) => {
        // 回调与时钟轮询交错时可能带回略旧的值：小幅倒退直接忽略（外推基准也不动），
        // 否则 UI 进度和歌词高亮行会在两行之间来回跳。
        // 真正的回退（seek、切歌、重播）都由 seek()/play() 自己写进度，不走这里。
        // seek/切歌后的基准窗口内原生轮询可能仍报旧位置（重置尚未生效），一律忽略
        if (Date.now() < this.seekFreezeUntil) {
          this.listenSession.resetSample();
          return;
        }
        const listenSong = this.current;
        if (listenSong != null) {
          const listenKey = this.mediaIdOf(listenSong);
          const nativeKey = audioPlayer.currentMediaId();
          if (nativeKey.length == 0 || nativeKey == listenKey) {
            const listenDuration = duration > 0 ? duration : (listenSong.duration ?? 0);
            const delta = this.listenSession.sample(listenKey, time, listenDuration,
              this.playing, listenClockNow(), audioPlayer.rate, Date.now());
            this.applyListenDelta(listenSong, delta);
          } else {
            this.listenSession.resetSample();
          }
        }
        // 「真的在播」的判据：位置连续小步前进（200ms 一次的回调里每次约 0.2 秒）。
        // 三类位移不算「前进」：拖动进度条/切歌的大跳（>5 秒）、重推时间线后跳到新
        // 起播点的位移（抑制窗口内），以及加载失败时冻住不动（位移≈0）。
        // 而且必须连续累计到 3 秒才采信 —— 单次小跳绝不能算：重取地址会把条目重推到
        // 新起播点，位置只跳 0.x 秒却正好落进位移区间，于是每轮重取都被当成「播起来了」
        // 而把熔断计数与「每曲只重取一次」标记清掉，这一首就被无限重取、熔断永不触发
        //（真机踩过：拖到曲末取链失败，同一首的 resolve 请求刷了 60 多次不停，
        //  用户观感就是「不是应该切下一首吗，为什么无限调用」）
        const delta = this.lastNativeTime >= 0 ? time - this.lastNativeTime : 0;
        this.lastNativeTime = time;
        const moving =
          delta > 0.05 && delta < 5 && Date.now() >= this.healthyIgnoreUntil;
        this.healthyRun = moving ? this.healthyRun + delta : 0;
        if (time >= this.progress - 0.25) {
          this.progress = time;
          this.markProgress(time);
          if (this.desktopLyricHook != null) this.desktopLyricHook(time);
        }
        this.duration = duration;
        // 只有「连续前进满 3 秒且已过 3 秒」才算地址有效，清掉「重取地址」标记，
        // 下次失效时可再重试一次；同时重开自动切歌熔断。
        if (this.healthyRun >= 3 && time > 3) {
          this.healthyRun = 0;
          this.failStreak = 0;
          this.autoNext = true;
          // 播起来了：网络已恢复，清掉弱网重试计数与失败性质记录
          // （否则弱网恢复后仍会沿用超时攒下的次数，很快又打满）
          this.stallRetry = 0;
          this.stalledMap.clear();
          if (this.urlRetryKey.length > 0) this.urlRetryKey = "";
          this.earlyEosKey = "";
        }
        // 节流持久化进度（约每 5 秒一次），确保重启后能定位到上次位置。
        // 只写轻量进度键：全量 saveState 要把整条队列逐首 songToJson 再整体
        // stringify，大队列下每 5 秒一次 O(N) 跨桥序列化，只为存进度不值
        if (time >= this.lastPersistAt + 5) {
          this.lastPersistAt = time;
          this.saveProgressLight();
        }
      },
      () => {
        const now = Date.now();
        if (this.skipNextEndedAt > 0 && now - this.skipNextEndedAt < 2000) {
          this.skipNextEndedAt = 0;
          return;
        }
        this.skipNextNativeTransitionAt = now;
        logMsg("[QT Media] 原生播完回调 → 自动下一首");
        this.finishListenSession();
        this.next(true);
      },
      () => {
        // 播放出错：有限次自动切歌，避免死循环刷日志
        this.handlePlaybackError();
      },
      (playing: boolean) => {
        // 状态栏媒体控制（通知栏播放/暂停/停止）改变播放状态时同步 UI
        if (this.playing != playing) {
          this.listenSession.resetSample();
          this.playing = playing;
          qtDiag("[QT Prog] 播放状态同步 → playing=" + playing);
          // 起播耗时诊断：从点播/切歌到「真的播起来了」到底等了多久（只报一次）
          if (playing && this.playKickAt > 0) {
            qtDiag("[QT Prog] 起播耗时 " + (Date.now() - this.playKickAt) + "ms");
            this.playKickAt = 0;
          }
          // 底层给出了权威状态：起播宽限到此结束（真播起来了，或用户从通知栏
          // 暂停了）。不清的话下一次真暂停后仍会被宽限压制对账。
          this.playRequestedAt = 0;
          this.activeProbeMisses = 0;
          this.persist();
        }
      },
      // 通知栏「下一首/上一首」按钮（原生播放器转发）
      () => {
        this.next(false);
      },
      () => {
        this.previous();
      }
    );
    // media3 时间线懒解析桥：条目真正建连那一刻回 JS 换真实地址。
    // 复用统一取链（限时 + musicApi 地址缓存，同曲重播/重试直接命中缓存）；
    // resolveFail 让原生层对该条目抛 IO 异常 → 底层 Error 事件 → handlePlaybackError。
    // 取链失败不再发生在切换前，play() 本身永不阻塞在取链上（切歌瞬时可达）。
    audioPlayer.onResolveRequest((mediaId: string) => {
      const song = this.findSongByMediaId(mediaId);
      if (song == null) {
        audioPlayer.resolveFail(mediaId);
        return;
      }
      // 取链请求到达 = 原生正处在「懒解析窗口」：此刻底层尚未置起播意图，
      // 向下对账探针必须继续放行。除了续期宽限，还标记「解析在飞」——地址没回来
      // 底层根本不可能起播，弱网取链超过固定宽限窗也不会被误拉平成暂停。
      const curNow = this.current;
      if (
        this.playing &&
        curNow != null &&
        curNow.platform + ":" + curNow.id == mediaId
      ) {
        this.playRequestedAt = Date.now();
      }
      this.resolveInFlightMid = mediaId;
      // 本地歌不走网络取链：地址就是 content:// 本体（pushTimeline 已直接推真实地址，
      // 正常不会进来；url 缺失的脏数据兜底在这里回填，缺失则按失败处理）
      if (song.platform == "local") {
        if (song.url != null && song.url.length > 0) {
          this.resolveInFlightMid = "";
          // 交地址给底层 = 进入 prepare 窗口：重置宽限，覆盖「解析慢、prepare 还在走」
          if (this.playing) this.playRequestedAt = Date.now();
          audioPlayer.resolveDone(mediaId, song.url);
        } else {
          this.resolveInFlightMid = "";
          audioPlayer.resolveFail(mediaId);
        }
        return;
      }
      // 在线歌的在线取链（本地优先未命中/被拉黑/开关关时走）：
      const fetchOnline = (): void => {
        this.fetchUrlWithTimeout(song, URL_FETCH_BUDGET_MS)
          .then((res: { url: string; stalled: boolean }) => {
            // 记下本次失败性质，handlePlaybackError 据此区分「网络慢」与「没地址」
            this.stalledMap.set(mediaId, res.stalled);
            if (this.resolveInFlightMid == mediaId) this.resolveInFlightMid = "";
            if (res.url.length > 0) {
              // 留一份展示副本（管理端「当前播放地址」用，见 resolvedUrlMap），
              // 并把当前播放曲的 url 字段回填：展示入口读 current.url 时才不是空
              this.resolvedUrlMap.set(mediaId, res.url);
              const cur = this.current;
              if (cur != null && cur.platform + ":" + cur.id == mediaId) {
                cur.url = res.url;
              }
              // 取链慢时 playRequestedAt 可能已过期：这里以「交地址给底层」为新起点
              // 重置宽限，否则解析完到 prepared 之间那段仍会被误判成真暂停
              if (this.playing) this.playRequestedAt = Date.now();
              audioPlayer.resolveDone(mediaId, res.url);
            } else {
              audioPlayer.resolveFail(mediaId);
            }
          })
          .catch(() => {
            if (this.resolveInFlightMid == mediaId) this.resolveInFlightMid = "";
            this.stalledMap.set(mediaId, true);
            audioPlayer.resolveFail(mediaId);
          });
      };
      // 在线歌：本地优先（DESIGN §7.13）——先全本地查一遍（下载账本身份级 +
      // 本地曲库元数据级），命中直接交本地文件，跳过全部取链；查不到走原取链。
      // 上次用本地文件起播失败过的（localFirstFailed）不再顶，直接在线取链。
      if (localFirstEnabled() && !this.localFirstFailed.has(mediaId)) {
        localFileFor(song)
          .then((localUrl: string | null) => {
            if (localUrl != null && localUrl.length > 0) {
              if (this.resolveInFlightMid == mediaId) this.resolveInFlightMid = "";
              this.stalledMap.set(mediaId, false);
              // 展示副本同口径：管理端「当前播放地址」看得到本地文件路径
              this.resolvedUrlMap.set(mediaId, localUrl);
              const cur = this.current;
              if (cur != null && cur.platform + ":" + cur.id == mediaId) {
                cur.url = localUrl;
              }
              this.localFirstUsed.set(mediaId, localUrl);
              this.localFirstTick++;
              // 这一刻 song.url 还是在线流地址，syncSongExtras 读不到文件标签区：
              // 拿到真实文件路径后补读内嵌封面/歌词，才能做到「内嵌优先于在线」
              this.syncLocalFileMedia(song, localUrl);
              if (this.playing) this.playRequestedAt = Date.now();
              audioPlayer.resolveDone(mediaId, localUrl);
              return;
            }
            fetchOnline();
          })
          .catch(() => {
            // 本地查询自身异常（存储损坏等）：不当播放失败，直接走在线取链
            if (this.resolveInFlightMid == mediaId) this.resolveInFlightMid = "";
            fetchOnline();
          });
      } else {
        fetchOnline();
      }
    });
    // 原生自动衔接下一首（时间线顺序）/媒体键切歌后对账：换 current、记历史、
    // 刷新歌词与封面。睡眠定时「当前歌播完停止」也在这里落地 —— 懒解析窗口里
    // 原生切歌无声，这里立即停播退出，听感就是「这首歌放完就停」。
    // 回调第二参 naturalEnd = 切换由「条目自然播到头」引发，用于提前结束自愈。
    audioPlayer.onTrackChanged((mediaId: string, naturalEnd: boolean) => {
      this.onNativeTrackChanged(mediaId, naturalEnd);
    });
    // 通知栏/系统媒体卡片/车机/原子随身听的收藏 ♡：落到「默认收藏歌单」
    // （未设置时 = 第一个自建歌单；一个都没有则新建「我的收藏」）
    audioPlayer.onSetRating((mediaId: string, liked: boolean) => {
      this.onNativeSetRating(mediaId, liked);
    });
    // 进度时钟不依赖原生回调，应用启动即开（播放中每 100ms 自己取一次真实进度）
    this.startProgressClock();
    // 重启后恢复上次播放：重新获取当前歌曲播放地址并定位到上次进度续播
    this.restorePlayback();
  }

  /**
   * 启动后恢复上次播放：只恢复「暂停展示态」（current/queue/progress 已由 loadState 还原）。
   * 播放地址不再启动时预取 —— 队列已归 media3，地址在条目真正加载那一刻才懒解析
   * （qt-resolve 桥），过期链接天然不会带病续播。用户点播放时 ensurePlayback 推时间线，
   * 从上次进度续播。
   */
  async restorePlayback(): Promise<void> {
    if (this.current == null) return;
    this.playing = false;
    this.persist();
  }

  setQuality(q: string): void {
    this.quality = q;
    this.persist();
  }

  /**
   * 某首歌实际使用的播放音质（2026-10-28 平台独立，对齐 PC 的
   * effective_quality_for）：该源存过独立播放档位用之，否则回落全局默认
   * this.quality（设置页写入）。所有取链点（懒解析/预热/地址作废重取）统一
   * 走这里——按歌取，同一队列里跨源的歌各用各的档。
   */
  effQualityOf(song: Song): string {
    if (song == null) return this.quality;
    return sourcePlayQualityOf(song.platform, this.sourceDownloadQualityFallback(song.platform));
  }

  /**
   * 播放音质的回落值 = 该源的下载音质（下载缺省 = 音源第二档）。
   * 设置页默认值即此口径；播放页手动选过的档位仍优先（sourcePlayQualityOf 已处理）。
   */
  sourceDownloadQualityFallback(platform: string): string {
    return sourceDownloadQualityOf(platform, useDownloadsStore().downloadQuality);
  }

  /**
   * 播放页音质菜单选择落地（平台独立）：写入当前曲所属平台的独立播放档位。
   * 返回 false = 形状非法（调用方提示）。全局默认不在这里动——设置页的
   * 「播放音质」仍是没存过独立档位的源的回落值。
   */
  setSourceQuality(q: string): boolean {
    const cur = this.current;
    if (cur == null) return false;
    return setSourcePlayQuality(cur.platform, q);
  }

  /** 播放模式切换后立即同步循环模式给 media3（否则要等下一次推时间线才生效：
      播放中把顺序切成单曲循环，当前这首播完就该重头而不是进下一首） */
  syncRepeatMode(): void {
    audioPlayer.setRepeatMode(this.mode == "single" ? 1 : 2);
    // 「下一首播放」锁在单曲循环下必须走得过去：REPEAT_ONE 是原地重播，永远到不了
    // 插进来的那首，所以锁定期间临时放开成列表环绕，播到后由 onNativeTrackChanged
    // 收回（2026-10-30）
    if (this.mode == "single" && this.lockedNextMid.length > 0) {
      audioPlayer.setRepeatMode(2);
    }
  }

  setSleep(minutes: number): void {
    this.sleepRequestedMinutes = minutes;
    this.sleepStopAfterCurrent = false;
    this.sleepEndTime = 0;
    const timer = this.sleepTimer;
    if (timer != null) {
      clearTimeout(timer);
      this.sleepTimer = null;
    }
    if (minutes == 0) return;
    if (minutes == 90) {
      this.sleepStopAfterCurrent = true;
      this.sleepEndTime = -1;
      return;
    }
    this.sleepEndTime = Date.now() + minutes * 60 * 1000;
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      this.sleepEndTime = 0;
      this.exitAfterSleep();
    }, minutes * 60 * 1000) as number;
  }

  /**
   * 睡眠定时到点：停掉播放并退出应用。
   *
   * 必须显式收尾：退出走的是 Android「热退出」（只关 Activity，后台进程保留），
   * 不停播放器/不撤悬浮窗的话，音频会继续响、系统媒体通知与桌面歌词会留在屏幕上。
   * 保留 current/queue/progress，下次启动仍停在上次位置（不自动播放）。
   */
  private exitAfterSleep(): void {
    if (desktopLyric.isEnabled()) desktopLyric.disable();
    this.playing = false;
    audioPlayer.stop();
    this.persist();
    exitApp();
  }

  private loadSongList(key: string): Song[] {
    try {
      const raw = uni.getStorageSync(key) as string;
      if (raw.length == 0) return [];
      const arr = JSON.parse(raw) as string[];
      const songs: Song[] = [];
      for (let index = 0; index < arr.length; index++) {
        const song = songFromJson(arr[index] as string);
        if (song != null) songs.push(song);
      }
      return songs;
    } catch (_) {
      return [];
    }
  }

  private saveSongList(key: string, songs: Song[]): boolean {
    try {
      const arr: string[] = [];
      for (let index = 0; index < songs.length; index++)
        arr.push(songToJson(songs[index]));
      uni.setStorageSync(key, JSON.stringify(arr));
      return true;
    } catch (_) {
      return false;
    }
  }

  private loadPlaylistList(): Playlist[] {
    try {
      const raw = uni.getStorageSync(PLAYLIST_KEY) as string;
      if (raw.length == 0) return [];
      const arr = JSON.parse(raw) as string[];
      const playlists: Playlist[] = [];
      for (let index = 0; index < arr.length; index++) {
        const pl = playlistFromJson(arr[index] as string);
        if (pl != null) playlists.push(pl);
      }
      return playlists;
    } catch (_) {
      return [];
    }
  }

  private savePlaylistList(): void {
    try {
      const arr: string[] = [];
      for (let index = 0; index < this.savedPlaylists.length; index++)
        arr.push(playlistToJson(this.savedPlaylists[index]));
      uni.setStorageSync(PLAYLIST_KEY, JSON.stringify(arr));
      this.playlistsDirty = false;
    } catch (_) {
      // 静默：歌单落盘失败（存储满/IO 异常）时保留脏标记，下次变更窗口重试
    }
  }

  /** 读取收藏同步游标与待推送队列（LIKE_SYNC_DESIGN.md §5.4） */
  private loadLocalPlaylistList(): Playlist[] {
    try {
      const raw = uni.getStorageSync(LOCAL_PLAYLIST_KEY) as string;
      if (raw.length == 0) return [];
      const arr = JSON.parse(raw) as string[];
      const playlists: Playlist[] = [];
      for (let index = 0; index < arr.length; index++) {
        const pl = playlistFromJson(arr[index] as string);
        if (pl != null) playlists.push(pl);
      }
      return playlists;
    } catch (_) {
      return [];
    }
  }

  private saveLocalPlaylistList(): void {
    try {
      const arr: string[] = [];
      for (let index = 0; index < this.localPlaylists.length; index++)
        arr.push(playlistToJson(this.localPlaylists[index]));
      uni.setStorageSync(LOCAL_PLAYLIST_KEY, JSON.stringify(arr));
      this.localPlaylistsDirty = false;
    } catch (_) {
      // 静默：本地歌单落盘失败时保留脏标记，下次落盘窗口重试
    }
  }

  private loadState(): void {
    try {
      // 默认收藏歌单 id 用独立存储键（不随播放状态全量序列化）：先恢复，且不受
      // 下面的「无全量状态」早退影响（新装用户没 STATE_KEY 也要认默认收藏歌单）
      const favId = uni.getStorageSync(DEFAULT_FAV_KEY) as string;
      if (favId != null && favId.length > 0) this.defaultFavPlaylistId = favId;
      const raw = uni.getStorageSync(STATE_KEY) as string;
      if (raw.length == 0) return;
      const obj = parseJsonToUtso(raw);
      const mode = obj.get("mode") as string | null;
      if (mode != null && mode.length > 0) this.mode = mode;
      const quality = obj.get("quality") as string | null;
      if (quality != null && quality.length > 0) this.quality = quality;
      // 随机模式「下一首播放」的锁定（2026-10-30）：重启后队列还在，锁也得跟着活，
      // 否则杀进程回来「下一首」会变回随机
      const lockedNext = obj.get("lockedNext") as string | null;
      if (lockedNext != null && lockedNext.length > 0) this.lockedNextMid = lockedNext;
      const counts = obj.get("playCounts") as UTSJSONObject | null;
      if (counts != null) {
        const keys = UTSJSONObject.keys(counts);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i] as string;
          const value = counts.get(key) as number | null;
          if (value != null) this.playCounts.set(key, value);
        }
      }
      const queueArr = obj.get("queue") as string[] | null;
      if (queueArr != null && queueArr.length > 0) {
        const queue: Song[] = [];
        for (let index = 0; index < queueArr.length; index++) {
          const song = songFromJson(queueArr[index] as string);
          if (song != null) queue.push(song);
        }
        if (queue.length > 0) this.queue = queue;
      }
      // 无论队列是否为空，都恢复当前歌曲与进度（否则单曲播放后重启 current 会丢失）
      const currentText = obj.get("current") as string | null;
      const current = songFromJson(currentText != null ? currentText : "");
      if (current != null) this.current = current;
      const progress = obj.get("progress") as number | null;
      const duration = obj.get("duration") as number | null;
      this.progress = progress != null ? progress : 0;
      this.duration = duration != null ? duration : 0;
      // 轻量进度键比全量态新鲜（进度时钟只写它）：当前曲对得上且进度更靠前
      // 才采信 —— 正常退出时 persist() 会写全量态（含 seek 后的进度），轻量键
      // 只在崩溃/被杀没来得及全量落盘的场景兜底
      try {
        const lightRaw = uni.getStorageSync(PROGRESS_KEY) as string;
        if (lightRaw.length > 0 && this.current != null) {
          const light = parseJsonToUtso(lightRaw);
          const key = light.get("key") as string | null;
          if (key != null && key == this.mediaIdOf(this.current)) {
            const lightProgress = light.get("progress") as number | null;
            const lightDuration = light.get("duration") as number | null;
            if (lightProgress != null && lightProgress > this.progress) {
              this.progress = lightProgress;
            }
            if (lightDuration != null && lightDuration > 0) {
              this.duration = lightDuration;
            }
          }
        }
      } catch (_) {
        // 静默：轻量进度键缺失或损坏时退回全量态里的进度
      }
    } catch (_) {
      // 静默：全量播放状态损坏时按默认状态启动，不阻断进 App
    }
  }

  /** 轻量进度持久化：几十字节的当前曲+进度，进度时钟专用（见 PROGRESS_KEY） */
  private saveProgressLight(): void {
    try {
      const cur = this.current;
      if (cur == null) return;
      const obj = new UTSJSONObject();
      obj.set("key", this.mediaIdOf(cur));
      obj.set("progress", this.progress);
      obj.set("duration", this.duration);
      uni.setStorageSync(PROGRESS_KEY, JSON.stringify(obj));
    } catch (_) {
      // 静默：轻量进度写失败只影响崩溃恢复精度，下一个时钟周期会重写
    }
  }

  private saveState(): void {
    try {
      const obj = new UTSJSONObject();
      obj.set("mode", this.mode);
      obj.set("quality", this.quality);
      // 听歌统计由 listen-stats 独立存到公共目录；上面的 loadState 只读旧键做迁移。
      if (this.current != null) obj.set("current", songToJson(this.current));
      const queueJson: string[] = [];
      for (let index = 0; index < this.queue.length; index++)
        queueJson.push(songToJson(this.queue[index]));
      obj.set("queue", queueJson);
      obj.set("progress", this.progress);
      obj.set("duration", this.duration);
      // 随机模式「下一首播放」的锁定随播放态一起落盘（2026-10-30）
      if (this.lockedNextMid.length > 0) obj.set("lockedNext", this.lockedNextMid);
      uni.setStorageSync(STATE_KEY, JSON.stringify(obj));
    } catch (_) {
      // 静默：全量态写失败时下次 persist 再试，播放不受影响
    }
  }

  // ==================== 桌面歌词 ====================

  /** 桌面歌词服务注册进度钩子（单订阅；服务自身保证幂等） */
  addDesktopLyricHook(hook: (progress: number) => void): void {
    this.desktopLyricHook = hook;
  }

  removeDesktopLyricHook(): void {
    this.desktopLyricHook = null;
  }

  /**
   * 全量持久化。HISTORY_KEY 与 STATE_KEY 每次都写（历史与播放态是热路径数据，
   * 且 STATE_KEY 是唯一记录当前曲/队列/进度的键，App 退后台被杀前必须落盘）；
   * 三张重表只在脏时写（见 likedDirty 等标记）。
   */
  persist(): void {
    if (this.likedDirty && this.saveSongList(LIKED_KEY, this.likedSongs)) {
      this.likedDirty = false;
    }

    this.saveSongList(HISTORY_KEY, this.history);
    if (this.playlistsDirty) this.savePlaylistList();
    if (this.localPlaylistsDirty) this.saveLocalPlaylistList();
    this.saveState();
    useListenStatsStore().flush();
  }

  /** @internal 供 LikeSyncEngine 落盘收藏总表/歌单表（等同 persist 热路径） */
  persistNow(): void {
    this.persist();
  }

  /** @internal 供 LikeSyncEngine 全量落盘本地歌单表 */
  saveLocalPlaylistsNow(): void {
    this.saveLocalPlaylistList();
  }

  async play(song: Song, queue: Song[] = [], restorePosition = false, auto = false): Promise<void> {
    // 每次播放请求递增；下面快路的 await 之后只认「我还是最新那次」
    this.playSeq += 1;
    const playSeq = this.playSeq;
    // 用户手动发起的播放（点歌/播放全部/手动切歌/按播放续播）重开自动切歌熔断
    if (!auto) {
      this.autoNext = true;
      this.failStreak = 0;
      this.stallRetry = 0;
      this.stalledMap.clear();
      this.pauseIntentAt = 0;
      this.explicitPlayAt = Date.now();
    }
    // 起播耗时基准：playing=true 时据此报一行「起播耗时 Xms」（见 state 回调）
    this.playKickAt = Date.now();
    // 播放全部/外部队列：先剔除被屏蔽的歌（点播的 song 永远保留——
    // 屏蔽语义是「别自动出现」，不是「禁止聆听」）。无规则时原样返回不复制
    if (queue.length > 0) {
      this.queue = useDislikesStore().filterQueue(queue, song);
    }
    const resumeAt = restorePosition && this.progress > 0 ? this.progress : 0;
    const prev = this.current;
    const switched =
      prev == null || prev.id != song.id || prev.platform != song.platform;
    // 「下一首播放」是一次性指示：真换歌就作废（播到了算完成，被手动切走算过期），
    // 与 qt-pc 的 Queue::commit_index 同口径 —— 不清的话旧锁可能在后来的某次
    // 「下一首」上凑巧复活，把用户没指定过的歌顶上来（2026-10-30）
    if (switched) this.lockedNextMid = "";
    if (switched || !restorePosition) this.listenSession.start(this.mediaIdOf(song));
    // 同一首重播（点列表里正在播的歌/队列环绕/切回旧歌）：底层时间线当前条目就是
    // 这首歌时 seek(0)+resume 即可（不重复记历史/播放次数）。不能盲目 seek+resume ——
    // 冷启动后播放器还没建（时间线为空），那样会静默空转「点了没反应」，必须落到
    // 下面的完整推时间线流程（首播簿记 + 建播放器 + 定位）。
    // 但快路会沿用底层条目「上次已解析的旧地址」：这首歌上次解析成在线流（当时下载
    // 还没完成），之后下载完成了，用户「重新播放」期望走本地优先，却被快路锁死在
    // 在线流上（反复报「下载了还是在线」的根源）。所以对在线歌补一次本地复查：
    // 本地能找到就放弃快路，落回下面完整重推（占位符 → 懒解析 → 本地优先命中本地
    // 文件）；找不到/已拉黑/已本地才维持 seek(0)+resume 快路
    if (!switched && !restorePosition && queue.length == 0) {
      if (audioPlayer.currentMediaId() == this.mediaIdOf(song)) {
        let fastReplay = true;
        if (
          song.platform != "local" &&
          localFirstEnabled() &&
          this.localFirstPathOf(song).length == 0 &&
          !this.localFirstFailed.has(this.mediaIdOf(song))
        ) {
          const recheck = await localFileFor(song);
          // 等本地复查的这段时间用户又切了歌：这条请求已经过期，直接放手
          // （新请求会自己走完完整流程；继续跑只会把旧歌顶回当前）
          if (playSeq != this.playSeq) return;
          if (recheck != null && recheck.length > 0) {
            // 本地有货：放弃快路，走完整重推（懒解析命中后点亮本地标签/kbps）
            fastReplay = false;
          }
        }
        if (fastReplay) {
          this.playing = true;
          this.seek(0);
          audioPlayer.resume();
          // 快路是「同一首原地重播」，不是新起播：基准必须在置 playing 之前清掉，
          // 否则状态回调里 `this.playing != playing` 恒 false 永远清不掉基准，
          // 之后用户暂停再播会打出一条跨整段播放的假「起播耗时」（2026-11-02 审阅）
          this.playKickAt = 0;
          return;
        }
      }
    }
    this.current = song;
    this.playing = true;
    // 进度时钟可能已被 stop()/stopForExit() 关掉（清空队列/退出登录后不再重开），
    // 这里幂等补开，保证进度/UI 持续走字；时钟本身开着时 start 是空操作
    this.startProgressClock();
    // 换了歌就丢掉上一首的地址展示副本：它是纯展示用的内存数据，留着只占内存
    //（管理端只看当前播放地址）；同一首重播/重取不清，保证弹窗还能看到地址
    if (switched && this.resolvedUrlMap.size > 0) {
      const keep = this.mediaIdOf(song);
      const keepUrl = this.resolvedUrlMap.get(keep);
      this.resolvedUrlMap.clear();
      if (keepUrl != null) this.resolvedUrlMap.set(keep, keepUrl);
    }
    // 真正换了歌先把旧曲静音：推送新时间线后原生要重新定位+懒解析，这段窗口旧曲
    // 继续响的观感同样是「点了下一首没反应」。同曲重播（refetchAndReplay）和启动
    // 续播（restorePlayback，current 未变）不算切歌，不打断。
    if (switched) audioPlayer.pause();
    this.duration = song.duration != null ? song.duration : 0;
    this.history = [
      song,
      ...this.history.filter(
        (item) => item.id != song.id || item.platform != song.platform
      ),
    ].slice(0, 200);
    // 新的播放请求：允许该歌曲在链接失效时重取地址一次（见 handlePlaybackError）
    this.urlRetryKey = "";
    // 切换真发生在此刻：进度基准重置为新歌起点（或续播点），并给一小段外推窗口，
    // 防止基准重置在原生层生效前的旧位置读数把 progress 重新抬高（会永久冻住）
    this.markProgress(resumeAt);
    this.seekFreezeUntil = Date.now() + 800;
    // 队列推给 media3：条目用 qt-resolve:// 占位地址，真正加载那一刻才向 JS 换
    // 真实播放地址（懒解析）。play() 本身不再取址 —— 切歌瞬时完成；解析失败由
    // 原生 Error → handlePlaybackError 的既有重试/熔断路径兜住
    // 分段各记各的起点（原先四段都减同一个起点，数字互相包含，看不出真正贵在哪段）
    let segMark = Date.now();
    this.pushTimeline(song, resumeAt);
    const segTimeline = Date.now() - segMark;
    segMark = Date.now();
    this.persist();
    const segPersist = Date.now() - segMark;
    segMark = Date.now();
    // 桌面歌词跟随切歌重新拉词
    desktopLyric.notifySongChanged();
    // 封面兜底 + 车机蓝牙歌词同步（⑧/⑩ 批次接线点，详见 syncSongExtras）
    this.syncSongExtras(song);
    const segExtras = Date.now() - segMark;
    segMark = Date.now();
    // 无缝播放：刚起播就顺手把下一首的地址取好 + 整首预取（默认开启，见 audio-player.uts GAPLESS_KEY）
    this.preloadNextUrl();
    const segPreload = Date.now() - segMark;
    // 起播分段耗时：本地歌/在线歌差在哪一段，一眼能看出来（配合「起播耗时」那一行）
    qtDiag(
      "[QT Player] play 分段 时间线=" +
        segTimeline +
        "ms 落盘=" +
        segPersist +
        "ms 附加=" +
        segExtras +
        "ms 预取=" +
        segPreload +
        "ms 直推=" +
        (this.localPathByMid.get(this.mediaIdOf(song)) != null ? "1" : "0") +
        " 起播处=" +
        (this.playKickAt > 0 ? "等原生" : "已播")
    );
  }

  /**
   * 无缝播放：提前把「下一首」准备好 —— 取链 + 整首预取。
   *
   * 两件事：
   * 1. 调 `musicApi.playUrl(next, quality)` 让地址落进 musicApi 的 urlCache
   *    （10 分钟 TTL）。真正切歌时原生发起懒解析，`fetchUrlWithTimeout` 的
   *    取链会立刻命中缓存，省掉整条音源回退链（最坏 9s+）的耗时；
   * 2. 调 `audioPlayer.preloadTrack(占位URI)`（Android）让原生用与播放相同的
   *    数据源栈把整首歌读进 SimpleCache —— 缓存 key 就是 qt-resolve 占位地址，
   *    真正切歌时 CacheDataSource 全量命中磁盘，首字节网络等待也省掉。
   *
   * 为什么**不**提前调 `audioPlayer.resolveDone`：Android 侧 `audioResolveDone`
   * 在 `gPendingResolves` 里没有该 mediaId 的挂起请求时直接丢弃结果
   *（qt-audio-player utssdk/app-android/index.uts），鸿蒙侧同样按单值 gPendingMid
   * 判定；提前回填无效，只能预热地址缓存。
   *
   * 不写任何 UI/播放状态：不改 current、不改 playing、不记历史、不碰时间线。
   * 失败静默（下一首取不到地址时，正常切歌路径会自己重试/熔断）。
   */
  private preloadNextUrl(): void {
    if (!audioPlayer.getGapless()) return;
    if (!this.playing) return;
    const cur = this.current;
    if (cur == null || this.timelineIds.length < 2) return;
    // 播完就停 / 单曲循环都不会走到下一首，没必要取链
    if (this.sleepStopAfterCurrent) return;
    if (this.mode == "single") return;
    const idx = this.timelineIndexOf(cur);
    if (idx < 0) return;
    const nextMid = this.timelineIds[(idx + 1) % this.timelineIds.length];
    // 队列里只有这一首（时间线首尾同一曲）时无事可做
    if (nextMid == this.mediaIdOf(cur)) return;
    // 同一首刚预热过就不重复取（地址 TTL 10 分钟，这里留 5 分钟余量）
    if (nextMid == this.preloadMid && Date.now() - this.preloadAt < PRELOAD_TTL_MS) return;
    const song = this.findSongByMediaId(nextMid);
    if (song == null) return;
    // 本地歌直接推 content:// 播放，不经过取链，无需预热
    if (song.platform == "local") return;
    // 时间线已直推磁盘路径的在线歌同理（见 refreshLocalPathIndex）：预热在线
    // 取链纯属白费，本地文件也不需要预取
    if (this.localPathByMid.has(nextMid)) return;
    this.preloadMid = nextMid;
    this.preloadAt = Date.now();
    // 本地优先预热（DESIGN §7.13）：下一首能在本地找到就直接预热本地文件，
    // 跳过在线取链预热（playUrl 预热取回来也是白费——resolve 回调根本不会用它）
    if (localFirstEnabled() && !this.localFirstFailed.has(nextMid)) {
      localFileFor(song)
        .then((localUrl: string | null) => {
          if (localUrl != null && localUrl.length > 0) {
            audioPlayer.preloadTrack(localUrl);
            return;
          }
          this.warmNextOnlineUrl(song);
        })
        .catch(() => {
          this.warmNextOnlineUrl(song);
        });
      return;
    }
    this.warmNextOnlineUrl(song);
  }

  /** 在线取链预热（playUrl 预热 + 整首占位预取）：本地优先未命中时走这里 */
  private warmNextOnlineUrl(song: Song): void {
    // 命中 urlCache 时 playUrl 内部直接返回，不会重复走网络（音质按平台独立取）
    musicApi.playUrl(song, this.effQualityOf(song)).catch((_e: any) => {});
    // 整首预取：用与时间线条目完全相同的占位地址（= 磁盘缓存 key），原生读完整首
    // 落盘；已缓存的歌这条链路只会从缓存读（开销≈0），本地歌原生侧自动忽略
    audioPlayer.preloadTrack(this.buildTimelineItem(song).uri);
  }

  /** 歌曲的全局唯一键（platform:id）：media3 条目 mediaId 与对账探针都用它 */
  private mediaIdOf(song: Song): string {
    return song.platform + ":" + song.id;
  }

  /**
   * 这首歌最近一次取链拿到的真实地址（管理端「当前播放地址」用，取不到返回空串）。
   * 优先读展示副本，其次把正式音频用过的地址读回来，保证「能在播就一定能看到地址」。
   */
  resolvedUrlOf(song: Song): string {
    if (song == null) return "";
    if (song.url != null && song.url.length > 0) return song.url;
    const v = this.resolvedUrlMap.get(this.mediaIdOf(song));
    if (v != null) return v;
    // 本地优先命中：在线歌播的是磁盘文件、没有在线地址——把命中的本地文件
    // 路径当「最近一次地址」返回，管理端面板才能显示真实在播的路径
    return this.localFirstPathOf(song);
  }

  /**
   * 这首歌**这次实际播放的本地文件**（本地优先命中项，管理端「当前播放地址」用）。
   * 空串 = 这次不是本地优先命中（本地曲目不算：那种 platform 就是 "local"，
   * 地址即 song.url 自身）。
   *
   * 为什么要单独暴露：本地优先命中时在线歌的 platform 还是原平台（kg/qq…），
   * 但音频层播的是磁盘文件、根本没有在线地址——面板只读 resolvedUrlOf 会
   * 把「本地文件路径」当成在线地址展示，还会挂着上一条在线曲目的线路名。
   */
  localFirstPathOf(song: Song): string {
    if (song == null) return "";
    const v = this.localFirstUsed.get(this.mediaIdOf(song));
    return v != null ? v : "";
  }

  /**
   * 本地优先**会话状态**的一句话补充说明（管理端「当前播放地址」弹窗用）：
   * localFirstDiagnose 讲的是「账本/文件层面能不能用」，讲不到「这次为什么还是
   * 走了在线」——那个答案只在播放器会话态里（已直推 / 已回退）。空串=无补充。
   */
  localFirstSessionNote(song: Song): string {
    if (song == null || song.platform == "local") return "";
    const mid = this.mediaIdOf(song);
    if (this.localFirstUsed.has(mid)) return "";
    if (this.localFirstFailed.has(mid)) {
      return "本次会话已回退在线（本地文件起播失败过，重按播放/重开应用会再试）";
    }
    const p = this.localPathByMid.get(mid);
    if (p != null && p.length > 0) return "时间线已直推本地文件，起播即读磁盘";
    if (!localFirstEnabled()) return "本地优先已关闭（走在线取链）";
    return "";
  }

  /**
   * 当前歌曲的**显示封面**：在播本地文件有内嵌封面就用它，否则用曲目自带封面。
   * 播放页/播放条/迷你条统一走这里 —— 本地文件（含本地优先命中的在线歌）判断口径
   * 与 syncSongExtras 一致，不能只看 platform=="local"。
   */
  coverOf(song: Song): string {
    if (song == null) return "";
    if (this.embeddedCover.length > 0 && this.embeddedCoverKey == this.mediaIdOf(song)) {
      return this.embeddedCover;
    }
    return song.picUrl;
  }

  /**
   * 当前歌曲**在播本地文件的内嵌歌词**（空串=文件里没有词，调用方退回在线取词）。
   * 只有一首歌的量：播放页/桌面歌词都在渲染「当前曲」，不需要按歌缓存整张表。
   */
  embeddedLyricOf(song: Song): string {
    if (song == null) return "";
    if (this.embeddedLyricKey == this.mediaIdOf(song)) return this.embeddedLyric;
    return "";
  }

  /**
   * 上一拍内嵌标签读取的诊断（「本地文件地址」弹窗展示用；key 不匹配=空串）。
   * 为什么需要：真机「播得响、有歌词、就是没封面」时分不清是文件本来没图、
   * 封面被截断、还是根本没读到文件 —— 这行文本一次说清（2026-11-02 现场）。
   */
  embeddedDiagOf(song: Song): string {
    if (song == null) return "";
    if (this.embeddedDiagKey.length == 0) return "";
    if (this.embeddedDiagKey != this.mediaIdOf(song)) return "";
    return this.embeddedDiag;
  }

  /** 内嵌标签读取结果 → 一行诊断文本（读了多少字节 / 封面多少字节 / 歌词多少字 / 读了几毫秒） */
  private embeddedDiagText(embedded: EmbeddedReadResult | null, costMs: number): string {
    const tail = costMs > 0 ? "，读耗时 " + costMs + "ms" : "（命中缓存）";
    if (embedded == null) return "内嵌标签：读不到（无标签区，或文件读不开）" + tail;
    let text =
      "内嵌标签：读 " +
      embedded.readBytes +
      "B，封面 " +
      embedded.coverBytes +
      "B，歌词 " +
      embedded.lrcText.length +
      " 字";
    if (embedded.coverBytes == 0) {
      text += "（文件里没有封面，播放页只能显示默认图）";
    } else if (embedded.coverPath.length == 0) {
      text += "（封面已抽出但缓存落盘失败）";
    }
    return text + tail;
  }

  /**
   * 读内嵌标签（带会话级缓存 + 耗时日志）。
   *
   * 这是同步原生调用，一次可能读几 MB：调用方**必须**在起播命令下发之后的
   * 下一拍再调（见 `syncLocalFileMedia` / `syncSongExtras`），否则本地歌起播
   * 会被这段 IO 堵住（2026-11-02 真机定位）。
   */
  private readEmbeddedCached(fileUrl: string): EmbeddedReadResult | null {
    const hit = this.embeddedCache.get(fileUrl);
    if (hit != null) {
      this.embeddedDiagCost = 0;
      return hit;
    }
    const started = Date.now();
    let result: EmbeddedReadResult | null = null;
    // 静默：读不到按「无内嵌」处理（封面走在线、歌词走在线词源）
    try {
      result = readEmbeddedTags(fileUrl);
    } catch (e) {
      result = null;
    }
    const cost = Date.now() - started;
    this.embeddedDiagCost = cost;
    if (cost >= 300) {
      logMsgWarn("[QT Player] 内嵌标签读取耗时 " + cost + "ms：" + fileUrl);
    }
    // 只缓存成功的：读失败多半是文件刚落盘还没同步（下载完成瞬间），下次还能再试
    if (result != null) {
      if (this.embeddedCache.size >= 24) this.embeddedCache.clear();
      this.embeddedCache.set(fileUrl, result);
    }
    return result;
  }

  /** 按 mediaId 找歌：先看当前曲，再查播放队列（懒解析回调只可能要这两处的歌） */
  private findSongByMediaId(mediaId: string): Song | null {
    if (mediaId.length == 0) return null;
    const cur = this.current;
    if (cur != null && cur.platform + ":" + cur.id == mediaId) return cur;
    for (let i = 0; i < this.queue.length; i++) {
      const s = this.queue[i];
      if (s != null && s.platform + ":" + s.id == mediaId) return s;
    }
    return null;
  }

  /** 歌曲在 media3 时间线里的下标（找不到返回 -1） */
  private timelineIndexOf(song: Song): number {
    const mid = this.mediaIdOf(song);
    for (let i = 0; i < this.timelineIds.length; i++) {
      if (this.timelineIds[i] == mid) return i;
    }
    return -1;
  }

  /**
   * 重建本地优先直推索引：下载账本（完成品）逐条原生 stat 确认在盘。
   * 账本一般几条到几十条，stat 是同步本地调用，切歌路径上的开销可忽略。
   * 在 pushTimeline/syncTimeline 组装时间线前各刷一次：下载完成、应用重启
   * （账本持久化而索引是内存态）都能被覆盖到。
   */
  private refreshLocalPathIndex(): void {
    this.localPathByMid.clear();
    // 本地优先关掉时一律在线取链，不做任何直推（开关语义见 DESIGN §7.13）
    if (!localFirstEnabled()) return;
    const items = useDownloadsStore().items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it == null || it.path == null || it.path.length == 0) continue;
      const mid = this.mediaIdOf(it.song);
      // 已拉黑的曲目不再直推（本会话内本地文件起播失败过，交给在线取链）
      if (this.localFirstFailed.has(mid)) continue;
      // 静默：stat 异常按「不在盘」处理，该曲回落在线取链
      try {
        if (statLocalFile(it.path) >= 0) this.localPathByMid.set(mid, it.path);
      } catch (e) {
        logMsgWarn("[QT Player] 直推索引 stat 失败：" + it.path + " " + (e != null ? e.toString() : ""));
      }
    }
  }

  /** 当前曲命中直推索引时的状态对齐：让弹窗/播放页（localFirstPathOf 等）与
   *  「原生时间线已拿到本地地址」保持同一口径，不依赖 resolve 回调（占位地址
   *  都不会上引擎，回调自然不存在）。返回是否命中。 */
  private adoptLocalPathIfIndexed(s: Song | null): boolean {
    if (s == null) return false;
    const mid = this.mediaIdOf(s);
    const path = this.localPathByMid.get(mid);
    if (path == null || path.length == 0) return false;
    this.resolvedUrlMap.set(mid, path);
    this.localFirstUsed.set(mid, path);
    if (s.url == null || s.url != path) s.url = path;
    this.syncLocalFileMedia(s, path);
    this.localFirstTick++;
    return true;
  }

  /**
   * 时间线条目构建（pushTimeline / syncTimeline 共用）。
   *
   * 注意：这里**不算**收藏态（liked）—— 逐条算要把 likedSongs 全表扫一遍，
   * 入队就成了 O(队列×收藏总表)。条目统一带「未收藏」样式，真实红心由
   * refreshNativeRating() 在切歌/重推后对当前曲单独回写。
   */
  private buildTimelineItem(s: Song): AudioPlaylistItem {
    const mid = this.mediaIdOf(s);
    // 本地歌直接推真实 content:// 地址：DefaultDataSource 按 scheme 路由到
    // ContentDataSource，不经过懒解析层也不进音频缓存（避免把本地文件再拷一份）。
    // 在线歌优先直推下载成品（refreshLocalPathIndex 确认在盘）：本地路径由
    // DefaultDataSource 路由到 FileDataSource，绕开懒解析层（HTTP 上游喂本地
    // 路径必败，2026-11-02 真机定位）。占位地址 q 仅调试用，实际音质由 resolve
    // 回调经 effQualityOf 按歌的平台现取（平台独立档位 + 全局默认回落），
    // 换音质后尚未加载的条目自动用新档。
    let uri = "";
    if (s.platform == "local" && s.url != null && s.url.length > 0) {
      uri = s.url;
    } else {
      const localPath = this.localPathByMid.get(mid);
      if (localPath != null && localPath.length > 0) uri = localPath;
    }
    if (uri.length == 0) {
      uri = "qt-resolve://song/?mid=" + encodeURIComponent(mid) + "&q=" + this.effQualityOf(s);
    }
    const item: AudioPlaylistItem = {
      mediaId: mid,
      uri: uri,
      title: s.name,
      artist: s.singer,
      album: s.album,
      coverUrl: s.picUrl,
      duration: s.duration != null ? s.duration : 0,
    };
    return item;
  }

  /**
   * 把整条队列推给 media3 并定位到 song（懒解析占位地址）。
   * 顺序/单曲模式按队列原序；随机模式把队列洗牌成新的播放顺序（当前曲放首位），
   * 「下一首」由时间线顺序决定 —— 随机语义完全由 JS 侧控制，原生只管顺序衔接。
   * 循环模式同步映射给原生：单曲→REPEAT_ONE，列表循环/随机→列表环绕。
   * 队列里找不到 song 时（恢复场景队列丢失等）用单条时间线兜底。
   */
  private pushTimeline(song: Song, resumeAt: number): void {
    // 本地优先直推索引重建（DESIGN §7.13）：本轮时间线里已下载且在盘的在线歌
    // 直接推磁盘路径，绕开懒解析层（其上游是 HTTP 数据源，喂本地路径必败）
    this.refreshLocalPathIndex();
    // 重推时间线后 loader 会把位置直接跳到新起播点：这段位移不是「播放前进」，
    // 抑制窗口内一律不计入 healthyRun（否则重取地址会被误判成播放成功，见 onTime）
    this.healthyRun = 0;
    this.healthyIgnoreUntil = Date.now() + 3000;
    // 带播放意图的重推 = 起播请求：记下时刻，供进度时钟的向下对账在原生
    // 懒解析/准备窗口内放行（见 PLAY_START_GRACE_MS 与 activeProbeMisses 分支）。
    // 冷启动首播走的就是这条路（播放器尚未建立，ensurePlayback 落到 play()）。
    if (this.playing) this.playRequestedAt = Date.now();
    // 不喜欢列表：时间线剔除被屏蔽的歌，song（点播曲）永远保留。
    // 必须先过滤再找 curIdx——过滤会让索引前移，先找后滤会定位到错的歌
    const dislikes = useDislikesStore();
    let source =
      dislikes.hasRules() ? dislikes.filterQueue(this.queue, song) : this.queue;
    let curIdx = -1;
    for (let i = 0; i < source.length; i++) {
      const item = source[i];
      if (item != null && item.id == song.id && item.platform == song.platform) {
        curIdx = i;
        break;
      }
    }
    if (curIdx < 0) {
      source = [song];
      curIdx = 0;
    }
    const order: number[] = [];
    for (let i = 0; i < source.length; i++) order.push(i);
    let startIndex = curIdx;
    if (this.mode == "random") {
      // Fisher-Yates 洗牌后把当前曲换到首位：原生自动衔接从「当前曲的下一项」走，
      // 当前曲在首位衔接起点才正确
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
      }
      let at = 0;
      for (let i = 0; i < order.length; i++) {
        if (order[i] == curIdx) {
          at = i;
          break;
        }
      }
      if (at > 0) {
        const tmp = order[0];
        order[0] = order[at];
        order[at] = tmp;
      }
      // 「下一首播放」锁定：洗牌会把锁定的那首甩到序列任意位置，原生衔接就不听
      // 指挥了——这里把它固定换到当前曲之后（下标 1），随机模式下「下一首」才真的
      // 是用户点的那首（2026-10-30 用户反馈）
      if (this.lockedNextMid.length > 0 && order.length > 1) {
        let lockAt = -1;
        for (let i = 1; i < order.length; i++) {
          const s = source[order[i]];
          if (s != null && this.mediaIdOf(s) == this.lockedNextMid) {
            lockAt = i;
            break;
          }
        }
        if (lockAt > 1) {
          const keep = order[1];
          order[1] = order[lockAt];
          order[lockAt] = keep;
        }
      }
      startIndex = 0;
    }
    this.timelineIds = [];
    const items: AudioPlaylistItem[] = [];
    for (let i = 0; i < order.length; i++) {
      const s = source[order[i]];
      if (s == null) continue;
      this.timelineIds.push(this.mediaIdOf(s));
      items.push(this.buildTimelineItem(s));
    }
    // 循环模式映射：单曲循环原生 REPEAT_ONE（循环重启的位置回跳由进度时钟识别）；
    // 列表循环/随机 → 列表环绕（随机的顺序来自洗牌时间线）。
    // 必须放在 setPlaylist 之后：首播时播放器由 setPlaylist 内部引导创建，
    // 先设 repeat 会打在 null 上静默丢失，整轮播放退化为不循环
    // 本地优先直推命中当前曲：状态对齐（resolvedUrlMap/song.url/内嵌媒体/版本号），
    // 让弹窗与播放页立即显示「本地文件」，不依赖取链回调（直推时根本没有回调）
    this.adoptLocalPathIfIndexed(song);
    audioPlayer.setPlaylist(items, startIndex, true, resumeAt);
    audioPlayer.setRepeatMode(this.mode == "single" ? 1 : 2);
  }

  /**
   * 队列编辑（追加/删除/排序）后的无损时间线同步：不打断当前播放。
   * 顺序/单曲模式按队列原序对齐；随机模式保持已洗好的顺序，只做增（队尾）/删，
   * 避免重排打乱正在进行的随机序列。播放器还没时间线（没播过/已清空）时跳过，
   * 下次 play() 自然整条重推。
   */
  syncTimeline(): void {
    if (this.current == null) return;
    if (this.timelineIds.length == 0) return;
    // 本地优先直推索引重建（见 pushTimeline 同款注释）：队列编辑、屏蔽规则变化、
    // 下载完成后重推，也要让已下载且在盘的歌回到磁盘路径
    this.refreshLocalPathIndex();
    let expected: Song[] = [];
    if (this.mode == "random") {
      // 旧时间线里仍在队列的按原顺序保留（随机序列不重排），不在的（已删）自然剔除
      for (let i = 0; i < this.timelineIds.length; i++) {
        const s = this.findSongByMediaId(this.timelineIds[i]);
        if (s != null) expected.push(s);
      }
      // 队列里有而时间线没有的（新加的）追加到队尾
      for (let i = 0; i < this.queue.length; i++) {
        const s = this.queue[i];
        if (s != null && this.timelineIndexOf(s) < 0) expected.push(s);
      }
      // 兜底与顺序分支同口径：当前曲不在组装结果里（异常态/绕过页面守卫的
      // 编辑路径）也要留在时间线上，否则原生衔接丢锚
      if (this.timelineIndexOf(this.current) < 0) expected.push(this.current);
    } else {
      for (let i = 0; i < this.queue.length; i++) {
        const s = this.queue[i];
        if (s != null) expected.push(s);
      }
      // 兜底：当前曲不在队列（异常态）也要留在时间线上，否则原生衔接丢锚
      if (this.timelineIndexOf(this.current) < 0) expected.push(this.current);
    }
    // 不喜欢列表：规则变化触发的重推走这里（restore 里的 DISLIKES_CHANGED_EVENT
    // 订阅），剔除新命中屏蔽的歌——包括上面「队列新增追加」分支可能带回来的。
    // 当前曲永远保留：屏蔽的是「自动出现」，正在播的不掐断
    const dislikes = useDislikesStore();
    if (dislikes.hasRules()) {
      const cur = this.current!;
      const kept: Song[] = [];
      for (let i = 0; i < expected.length; i++) {
        const s = expected[i];
        if (s.id == cur.id && s.platform == cur.platform) {
          kept.push(s);
          continue;
        }
        if (!dislikes.isDisliked(s)) kept.push(s);
      }
      expected = kept;
    }
    if (expected.length == 0) return;
    this.placeLockedNextAfterCurrent(expected);
    this.timelineIds = [];
    const items: AudioPlaylistItem[] = [];
    for (let i = 0; i < expected.length; i++) {
      const s = expected[i];
      if (s == null) continue;
      this.timelineIds.push(this.mediaIdOf(s));
      items.push(this.buildTimelineItem(s));
    }
    audioPlayer.syncTimeline(items, this.mediaIdOf(this.current));
    // 重推的条目带的是「未收藏」样式（buildTimelineItem 不算收藏态，见其注释），
    // 当前曲的红心必须重算回写，否则编辑一次队列图标就凭空变空
    // 直推命中当前曲时同步对齐展示状态（resolvedUrlMap/song.url/内嵌媒体/版本号）
    this.adoptLocalPathIfIndexed(this.current);
    this.refreshNativeRating();
  }

  /**
   * 「下一首播放」锁定的那首必须紧挨当前曲之后（时间线重排的收口点）。
   *
   * 随机的播放顺序是洗好的乱序序列，原生按序列衔接；只把歌插进队列，它落到序列
   * 哪一格就听天由命了。单曲循环则是原生 REPEAT_ONE 原地重播，压根走不到下一项。
   * 队列编辑、屏蔽规则变化、重新推时间线都会重排序列，所以统一在这里把锁定的条目
   * 挪到当前曲后一位（2026-10-30 用户反馈「随机播放时点了下一首播放，实际播的
   * 不是它」）。
   */
  private placeLockedNextAfterCurrent(expected: Song[]): void {
    if (this.lockedNextMid.length == 0) return;
    if (this.mode == "sequence") return;
    const cur = this.current;
    if (cur == null) return;
    const curMid = this.mediaIdOf(cur);
    let curAt = -1;
    let lockAt = -1;
    for (let i = 0; i < expected.length; i++) {
      const s = expected[i];
      if (s == null) continue;
      const mid = this.mediaIdOf(s);
      if (mid == curMid) curAt = i;
      else if (mid == this.lockedNextMid) lockAt = i;
    }
    if (curAt < 0 || lockAt < 0 || lockAt == curAt + 1) return;
    const locked = expected[lockAt];
    expected.splice(lockAt, 1);
    // 摘掉的那位在当前曲之前时，当前曲下标要前移一格（splice 之后才准）
    const at = lockAt < curAt ? curAt - 1 : curAt;
    expected.splice(at + 1, 0, locked);
  }

  /**
   * 取播放地址并限时：超时按空地址返回。
   * 超时后原始请求仍在跑，成功时 URL 会落进 musicApi 的地址缓存，
   * 下一次（自动切歌到这首、或用户重播）能直接命中，不算白跑。
   *
   * `stalled` 区分两种「拿不到地址」（2026-10-03 弱网修复）：
   * - true  = **限时到了**（网络慢/引擎卡）→ 环境问题，不该记为「这首歌坏了」；
   * - false = 引擎在预算内明确回了「没有地址」→ 内容问题。
   * 过去两者都返回空串，于是弱网时每首都被当成坏歌、连挂5 首打满熔断，
   * 自动切歌一关就再也回不来（用户反馈「网络质量差一点就疯狂不可用」）。
   */
  private fetchUrlWithTimeout(
    song: Song,
    ms: number,
  ): Promise<{ url: string; stalled: boolean }> {
    return new Promise<{ url: string; stalled: boolean }>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 超时 = 环境问题
        resolve({ url: "", stalled: true });
      }, ms) as number;
      musicApi
        .playUrl(song, this.effQualityOf(song))
        .then((url: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 拿到地址 = 内容没问题（music-api 对失败只会抛错，不会再返回空串）
          resolve({ url: url, stalled: false });
        })
        .catch((e: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 抛错分流（与 music-api resolvePlayUrl 的弱网修复对齐，2026-10-03）：
          // 弱网/引擎卡抛「网络较慢」→ stalled:true（环境问题，原地退避重试、
          // 不计熔断）；内容失败抛「该歌曲暂时无法播放」→ stalled:false（坏歌，
          // 走重取/自动切歌路径）。性质由异常对象本身携带，不读全局标记——
          // 取链是并发的（换音质重取/恢复探测/下载会同时跑），全局标记会被
          // 别的调用的结果串味，把弱网误判成坏歌而消耗熔断额度。
          resolve({ url: "", stalled: !isContentFailError(e) });
        });
    });
  }

  /**
   * 点击单首歌曲：播放这一首，并只把这一首追加到播放队列（按 id+platform 去重），
   * 不替换整个队列。「播放全部」才替换整体队列（见各页 playAll）。
   */
  async playSingle(song: Song): Promise<void> {
    const dup = this.queue.findIndex(
      (item) => item.id == song.id && item.platform == song.platform
    );
    if (dup < 0) {
      this.queue = [...this.queue, song];
    }
    await this.play(song);
  }

  /**
   * 播放时缺封面则查询并回填：写入 current / queue / 所属本地歌单，并持久化。
   * 不阻塞播放，封面取到后再刷新 UI。
   */
  /** 封面回填：写 Song 本体/当前歌/队列/所在歌单 + 收藏表脏标记 + 落盘（网络回填与本地内嵌封面共用路径） */
  private applyCover(song: Song, cover: string): void {
    if (cover.length == 0) return;
    song.picUrl = cover;
    // 响应式对象（current / queue）赋值会触发播放页/列表刷新
    const cur = this.current;
    if (cur != null && cur.id == song.id && cur.platform == song.platform) {
      cur.picUrl = cover;
    }
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      if (q.id == song.id && q.platform == song.platform) {
        q.picUrl = cover;
        break;
      }
    }
    // 同步回本地歌单，让歌单列表里的封面也补上
    const containing = this.getPlaylistsContainingSong(song);
    for (let i = 0; i < containing.length; i++) {
      const pl = containing[i];
      if (pl.tracks) {
        for (let j = 0; j < pl.tracks.length; j++) {
          const t = pl.tracks[j];
          if (t.id == song.id && t.platform == song.platform) {
            t.picUrl = cover;
          }
        }
      }
    }
    // song 可能是收藏总表里那条记录本身，封面回填后同样要落盘；
    // 这条路径每首歌至多走一次（首次播放且缺封面），多写一次的代价可忽略
    this.likedDirty = true;
    this.persist();
  }

  private backfillCover(song: Song): void {
    musicApi
      .songCover(song)
      .then((cover: string) => {
        if (cover != null && cover.length > 0) this.applyCover(song, cover);
      })
      .catch(() => {});
  }

  /**
   * 本地优先命中（在线歌播磁盘文件）后补读内嵌标签。为什么不在 syncSongExtras 里做：
   * 那一刻 song.url 还是在线流地址（本地地址是取链回调里异步回写的），读不到标签区。
   * 内嵌封面/歌词只登记「显示用」（coverOf / embeddedLyricOf），不写回 song.picUrl。
   * 只在目标确为当前曲时生效（时间线直推会把非当前曲的地址提前写好，不能抢跑）。
   */
  private syncLocalFileMedia(song: Song, fileUrl: string): void {
    // 关键：本函数在 `pushTimeline` 里被 `adoptLocalPathIfIndexed` 调，位置就在
    // `audioPlayer.setPlaylist(...)` **之前**。内嵌标签解析是同步原生 IO（可能读
    // 几 MB），同步做在这里等于把「推时间线 → 原生起播」整条路堵住 —— 这就是
    // 「本地歌起播 5 秒、纯在线 1-2 秒」的真凶（2026-11-02 真机）。
    // 所以推到下一拍：起播命令先发出去，标签解析随后补上（封面/歌词晚一帧到）。
    const mediaId = this.mediaIdOf(song);
    const cur = this.current;
    if (cur == null || this.mediaIdOf(cur) != mediaId) return;
    setTimeout((): void => {
      const now = this.current;
      if (now == null || this.mediaIdOf(now) != mediaId) return;
      const embedded = this.readEmbeddedCached(fileUrl);
      this.applyLocalFileMedia(mediaId, embedded);
    }, 0);
  }

  /** 内嵌标签落地（封面/歌词/车机歌词 + 诊断）；延迟读取与缓存命中共用 */
  private applyLocalFileMedia(mediaId: string, embedded: EmbeddedReadResult | null): void {
    this.embeddedDiag = this.embeddedDiagText(embedded, this.embeddedDiagCost);
    this.embeddedDiagKey = mediaId;
    if (embedded == null) return;
    if (embedded.coverPath.length > 0) {
      this.embeddedCover = embedded.coverPath;
      this.embeddedCoverKey = mediaId;
    }
    if (embedded.lrcText.length > 0) {
      this.embeddedLyric = embedded.lrcText;
      this.embeddedLyricKey = mediaId;
      // 词源换成本地文件里那份：作废已装载的在线词并重拉（歌曲 key 没变，
      // notifySongChanged 会被 loadedKey 短路，必须用这个入口）
      desktopLyric.notifyLyricChanged();
    }
    // 车机蓝牙歌词也换成本地文件里那份（在线歌走本地文件时同样适用）
    audioPlayer.setCarLyric(embedded.lrcText);
  }

  /**
   * 切歌后的原生附加同步（⑧/⑩ 批次接线点，两个起播路径共用）：
   * ① 内嵌优先 —— 在播本地文件（本地曲目 / 下载歌 / 本地优先命中的在线歌）自带
   *    封面与歌词时，登记到 embeddedCover/embeddedLyric，播放页与桌面歌词先用它，
   *    没有内嵌才走在线；
   * ② 封面兜底 —— 缺网络封面时：本地歌曲优先读文件内嵌封面（下载写入侧已在
   *    APIC/PICTURE 落盘），读不到再走网络回填（服务器同步来的收藏等场景）；
   * ③ 车机蓝牙歌词（AVRCP "android.media.metadata.LYRICS"）—— 本地歌曲用内嵌
   *    歌词（无词清空）；在线歌曲等取址预取（musicApi.playUrl → prefetchLyric）
   *    落地后异步补推，预取与 lyrics() 共用同一份缓存/inflight，不会重复请求。
   */
  private syncSongExtras(song: Song): void {
    // 内嵌读取只对本地文件有意义（在线歌曲 url 是流地址，没有标签区可读）。
    // 「本地文件」的判定不能只看 platform=="local"：已下载歌曲离线播放时，播放器
    // 会把落盘路径写回 song.url，而 platform 仍是 qq/netease（downloads.ts 的
    // isRemoteUrl 同款判定），漏了它们会让下载歌在车机上丢歌词/丢内嵌封面。
    const songUrl = song.url;
    const isLocalFile =
      songUrl != null &&
      songUrl.length > 0 &&
      songUrl.toLowerCase().indexOf("http://") != 0 &&
      songUrl.toLowerCase().indexOf("https://") != 0;
    // 切歌先清空内嵌状态：宁可这一拍先显示在线封面，也不能让上一首的内嵌串过来
    this.embeddedCover = "";
    this.embeddedCoverKey = "";
    this.embeddedLyric = "";
    this.embeddedLyricKey = "";
    this.embeddedDiag = "";
    this.embeddedDiagKey = "";
    this.embeddedDiagCost = 0;
    if (!isLocalFile) {
      // 在线歌：没有标签区可读，封面缺就网络回填，车机歌词等 lyrics 落地再推
      if (song.picUrl == null || song.picUrl.length == 0) this.backfillCover(song);
      musicApi
        .lyrics(song)
        .then((text: string) => {
          audioPlayer.setCarLyric(text);
        })
        .catch(() => {});
      return;
    }
    // 本地文件：上一首的车机歌词先清掉，标签解析推到下一拍再做。
    // 同步读要读几 MB（还可能要放大窗口重读），堵在这里会把起播与取链回调一起
    // 拖慢 —— 「本地歌起播 5 秒、纯在线 1-2 秒」就是它（2026-11-02 真机）
    audioPlayer.setCarLyric("");
    const mediaId = this.mediaIdOf(song);
    setTimeout((): void => {
      const now = this.current;
      if (now == null || this.mediaIdOf(now) != mediaId) return;
      const embedded = this.readEmbeddedCached(songUrl);
      // 内嵌优先（文件里自带的那份最准，也省掉同一首歌的在线请求）；
      // 只登记「显示用」，不写回 song.picUrl —— 那会被收藏同步带上服务端（like-sync.ts:121）
      this.applyLocalFileMedia(mediaId, embedded);
      if (song.picUrl == null || song.picUrl.length == 0) {
        if (embedded != null && embedded.coverPath.length > 0) {
          this.applyCover(song, embedded.coverPath);
        } else {
          this.backfillCover(song);
        }
      }
    }, 0);
  }

  recordPlay(song: Song): void {
    // 兼容已有调用方：开始一轮收听，真正推进后才由会话判定次数。
    this.listenSession.start(this.mediaIdOf(song));
  }

  playCount(song: Song): number {
    const key = song.platform + ":" + song.id;
    const record = useListenStatsStore().songs.find((row) => row.song.platform + ":" + row.song.id == key);
    const value = record != null ? record.count : this.playCounts.get(key);
    return value != null ? value : 0;
  }

  topPlayed(limit: number): Song[] {
    const songs = this.history;
    const pairs: { song: Song; count: number }[] = [];
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i] as Song | null;
      // 持久化数据可能带出空条目，统计页模板直接读 song.id 会崩，这里先过滤
      if (song == null || song.id == null || song.id.length == 0) continue;
      pairs.push({ song, count: this.playCount(song) });
    }
    pairs.sort((a, b) => b.count - a.count);
    const result: Song[] = [];
    for (let i = 0; i < pairs.length && i < limit; i++) {
      if (pairs[i].count > 0) result.push(pairs[i].song);
    }
    return result;
  }

  private async ensurePlayback(): Promise<void> {
    if (this.current == null) return;
    // 手动按播放 = 明确意图：重开自动切歌熔断，消化掉之前的暂停意图
    this.autoNext = true;
    this.failStreak = 0;
    this.stallRetry = 0;
    this.stalledMap.clear();
    this.pauseIntentAt = 0;
    // 时间线在 media3 上，地址加载那一刻才懒解析 —— 不存在「URL 过期续播失败」，
    // 不用再预取地址。底层当前条目就是这首歌：直接恢复播放意图；没有时间线或
    // 当前条目对不上（热退出/进程重建后点播放、切歌失败停在别曲）按当前曲重推，
    // restorePosition 让播放从上次进度续播
    if (audioPlayer.currentMediaId() == this.mediaIdOf(this.current)) {
      // 恢复播放意图同样是起播请求：原生播放器若已被拆掉（热退出/进程重建），
      // audioResume 会走 audioPlay 整体重建，起播窗口与冷启动首播一样长，
      // 需要同一段宽限（见 PLAY_START_GRACE_MS）
      this.playRequestedAt = Date.now();
      audioPlayer.resume();
      return;
    }
    await this.play(this.current, [], true, false);
  }

  toggle(): void {
    if (this.current == null) return;
    this.playing = !this.playing;
    if (this.playing) {
      this.pauseIntentAt = 0;
      this.playRequestedAt = Date.now();
      this.ensurePlayback();
    } else {
      this.pauseIntentAt = Date.now();
      this.playRequestedAt = 0;
      // 明确暂停：在飞的取链不再具有「即将起播」含义，连同标记一起撤掉
      this.resolveInFlightMid = "";
      audioPlayer.pause();
    }
    this.persist();
  }

  pause(): void {
    this.listenSession.resetSample();
    if (this.current == null) return;
    this.playing = false;
    this.pauseIntentAt = Date.now();
    this.playRequestedAt = 0;
    this.resolveInFlightMid = "";
    audioPlayer.pause();
    this.persist();
  }

  /** 系统自动暂停（弱网重试打满/熔断停住）：与用户暂停区分，不记暂停意图，
      否则恢复探测会误判「用户不想听」而不自动重放 */
  private autoPause(): void {
    this.listenSession.resetSample();
    this.playing = false;
    this.playRequestedAt = 0;
    this.resolveInFlightMid = "";
    audioPlayer.pause();
    this.persist();
  }

  resume(): void {
    this.listenSession.resetSample();
    if (this.current == null) return;
    this.playing = true;
    this.playRequestedAt = Date.now();
    this.ensurePlayback();
    this.persist();
  }

  stop(): void {
    this.listenSession.start("");
    this.stopProgressClock();
    this.current = null;
    this.queue = [];
    this.playing = false;
    // 停播：起播宽限与在飞取链一并作废，否则下一次冷启动首播前的对账会被旧宽限压制
    this.playRequestedAt = 0;
    this.resolveInFlightMid = "";
    this.timelineIds = [];
    // 清空播放态 → 「下一首播放」的锁也没有意义了（2026-10-30）
    this.lockedNextMid = "";
    this.markProgress(0);
    this.duration = 0;
    audioPlayer.stop();
    this.persist();
  }

  /**
   * 双击返回退出应用前的停播：停掉音频、撤掉媒体通知，但保留 current/queue/progress
   * 并持久化——下次冷启动 restorePlayback 能恢复「上次听到哪」。不能用 stop()：
   * 那会清空播放状态并持久化空态，重启后悬浮球和续播就都没了（后台退出进程不死所以无感）。
   */
  stopForExit(): void {
    this.listenSession.resetSample();
    this.stopProgressClock();
    this.playing = false;
    this.playRequestedAt = 0;
    this.resolveInFlightMid = "";
    audioPlayer.stop();
    this.persist();
  }

  /** 清理本地音乐数据：停播并清空内存与持久化数据，等待听歌统计落盘；
      收藏同步游标/待同步队列一并复位，避免残留操作被重放到服务器。
      播放设置和下载记录保持原值，其余页面级数据由调用方清理。 */
  async resetLocalData(): Promise<void> {
    this.stop();
    this.likedSongs = [];
    this.history = [];
    this.savedPlaylists = [];
    this.localPlaylists = [];
    this.likedDirty = true;
    this.playlistsDirty = true;
    this.localPlaylistsDirty = true;
    this.playCounts = new Map<string, number>();
    this.defaultFavPlaylistId = "";
    this.likeCursor = 0;
    this.pendingOps = [];
    this.persist();
    await useListenStatsStore().clear();
  }

  next(auto: boolean = false): void {
    logMsg(
      "[QT Media] next() auto=" + auto +
      " mode=" + this.mode +
      " queue=" + this.queue.length +
      " cur=" + (this.current != null ? this.current.platform + ":" + this.current.id : "null")
    );
    if (this.current == null) return;
    if (auto && this.sleepStopAfterCurrent) {
      this.sleepStopAfterCurrent = false;
      this.exitAfterSleep();
      return;
    }
    // 单曲循环但用户指定了「下一首播放」时不进这段原地重播（2026-10-30）：
    // 锁要抢在 repeat-one 前面，见下面的锁定分支
    if (this.mode == "single" && auto && this.lockedNextMid.length == 0) {
      this.listenSession.start(this.mediaIdOf(this.current!));
      // 单曲循环且播完自动重播：走 store 的 seek（同步写进度 + 冻结窗口），
      // 否则原生位置回跳到 0 会被「小幅倒退」过滤吞掉，进度条会一直停在末尾。
      // 手动点「下一首」不能走这里——重播同曲听不出任何变化，等于「下一首无反应」；
      // 单曲循环只该约束自动切歌，手动切歌必须真的换下一首。
      this.seek(0);
      audioPlayer.resume();
      return;
    }
    if (this.queue.length == 0) return;
    let index = this.queue.findIndex(
      (item) =>
        item.id == this.current!.id && item.platform == this.current!.platform
    );
    if (index < 0) index = 0;
    // 不喜欢列表：手动切歌跳过被屏蔽的歌。自动衔接不走这里（原生按已过滤的
    // 时间线走），这段只管「下一首」按钮；全被屏蔽时退回当前曲（play 同曲
    // 分支重播，绝不空转）
    const dislikes = useDislikesStore();
    // 「下一首播放」优先于任何模式：随机不该掷骰、单曲循环也先播它一次 ——
    // 用户显式指定的顺序压过模式规则（2026-10-30 用户反馈随机模式不生效）
    if (this.lockedNextMid.length > 0) {
      const locked = this.findSongByMediaId(this.lockedNextMid);
      this.lockedNextMid = "";
      if (locked != null && !dislikes.isDisliked(locked)) {
        this.play(locked, [], false, auto);
        return;
      }
    }
    if (this.mode == "random") {
      if (this.queue.length == 1) index = 0;
      else if (dislikes.hasRules()) {
        const playable: number[] = [];
        for (let i = 0; i < this.queue.length; i++) {
          if (i == index) continue;
          if (!dislikes.isDisliked(this.queue[i])) playable.push(i);
        }
        // 除当前曲外全被屏蔽时保留 index（当前曲重播），不空转
        if (playable.length > 0) {
          index = playable[Math.floor(Math.random() * playable.length)];
        }
      } else {
        let random = Math.floor(Math.random() * this.queue.length);
        if (random == index) random = (random + 1) % this.queue.length;
        index = random;
      }
    } else if (dislikes.hasRules()) {
      // 列表循环模式：循环扫描下一个未屏蔽的；扫完一轮全屏蔽则停在当前曲（重播）
      let target = index;
      for (let step = 1; step < this.queue.length; step++) {
        const cand = (index + step) % this.queue.length;
        if (!dislikes.isDisliked(this.queue[cand])) {
          target = cand;
          break;
        }
      }
      index = target;
    } else {
      index = (index + 1) % this.queue.length;
    }
    const target = this.queue[index];
    const cur = this.current;
    if (cur != null && target.id == cur.id && target.platform == cur.platform) {
      logMsg("[QT Media] next() 目标仍是当前曲 → 重头播（play 同曲分支处理）");
    }
    // auto 透传：自动切歌时解析失败要继续往下切，手动点「下一首」则停住提示。
    // 同曲重播不再单独 seek+resume —— play() 的同曲分支已按「时间线是否已加载」分流
    this.play(target, [], false, auto);
  }

  /**
   * 原生切歌对账：media3 自动衔接下一首（时间线顺序）、媒体键/通知栏切歌、
   * 点选定位跳转都会触发。同曲（单曲循环重启、同曲重定位、play() 自身推送后的
   * 定位事件）直接忽略；真换歌时做 store 侧切歌簿记：换 current、进度归零、
   * 记历史/播放次数、刷新歌词与封面。
   * 睡眠定时「当前歌播完停止」也在这里落地：懒解析窗口里原生切歌无声，
   * 立即停播退出，听感就是「这首歌放完就停」。
   */
  private onNativeTrackChanged(mediaId: string, naturalEnd: boolean): void {
    const song = this.findSongByMediaId(mediaId);
    if (song == null) return;
    const cur = this.current;
    // 「下一首播放」一次性指示：真换歌就收（顺着时间线衔接到锁定的那首 = 完成，
    // 被别的路径带到别处 = 过期）。同曲事件（重定位/单曲重播）必须放行，否则一次
    // seek 就把锁冲掉了。单曲循环为走到它临时放开过循环，播到后按模式收回（2026-10-30）
    if (this.lockedNextMid.length > 0) {
      const switchedTo =
        cur == null || cur.id != song.id || cur.platform != song.platform;
      if (switchedTo) {
        if (this.lockedNextMid == mediaId && this.mode == "single") this.syncRepeatMode();
        this.lockedNextMid = "";
      }
    }
    const suppressNaturalFinish = naturalEnd && this.skipNextNativeTransitionAt > 0 && Date.now() - this.skipNextNativeTransitionAt < 2000;
    if (suppressNaturalFinish) this.skipNextNativeTransitionAt = 0;
    // 同曲事件（单曲循环/环绕重启条目）不做簿记；但若这轮是「自然播到头」而
    // 位置离末尾还远 = 内容提前结束，先自愈重放（见 tryRecoverEarlyEnd）
    if (cur != null && cur.id == song.id && cur.platform == song.platform) {
      if (naturalEnd && this.endedTooEarly(cur)) {
        if (this.tryRecoverEarlyEnd(cur)) return;
      }
      if (naturalEnd) {
        if (suppressNaturalFinish) {
          this.markProgress(0);
        } else {
          this.skipNextEndedAt = Date.now();
          this.finishListenSession();
          this.listenSession.start(mediaId);
          this.markProgress(0);
        }
        this.seekFreezeUntil = Date.now() + 800;
      }
      return;
    }
    // 手动点歌后原生仍可能送达旧时间线在途的 trackChanged（A≠B 即采信会把
    // current 短暂拉回旧歌，多记一条历史/播放次数）：点歌后短窗口内与当前
    // 选曲不符的事件一律丢弃；窗口之外的同名事件是正常的原生自动衔接。
    // 跨桥在途事件毫秒级送达，2.5s 窗口绰绰有余；正常自动衔接最快也在
    // 一首歌时长之后，不会误伤。
    if (cur != null && Date.now() - this.explicitPlayAt < 2500) {
      logMsg("[QT Media] 忽略迟到的原生切歌事件 → " + mediaId);
      return;
    }
    // 原生自动衔接（naturalEnd）但上一首的位置离末尾还远 = 上一首内容提前
    // 结束（流被截断/缓存投毒，media3 视为正常播完，无停顿无错误事件），
    // 先清缓存从原位置重放上一首；重放仍提前结束就放行正常衔接
    if (cur != null && naturalEnd && this.endedTooEarly(cur)) {
      if (this.tryRecoverEarlyEnd(cur)) return;
    }
    if (naturalEnd && !suppressNaturalFinish) {
      this.skipNextEndedAt = Date.now();
      this.finishListenSession();
    }
    this.listenSession.start(mediaId);
    logMsg("[QT Media] 原生切歌 → " + mediaId);
    this.current = song;
    this.playing = true;
    // 同 play()：原生自动衔接下一首也丢掉上一首的地址展示副本（纯展示用，见 resolvedUrlMap）
    if (this.resolvedUrlMap.size > 0) {
      const keepUrl = this.resolvedUrlMap.get(mediaId);
      this.resolvedUrlMap.clear();
      if (keepUrl != null) this.resolvedUrlMap.set(mediaId, keepUrl);
    }
    this.duration = song.duration != null ? song.duration : 0;
    this.markProgress(0);
    this.seekFreezeUntil = Date.now() + 800;
    this.history = [
      song,
      ...this.history.filter(
        (item) => item.id != song.id || item.platform != song.platform
      ),
    ].slice(0, 200);
    this.urlRetryKey = "";
    this.persist();
    desktopLyric.notifySongChanged();
    // 通知栏/车机 ♡ 状态回写：入队时统一给的是「未收藏」样式（buildPlaylistMediaItem），
    // 这里按「是否在默认收藏歌单里」逐首校正 —— 只算当前这一首（O(收藏总表)），
    // 不在 pushTimeline 里逐条算（那会把入队变成 O(队列×收藏总表)）
    this.refreshNativeRating();
    this.syncSongExtras(song);
    if (this.sleepStopAfterCurrent) {
      this.sleepStopAfterCurrent = false;
      this.exitAfterSleep();
      return;
    }
    // 无缝播放：换歌成功后接着预热再下一首（链式预热，保证长播不中断）
    this.preloadNextUrl();
  }

  /** 「自然播到头」但位置离歌曲元数据时长还差 10s 以上 = 内容提前结束
   *（截断流/坏缓存被 media3 视为正常播完；用元数据时长判定而非 this.duration，
   *  后者可能已被原生实际流时长污染）。刚点歌（pos=0）不算。 */
  private endedTooEarly(song: Song): boolean {
    const meta = song.duration != null ? song.duration : 0;
    return meta > 30 && this.progress > 0 && this.progress < meta - 10;
  }

  /**
   * 提前结束自愈：清掉该曲的磁盘缓存分片并作废地址缓存，从最后位置重放
   * （refetchAndReplay 会重推时间线并强制懒解析重新取址）。每曲仅自愈一次：
   * 重放仍提前结束（试听片段/源本身被截断）就放行正常衔接，返回 false 由
   * 调用方走原流程，避免无限拉锯。
   */
  private tryRecoverEarlyEnd(song: Song): boolean {
    const key = song.platform + ":" + song.id;
    if (this.earlyEosKey == key) {
      logMsg(
        "[QT Player] 重放后仍提前结束（疑似试听片段/截断源），放行正常衔接: " +
          key
      );
      return false;
    }
    this.earlyEosKey = key;
    const meta = song.duration != null ? song.duration : 0;
    logMsg(
      "[QT Player] 检测到提前结束（播到 " +
        Math.floor(this.progress) +
        "s / 共 " +
        meta +
        "s），清缓存后从原位置重放: " +
        key
    );
    // 先停掉在途读取（循环重启时原生可能正在重读坏缓存），再精准清这一首的
    // 缓存分片；refetchAndReplay 内部会作废地址缓存（invalidatePlayUrl）
    audioPlayer.pause();
    audioPlayer.evictSongCache(this.mediaIdOf(song));
    this.refetchAndReplay(song);
    return true;
  }

  /**
   * 通知栏/自动播放出错时的处理。
   *
   * 三条分支（2026-10-03 弱网修复后）：
   * 1. **弱网**（上次取链是超时/引擎不可用）：不换歌、不计熔断，等一下重试**同一首**。
   *    换歌在弱网下几乎必然同样超时，过去正是「连挂 5 首 → 打满熔断 → 自动切歌
   *    关闭」把网络波动放大成「疯狂不可用」。
   * 2. 内容失败且该曲还没重取过：作废地址重取一次（签名 URL 过期是常见原因）。
   * 3. 仍失败：进失败处理（自动下一首标识开着就切下一首，连续 5 首熔断 + 通知栏）。
   */
  private handlePlaybackError(): void {
    this.listenSession.resetSample();
    const song = this.current;
    // ① 弱网：原地重试，不动熔断计数
    if (song != null && this.isStalled(song)) {
      this.retryStalled(song);
      return;
    }
    if (song != null && song.platform != "local") {
      const key = song.platform + ":" + song.id;
      // 本地优先交付的文件起播失败（文件损坏/被系统清理）：拉黑这份本地文件，
      // 本会话内不再用它顶在线歌，然后落回标准「重取在线地址并重放」路径
      // （拉黑后 resolve 回调自动走在线取链）
      if (this.localFirstUsed.has(key)) {
        this.localFirstUsed.delete(key);
        this.localFirstFailed.set(key, true);
        this.localFirstTick++;
        logMsg("[QT Player] 本地优先文件播放失败，已拉黑并回退在线取链：" + key);
      }
      // 同一首歌只重取一次；换歌或超过一分钟后重新允许，覆盖长时间播放后再次失效的情况
      const expired = Date.now() - this.urlRetryAt > 60 * 1000;
      if (this.urlRetryKey != key || expired) {
        this.urlRetryKey = key;
        this.urlRetryAt = Date.now();
        this.refetchAndReplay(song);
        return;
      }
    }
    // 本地歌文件丢失/损坏：替身链——在线搜索同名歌找时长最接近的接着播，
    // 找不到才跳下一首（口径对齐 urlRetry：同一首一分钟内只替一次）
    if (song != null && song.platform == "local") {
      const skey = song.platform + ":" + song.id;
      const sexpired = Date.now() - this.substituteAt > 60 * 1000;
      if (this.substituteKey != skey || sexpired) {
        this.substituteKey = skey;
        this.substituteAt = Date.now();
        this.substituteLocalSong(song);
        return;
      }
    }
    // 该曲已重取过仍失败：统一进失败处理（自动下一首标识开着就切下一首，
    // 连续 5 首失败熔断+通知栏提示，防止死歌队列无限空转）
    this.skipAfterFailure();
  }

  /**
   * 本地歌替身链（DESIGN §7.13）：文件丢失/损坏时在线搜索同名歌，
   * 时长最接近的当替身接着播；队列里坏条目原位换成替身。找不到/搜索失败
   * 则跳下一首（与 PC 端 arm1 同口径）。
   */
  private substituteLocalSong(song: Song): void {
    findSubstituteSong(song)
      .then((sub: Song | null) => {
        if (sub == null) {
          logMsg("[QT Player] 本地歌替身链未找到替身，跳下一首：" + song.name);
          this.skipAfterFailure();
          return;
        }
        logMsg(
          "[QT Player] 本地歌替身：" +
            song.name +
            " -> " +
            sub.platform +
            ":" +
            sub.id
        );
        // 队列里把坏条目原位换成替身（保持位置），然后接着播替身
        for (let i = 0; i < this.queue.length; i++) {
          const s = this.queue[i];
          if (s != null && s.platform == song.platform && s.id == song.id) {
            this.queue[i] = sub;
            break;
          }
        }
        this.play(sub);
      })
      .catch((_e: any) => {
        logMsg("[QT Player] 本地歌替身链搜索失败，跳下一首：" + song.name);
        this.skipAfterFailure();
      });
  }

  /** 本曲上次取链失败是否只是环境问题（弱网/引擎卡） */
  private isStalled(song: Song): boolean {
    if (song == null) return false;
    return this.stalledMap.get(song.platform + ":" + song.id) === true;
  }

  /**
   * 弱网原地重试同一首：等STALLED_RETRY_BASE_MS 起指数退避再重推时间线。
   *
   * 退避且限次（STALLED_RETRY_LIMIT）：网络长时间不可用时不会无限空转；
   * 到上限后停在错误态等用户操作，且**不把这首拉黑**（用户手动播即可再试）。
   */
  private retryStalled(song: Song): void {
    if (this.stallRetry >= STALLED_RETRY_LIMIT) {
      if (!this.autoNext) {
        // 熔断已开且网络仍未恢复：交给恢复探测，别再自己试
        return;
      }
      logMsg(
        "[QT Player] 连续" +
          STALLED_RETRY_LIMIT +
          "次因网络超时，停止自动重试，等待用户操作"
      );
      this.autoPause();
      qtShowToast({ title: "网络较慢，请稍后重试", icon: "none" });
      // 走到这里时 autoNext 仍是 true（弱网超时不计熔断，熔断没被打开），
      // 若不再挂恢复探测，这次退避打满就真的停在这儿了 —— 用户不手动点一下
      // 永远不会再试，正是「熔断单向门」的另一种形态。挂上探测，网络一恢复
      // 就自动重放（探测会真的取一次链来判恢复，不是空转计时器）。
      this.scheduleRecoveryProbe();
      return;
    }
    const delay = Math.min(
      STALLED_RETRY_BASE_MS * Math.pow(2, this.stallRetry),
      STALLED_RETRY_MAX_MS
    );
    this.stallRetry += 1;
    logMsg(
      "[QT Player] 网络较慢，" +
        delay +
        "ms 后重试同一首（" +
        this.stallRetry +
        "/" +
        STALLED_RETRY_LIMIT +
        "）"
    );
    const scheduledAt = Date.now();
    setTimeout(() => {
      // 期间用户可能已切歌：只在仍是当前曲时才重推
      const cur = this.current;
      if (cur == null || cur.id != song.id || cur.platform != song.platform) return;
      // 退避窗内用户按了暂停：那是明确的「先别放」，到点也不强行拉起
      if (this.pauseIntentAt > scheduledAt) {
        logMsg("[QT Player] 退避期间用户已暂停，放弃自动重试");
        return;
      }
      // 起播点在到点那一刻取：退避窗内的 seek 不丢（此前在排队时就取定，
      // 等待期拖动进度条会被重试拉回旧位置）
      const resumeAt = this.progress;
      this.playing = true;
      this.markProgress(resumeAt);
      this.seekFreezeUntil = Date.now() + 800;
      this.pushTimeline(song, resumeAt);
      this.persist();
    }, delay);
  }

  /**
   * 熔断后的恢复探测（2026-10-03 弱网修复）。
   *
   * 过去熔断是单向门：只有用户手动播歌才重开。网络在 20:24 恢复，但20:16
   * 已经熔断，没人操作就整晚放不回来——这正是用户反馈的现象。这里挂一个
   * 指数退避的后台探测：**真的取一次链**来判恢复（不是空转计时器），
   * 成功就重开自动切歌并重放当前曲。
   */
  private scheduleRecoveryProbe(): void {
    if (this.recoverTimer != null) return;
    const song = this.current;
    if (song == null) return;
    // 挂探测的那一刻熔断是否真的开着。两种调用场景的判定不同：
    // - 熔断开（skipAfterFailure）：autoNext 变 true 说明期间用户手动播了或
    //   别处已成功，直接收工重放，不必再探；
    // - 弱网退避打满（retryStalled）：autoNext 本来就是 true，此时**必须真的
    //   取一次链**才能知道网络恢复没有，不能顺手重放又白等一轮。
    const wasBreakerOpen = !this.autoNext;
    this.probeStartedAt = Date.now();
    let delay = RECOVERY_PROBE_BASE_MS;
    let attempt = 0;
    const probe = (): void => {
      attempt += 1;
      this.recoverTimer = setTimeout(() => {
        this.recoverTimer = null;
        const cur = this.current;
        // 用户已经手动播了 / 换了歌：不介入
        if (cur == null || cur.id != song.id || cur.platform != song.platform) return;
        if (wasBreakerOpen && this.autoNext) {
          this.probeDone(attempt);
          return;
        }
        this.fetchUrlWithTimeout(song, URL_FETCH_BUDGET_MS)
          .then((res: { url: string; stalled: boolean }) => {
            if (res.url.length > 0) {
              logMsg("[QT Player] 第" + attempt + "次恢复探测成功，重开自动切歌");
              this.probeDone(attempt);
              return;
            }
            this.scheduleProbeNext(probe, attempt, delay);
          })
          .catch(() => this.scheduleProbeNext(probe, attempt, delay));
      }, delay) as number;
      delay = Math.min(delay * 2, RECOVERY_PROBE_MAX_MS);
    };
    probe();
  }

  /** 继续安排下一次探测（超过上限就交给用户） */
  private scheduleProbeNext(
    probe: () => void,
    attempt: number,
    _lastDelay: number,
  ): void {
    if (attempt >= RECOVERY_PROBE_LIMIT) {
      logMsg(
        "[QT Player] 恢复探测" + attempt + "次仍未成功，等待用户手动播放"
      );
      return;
    }
    this.recoverTimer = null;
    probe();
  }

  /** 探测判定为已恢复：重开自动切歌并重放当前曲 */
  private probeDone(attempt: number): void {
    if (attempt <= 0) return;
    const song = this.current;
    if (song == null) return;
    this.autoNext = true;
    this.failStreak = 0;
    this.stallRetry = 0;
    this.urlRetryKey = "";
    // 熔断期间用户明确暂停过：只重开熔断状态，不强行拉起播放
    if (this.pauseIntentAt > 0 && this.pauseIntentAt > this.probeStartedAt) {
      logMsg("[QT Player] 网络已恢复，但用户已暂停，不自动重放");
      this.persist();
      return;
    }
    // 探测期间已手动续上同一首：只复位计数，不再重推时间线造成二次缓冲
    if (this.playing && audioPlayer.currentMediaId() == this.mediaIdOf(song)) {
      this.persist();
      return;
    }
    this.playing = true;
    this.markProgress(this.progress);
    this.pushTimeline(song, this.progress);
    this.persist();
  }

  /** 作废旧地址并重新解析当前歌曲（保留当前进度）；失败则按错误流程继续 */
  private refetchAndReplay(song: Song): void {
    const resumeAt = this.progress;
    this.listenSession.resetSample();
    logMsg(
      "[QT Player] 播放地址可能已失效，重新获取：" + song.platform + ":" + song.id
    );
    // 先作废该歌曲的地址缓存，否则重解析时 playUrl 会把刚失败的同一条 URL 再返回一次
    musicApi.invalidatePlayUrl(song, this.effQualityOf(song));
    // 重推时间线重新定位：条目加载那一刻再次触发懒解析（缓存已作废 → 拿新地址）。
    // 取链限时在 resolve 桥内（超时 → resolveFail → 原生 Error 回到这里再走跳歌）；
    // 不能只 seekTo 当前条目 —— 出错后播放器停在 IDLE，不重推时间线不会重新加载
    this.playing = true;
    this.markProgress(resumeAt);
    this.seekFreezeUntil = Date.now() + 800;
    this.pushTimeline(song, resumeAt);
    this.persist();
  }

  /**
   * 播放失败（**内容问题**：取链明确无地址 / 重取仍失败 / 底层播放错误）后的处理：
   * 自动下一首标识开着 → 切到下一首继续播；连续失败满 5 首 → 关闭标识熔断，
   * 通知栏提示「自动播放失败」，不再一首接一首白等取链空转。
   * 标识在任一成功播放（进度>3 秒）或用户手动发起播放时重新打开。
   *
   * 弱网超时**不会**走到这里（见 `handlePlaybackError` 的分支①）：
   * 那是环境问题，原地重试即可，不该消耗熔断额度。
   */
  private skipAfterFailure(): void {
    if (!this.autoNext) {
      // 熔断已打开：停住提示，等用户手动选一首能播的（播放成功后自动恢复）
      this.autoPause();
      qtShowToast({ title: "该歌曲暂时无法播放", icon: "none" });
      return;
    }
    this.failStreak++;
    if (this.failStreak >= 5) {
      this.autoNext = false;
      this.failStreak = 0;
      this.autoPause();
      this.persist();
      // 后台自动切歌时 toast 看不见，走通知栏
      audioPlayer.postNotice("轻听", "连续5首播放失败，已停止自动切歌");
      qtShowToast({ title: "自动播放失败，已停止自动切歌", icon: "none" });
      // 熔断是单向门的问题（2026-10-03）：挂恢复探测，网络/音源一恢复就自动
      // 重开自动切歌并重放当前曲，不要求用户手动操作
      this.scheduleRecoveryProbe();
      return;
    }
    logMsg(
      "[QT Player] 播放失败，自动切下一首（连续失败 " + this.failStreak + " 首）"
    );
    this.next(true);
  }

  /**
 * 上一首。
 *
 * **刻意不过滤屏蔽**（与 `next()` 不对称，不是漏写）：屏蔽语义是「别让它自动出现」，
 * 不是「禁止聆听」。`next()` 需要过滤是因为自动切歌必须躲开屏蔽项；
 * 而 `previous()` 只会由用户的「上一首」按钮触发 —— 用户主动点的那首歌，
 * 屏蔽规则不跟他争。如果这里也过滤，全被屏蔽时按钮会变成死键（点不动），
 * 用户反而拿不回控制权。qt-pc 的引擎侧 `previous` 同口径。
 */
  previous(): void {
    logMsg("[QT Media] previous() called");
    if (this.current == null) return;
    if (this.queue.length <= 1) {
      // 单曲队列没有上一首：重头播。走 play() 同曲分支（已加载 → seek+resume；
      // 冷启动没建播放器 → 完整推时间线），旧直调 seek+resume 在冷启动会空转
      this.play(this.current!, [], false, false);
      return;
    }
    const index = this.queue.findIndex(
      (item) =>
        item.id == this.current!.id && item.platform == this.current!.platform
    );
    if (index < 0) return;
    const target = this.queue[(index - 1 + this.queue.length) % this.queue.length];
    // 相邻重复歌曲（或环绕后仍是同一首）：重头播，同上交给 play() 同曲分支
    this.play(target);
  }

  seek(value: number): void {
    this.listenSession.resetSample();
    audioPlayer.seek(value);
    this.markProgress(value);
    // seek 后播放器位置要过一小会儿才跟上，这段窗口内进度按外推走，避免显示跳回去
    this.seekFreezeUntil = Date.now() + 600;
  }

  /** 从底层播放器立即同步一次当前进度（返回播放页时调用，避免进度条滞后/停在起点） */
  syncProgressNow(): void {
    try {
      const t = audioPlayer.currentTime();
      if (t >= 0) this.markProgress(t);
    } catch (_) {
      // 静默：底层播放器尚未就绪时读进度失败，保持现有外推值即可
    }
  }

  currentIndex(): number {
    if (this.current == null) return -1;
    return this.queue.findIndex(
      (item) =>
        item.id == this.current!.id && item.platform == this.current!.platform
    );
  }

  /**
   * 「下一首播放」= 插队到当前曲之后，**不打断正在播的歌**。
   *
   * 旧实现末尾 `this.play(song)` 会立刻切歌，用户反馈「点下一首播放，正在听的被打断」。
   * 现在只改队列 + 无损重推原生时间线（同 addToQueue）：当前曲继续播，
   * 播完自动衔接到插进来的这首。
   *
   * 随机模式的时间线是既有的乱序序列，只改队列的话 syncTimeline 会把它追加到队尾，
   * 「下一首」就不是它了——所以同时把 mediaId 插到时间线里当前曲之后。
   */
  playNext(song: Song): void {
    // 不喜欢列表：与 addToQueue 同口径——被屏蔽的歌不进队列。syncTimeline 的
    // 过滤也会把它从原生时间线剔掉，不拦就是「队列里有、播不到」的错位。
    if (useDislikesStore().isDisliked(song)) {
      qtShowToast({ title: "该歌曲已屏蔽", icon: "none" });
      return;
    }
    const current = this.current;
    // 还没有任何在播曲（冷启动/空闲）：没有「下一首」可言，直接开始播
    if (current == null) {
      this.queue = [...this.queue, song];
      this.play(song);
      return;
    }
    const mid = this.mediaIdOf(song);
    const curMid = this.mediaIdOf(current);
    if (mid == curMid) {
      qtShowToast({ title: "这首歌正在播放", icon: "none" });
      return;
    }
    // 队列里已有同一首：先摘掉旧条目，再插到当前曲之后（不留重复行）
    const next: Song[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item != null && item.platform + ":" + item.id == mid) continue;
      next.push(item);
    }
    // 插队位置 = 当前曲在队列里的下一位；当前曲不在队列（异常态）就放队首
    let pos = 0;
    for (let i = 0; i < next.length; i++) {
      if (next[i].platform + ":" + next[i].id == curMid) {
        pos = i + 1;
        break;
      }
    }
    next.splice(pos, 0, song);
    this.queue = next;
    // 落锁：随机模式的顺序来自乱序时间线，单曲循环模式下原生在 REPEAT_ONE 里原地
    // 重播 —— 两者都不会自动播到插进来的这首。锁住后由 pushTimeline/syncTimeline
    // 把它排到当前曲之后，单曲循环还会临时放开循环让原生能走过去（见 playNext 尾部）
    this.lockedNextMid = mid;
    if (this.mode == "random") {
      const ti = this.timelineIndexOf(current);
      if (ti >= 0) {
        // 旧时间线里可能已有同一首（队列去重了，时间线没有）：先剔除再插，
        // 否则同一个 mediaId 会在原生时间线里出现两次
        const ids: string[] = [];
        for (let i = 0; i < this.timelineIds.length; i++) {
          if (this.timelineIds[i] != mid) ids.push(this.timelineIds[i]);
          if (i == ti) ids.push(mid);
        }
        this.timelineIds = ids;
      }
    }
    // 无损重推原生时间线（同 addToQueue）：当前曲不打断，下一首按新顺序衔接
    this.syncTimeline();
    // 单曲循环：原生是 REPEAT_ONE 原地重播，不会走到插进来的这首，所以插队期间临时
    // 放开成列表环绕，让它能顺着时间线走过去；锁被消费时再按模式收回（见
    // onNativeTrackChanged 里的 syncRepeatMode 调用）
    if (this.mode == "single") audioPlayer.setRepeatMode(2);
    this.persist();
    qtShowToast({ title: "已设为下一首播放", icon: "none" });
  }

  addToQueue(song: Song): void {
    // 不喜欢列表：被屏蔽的歌不进队列（用户明确表达过「别自动出现」）
    if (useDislikesStore().isDisliked(song)) {
      qtShowToast({ title: "该歌曲已屏蔽", icon: "none" });
      return;
    }
    for (let index = 0; index < this.queue.length; index++) {
      const item = this.queue[index];
      if (item.id == song.id && item.platform == song.platform) return;
    }
    this.queue = [...this.queue, song];
    // 队列已归 media3：无损追加进原生时间线，否则自动衔接感知不到新加的歌
    this.syncTimeline();
    qtShowToast({ title: "已加入播放队列", icon: "none" });
    this.persist();
  }

  enqueueMany(songs: Song[]): void {
    let added = 0;
    let blocked = 0;
    let next = this.queue;
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      // 不喜欢列表：批量入队跳过被屏蔽的歌
      if (useDislikesStore().isDisliked(song)) {
        blocked++;
        continue;
      }
      let dup = false;
      for (let j = 0; j < next.length; j++) {
        const item = next[j];
        if (item.id == song.id && item.platform == song.platform) {
          dup = true;
          break;
        }
      }
      if (!dup) {
        next = [...next, song];
        added++;
      }
    }
    this.queue = next;
    if (added > 0) {
      // 同 addToQueue：无损追加进原生时间线
      this.syncTimeline();
      this.persist();
    }
    let title = "队列已包含这些歌曲";
    if (added > 0 && blocked > 0) {
      title = "已加入" + added + " 首，跳过 " + blocked + " 首已屏蔽";
    } else if (added > 0) {
      title = "已加入" + added + " 首到播放队列";
    } else if (blocked > 0) {
      title = "这些歌曲都已屏蔽";
    }
    qtShowToast({ title, icon: "none" });
  }

  /**
   * 红心状态 = 这首歌在任意一个自建歌单里被收藏过。
   *
   * 自建歌单包括本地建的（`localPlaylists`）和从别的设备同步回来的
   * （`savedPlaylists` 里 platform=local 的）；判断方式是这首歌的 pids
   * 与歌单 pid 有交集，所以进了哪个歌单都算，取消最后一个才灭。
   */
  isLiked(song: Song): boolean {
    return this.isInLikedSongs(song);
  }

  /** 这首歌是否在任意一个自建歌单里 */
  isSongInAnyPlaylist(song: Song): boolean {
    return this.getPlaylistsContainingSong(song).length > 0;
  }

  /**
   * 这首歌所在的自建歌单（含同步回来的）。
   *
   * 必须用**收藏总表里那条记录**的 pids 来判断，不能直接用传进来的 song：
   * 列表/搜索结果里的 song 对象通常没带 pids，收藏时 pid 是加在总表记录上的，
   * 拿传入对象判会导致刚收藏完红心还是不亮。
   */
  getPlaylistsContainingSong(song: Song): Playlist[] {
    const result: Playlist[] = [];
    const idx = this.findCollectedSong(song);
    const entry = idx >= 0 ? this.likedSongs[idx] : song;
    if (entry.pids == null || entry.pids.length == 0) return result;
    const lists = this.collectiblePlaylists();
    for (let i = 0; i < lists.length; i++) {
      const pid = lists[i].pid;
      if (pid == null || pid.length == 0) continue;
      if (this.songHasPid(entry, pid)) result.push(lists[i]);
    }
    return result;
  }

  createLocalPlaylist(name: string, picUrl?: string): Playlist | null {
    const trimmed = name != null ? name.trim() : "";
    if (trimmed.length === 0) return null;
    // 名称重复校验（与现有本地歌单同名则报错）
    for (let i = 0; i < this.localPlaylists.length; i++) {
      if (this.localPlaylists[i].name === trimmed) return null;
    }
    // 生成唯一 ID：循环直到不与现有歌单冲突，避免后续备份/恢复因 id 撞车而出错
    let id = this.generateLocalPlaylistId();
    while (this.localPlaylists.some(p => p.id === id)) {
      id = this.generateLocalPlaylistId();
    }
    const playlist: Playlist = {
      id,
      name: trimmed,
      // 默认封面统一用本地占位资源（UPDATE_DESIGN.md §5.1，与 qt-pc 同路径约定）
      picUrl: picUrl && picUrl.length > 0 ? picUrl : DEFAULT_PLAYLIST_COVER_ASSET,
      playCount: '0',
      platform: 'local',
      description: '',
      tracks: [],
      // 全局唯一键，收藏歌曲时作为归属 pid 上送，多端同步也靠它识别歌单
      pid: generateGlobalPid()
    };
    this.localPlaylists.push(playlist);
    this.saveLocalPlaylistList();
    // 歌单元数据上送服务器（按 pid upsert，幂等）：不推的话数据库里没有这条歌单，
    // 其他设备拉不到。断网时进 pendingOps，联网自动补推。
    this.enqueueLikeOp({ type: "playlist", action: "add", dataJson: this.likePlaylistPayloadJson(playlist) });
    return playlist;
  }

  /**
   * 重命名自建歌单（「我的收藏歌单」长按 → 修改歌单信息 → 编辑歌单名称）。
   *
   * 返回空串=成功，否则是可直接展示给用户的中文原因，调用方不必再翻译。
   * 校验与新建同一套：空白名、超长、重名都不落库。
   *
   * 两个存储都要覆盖：本机建的在 `localPlaylists`（按 id 命中），别的设备建好同步
   * 回来的落在 `savedPlaylists`（platform=local、id 即 pid）——收藏歌单页是两者直接
   * 拼接展示，长按对两张卡都得能用。
   *
   * 落盘后按 pid 补推一次 `playlist/add`：**这条才是改数据库的那一步**。服务端
   * `upsertActive` 里 `name = COALESCE(EXCLUDED.name, 库里已有名)`，带非空 name 就
   * 覆盖旧名并推进该用户的同步 seq，其他设备下次拉取即可看到新名；断网时先进
   * pendingOps，联网自动补推。推送积压期间拉取合并会被 `hasPendingLikeOp` 挡住，
   * 本地这份不会被服务器上的旧名覆盖回去。
   */
  renameLocalPlaylist(playlistId: string, name: string): string {
    const trimmed = name != null ? name.trim() : "";
    if (trimmed.length === 0) return "歌单名称不能为空";
    // 服务端 QtLikePlaylistActionDto.name 是 @Size(max = 128)，本地先挡，免得白推一次
    if (trimmed.length > 128) return "歌单名称不能超过 128 个字符";
    let target: Playlist | null = null;
    let inLocalList = false;
    for (let i = 0; i < this.localPlaylists.length; i++) {
      if (this.localPlaylists[i].id === playlistId) {
        target = this.localPlaylists[i];
        inLocalList = true;
        break;
      }
    }
    if (target == null) {
      for (let i = 0; i < this.savedPlaylists.length; i++) {
        const pl = this.savedPlaylists[i];
        if (pl.platform === "local" && pl.id === playlistId) {
          target = pl;
          break;
        }
      }
    }
    if (target == null) return "歌单不存在";
    if (target.name === trimmed) return "";
    // 重名只和「自己的歌单」比：本机建的 + 同步回来的自建歌单，排除自己；
    // 收藏的在线歌单不参与（它们不归这里改名，也不会和自己撞成两张同名卡）
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const pl = this.localPlaylists[i];
      if (pl.id !== playlistId && pl.name === trimmed) return "该歌单名称已存在";
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      if (pl.platform === "local" && pl.id !== playlistId && pl.name === trimmed) return "该歌单名称已存在";
    }
    target.name = trimmed;
    if (inLocalList) {
      // localPlaylists 那条：就地改名后整表落盘（写成功由 saveLocalPlaylistList 清脏标记）
      this.localPlaylistsDirty = true;
      this.saveLocalPlaylistList();
    } else {
      // savedPlaylists 这条没有紧跟整表写，必须自己置脏，交给 persist 落盘
      this.playlistsDirty = true;
    }
    this.persist();
    this.enqueueLikeOp({ type: "playlist", action: "add", dataJson: this.likePlaylistPayloadJson(target) });
    return "";
  }

  /**
   * 写入歌单封面的本地缓存（「我的收藏歌单」长按 → 修改歌单信息 → 编辑歌单封面）。
   *
   * 与改名相反，这里**不再** enqueue `playlist/add`：封面上传走
   * `/like/playlist/{pid}/cover/complete`，服务端在那里已经把 URL 直接写进
   * `qt_like_playlist.pic_url` 并推进了同步 seq，再补推一次同值只会白涨一格 seq、
   * 白插一条 pending。断网也做不成这个操作（要先直传文件），所以无需离队重放。
   *
   * 返回空串=成功，否则是可直接展示的原因。
   */
  setPlaylistCover(playlistId: string, coverUrl: string): string {
    let target: Playlist | null = null;
    let inLocalList = false;
    for (let i = 0; i < this.localPlaylists.length; i++) {
      if (this.localPlaylists[i].id === playlistId) {
        target = this.localPlaylists[i];
        inLocalList = true;
        break;
      }
    }
    if (target == null) {
      for (let i = 0; i < this.savedPlaylists.length; i++) {
        const pl = this.savedPlaylists[i];
        if (pl.platform === "local" && pl.id === playlistId) {
          target = pl;
          break;
        }
      }
    }
    if (target == null) return "歌单不存在";
    target.picUrl = coverUrl;
    if (inLocalList) {
      this.localPlaylistsDirty = true;
      this.saveLocalPlaylistList();
    } else {
      this.playlistsDirty = true;
    }
    this.persist();
    return "";
  }

  /**
   * 长按可编辑的目标歌单 pid（服务端以 pid + platform 定位收藏行/封面），取不到返回空串。
   * 与内部 private playlistPidOf 的区别：本机新建但还没拿到 pid 的歌单回落到 id，
   * 调用方（封面上传）需要的是一个可拼进 URL 的稳定值，而不是「未同步」的信号。
   */
  editablePlaylistPidOf(playlistId: string): string {
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const lp = this.localPlaylists[i];
      if (lp.id === playlistId) return lp.pid != null && lp.pid!.length > 0 ? lp.pid! : lp.id;
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      if (pl.platform === "local" && pl.id === playlistId) {
        return pl.pid != null && pl.pid!.length > 0 ? pl.pid! : pl.id;
      }
    }
    return "";
  }

  /**
   * 长按可编辑歌单「库里存的」封面：返回原始 picUrl，不让 playlistDisplayPic 的
   * 「本地歌单没封面就随第一首歌」的展示兜底混进来 —— 编辑弹层要用它判断
   * 「有没有自定义封面」（决定是否显示「恢复默认封面」），也用它做预览。
   */
  playlistCoverOf(playlistId: string): string {
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const lp = this.localPlaylists[i];
      if (lp.id === playlistId) return lp.picUrl != null ? lp.picUrl : "";
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      if (pl.platform === "local" && pl.id === playlistId) return pl.picUrl != null ? pl.picUrl : "";
    }
    return "";
  }

  // 生成本地歌单 ID（时间戳 + 随机段），不保证绝对唯一，但范围足够大
  private generateLocalPlaylistId(): string {
    return 'local_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  }

  deleteLocalPlaylist(playlistId: string): void {
    // 本机创建的歌单：从 localPlaylists 删
    const index = this.localPlaylists.findIndex(p => p.id === playlistId);
    if (index !== -1) {
      const removed = this.localPlaylists[index];
      this.localPlaylists.splice(index, 1);
      this.saveLocalPlaylistList();
      // 歌单记录本身推 remove；成员歌曲的 (sid,pid) 记录由服务端删除歌单时一并清理
      if (removed != null) {
        this.enqueueLikeOp({ type: "playlist", action: "remove", dataJson: this.likePlaylistPayloadJson(removed) });
      }
      // 删掉的正是默认收藏歌单：当前曲的红心按新的默认歌单重算（可能是别的歌单，也可能没了）
      if (this.defaultFavPlaylistId === playlistId) {
        this.defaultFavPlaylistId = "";
        uni.setStorageSync(DEFAULT_FAV_KEY, "");
      }
      this.refreshNativeRating();
      return;
    }
    // 从服务器/其他设备同步回来的自建歌单（platform=local，id 即 pid）：
    // 存放在 savedPlaylists，同样允许删除
    const sidx = this.savedPlaylists.findIndex(p => p.platform === 'local' && p.id === playlistId);
    if (sidx !== -1) {
      const removed = this.savedPlaylists[sidx];
      this.savedPlaylists.splice(sidx, 1);
      // 这条路径没有紧跟整表写（成员清理只在真的摘到歌时才写），必须自己置脏
      this.playlistsDirty = true;
      if (removed != null) {
        this.removeSongsOfPlaylistLocal(removed);
        this.enqueueLikeOp({ type: "playlist", action: "remove", dataJson: this.likePlaylistPayloadJson(removed) });
      }
      if (this.defaultFavPlaylistId === playlistId) {
        this.defaultFavPlaylistId = "";
        uni.setStorageSync(DEFAULT_FAV_KEY, "");
      }
      this.refreshNativeRating();
    }
  }

  /**
   * 云端下发的 local 歌单删除（机制 B）：按 pid 在两个存储里找齐并清理，
   * 成员归属一并摘除（不回推，服务端删歌单时已级联清了 (sid,pid) 行）。
   * LWW：本地条目 seq 比变更大说明本地更新（重命名后还没推上去），不动。
   */
  removeLocalPlaylistEverywhere(pid: string, seq: number): void {
    let touched = false;
    // localPlaylists：本机创建的（按 pid 匹配）
    for (let i = this.localPlaylists.length - 1; i >= 0; i--) {
      const lp = this.localPlaylists[i];
      if (lp == null) continue;
      const lpid = lp.pid != null && lp.pid.length > 0 ? lp.pid! : lp.id;
      if (lpid != pid) continue;
      const localSeq = lp.likeSeq != null ? lp.likeSeq! : 0;
      if (localSeq > seq) continue;
      this.localPlaylists.splice(i, 1);
      this.removeSongsOfPlaylistLocal(lp);
      touched = true;
    }
    if (touched) this.saveLocalPlaylistList();
    // savedPlaylists：他端建的（id 或 pid 都可能是键）
    let savedTouched = false;
    for (let i = this.savedPlaylists.length - 1; i >= 0; i--) {
      const sp = this.savedPlaylists[i];
      if (sp == null || sp.platform !== 'local') continue;
      const spid = sp.pid != null && sp.pid.length > 0 ? sp.pid! : sp.id;
      if (spid != pid) continue;
      const localSeq = sp.likeSeq != null ? sp.likeSeq! : 0;
      if (localSeq > seq) continue;
      this.savedPlaylists.splice(i, 1);
      this.playlistsDirty = true;
      this.removeSongsOfPlaylistLocal(sp);
      savedTouched = true;
    }
    if (touched || savedTouched) this.persist();
    // 云端删掉的歌单正是默认收藏歌单：id 失效，清掉让它回落到第一个自建歌单，
    // 并按新答案刷新当前曲红心
    if (this.defaultFavPlaylistId.length > 0 && this.playlistPidOf(this.defaultFavPlaylistId).length === 0) {
      this.defaultFavPlaylistId = "";
      uni.setStorageSync(DEFAULT_FAV_KEY, "");
      this.refreshNativeRating();
    }
  }

  /**
   * 删除歌单时清理本地成员歌曲（不上送，服务器在删歌单时一并清 (sid,pid) 记录）：
   * 摘掉该歌单 pid 归属，pids 清空的歌整条从收藏总表移除并落盘。
   */
  removeSongsOfPlaylistLocal(removed: Playlist): void {
    const pid = removed.pid != null && removed.pid.length > 0 ? removed.pid! : removed.id;
    if (pid.length == 0) return;
    let touched = false;
    for (let i = this.likedSongs.length - 1; i >= 0; i--) {
      const s = this.likedSongs[i];
      if (s == null || s.pids == null) continue;
      if (s.pids.indexOf(pid) < 0) continue;
      this.removePidFromSong(s, pid);
      if (s.pids == null || s.pids.length == 0) this.likedSongs.splice(i, 1);
      this.likedDirty = true;
      touched = true;
    }
    if (touched) this.persist();
  }

  /**
   * 收藏进某个本地歌单：把这首歌登记进收藏总表并打上该歌单的 pid，然后推 add。
   * 一首歌可以进多个歌单，各推各的、互不影响。
   *
   * 收尾统一回写系统卡片红心：改的若是当前曲在「默认收藏歌单」里的归属，
   * 图标要立刻跟上（原生侧按 mediaId 判断，改别的歌是空操作）。
   */
  addSongToPlaylist(song: Song, playlistId: string): void {
    this.addSongToPid(song, this.playlistPidOf(playlistId));
    this.refreshNativeRating();
  }

  /**
   * 批量导入歌曲进歌单（歌单导入向导专用路径）。
   *
   * 与逐首 addSongToPlaylist 的差别在落库时机：逐首路径每首歌都要
   * persist()（全量重写 likedSongs/历史/歌单等存储键）+ saveLikeSync()
   * （全量重写待推送队列），大歌单导入是 O(N^2) 次存储写，UI 会卡到秒级。
   * 这里全部在内存里去重登记完，persist 与 saveLikeSync 各只做一次，
   * 最后触发一次统一推送（服务端按 (sid,pid) upsert，天然幂等）。
   * 返回实际新加入的歌数（已在目标歌单里的歌跳过，不重复推）。
   */
  importSongsToPlaylist(tracks: Song[], playlistId: string): number {
    const pid = this.playlistPidOf(playlistId);
    if (pid.length === 0) return 0;
    let added = 0;
    for (let i = 0; i < tracks.length; i++) {
      const song = tracks[i];
      if (song == null) continue;
      const idx = this.findCollectedSong(song);
      if (idx >= 0) {
        // 已在收藏总表：补 pid（幂等，补不上说明已在该歌单，跳过不重推）
        const entry = this.likedSongs[idx];
        if (entry == null || !this.addPidToSong(entry, pid)) continue;
        added++;
        this.pendingOps.push({
          type: "song",
          action: "add",
          dataJson: this.likeSongPayloadJson(entry, pid),
        });
      } else {
        const entry: Song = {
          id: song.id,
          name: song.name,
          singer: song.singer,
          album: song.album,
          picUrl: song.picUrl,
          platform: song.platform,
          duration: song.duration,
          musicId: song.musicId,
          pids: [pid],
        };
        this.likedSongs.push(entry);
        added++;
        this.likedDirty = true;
        this.pendingOps.push({
          type: "song",
          action: "add",
          dataJson: this.likeSongPayloadJson(entry, pid),
        });
      }
    }
    if (added > 0) {
      this.persist();
      this.saveLikeSync();
      this.flushPendingOps().catch(() => {});
      // 批量导入可能包含正在播放的这首，红心要跟上（原生按 mediaId 判定，无关则空操作）
      this.refreshNativeRating();
    }
    return added;
  }

  /**
   * 从某个本地歌单移除：只摘掉这首歌的该歌单 pid，并推 remove（带 pid），
   * 后端只删 (sid, pid) 这一条，所以不影响它还在其他歌单里的记录。
   * 摘完 pid 后这首歌不属于任何歌单了，才从收藏总表里删掉。
   */
  removeSongFromPlaylist(song: Song, playlistId: string): void {
    this.removeSongFromPid(song, this.playlistPidOf(playlistId));
    this.refreshNativeRating();
  }

  /**
   * 批量从某个歌单移除（批量取消收藏）。
   *
   * 为什么不是循环调 removeSongFromPlaylist：那支每首都 persist()（全量重写
   * likedSongs / 播放历史 / 歌单等存储键）再 saveLikeSync()（全量重写待推送队列），
   * 取消收藏 40 首就是 80 次全量存储写，UI 会卡到秒级 —— 与 importSongsToPlaylist
   * 面对的 O(N²) 是同一个问题，所以走同一条路：全在内存里摘完 pid，
   * persist 与 saveLikeSync 各只做一次，最后统一推一批 remove
   * （服务端按 (sid,pid) 删一条，天然幂等，重复推不会误删其他歌单的记录）。
   *
   * 返回实际摘掉的歌数（本来就不在这个歌单里的跳过，不计入）。
   */
  removeSongsFromPlaylist(tracks: Song[], playlistId: string): number {
    const pid = this.playlistPidOf(playlistId);
    if (pid.length === 0) return 0;
    let removed = 0;
    /** 摘完 pid 后不属于任何歌单的记录，循环走完再整条删（与单曲路径同口径） */
    const emptied: Song[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const song = tracks[i];
      if (song == null) continue;
      const idx = this.findCollectedSong(song);
      if (idx < 0) continue;
      const entry = this.likedSongs[idx];
      if (entry == null || !this.removePidFromSong(entry, pid)) continue;
      removed++;
      this.pendingOps.push({
        type: "song",
        action: "remove",
        dataJson: this.likeSongPayloadJson(entry, pid),
      });
      if (entry.pids == null || entry.pids.length == 0) emptied.push(entry);
    }
    if (removed > 0) {
      for (let i = 0; i < emptied.length; i++) {
        for (let j = this.likedSongs.length - 1; j >= 0; j--) {
          if (this.likedSongs[j] === emptied[i]) {
            this.likedSongs.splice(j, 1);
            this.likedDirty = true;
          }
        }
      }
      this.persist();
      this.saveLikeSync();
      this.flushPendingOps().catch(() => {});
      // 批量取消收藏可能摘掉正在播放的这首，红心要跟上（原生按 mediaId 判定，无关则空操作）
      this.refreshNativeRating();
    }
    return removed;
  }

  /**
   * 把一首歌收进某个 pid 对应的歌单：本地登记 + 推送 add。
   * 已经存在就只补一个 pid（同一歌单重复加入不再推送）。
   */
  private addSongToPid(song: Song, pid: string): void {
    if (pid.length == 0) return;
    const idx = this.findCollectedSong(song);
    if (idx >= 0) {
      const entry = this.likedSongs[idx];
      if (!this.addPidToSong(entry, pid)) return;
      this.persist();
      this.pushSongPid(entry, pid, "add");
      return;
    }
    this.collectSongInto(song, pid);
    this.pushSongPid(song, pid, "add");
  }

  /**
   * 把一首歌从某个 pid 对应的歌单移除：本地摘 pid + 推送 remove。
   * 摘完 pid 后这首歌不属于任何歌单了，才从收藏总表里删掉整条记录。
   */
  private removeSongFromPid(song: Song, pid: string): void {
    if (pid.length == 0) return;
    const idx = this.findCollectedSong(song);
    if (idx < 0) return;
    const entry = this.likedSongs[idx];
    if (!this.removePidFromSong(entry, pid)) return;
    this.persist();
    this.pushSongPid(entry, pid, "remove");
    if (entry.pids == null || entry.pids.length == 0) {
      this.likedSongs.splice(idx, 1);
      this.likedDirty = true;
      this.persist();
    }
  }

  /**
   * 这首歌是否已收藏（在任意一个本地歌单里）。
   *
   * 不再有内置的「我喜欢的歌曲」—— 收藏必须落到用户自己建的歌单上，
   * 所以红心的点亮条件就是「这首歌已经在某个本地歌单里」。
   * 按 id + platform 查收藏总表，传进来的 song 没带 pids 也能判对。
   */
  isInLikedSongs(song: Song): boolean {
    return this.getPlaylistsContainingSong(song).length > 0;
  }

  /** 按歌单 id 取它的 pid（自建歌单，含同步回来的），找不到返回空串 */
  private playlistPidOf(playlistId: string): string {
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const pl = this.localPlaylists[i];
      if (pl.id === playlistId) return pl.pid != null ? pl.pid! : "";
    }
    // 同步回来的自建歌单：它的 id 就是 pid
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      if (pl.platform !== "local") continue;
      if (pl.id === playlistId && pl.pid != null && pl.pid.length > 0) return pl.pid!;
    }
    return "";
  }

  /**
   * 某个歌单里的歌曲：按 pid 从收藏总表里过滤。
   *
   * 这是查询本地歌单的**唯一入口** —— 一首歌的 pids 里含哪个歌单的 pid，
   * 它就属于哪个歌单。所以歌单之间不会串歌：A 只能展示 pids 含 A.pid 的那些。
   */
  songsOfPid(pid: string): Song[] {
    const out: Song[] = [];
    if (pid.length == 0) return out;
    for (let i = 0; i < this.likedSongs.length; i++) {
      const s = this.likedSongs[i];
      if (s.pids == null) continue;
      for (let j = 0; j < s.pids.length; j++) {
        if (s.pids[j] == pid) {
          out.push(s);
          break;
        }
      }
    }
    return out;
  }

  /** 按歌单 id 取歌曲（用户自建的本地歌单） */
  songsOfPlaylist(playlistId: string): Song[] {
    return this.songsOfPid(this.playlistPidOf(playlistId));
  }

  /** 这首歌是否在某个歌单里 */
  private songHasPid(song: Song, pid: string): boolean {
    if (pid.length == 0 || song.pids == null) return false;
    for (let i = 0; i < song.pids.length; i++) {
      if (song.pids[i] == pid) return true;
    }
    return false;
  }

  /** 给这首歌加上某个 pid（本地登记，返回是否真的新增） */
  addPidToSong(song: Song, pid: string): boolean {
    if (pid.length == 0) return false;
    if (song.pids == null) song.pids = [];
    for (let i = 0; i < song.pids.length; i++) {
      if (song.pids[i] == pid) return false;
    }
    song.pids.push(pid);
    // 收藏总表条目是原地改的（pids 不在「重赋值/增删条目」的范畴内），
    // 不在这里置脏，纯补 pid 的路径就会漏落盘
    this.likedDirty = true;
    return true;
  }

  /** 从这首歌移除某个 pid（本地登记，返回是否真的删掉了） */
  removePidFromSong(song: Song, pid: string): boolean {
    if (pid.length == 0 || song.pids == null) return false;
    const next: string[] = [];
    let removed = false;
    for (let i = 0; i < song.pids.length; i++) {
      if (song.pids[i] == pid) {
        removed = true;
        continue;
      }
      next.push(song.pids[i]);
    }
    song.pids = next;
    if (removed) this.likedDirty = true;
    return removed;
  }

  /** 在指定列表里按 id + platform 找歌（用于合并服务器返回的同歌多条记录） */
  findCollectedSongInList(
    list: Song[],
    id: string,
    platform: string
  ): number {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.id == id && s.platform == platform) return i;
    }
    return -1;
  }

  /** 在收藏总表里按 id + platform 找到这首歌（总表里一首歌只有一条记录） */
  findCollectedSongById(id: string, platform: string): number {
    return this.findCollectedSongInList(this.likedSongs, id, platform);
  }

  private findCollectedSong(song: Song): number {
    return this.findCollectedSongById(song.id, song.platform);
  }

  /**
   * 把一首歌收进收藏总表并归属到某个 pid。
   * 已经存在就只补 pid（一首歌可以同时属于多个歌单），不存在才新建条目。
   */
  private collectSongInto(song: Song, pid: string): void {
    if (pid.length == 0) return;
    const idx = this.findCollectedSong(song);
    if (idx >= 0) {
      if (this.addPidToSong(this.likedSongs[idx], pid)) this.persist();
      return;
    }
    const entry: Song = {
      id: song.id,
      name: song.name,
      singer: song.singer,
      album: song.album,
      picUrl: song.picUrl,
      platform: song.platform,
      duration: song.duration,
      musicId: song.musicId,
      pids: [pid],
    };
    this.likedSongs.push(entry);
    this.likedDirty = true;
    this.persist();
  }

  /**
   * 可作为收藏目标的歌单：本地自建歌单 + 从服务器同步回来的自建歌单。
   *
   * 自建歌单同步到服务器后再拉回来，会落在 `savedPlaylists` 里、
   * platform 仍是 'local'、且 `id` 就等于它的 `pid` —— 它们同样是「我自己的歌单」，
   * 必须能往里收藏，不能只认 `localPlaylists`。
   * 只有 id === 'local' 那个才是已经移除的内置「我喜欢的歌曲」，要排除。
   */
  private collectiblePlaylists(): Playlist[] {
    const out: Playlist[] = [];
    const seen: string[] = [];
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const pl = this.localPlaylists[i];
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : "";
      if (pid.length == 0) continue;
      out.push(pl);
      seen.push(pid);
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      // 只要 platform=local 就是自己的歌单（本地建的、或从别的设备同步回来的），
      // 一律作为可收藏目标；非 local 的是在平台上收藏的别人/平台歌单，不参与。
      // 注意不能按名字或 id 猜 —— 用户完全可能自建一个叫「我喜欢的歌曲」的歌单。
      if (pl.platform !== "local") continue;
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (pid.length == 0) continue;
      let dup = false;
      for (let j = 0; j < seen.length; j++) {
        if (seen[j] === pid) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      out.push(pl);
      seen.push(pid);
    }
    return out;
  }

  /**
   * 该 pid 是否就是本机 `localPlaylists` 里的自建歌单。
   *
   * 本机自建歌单以 `localPlaylists` 里的原条目为唯一准据，服务器上那份同名同 pid
   * 的记录不再重复收下 —— 否则「我的收藏歌单」会出两张卡、profile 计数多 1
   * （collectiblePlaylists 虽按 pid 去重，但展示层是 localPlaylists + savedPlaylists 拼接）。
   */
  isLocallyOwnedPlaylist(pid: string, platform: string): boolean {
    if (pid.length == 0) return false;
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const lp = this.localPlaylists[i];
      const lpid = lp.pid != null && lp.pid.length > 0 ? lp.pid! : lp.id;
      if (lpid == pid && lp.platform == platform) return true;
    }
    return false;
  }

  /**
   * 收藏选择器可用的歌单列表：本地自建的 + 同步回来的自建歌单。
   * 不再内置任何歌单（包括原来的「我喜欢的歌曲」），一个都没有时列表就是空的，
   * 由界面提示「还没有歌单，请先新建」。
   */
  pickerPlaylists(): Playlist[] {
    return this.collectiblePlaylists().map(pl => ({ ...pl, picUrl: this.playlistDisplayPic(pl) }));
  }

  /** 歌曲当前在选择器中应勾选的歌单 id：它所在的自建歌单 */
  pickerSelectedIds(song: Song): string[] {
    const ids: string[] = [];
    const containing = this.getPlaylistsContainingSong(song);
    for (let i = 0; i < containing.length; i++) ids.push(containing[i].id);
    return ids;
  }

  /**
   * 把这首歌加进这个歌单前，先查「同名不同源」：歌单里已经有别的音源的
   * 同一首歌时返回冲突列表，UI 拿它弹一次确认再决定要不要真的加。
   *
   * 与 qt-pc 的 lib/collect-dup 同口径（人工保持同步）：只按歌名+歌手判定，
   * 不联网。取不到歌单 pid（不是自建歌单）时返回空数组——那种歌单的曲目
   * 归音源管，本地收藏总表里根本没有可比的数据。
   */
  collectDupIn(song: Song, playlistId: string): Song[] {
    if (song == null) return [];
    const pid = this.playlistPidOf(playlistId);
    if (pid.length == 0) return [];
    return findCrossSourceDup(song, this.songsOfPid(pid));
  }

  /**
   * 对一整批「要加入的歌单」查重：把每个有冲突的歌单凑成一条
   * CollectDupConflict，UI 依次弹确认。**没有冲突的歌单**会先被直接放行
   * （返回 `passed`），这样用户点掉冲突那几下之后，剩下的歌单不必再问一遍。
   */
  collectDupConflicts(song: Song, addIds: string[]): {
    conflicts: CollectDupConflict[];
    passed: string[];
  } {
    const conflicts: CollectDupConflict[] = [];
    const passed: string[] = [];
    if (song == null) return { conflicts: conflicts, passed: passed };
    for (let i = 0; i < addIds.length; i++) {
      const id = addIds[i];
      const dups = this.collectDupIn(song, id);
      if (dups.length == 0) {
        passed.push(id);
        continue;
      }
      conflicts.push({
        playlistId: id,
        playlistName: this.playlistNameOf(id),
        dups: dups,
      });
    }
    return { conflicts: conflicts, passed: passed };
  }

  /** 歌单 id → 展示名（查重提示文案用；找不到就显示 id 本身，不至于空白） */
  playlistNameOf(playlistId: string): string {
    for (let i = 0; i < this.localPlaylists.length; i++) {
      if (this.localPlaylists[i].id == playlistId) return this.localPlaylists[i].name;
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      if (this.savedPlaylists[i].id == playlistId) return this.savedPlaylists[i].name;
    }
    return playlistId;
  }

  /** 统一处理「加入/移出歌单」选择结果，返回是否有变更 */
  applyPickerSelection(song: Song, selectedIds: string[]): boolean {
    const currentIds = this.pickerSelectedIds(song);
    const toAdd = selectedIds.filter(id => !currentIds.includes(id));
    const toRemove = currentIds.filter(id => !selectedIds.includes(id));
    for (const id of toAdd) {
      this.addSongToPlaylist(song, id);
    }
    for (const id of toRemove) {
      this.removeSongFromPlaylist(song, id);
    }
    // 当前曲的归属变了 → 系统卡片红心要跟着变（其他歌等切到它时再算）
    if (toAdd.length > 0 || toRemove.length > 0) this.refreshNativeRating();
    return toAdd.length > 0 || toRemove.length > 0;
  }

  // ==================== 收藏同步（LIKE_SYNC_DESIGN.md §5） ====================

  // ===== 收藏同步转发层：实现在 services/like-sync.ts（LikeSyncEngine）。
  // 方法名/签名与抽出前完全一致，页面与其余 store 不感知搬迁；调用点零改动。 =====

  private loadLikeSync(): void {
    likeSync().load();
  }

  private saveLikeSync(): void {
    likeSync().save();
  }

  /** 推送积压的收藏操作（对外入口，防止与增量拉取并发交错） */
  async flushPendingOps(): Promise<void> {
    await likeSync().flushPendingOps();
  }

  async pullChanges(): Promise<void> {
    await likeSync().pullChanges();
  }

  async syncLikedFromServer(): Promise<void> {
    await likeSync().syncLikedFromServer();
  }

  async syncLikedFromServerInBackground(): Promise<void> {
    await likeSync().syncLikedFromServerInBackground();
  }

  async syncLikesOnLaunch(): Promise<void> {
    await likeSync().syncLikesOnLaunch();
  }

  /** 退出登录时重置收藏同步状态：清空游标与待推送队列，避免串到下一个账号 */
  resetLikeSync(): void {
    likeSync().resetLikeSync();
  }

  /** 切换账号时清空本地收藏缓存（服务器是数据源，新账号全量拉取自动恢复）。 */
  clearLocalLikeData(): void {
    likeSync().clearLocalLikeData();
  }

  private enqueueLikeOp(op: PendingLikeOp): void {
    likeSync().enqueueLikeOp(op);
  }

  private pushSongPid(song: Song, pid: string, action: "add" | "remove"): void {
    likeSync().pushSongPid(song, pid, action);
  }

  private likeSongPayloadJson(song: Song, pid?: string): string {
    return likeSync().likeSongPayloadJson(song, pid);
  }

  private likePlaylistPayloadJson(playlist: Playlist): string {
    return likeSync().likePlaylistPayloadJson(playlist);
  }
  /** 是否至少有一个自建歌单（决定收藏入口能不能弹选择） */
  canPickPlaylist(): boolean {
    return this.collectiblePlaylists().length > 0;
  }

  /**
   * 弹出本地歌单列表让用户挑一个收进这首歌（用于没有自带选择器的入口，
   * 比如歌曲行红心、歌曲菜单）。已在该歌单里再点一次就是移出。
   *
   * 一个自建歌单都没有时不会弹空列表，而是提示先新建。
   */
  showPlaylistPickerFor(song: Song): void {
    const lists: Playlist[] = [];
    for (let i = 0; i < this.localPlaylists.length; i++) lists.push(this.localPlaylists[i]);
    if (lists.length == 0) {
      qtShowToast({ title: "还没有歌单，请先新建", icon: "none" });
      return;
    }
    const names: string[] = [];
    for (let i = 0; i < lists.length; i++) names.push(lists[i].name);
    qtShowActionSheet({ title: "收藏到歌单", itemList: names }).then((tap: number) => {
      if (tap < 0 || tap >= lists.length) return;
      const targetId = lists[tap].id;
      const ids = this.pickerSelectedIds(song);
      const next: string[] = [];
      let has = false;
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] == targetId) has = true;
      }
      if (has) {
        // 已在里面 → 移出这一个
        for (let i = 0; i < ids.length; i++) {
          if (ids[i] != targetId) next.push(ids[i]);
        }
      } else {
        for (let i = 0; i < ids.length; i++) next.push(ids[i]);
        next.push(targetId);
      }
      // 加进来之前查一次「同名不同源」：这个歌单里已经有别的音源的同一首歌
      // 时先弹确认，用户点了「继续收藏」才真的加
      const dups = this.collectDupIn(song, targetId);
      if (dups.length > 0) {
        qtConfirm({
          title: "同名歌曲提示",
          content: collectDupMessage(this.playlistNameOf(targetId), dups),
          confirmText: "继续收藏",
          cancelText: "取消",
        }).then((ok: boolean) => {
          if (ok) this.applyPickerSelection(song, next);
        });
        return;
      }
      this.applyPickerSelection(song, next);
    });
  }

  removeHistory(song: Song): void {
    const next: Song[] = [];
    for (let index = 0; index < this.history.length; index++) {
      const item = this.history[index];
      if (!(item.id == song.id && item.platform == song.platform))
        next.push(item);
    }
    this.history = next;
    this.persist();
  }

  clearHistory(): void {
    this.history = [];
    this.persist();
  }

  /**
   * 批量移除播放记录（历史页多选删除）。
   * 逐条调 removeHistory 会 persist 同等次数（每条都全量重写存储键），
   * 选几十首时明显卡顿，所以这里合并成一次落盘。
   */
  removeHistoryMany(songs: Song[]): void {
    if (songs.length == 0) return;
    const next: Song[] = [];
    for (let index = 0; index < this.history.length; index++) {
      const item = this.history[index];
      let hit = false;
      for (let k = 0; k < songs.length; k++) {
        if (item.id == songs[k].id && item.platform == songs[k].platform) {
          hit = true;
          break;
        }
      }
      if (!hit) next.push(item);
    }
    if (next.length == this.history.length) return;
    this.history = next;
    this.persist();
  }

  isPlaylistSaved(playlist: Playlist): boolean {
    for (let index = 0; index < this.savedPlaylists.length; index++) {
      const item = this.savedPlaylists[index];
      if (item.id == playlist.id && item.platform == playlist.platform)
        return true;
    }
    return false;
  }

  toggleSavePlaylist(playlist: Playlist): void {
    let found = -1;
    for (let index = 0; index < this.savedPlaylists.length; index++) {
      const item = this.savedPlaylists[index];
      if (item.id == playlist.id && item.platform == playlist.platform) {
        found = index;
        break;
      }
    }
    const removing = found >= 0;
    if (removing) {
      const next: Playlist[] = [];
      for (let index = 0; index < this.savedPlaylists.length; index++) {
        if (index != found) next.push(this.savedPlaylists[index]);
      }
      this.savedPlaylists = next;
    } else {
      const meta: Playlist = {
        id: playlist.id,
        name: playlist.name,
        picUrl: playlist.picUrl,
        playCount: playlist.playCount,
        platform: playlist.platform,
        description: playlist.description,
      };
      this.savedPlaylists = [meta, ...this.savedPlaylists];
    }
    this.playlistsDirty = true;
    this.persist();
    // 增量推送：单条收藏/取消（断网时进队列，联网自动补推，不再全量上传）
    const action: "add" | "remove" = removing ? "remove" : "add";
    this.enqueueLikeOp({ type: "playlist", action, dataJson: this.likePlaylistPayloadJson(playlist) });
  }

  // ==================== 默认收藏歌单（通知栏 ♡ 的收藏目标） ====================

  /**
   * 设置默认收藏歌单（歌单页长按入口）。只记 id：歌单本身仍按既有链路增删，
   * 这里不做额外引用计数，歌单被删后由 defaultFavPlaylist() 自动回落。
   */
  setDefaultFavPlaylist(playlistId: string): void {
    this.defaultFavPlaylistId = playlistId;
    uni.setStorageSync(DEFAULT_FAV_KEY, playlistId);
    // 换了默认歌单 = 换了「当前曲在不在收藏歌单里」的答案，红心要跟着变
    this.refreshNativeRating();
  }

  /**
   * 解析当前生效的默认收藏歌单：
   *  1. 显式设置过的 id（歌单已被删则跳过，避免收藏落到不存在的歌单）
   *  2. 第一个自建歌单（用户没设置过时的默认口径）
   *  3. 同步回来的自建歌单（platform === 'local'）
   *  4. 都没有 → null（收藏时再按需新建，见 ensureDefaultFavPlaylist）
   */
  defaultFavPlaylist(): Playlist | null {
    const id = this.defaultFavPlaylistId;
    if (id.length > 0 && this.playlistPidOf(id).length > 0) {
      for (let i = 0; i < this.localPlaylists.length; i++) {
        if (this.localPlaylists[i].id === id) return this.localPlaylists[i];
      }
      for (let i = 0; i < this.savedPlaylists.length; i++) {
        const pl = this.savedPlaylists[i];
        if (pl.platform === "local" && pl.id === id) return pl;
      }
    }
    if (this.localPlaylists.length > 0) return this.localPlaylists[0];
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      if (this.savedPlaylists[i].platform === "local") return this.savedPlaylists[i];
    }
    return null;
  }

  /** 确保默认收藏歌单存在：一个自建歌单都没有时新建「我的收藏」并记为默认 */
  ensureDefaultFavPlaylist(): Playlist | null {
    const existing = this.defaultFavPlaylist();
    if (existing != null) return existing;
    const created = this.createLocalPlaylist("我的收藏");
    if (created == null) return null;
    this.setDefaultFavPlaylist(created.id);
    return created;
  }

  /** 这首歌是否在默认收藏歌单里 —— 系统媒体卡片 ♡ 实心/空心的判定口径 */
  isInDefaultFav(song: Song): boolean {
    const pl = this.defaultFavPlaylist();
    if (pl == null) return false;
    const pid = this.playlistPidOf(pl.id);
    if (pid.length === 0) return false;
    const idx = this.findCollectedSong(song);
    const entry = idx >= 0 ? this.likedSongs[idx] : song;
    return this.songHasPid(entry, pid);
  }

  /**
   * 把当前曲在「默认收藏歌单」里的归属回写系统媒体卡片（♡ 实心/空心）。
   *
   * 所有会改变这个答案的入口都要调它：切歌、系统 ♡ 点击、改默认歌单、
   * 应用内把当前曲加/移出歌单、歌单被删。漏一处就会出现「数据已改、图标没变」
   * 的不一致 —— 图标是系统按元数据画的，不主动回写它不会自己刷新。
   */
  private refreshNativeRating(): void {
    const song = this.current;
    if (song == null) return;
    audioPlayer.setLiked(this.mediaIdOf(song), this.isInDefaultFav(song));
  }

  /**
   * 系统收藏（♡）点击：收进/移出默认收藏歌单，并把新状态回写媒体元数据刷新图标。
   * 语义是「这首歌在不在默认收藏歌单里」而不是「在不在任意歌单里」—— 通知栏的
   * ♡ 只有两态，若按「任意歌单」显示，点一下的语义就和图标对不上；收藏歌单本身
   * 的归属不受影响（移出默认歌单不会把歌从别的歌单里摘掉）。
   */
  onNativeSetRating(mediaId: string, liked: boolean): void {
    const song = this.findSongByMediaId(mediaId);
    if (song == null) {
      logMsg("[QT Media] 系统收藏请求找不到对应歌曲 → " + mediaId);
      return;
    }
    const pl = this.ensureDefaultFavPlaylist();
    if (pl == null) {
      audioPlayer.postNotice("轻听", "新建默认收藏歌单失败，请先在歌单页新建一个歌单");
      return;
    }
    if (liked) {
      this.addSongToPlaylist(song, pl.id);
    } else {
      this.removeSongFromPlaylist(song, pl.id);
    }
    // 增删两支内部已回写红心（见 refreshNativeRating），这里只取真实结果给提示
    const inFav = this.isInDefaultFav(song);
    qtShowToast({ title: inFav ? "已收藏到「" + pl.name + "」" : "已取消收藏", icon: "none" });
  }

  /** 统一切换播放模式，并立即同步原生循环策略与持久化状态。 */
  cycleMode(): string {
    this.mode =
      this.mode == "sequence"
        ? "random"
        : this.mode == "random"
        ? "single"
        : "sequence";
    this.syncRepeatMode();
    this.persist();
    return this.mode;
  }

  /** 播放模式的用户可见名称，避免各页面重复维护文案。 */
  modeLabel(): string {
    if (this.mode == "sequence") return "列表顺序循环";
    if (this.mode == "random") return "随机播放";
    return "单曲循环";
  }

  /** 本地歌单没有独立封面时，随第一首歌曲的图片变化；只用于展示。 */
  playlistDisplayPic(pl: Playlist): string {
    const pic = pl.picUrl != null ? pl.picUrl : "";
    if (pl.platform !== "local") return pic;
    if (
      pic.length > 0 &&
      pic !== DEFAULT_PLAYLIST_COVER_ASSET &&
      pic !== "/static/logo.png" &&
      pic !== "/static/qt-media/default-playlist-cover.png"
    ) return pic;
    const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
    const songs = this.songsOfPid(pid);
    if (songs.length > 0 && songs[0].picUrl != null && songs[0].picUrl.length > 0) {
      return songs[0].picUrl;
    }
    return DEFAULT_PLAYLIST_COVER_ASSET;
  }

  private applyListenDelta(song: Song, delta: ListenDelta | null): void {
    if (delta == null) return;
    useListenStatsStore().recordProgress(song, delta.seconds, delta.plays, delta.completed, delta.at);
  }

  private finishListenSession(): void {
    const song = this.current;
    if (song == null || this.endedTooEarly(song)) return;
    this.applyListenDelta(song, this.listenSession.end(Date.now()));
  }

  /**
   * 播放听歌报告/首页本地合辑。
   *
   * 报告存档会主动去掉临时 url；本地歌曲则从 qt-local-audio-v1 的扫描存档按
   * platform:id 找回 MediaStore uri。找不到 uri 的本地项无法播放，直接跳过；在线
   * 歌曲保留无 url 状态，由现有 Media3 懒解析链在真正播放时取地址。
   * 该入口只建立播放会话，不直接增加统计次数，统计仍由 ListenSession 在真实推进后结算。
   */
  async playReportSongs(songs: Song[], startIndex: number = 0): Promise<void> {
    if (songs.length == 0) return;
    const localUris = new Map<string, string>();
    try {
      const raw = uni.getStorageSync("qt-local-audio-v1");
      const items = raw as LocalAudioItem[];
      if (Array.isArray(items)) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item != null && item.id != null && item.id.length > 0 && item.uri != null && item.uri.length > 0) {
            localUris.set("local:" + item.id, item.uri);
          }
        }
      }
    } catch (_) {
      // 静默：存档损坏或旧基座返回异常值时，在线歌曲仍可正常播放。
    }
    let requested = Math.floor(startIndex);
    if (!Number.isFinite(requested) || requested < 0) requested = 0;
    if (requested >= songs.length) requested = songs.length - 1;
    const playable: Song[] = [];
    let selectedIndex = -1;
    for (let i = 0; i < songs.length; i++) {
      const source = songs[i];
      if (source == null || source.id == null || source.id.length == 0) continue;
      const song: Song = { ...source };
      if (song.platform == "local") {
        const uri = localUris.get("local:" + song.id);
        if (uri != null && uri.length > 0) song.url = uri;
        else continue;
      }
      if (selectedIndex < 0 && i >= requested) selectedIndex = playable.length;
      playable.push(song);
    }
    if (playable.length == 0) return;
    if (selectedIndex < 0) selectedIndex = playable.length - 1;
    await this.play(playable[selectedIndex], playable, false, false);
  }
}

/** 收藏同步引擎单例。必须是模块级变量：做成类字段会被 vue reactive 深代理，
 * host 也必须传 reactive 后的 player 代理（而非裸实例），否则引擎写数组不触发视图。 */
let likeSyncEngine: LikeSyncEngine | null = null;
function likeSync(): LikeSyncEngine {
  if (likeSyncEngine == null) likeSyncEngine = new LikeSyncEngine(player);
  return likeSyncEngine as LikeSyncEngine;
}

const player = reactive(new PlayerStore()) as PlayerStore;
export function usePlayerStore(): PlayerStore { return player; }
