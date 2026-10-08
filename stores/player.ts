import { reactive } from "vue";
import { audioPlayer } from "@/services/audio-player";
import { desktopLyric } from "@/services/desktop-lyric";
import { exitApp } from "@/services/app-native";
import { isContentFailError, musicApi } from "@/services/music-api";
import type { AudioPlaylistItem } from "@/uni_modules/qt-audio-player";
import { likeBatch, fetchChanges, fetchAllLikes } from "@/services/like";
import { parseJsonToUtso } from "@/services/http";
import type { Song, Playlist, LikeChange, PendingLikeOp } from "@/types/music";
import { getAccessToken } from "@/services/auth";
import { DEFAULT_PLAYLIST_COVER_ASSET } from "@/services/media";
import { qtDiag } from "@/services/diag";
import { useDislikesStore, DISLIKES_CHANGED_EVENT } from "@/stores/dislikes";
import { findCrossSourceDup, collectDupMessage, type CollectDupConflict } from "@/services/collect-dup";

const LIKED_KEY = "qt-liked-songs";
const HISTORY_KEY = "qt-history-songs";
const STATE_KEY = "qt-player-state";
/** 轻量进度键：进度时钟每 ~5 秒只写当前曲+进度，不拖着整条队列做全量序列化 */
const PROGRESS_KEY = "qt-player-progress";
const PLAYLIST_KEY = "qt-saved-playlists";
const LOCAL_PLAYLIST_KEY = "qt-local-playlists";
/** 收藏同步游标（LIKE_SYNC_DESIGN.md：多端增量拉取 since） */
const LIKE_CURSOR_KEY = "qt-like-cursor";
/** 待推送收藏操作队列（断网时暂存，联网后按序重放） */
const LIKE_OPS_KEY = "qt-like-pending-ops";
/** 收藏批量推送的单批上限（与后端 /like/batch 的 200 对齐，qt-stat 分片同款先例） */
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


/**
 * 生成全局唯一 pid（UUID v4 形态，36 字符，满足后端 ≤64 约束）。
 * 本地歌单用它作为多端同步的唯一键：不能用平台自己的歌单号（多端含义不同），
 * 也不能用「时间戳 + 短随机」（多设备同时建歌单会撞车）。
 */
function generateGlobalPid(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += hex.charAt(Math.floor(Math.random() * 16));
  }
  // 版本号 4 + 变体位，拼成 8-4-4-4-12 的标准形态
  const variant = "89ab".charAt(Math.floor(Math.random() * 4));
  return (
    out.substring(0, 8) +
    "-" +
    out.substring(8, 12) +
    "-4" +
    out.substring(13, 16) +
    "-" +
    variant +
    out.substring(17, 20) +
    "-" +
    out.substring(20, 32)
  );
}

function songToJson(song: Song): string {
  const obj = new UTSJSONObject();
  obj.set("id", song.id);
  obj.set("name", song.name);
  obj.set("singer", song.singer);
  obj.set("album", song.album);
  obj.set("picUrl", song.picUrl);
  obj.set("platform", song.platform);
  if (song.url != null && song.url.length > 0) obj.set("url", song.url);
  if (song.duration != null && song.duration > 0)
    obj.set("duration", song.duration);
  if (song.musicId != null && song.musicId.length > 0)
    obj.set("musicId", song.musicId);
  if (song.likeSeq != null && song.likeSeq > 0) obj.set("likeSeq", song.likeSeq);
  if (song.pids != null && song.pids.length > 0) {
    const pids: string[] = [];
    for (let i = 0; i < song.pids.length; i++) pids.push(song.pids[i]);
    obj.set("pids", pids);
  }
  return JSON.stringify(obj);
}

function songFromJson(text: string): Song | null {
  if (text.length == 0) return null;
  try {
    const obj = parseJsonToUtso(text);
    const id = obj.get("id") as string | null;
    if (id == null || id.length == 0) return null;
    const name = obj.get("name") as string | null;
    const singer = obj.get("singer") as string | null;
    const album = obj.get("album") as string | null;
    const picUrl = obj.get("picUrl") as string | null;
    const platform = obj.get("platform") as string | null;
    const url = obj.get("url") as string | null;
    const duration = obj.get("duration") as number | null;
    const musicId = obj.get("musicId") as string | null;
    const likeSeq = obj.get("likeSeq") as number | null;
    const pidsRaw = obj.get("pids") as string[] | null;
    let pids: string[] | undefined;
    if (pidsRaw != null && pidsRaw.length > 0) {
      pids = [];
      for (let i = 0; i < pidsRaw.length; i++) {
        const one = pidsRaw[i] as string;
        if (one != null && one.length > 0) pids.push(one);
      }
      if (pids.length == 0) pids = undefined;
    }
    return {
      id,
      name: name != null ? name : "",
      singer: singer != null ? singer : "",
      album: album != null ? album : "",
      picUrl: picUrl != null ? picUrl : "",
      platform: platform != null ? platform : "",
      url: url != null ? url : "",
      duration: duration != null ? duration : 0,
      musicId: musicId != null && musicId.length > 0 ? musicId : undefined,
      likeSeq: likeSeq != null && likeSeq > 0 ? likeSeq : undefined,
      pids,
    };
  } catch (_) {
    return null;
  }
}

function playlistToJson(playlist: Playlist): string {
  const obj = new UTSJSONObject();
  obj.set("id", playlist.id);
  obj.set("name", playlist.name);
  obj.set("picUrl", playlist.picUrl);
  obj.set("playCount", playlist.playCount);
  obj.set("platform", playlist.platform);
  obj.set("description", playlist.description != null ? playlist.description : "");
  if (playlist.likeSeq != null && playlist.likeSeq > 0) obj.set("likeSeq", playlist.likeSeq);
  if (playlist.pid != null && playlist.pid.length > 0) obj.set("pid", playlist.pid);
  if (playlist.tracks && playlist.tracks.length > 0) {
    const trackJson: string[] = [];
    for (let i = 0; i < playlist.tracks.length; i++) {
      trackJson.push(songToJson(playlist.tracks[i]));
    }
    obj.set("tracks", trackJson);
  }
  return JSON.stringify(obj);
}

function playlistFromJson(text: string): Playlist | null {
  if (text.length == 0) return null;
  try {
    const obj = parseJsonToUtso(text);
    const id = obj.get("id") as string | null;
    if (id == null || id.length == 0) return null;
    const name = obj.get("name") as string | null;
    const picUrl = obj.get("picUrl") as string | null;
    const playCount = obj.get("playCount") as string | null;
    const platform = obj.get("platform") as string | null;
    const descRaw = obj.get("description") as string | null;
    const tracksRaw = obj.get("tracks") as string[] | null;
    let tracks: Song[] | undefined;
    if (tracksRaw != null && tracksRaw.length > 0) {
      tracks = [];
      for (let i = 0; i < tracksRaw.length; i++) {
        const song = songFromJson(tracksRaw[i] as string);
        if (song != null) tracks.push(song);
      }
    }
    const likeSeqRaw = obj.get("likeSeq") as number | null;
    const pid = obj.get("pid") as string | null;
    return {
      id,
      name: name != null ? name : "",
      picUrl: picUrl != null ? picUrl : "",
      playCount: playCount != null ? playCount : "0",
      platform: platform != null ? platform : "",
      description: descRaw != null && descRaw.length > 0 ? descRaw : null,
      tracks,
      likeSeq: likeSeqRaw != null && likeSeqRaw > 0 ? likeSeqRaw : undefined,
      pid: pid != null && pid.length > 0 ? pid : undefined,
    };
  } catch (_) {
    return null;
  }
}

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
  sleepStopAfterCurrent = false;
  sleepEndTime = 0;
  quality = "320";
  private sleepTimer: number | null = null;
  /** 已因链接失效重取过地址的歌曲（platform:id）与重取时刻，避免「失败→重取」死循环 */
  private urlRetryKey = "";
  private urlRetryAt = 0;
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
  private likedDirty = true;
  private playlistsDirty = true;
  private localPlaylistsDirty = true;
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
  /** media3 时间线里的条目顺序（mediaId 列表）：时间线下标 ≠ 展示队列下标，定位用 */
  private timelineIds: string[] = [];
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
  /** 收藏同步游标（服务器 updated_seq 最大值，LIKE_SYNC_DESIGN.md D3） */
  private likeCursor = 0;
  /** 待推送收藏操作队列（断网暂存，联网后按序重放） */
  private pendingOps: PendingLikeOp[] = [];
  /** 收藏同步进行中标记（防止 flush 与 pull 并发交错） */
  private likeSyncBusy = false;

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
                console.log("[QT Player] 状态自愈：底层在播而 store 认为暂停，位置 " + t.toFixed(1));
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
        if (
          curMid.length > 0 &&
          audioPlayer.currentMediaId() == curMid &&
          !audioPlayer.isNativeIntendingToPlay()
        ) {
          this.activeProbeMisses++;
          if (this.activeProbeMisses >= 3) {
            this.activeProbeMisses = 0;
            console.log("[QT Player] 状态对账：底层已暂停而 store 认为在播，按底层拉平");
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
              console.log("[QT Player] 进度在末尾停住，补一次自动切歌");
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
      } catch (_) {}
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
        if (Date.now() < this.seekFreezeUntil) return;
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
        console.log("[QT Media] 原生播完回调 → 自动下一首");
        this.next(true);
      },
      () => {
        // 播放出错：有限次自动切歌，避免死循环刷日志
        this.handlePlaybackError();
      },
      (playing: boolean) => {
        // 状态栏媒体控制（通知栏播放/暂停/停止）改变播放状态时同步 UI
        if (this.playing != playing) {
          this.playing = playing;
          qtDiag("[QT Prog] 播放状态同步 → playing=" + playing);
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
      // 本地歌不走网络取链：地址就是 content:// 本体（pushTimeline 已直接推真实地址，
      // 正常不会进来；url 缺失的脏数据兜底在这里回填，缺失则按失败处理）
      if (song.platform == "local") {
        if (song.url != null && song.url.length > 0) {
          audioPlayer.resolveDone(mediaId, song.url);
        } else {
          audioPlayer.resolveFail(mediaId);
        }
        return;
      }
      this.fetchUrlWithTimeout(song, URL_FETCH_BUDGET_MS)
        .then((res: { url: string; stalled: boolean }) => {
          // 记下本次失败性质，handlePlaybackError 据此区分「网络慢」与「没地址」
          this.stalledMap.set(mediaId, res.stalled);
          if (res.url.length > 0) {
            // 留一份展示副本（管理端「当前播放地址」用，见 resolvedUrlMap），
            // 并把当前播放曲的 url 字段回填：展示入口读 current.url 时才不是空
            this.resolvedUrlMap.set(mediaId, res.url);
            const cur = this.current;
            if (cur != null && cur.platform + ":" + cur.id == mediaId) {
              cur.url = res.url;
            }
            audioPlayer.resolveDone(mediaId, res.url);
          } else {
            audioPlayer.resolveFail(mediaId);
          }
        })
        .catch(() => {
          this.stalledMap.set(mediaId, true);
          audioPlayer.resolveFail(mediaId);
        });
    });
    // 原生自动衔接下一首（时间线顺序）/媒体键切歌后对账：换 current、记历史、
    // 刷新歌词与封面。睡眠定时「当前歌播完停止」也在这里落地 —— 懒解析窗口里
    // 原生切歌无声，这里立即停播退出，听感就是「这首歌放完就停」。
    // 回调第二参 naturalEnd = 切换由「条目自然播到头」引发，用于提前结束自愈。
    audioPlayer.onTrackChanged((mediaId: string, naturalEnd: boolean) => {
      this.onNativeTrackChanged(mediaId, naturalEnd);
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

  /** 播放模式切换后立即同步循环模式给 media3（否则要等下一次推时间线才生效：
      播放中把顺序切成单曲循环，当前这首播完就该重头而不是进下一首） */
  syncRepeatMode(): void {
    audioPlayer.setRepeatMode(this.mode == "single" ? 1 : 2);
  }

  setSleep(minutes: number): void {
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
    } catch (_) {}
  }

  /** 读取收藏同步游标与待推送队列（LIKE_SYNC_DESIGN.md §5.4） */
  private loadLikeSync(): void {
    try {
      const cursorRaw = uni.getStorageSync(LIKE_CURSOR_KEY) as string;
      const cursor = cursorRaw.length > 0 ? parseFloat(cursorRaw) ?? 0 : 0;
      this.likeCursor = cursor > 0 ? cursor : 0;
    } catch (_) {
      this.likeCursor = 0;
    }
    try {
      const raw = uni.getStorageSync(LIKE_OPS_KEY) as string;
      if (raw.length == 0) {
        this.pendingOps = [];
        return;
      }
      const arr = JSON.parse(raw) as string[];
      const ops: PendingLikeOp[] = [];
      for (let i = 0; i < arr.length; i++) {
        try {
          const obj = parseJsonToUtso(arr[i] as string);
          const type = obj.get("type") as string | null;
          const action = obj.get("action") as string | null;
          const dataJson = obj.get("dataJson") as string | null;
          if (
            dataJson != null && dataJson.length > 0 &&
            (type == "song" || type == "playlist") &&
            (action == "add" || action == "remove")
          ) {
            ops.push({
              type: type as "song" | "playlist",
              action: action as "add" | "remove",
              dataJson,
            });
          }
        } catch (_) {}
      }
      this.pendingOps = ops;
    } catch (_) {
      this.pendingOps = [];
    }
  }

  private saveLikeSync(): void {
    try {
      uni.setStorageSync(LIKE_CURSOR_KEY, this.likeCursor.toString());
    } catch (_) {}
    try {
      const arr: string[] = [];
      for (let i = 0; i < this.pendingOps.length; i++) {
        const op = this.pendingOps[i];
        const obj = new UTSJSONObject();
        obj.set("type", op.type);
        obj.set("action", op.action);
        obj.set("dataJson", op.dataJson);
        arr.push(JSON.stringify(obj));
      }
      uni.setStorageSync(LIKE_OPS_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

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
    } catch (_) {}
  }

  private loadState(): void {
    try {
      const raw = uni.getStorageSync(STATE_KEY) as string;
      if (raw.length == 0) return;
      const obj = parseJsonToUtso(raw);
      const mode = obj.get("mode") as string | null;
      if (mode != null && mode.length > 0) this.mode = mode;
      const quality = obj.get("quality") as string | null;
      if (quality != null && quality.length > 0) this.quality = quality;
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
      } catch (_) {}
    } catch (_) {}
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
    } catch (_) {}
  }

  private saveState(): void {
    try {
      const obj = new UTSJSONObject();
      obj.set("mode", this.mode);
      obj.set("quality", this.quality);
      const counts = new UTSJSONObject();
      const countKeys = Array.from(this.playCounts.keys());
      for (let i = 0; i < countKeys.length; i++)
        counts.set(countKeys[i] as string, this.playCounts.get(countKeys[i] as string) ?? 0);
      obj.set("playCounts", counts);
      if (this.current != null) obj.set("current", songToJson(this.current));
      const queueJson: string[] = [];
      for (let index = 0; index < this.queue.length; index++)
        queueJson.push(songToJson(this.queue[index]));
      obj.set("queue", queueJson);
      obj.set("progress", this.progress);
      obj.set("duration", this.duration);
      uni.setStorageSync(STATE_KEY, JSON.stringify(obj));
    } catch (_) {}
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
  }

  async play(song: Song, queue: Song[] = [], restorePosition = false, auto = false): Promise<void> {
    // 用户手动发起的播放（点歌/播放全部/手动切歌/按播放续播）重开自动切歌熔断
    if (!auto) {
      this.autoNext = true;
      this.failStreak = 0;
      this.stallRetry = 0;
      this.stalledMap.clear();
      this.pauseIntentAt = 0;
      this.explicitPlayAt = Date.now();
    }
    // 播放全部/外部队列：先剔除被屏蔽的歌（点播的 song 永远保留——
    // 屏蔽语义是「别自动出现」，不是「禁止聆听」）。无规则时原样返回不复制
    if (queue.length > 0) {
      this.queue = useDislikesStore().filterQueue(queue, song);
    }
    const resumeAt = restorePosition && this.progress > 0 ? this.progress : 0;
    const prev = this.current;
    const switched =
      prev == null || prev.id != song.id || prev.platform != song.platform;
    // 同一首重播（点列表里正在播的歌/队列环绕/切回旧歌）：底层时间线当前条目就是
    // 这首歌时 seek(0)+resume 即可（不重复记历史/播放次数）。不能盲目 seek+resume ——
    // 冷启动后播放器还没建（时间线为空），那样会静默空转「点了没反应」，必须落到
    // 下面的完整推时间线流程（首播簿记 + 建播放器 + 定位）
    if (!switched && !restorePosition) {
      if (audioPlayer.currentMediaId() == this.mediaIdOf(song)) {
        this.seek(0);
        audioPlayer.resume();
        return;
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
    this.recordPlay(song);
    // 新的播放请求：允许该歌曲在链接失效时重取地址一次（见 handlePlaybackError）
    this.urlRetryKey = "";
    // 切换真发生在此刻：进度基准重置为新歌起点（或续播点），并给一小段外推窗口，
    // 防止基准重置在原生层生效前的旧位置读数把 progress 重新抬高（会永久冻住）
    this.markProgress(resumeAt);
    this.seekFreezeUntil = Date.now() + 800;
    // 队列推给 media3：条目用 qt-resolve:// 占位地址，真正加载那一刻才向 JS 换
    // 真实播放地址（懒解析）。play() 本身不再取址 —— 切歌瞬时完成；解析失败由
    // 原生 Error → handlePlaybackError 的既有重试/熔断路径兜住
    this.pushTimeline(song, resumeAt);
    this.persist();
    // 桌面歌词跟随切歌重新拉词
    desktopLyric.notifySongChanged();
    // 本地歌单里的歌可能缺封面（如服务器同步过来的收藏），播放时异步查询并回填
    if (song.picUrl == null || song.picUrl.length == 0) {
      this.backfillCover(song);
    }
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
    return v != null ? v : "";
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

  /** 时间线条目构建（pushTimeline / syncTimeline 共用） */
  private buildTimelineItem(s: Song): AudioPlaylistItem {
    const mid = this.mediaIdOf(s);
    // 本地歌直接推真实 content:// 地址：DefaultDataSource 按 scheme 路由到
    // ContentDataSource，不经过懒解析层也不进音频缓存（避免把本地文件再拷一份）。
    // 在线歌用懒解析占位符：q 仅调试用，实际音质由 resolve 回调取 this.quality 决定，
    // 换音质后尚未加载的条目自动用新档
    const item: AudioPlaylistItem = {
      mediaId: mid,
      uri:
        s.platform == "local" && s.url != null && s.url.length > 0
          ? s.url
          : "qt-resolve://song/?mid=" +
            encodeURIComponent(mid) +
            "&q=" +
            this.quality,
      title: s.name,
      artist: s.singer,
      album: s.album,
      coverUrl: s.picUrl,
    };
    return item;
  }

  /**
   * 把整条队列推给 media3 并定位到 song（懒解析占位地址）。
   * 顺序/单曲模式按队列原序；随机模式把队列洗牌成新的播放顺序（当前曲放首位），
   * 「下一首」由时间线顺序决定 —— 随机语义完全由 JS 侧控制，原生只管顺序衔接。
   * 循环模式同步映射给原生：单曲→REPEAT_ONE，顺序/随机→列表环绕。
   * 队列里找不到 song 时（恢复场景队列丢失等）用单条时间线兜底。
   */
  private pushTimeline(song: Song, resumeAt: number): void {
    // 重推时间线后 loader 会把位置直接跳到新起播点：这段位移不是「播放前进」，
    // 抑制窗口内一律不计入 healthyRun（否则重取地址会被误判成播放成功，见 onTime）
    this.healthyRun = 0;
    this.healthyIgnoreUntil = Date.now() + 3000;
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
    // 顺序/随机 → 列表环绕（随机的顺序来自洗牌时间线）。
    // 必须放在 setPlaylist 之后：首播时播放器由 setPlaylist 内部引导创建，
    // 先设 repeat 会打在 null 上静默丢失，整轮播放退化为不循环
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
    this.timelineIds = [];
    const items: AudioPlaylistItem[] = [];
    for (let i = 0; i < expected.length; i++) {
      const s = expected[i];
      if (s == null) continue;
      this.timelineIds.push(this.mediaIdOf(s));
      items.push(this.buildTimelineItem(s));
    }
    audioPlayer.syncTimeline(items, this.mediaIdOf(this.current));
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
        .playUrl(song, this.quality)
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
  private backfillCover(song: Song): void {
    musicApi
      .songCover(song)
      .then((cover: string) => {
        if (cover == null || cover.length == 0) return;
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
      })
      .catch(() => {});
  }

  recordPlay(song: Song): void {
    const key = song.platform + ":" + song.id;
    const current = this.playCounts.get(key);
    this.playCounts.set(key, (current != null ? current : 0) + 1);
  }

  playCount(song: Song): number {
    const key = song.platform + ":" + song.id;
    const value = this.playCounts.get(key);
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
      this.ensurePlayback();
    } else {
      this.pauseIntentAt = Date.now();
      audioPlayer.pause();
    }
    this.persist();
  }

  pause(): void {
    if (this.current == null) return;
    this.playing = false;
    this.pauseIntentAt = Date.now();
    audioPlayer.pause();
    this.persist();
  }

  /** 系统自动暂停（弱网重试打满/熔断停住）：与用户暂停区分，不记暂停意图，
      否则恢复探测会误判「用户不想听」而不自动重放 */
  private autoPause(): void {
    this.playing = false;
    audioPlayer.pause();
    this.persist();
  }

  resume(): void {
    if (this.current == null) return;
    this.playing = true;
    this.ensurePlayback();
    this.persist();
  }

  stop(): void {
    this.stopProgressClock();
    this.current = null;
    this.queue = [];
    this.playing = false;
    this.timelineIds = [];
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
    this.stopProgressClock();
    this.playing = false;
    audioPlayer.stop();
    this.persist();
  }

  /** 清除全部本地数据（设置页「清除全部缓存与数据」）：停播并清空内存态；
      收藏同步游标/待同步队列一并复位，避免残留操作被重放到服务器。
      存储键的删除由调用方负责（带白名单批量清）。 */
  resetLocalData(): void {
    this.stop();
    this.likedSongs = [];
    this.history = [];
    this.savedPlaylists = [];
    this.localPlaylists = [];
    this.likedDirty = true;
    this.playlistsDirty = true;
    this.localPlaylistsDirty = true;
    this.playCounts = new Map<string, number>();
    this.likeCursor = 0;
    this.pendingOps = [];
    this.persist();
  }

  next(auto: boolean = false): void {
    console.log(
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
    if (this.mode == "single" && auto) {
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
      // 顺序模式：循环扫描下一个未屏蔽的；扫完一轮全屏蔽则停在当前曲（重播）
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
      console.log("[QT Media] next() 目标仍是当前曲 → 重头播（play 同曲分支处理）");
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
    // 同曲事件（单曲循环/环绕重启条目）不做簿记；但若这轮是「自然播到头」而
    // 位置离末尾还远 = 内容提前结束，先自愈重放（见 tryRecoverEarlyEnd）
    if (cur != null && cur.id == song.id && cur.platform == song.platform) {
      if (naturalEnd && this.endedTooEarly(cur)) {
        if (this.tryRecoverEarlyEnd(cur)) return;
      }
      return;
    }
    // 手动点歌后原生仍可能送达旧时间线在途的 trackChanged（A≠B 即采信会把
    // current 短暂拉回旧歌，多记一条历史/播放次数）：点歌后短窗口内与当前
    // 选曲不符的事件一律丢弃；窗口之外的同名事件是正常的原生自动衔接。
    // 跨桥在途事件毫秒级送达，2.5s 窗口绰绰有余；正常自动衔接最快也在
    // 一首歌时长之后，不会误伤。
    if (cur != null && Date.now() - this.explicitPlayAt < 2500) {
      console.log("[QT Media] 忽略迟到的原生切歌事件 → " + mediaId);
      return;
    }
    // 原生自动衔接（naturalEnd）但上一首的位置离末尾还远 = 上一首内容提前
    // 结束（流被截断/缓存投毒，media3 视为正常播完，无停顿无错误事件），
    // 先清缓存从原位置重放上一首；重放仍提前结束就放行正常衔接
    if (cur != null && naturalEnd && this.endedTooEarly(cur)) {
      if (this.tryRecoverEarlyEnd(cur)) return;
    }
    console.log("[QT Media] 原生切歌 → " + mediaId);
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
    this.recordPlay(song);
    this.urlRetryKey = "";
    this.persist();
    desktopLyric.notifySongChanged();
    if (song.picUrl == null || song.picUrl.length == 0) {
      this.backfillCover(song);
    }
    if (this.sleepStopAfterCurrent) {
      this.sleepStopAfterCurrent = false;
      this.exitAfterSleep();
    }
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
      console.log(
        "[QT Player] 重放后仍提前结束（疑似试听片段/截断源），放行正常衔接: " +
          key
      );
      return false;
    }
    this.earlyEosKey = key;
    const meta = song.duration != null ? song.duration : 0;
    console.log(
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
    const song = this.current;
    // ① 弱网：原地重试，不动熔断计数
    if (song != null && this.isStalled(song)) {
      this.retryStalled(song);
      return;
    }
    if (song != null && song.platform != "local") {
      const key = song.platform + ":" + song.id;
      // 同一首歌只重取一次；换歌或超过一分钟后重新允许，覆盖长时间播放后再次失效的情况
      const expired = Date.now() - this.urlRetryAt > 60 * 1000;
      if (this.urlRetryKey != key || expired) {
        this.urlRetryKey = key;
        this.urlRetryAt = Date.now();
        this.refetchAndReplay(song);
        return;
      }
    }
    // 该曲已重取过仍失败：统一进失败处理（自动下一首标识开着就切下一首，
    // 连续 5 首失败熔断+通知栏提示，防止死歌队列无限空转）
    this.skipAfterFailure();
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
      console.log(
        "[QT Player] 连续" +
          STALLED_RETRY_LIMIT +
          "次因网络超时，停止自动重试，等待用户操作"
      );
      this.autoPause();
      uni.showToast({ title: "网络较慢，请稍后重试", icon: "none" });
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
    console.log(
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
        console.log("[QT Player] 退避期间用户已暂停，放弃自动重试");
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
              console.log("[QT Player] 第" + attempt + "次恢复探测成功，重开自动切歌");
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
      console.log(
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
      console.log("[QT Player] 网络已恢复，但用户已暂停，不自动重放");
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
    console.log(
      "[QT Player] 播放地址可能已失效，重新获取：" + song.platform + ":" + song.id
    );
    // 先作废该歌曲的地址缓存，否则重解析时 playUrl 会把刚失败的同一条 URL 再返回一次
    musicApi.invalidatePlayUrl(song, this.quality);
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
      uni.showToast({ title: "该歌曲暂时无法播放", icon: "none" });
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
      uni.showToast({ title: "自动播放失败，已停止自动切歌", icon: "none" });
      // 熔断是单向门的问题（2026-10-03）：挂恢复探测，网络/音源一恢复就自动
      // 重开自动切歌并重放当前曲，不要求用户手动操作
      this.scheduleRecoveryProbe();
      return;
    }
    console.log(
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
    console.log("[QT Media] previous() called");
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
    } catch (_) {}
  }

  currentIndex(): number {
    if (this.current == null) return -1;
    return this.queue.findIndex(
      (item) =>
        item.id == this.current!.id && item.platform == this.current!.platform
    );
  }

  playNext(song: Song): void {
    const index = this.currentIndex();
    const next: Song[] = [];
    const pos = index >= 0 ? index + 1 : this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (i == pos) next.push(song);
      next.push(this.queue[i]);
    }
    if (pos >= this.queue.length) next.push(song);
    this.queue = next;
    this.play(song);
  }

  addToQueue(song: Song): void {
    // 不喜欢列表：被屏蔽的歌不进队列（用户明确表达过「别自动出现」）
    if (useDislikesStore().isDisliked(song)) {
      uni.showToast({ title: "该歌曲已屏蔽", icon: "none" });
      return;
    }
    for (let index = 0; index < this.queue.length; index++) {
      const item = this.queue[index];
      if (item.id == song.id && item.platform == song.platform) return;
    }
    this.queue = [...this.queue, song];
    // 队列已归 media3：无损追加进原生时间线，否则自动衔接感知不到新加的歌
    this.syncTimeline();
    uni.showToast({ title: "已加入播放队列", icon: "none" });
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
    uni.showToast({ title, icon: "none" });
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
    }
  }

  /**
   * 云端下发的 local 歌单删除（机制 B）：按 pid 在两个存储里找齐并清理，
   * 成员归属一并摘除（不回推，服务端删歌单时已级联清了 (sid,pid) 行）。
   * LWW：本地条目 seq 比变更大说明本地更新（重命名后还没推上去），不动。
   */
  private removeLocalPlaylistEverywhere(pid: string, seq: number): void {
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
  }

  /**
   * 删除歌单时清理本地成员歌曲（不上送，服务器在删歌单时一并清 (sid,pid) 记录）：
   * 摘掉该歌单 pid 归属，pids 清空的歌整条从收藏总表移除并落盘。
   */
  private removeSongsOfPlaylistLocal(removed: Playlist): void {
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
   */
  addSongToPlaylist(song: Song, playlistId: string): void {
    this.addSongToPid(song, this.playlistPidOf(playlistId));
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
  private addPidToSong(song: Song, pid: string): boolean {
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
  private removePidFromSong(song: Song, pid: string): boolean {
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
  private findCollectedSongInList(
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
  private findCollectedSongById(id: string, platform: string): number {
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
  private isLocallyOwnedPlaylist(pid: string, platform: string): boolean {
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
    return this.collectiblePlaylists();
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
    return toAdd.length > 0 || toRemove.length > 0;
  }

  // ==================== 收藏同步（LIKE_SYNC_DESIGN.md §5） ====================

  /**
   * 单曲收藏 payload：只携带服务器需要的字段（不含 url 等本地字段）。
   * pid 为可选归属：收藏到哪个本地歌单就带上谁的 pid，为空表示不归属任何歌单。
   * 普通对象直出不建 UTSJSONObject：导入几百首时逐首建原生实例纯属浪费，
   * 还会放大 bytecode 运行时的实例注册表压力（曾触发「UTS instance is not registered」）。
   */
  private likeSongPayloadJson(song: Song, pid?: string): string {
    const obj: any = {
      sid: song.id,
      platform: song.platform,
      name: song.name,
      singer: song.singer,
      album: song.album,
    };
    if (song.musicId != null && song.musicId.length > 0) obj["hash"] = song.musicId;
    if (pid != null && pid.length > 0) obj["pid"] = pid;
    // 封面一并入 payload：在线收藏和离线重放共用，断网期间入队的收藏恢复后仍能带图
    if (song.picUrl != null && song.picUrl.length > 0) obj["picUrl"] = song.picUrl;
    return JSON.stringify(obj);
  }

  /** 歌单收藏 payload（pid 兜底：自建歌单缺 pid 时生成并写回本地缓存） */
  private likePlaylistPayloadJson(playlist: Playlist): string {
    // 歌单的 pid 就是它的全局唯一键，本地歌单用生成的 pid，其余沿用平台歌单号
    const pid = this.ensurePlaylistPid(playlist);
    const obj: any = {
      pid: pid,
      platform: playlist.platform,
      name: playlist.name,
    };
    if (playlist.picUrl != null && playlist.picUrl.length > 0) obj["picUrl"] = playlist.picUrl;
    return JSON.stringify(obj);
  }

  /** 本地变更入队并尝试推送（断网暂存，联网后自动补推） */
  private enqueueLikeOp(op: PendingLikeOp): void {
    this.pendingOps.push(op);
    this.saveLikeSync();
    this.flushPendingOps().catch(() => {});
  }

  /** 推送积压的收藏操作（对外入口，防止与增量拉取并发交错） */
  async flushPendingOps(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    if (this.likeSyncBusy) return;
    this.likeSyncBusy = true;
    try {
      await this.doFlushPendingOps();
    } finally {
      this.likeSyncBusy = false;
    }
  }

  /**
   * 推送这首歌在某个歌单下的收藏状态。
   *
   * 一首歌可以同时属于多个歌单，每个歌单在服务器上各有一条记录，
   * 所以 add 和 remove **都要带 pid** —— 后端按 (sid, pid) 定位，
   * 从某个歌单移除时才不会误删同一首歌在其他歌单里的记录。
   */
  private pushSongPid(song: Song, pid: string, action: "add" | "remove"): void {
    if (pid.length == 0) return;
    this.enqueueLikeOp({
      type: "song",
      action,
      dataJson: this.likeSongPayloadJson(song, pid),
    });
  }

  private hasPendingLikeOp(type: string, id: string, platform: string): boolean {
    for (let i = 0; i < this.pendingOps.length; i++) {
      const op = this.pendingOps[i];
      if (op.type != type) continue;
      try {
        const obj = parseJsonToUtso(op.dataJson);
        const oid = obj.get(type == "song" ? "sid" : "pid") as string | null;
        const pl = obj.get("platform") as string | null;
        if (oid != null && oid == id && pl != null && pl == platform) return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * 按序批量推送积压操作（/like/batch，单批上限 LIKE_BATCH_LIMIT）。
   * 整批原子：成功整批出队并盖 seq，失败整批原样留在队首保序重放（断网不丢，
   * upsert 幂等保证重放无害）；无效操作（本地歌无平台等）直接丢弃，
   * 与旧单条路径 seq=0 视同成功的语义一致。
   */
  private async doFlushPendingOps(): Promise<void> {
    while (this.pendingOps.length > 0) {
      // 预扫队首组装一批：无效 op 记下标（成功失败都要剔除），有效 op 进批。
      // 组批过程中不改动队列，失败时整批原样保留
      const batch: PendingLikeOp[] = [];
      const bodies: string[] = [];
      const invalidIdx: number[] = [];
      let scan = 0;
      while (scan < this.pendingOps.length && batch.length < LIKE_BATCH_LIMIT) {
        const op = this.pendingOps[scan];
        if (op != null) {
          const bodyJson = this.buildLikeOpBodyJson(op);
          if (bodyJson != null) {
            batch.push(op);
            bodies.push(bodyJson);
            scan++;
            continue;
          }
          console.log("[Player] 收藏批量推送丢弃无效操作 type=" + op.type + " action=" + op.action);
        }
        invalidIdx.push(scan);
        scan++;
      }
      // 无效 op 从后往前剔除（不影响前面的下标），并落盘
      for (let i = invalidIdx.length - 1; i >= 0; i--) {
        this.pendingOps.splice(invalidIdx[i], 1);
      }
      if (invalidIdx.length > 0) this.saveLikeSync();
      if (batch.length == 0) continue;
      let seq = 0;
      try {
        seq = await likeBatch(bodies);
        console.log("[Player] 收藏批量推送成功 " + batch.length + " 条 seq=" + seq);
      } catch (e) {
        console.log("[Player] 收藏批量推送失败 " + batch.length + " 条 err=" + (e != null ? e.toString() : "unknown"));
        return;
      }
      // 成功：整批出队并盖章。本批占用连续 seq 区段，统一盖整批最大 seq
      // 不会误判 LWW（其他端这期间的变更 seq 必然更大）
      for (let i = 0; i < batch.length; i++) {
        const idx = this.pendingOps.indexOf(batch[i]);
        if (idx >= 0) this.pendingOps.splice(idx, 1);
      }
      for (let i = 0; i < batch.length; i++) {
        const op = batch[i];
        if (op.action == "add") {
          if (op.type == "song") this.markSongLikedSeq(op.dataJson, seq);
          else this.markPlaylistLikedSeq(op.dataJson, seq);
        }
      }
      if (seq > this.likeCursor) this.likeCursor = seq;
      this.saveLikeSync();
    }
  }

  /**
   * 把一条待推送操作序列化成 /like/batch 的操作体 JSON 文本；无法上送返回 null
   * （如本地歌曲无 platform，由调用方丢弃）。字段映射与旧单条路径完全一致：
   * pid 兜底解析（存量队列缺 pid 时按收藏记录反查，必要时生成并写回本地）。
   * 封面不做逐条补查——批量路径不为封面再发 N 次网络请求，
   * payload 里已有的封面原样上送，缺封面的记录靠服务端 backfill 兜底。
   *
   * 全程普通 JS 对象（JSON.parse 直出、下标读写），不建 UTSJSONObject：
   * bytecode 运行时里 UTSJSONObject 是原生注册实例，一次导入几百首时
   * 整批建实例曾触发原生注册丢失（「UTS instance is not registered」）。
   */
  private buildLikeOpBodyJson(op: PendingLikeOp): string | null {
    const obj = JSON.parse(op.dataJson) as any;
    const body: any = { type: op.type, action: op.action };
    if (op.type == "song") {
      const sid = obj["sid"] as string | null;
      const songPlatform = obj["platform"] as string | null;
      // 本地歌与无平台信息的歌都无法在服务器建模（本地歌 platform 非空，
      // 是 "local"：推上云端后其他设备既无文件也无对应音源，取链必败），
      // 返回 null 由调用方丢弃
      if (sid == null || sid.length == 0 || songPlatform == null || songPlatform.length == 0) {
        return null;
      }
      if (songPlatform == "local") {
        return null;
      }
      body["sid"] = sid;
      body["platform"] = songPlatform;
      const name = obj["name"] as string | null;
      if (name != null && name.length > 0) body["name"] = name;
      const singer = obj["singer"] as string | null;
      if (singer != null && singer.length > 0) body["singer"] = singer;
      const album = obj["album"] as string | null;
      if (album != null && album.length > 0) body["album"] = album;
      const hash = obj["hash"] as string | null;
      if (hash != null && hash.length > 0) body["hash"] = hash;
      // 归属歌单 pid 兜底：payload 没带 pid 时（旧版本入队/存量数据），
      // 按这首歌的 pids 找到对应歌单并取（必要时生成）它的 pid
      let songPid = obj["pid"] as string | null;
      if (songPid == null || songPid.length == 0) {
        const resolved = this.resolveSongPidFallback(sid, songPlatform);
        if (resolved.length > 0) songPid = resolved;
      }
      if (songPid != null && songPid.length > 0 && songPid.length <= 64) {
        body["pid"] = songPid;
      }
      // 封面仅 add 且非空时上送（remove 没有图片语义，空值不上送避免覆盖云端已有图）
      if (op.action == "add") {
        const picUrl = obj["picUrl"] as string | null;
        if (picUrl != null && picUrl.length > 0) body["picUrl"] = picUrl;
      }
      return JSON.stringify(body);
    }
    const pid = obj["pid"] as string | null;
    const playlistPlatform = obj["platform"] as string | null;
    if (playlistPlatform == null || playlistPlatform.length == 0) {
      return null;
    }
    // 歌单 pid 兜底：仍为空（两端都空的异常数据）时生成一个，
    // 保证服务器按 pid upsert 的全局唯一键永远有值
    let finalPid = pid != null ? pid : "";
    if (finalPid.length == 0) {
      finalPid = generateGlobalPid();
      console.log("[Player] 歌单批量推送 pid 缺失，已生成 " + finalPid);
    }
    body["pid"] = finalPid;
    body["platform"] = playlistPlatform;
    const name = obj["name"] as string | null;
    if (name != null && name.length > 0) body["name"] = name;
    if (op.action == "add") {
      const picUrl = obj["picUrl"] as string | null;
      if (picUrl != null && picUrl.length > 0) body["picUrl"] = picUrl;
    }
    return JSON.stringify(body);
  }

  /** 在收藏总表里按 sid + platform 找本地歌曲条目，找不到返回 null */
  private findLikedSongEntry(sid: string, platform: string): Song | null {
    for (let i = 0; i < this.likedSongs.length; i++) {
      const s = this.likedSongs[i];
      if (s != null && s.id == sid && s.platform == platform) return s;
    }
    return null;
  }

  /**
   * 歌曲推送的 pid 兜底：按收藏记录里的 pids 找到对应歌单，
   * 取它的 pid（自建歌单 pid 为空则生成并写回本地缓存）。
   * 生成的新 pid 会同步登记进这首歌的 pids（写回本地缓存）。
   * 找不到任何对应歌单时返回空串（按无归属推送）。
   */
  private resolveSongPidFallback(sid: string, platform: string): string {
    const entry = this.findLikedSongEntry(sid, platform);
    if (entry == null || entry.pids == null) return "";
    for (let i = 0; i < entry.pids!.length; i++) {
      const pl = this.findPlaylistByPidOrId(entry.pids![i]);
      if (pl == null) continue;
      const pid = this.ensurePlaylistPid(pl);
      if (pid.length == 0) continue;
      if (pid != entry.pids![i]) {
        // 歌单 pid 是新生成的：把歌曲的归属引用也换成新 pid 并落盘
        this.addPidToSong(entry, pid);
        this.persist();
      }
      return pid;
    }
    return "";
  }

  /** 按 pid 或 id 在自建歌单与收藏歌单里找歌单，找不到返回 null */
  private findPlaylistByPidOrId(key: string): Playlist | null {
    if (key.length == 0) return null;
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const lp = this.localPlaylists[i];
      if (lp == null) continue;
      if (lp.id == key || (lp.pid != null && lp.pid == key)) return lp;
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      if (pl == null) continue;
      if (pl.id == key || (pl.pid != null && pl.pid == key)) return pl;
    }
    return null;
  }

  /**
   * 歌单 pid 兜底：返回用于上送的 pid。自建歌单（localPlaylists 里）pid 为空时
   * 生成全局唯一 pid 并写回本地缓存；在线歌单沿用平台歌单号（id），
   * 同步回来的自建歌单 id 即 pid，不能另造，否则多端对不上。
   */
  private ensurePlaylistPid(pl: Playlist): string {
    if (pl.pid != null && pl.pid.length > 0) return pl.pid!;
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const lp = this.localPlaylists[i];
      if (lp != null && lp.id == pl.id) {
        lp.pid = generateGlobalPid();
        this.saveLocalPlaylistList();
        console.log("[Player] 自建歌单 pid 缺失，已生成并写回本地 " + pl.name + " → " + lp.pid!);
        return lp.pid!;
      }
    }
    return pl.id;
  }

  /** 推送成功后把服务器 seq 回写到本地条目（后续增量比较用） */
  private markSongLikedSeq(dataJson: string, seq: number): void {
    try {
      const obj = parseJsonToUtso(dataJson);
      const sid = obj.get("sid") as string | null;
      const platform = obj.get("platform") as string | null;
      if (sid == null || platform == null) return;
      for (let i = 0; i < this.likedSongs.length; i++) {
        const song = this.likedSongs[i];
        if (song.id == sid && song.platform == platform) {
          song.likeSeq = seq;
          // 推送成功后回写 seq：这里没有跟着 persist()，靠脏标记留给下一次落盘
          this.likedDirty = true;
          return;
        }
      }
    } catch (_) {}
  }

  private markPlaylistLikedSeq(dataJson: string, seq: number): void {
    try {
      const obj = parseJsonToUtso(dataJson);
      const pid = obj.get("pid") as string | null;
      const platform = obj.get("platform") as string | null;
      if (pid == null || platform == null) return;
      for (let i = 0; i < this.savedPlaylists.length; i++) {
        const pl = this.savedPlaylists[i];
        if (pl.id == pid && pl.platform == platform) {
          pl.likeSeq = seq;
          this.playlistsDirty = true;
          return;
        }
      }
      // 本地自建歌单也记 likeSeq（按 pid 匹配），否则每次启动补推都会重复上送
      for (let i = 0; i < this.localPlaylists.length; i++) {
        const pl = this.localPlaylists[i];
        if (pl != null && pl.pid == pid && pl.platform == platform) {
          pl.likeSeq = seq;
          this.saveLocalPlaylistList();
          return;
        }
      }
    } catch (_) {}
  }

  /**
   * 增量拉取多端收藏变更（D3）：先推送本地积压操作，再按游标拉取并应用。
   * 游标为 0（首次登录/游标丢失）时转全量分页拉取。
   */
  async pullChanges(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    if (this.likeSyncBusy) return;
    this.likeSyncBusy = true;
    try {
      // 「要不要全量拉取」必须在推送之前定下来：doFlushPendingOps 推成功后会把游标
      // 推到服务器新分配的 seq，若在推送后再判 likeCursor <= 0 就永远不成立，
      // 首次登录时账号里已有的云端收藏会被整批跳过（增量只取 seq 更大的变更），
      // 而且之后每次启动游标都 > 0，再也补不回来。
      const needFullPull = this.likeCursor <= 0;
      await this.doFlushPendingOps();
      if (needFullPull) {
        await this.doFullPull();
        return;
      }
      let guard = 0;
      while (guard++ < 50) {
        const res = await fetchChanges(this.likeCursor);
        if (res == null) break;
        // 服务器 maxSeq 比本地游标还小说明数据库被重建过（seq 重新从 1 计）：
        // 旧游标已失效，对齐到新库，否则后续增量拉取会永远落在新库 maxSeq 之后
        if (res.maxSeq < this.likeCursor) {
          console.log("[Player] 检测到服务器收藏版本号倒退（数据库可能被重建），游标对齐 " + this.likeCursor + " → " + res.maxSeq);
          this.likeCursor = res.maxSeq;
          this.saveLikeSync();
          break;
        }
        if (res.changes.length == 0) {
          if (res.maxSeq > this.likeCursor) this.likeCursor = res.maxSeq;
          break;
        }
        let maxApplied = this.likeCursor;
        for (let i = 0; i < res.changes.length; i++) {
          const change = res.changes[i];
          if (change.updatedSeq > maxApplied) maxApplied = change.updatedSeq;
          this.applyLikeChange(change);
        }
        this.likeCursor = maxApplied;
        this.saveLikeSync();
        this.persist();
      }
    } catch (e) {
      console.log("[Player] 收藏增量同步失败", e);
    } finally {
      this.likeSyncBusy = false;
    }
  }

  /** 单条变更应用（D4 last-write-wins：updated_seq 大者胜出） */
  private applyLikeChange(change: LikeChange): void {
    if (change.type == "song") this.applySongChange(change);
    else this.applyPlaylistChange(change);
  }

  /**
   * 应用一条歌曲变更到收藏总表（**不推送**，否则「拉下来 → 又推上去」会无限回环）。
   *
   * 变更里的 pid 定位的是「这首歌在哪个歌单里的那一条记录」，
   * 所以新增/更新时把 pid 并入该歌曲的 pids，删除时只摘掉这一个 pid ——
   * 摘完还有其他 pid 说明它还在别的歌单里，整条记录要留着。
   */
  private applySongChange(change: LikeChange): void {
    const idx = this.findCollectedSongById(change.id, change.platform);
    if (change.deleted) {
      if (idx < 0) return;
      const entry = this.likedSongs[idx];
      const localSeq = entry.likeSeq != null ? entry.likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      // 只摘变更里指定的那一个 pid
      if (change.pid != null && change.pid.length > 0) {
        this.removePidFromSong(entry, change.pid);
        if (entry.pids != null && entry.pids.length > 0) {
          entry.likeSeq = change.updatedSeq;
          this.likedDirty = true;
          this.persist();
          return;
        }
      }
      const next: Song[] = [];
      for (let i = 0; i < this.likedSongs.length; i++) {
        if (i != idx) next.push(this.likedSongs[i]);
      }
      this.likedSongs = next;
      this.likedDirty = true;
      this.persist();
      return;
    }
    if (idx >= 0) {
      const entry = this.likedSongs[idx];
      const localSeq = entry.likeSeq != null ? entry.likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      entry.name = change.name;
      entry.singer = change.singer;
      entry.album = change.album;
      if (change.hash.length > 0 && change.hash.toLowerCase() != "nohash") entry.musicId = change.hash;
      // 封面「非空覆盖、空值保留」：空图变更不清掉本地已有封面
      if (change.picUrl != null && change.picUrl.length > 0) entry.picUrl = change.picUrl;
      if (change.pid != null && change.pid.length > 0) this.addPidToSong(entry, change.pid);
      entry.likeSeq = change.updatedSeq;
      this.likedDirty = true;
      this.persist();
      return;
    }
    // 本地不存在的新收藏（另一台设备加的）
    if (this.hasPendingLikeOp("song", change.id, change.platform)) return;
    const song: Song = {
      id: change.id,
      name: change.name,
      singer: change.singer,
      album: change.album,
      picUrl: change.picUrl != null && change.picUrl.length > 0 ? change.picUrl : "",
      platform: change.platform,
      likeSeq: change.updatedSeq,
    };
    if (change.pid != null && change.pid.length > 0) song.pids = [change.pid];
    if (change.hash.length > 0 && change.hash.toLowerCase() != "nohash") song.musicId = change.hash;
    this.likedSongs.push(song);
    this.likedDirty = true;
    this.persist();
  }

  private applyPlaylistChange(change: LikeChange): void {
    // platform=local 的删除是「自建歌单被删」（本机或他端操作）：
    // 本机建的在 localPlaylists、他端建的在 savedPlaylists，两处都查、
    // 摘成员归属并落盘，否则歌单以幽灵形态残留、下次对账还会把它复活
    if (change.deleted && change.platform === 'local') {
      const pid = change.pid != null && change.pid.length > 0 ? change.pid! : change.id;
      if (pid.length > 0) {
        this.removeLocalPlaylistEverywhere(pid, change.updatedSeq);
      }
      return;
    }
    let idx = -1;
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      if (pl.id == change.id && pl.platform == change.platform) {
        idx = i;
        break;
      }
    }
    if (change.deleted) {
      if (idx < 0) return;
      const localSeq = this.savedPlaylists[idx].likeSeq != null ? this.savedPlaylists[idx].likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      const next: Playlist[] = [];
      for (let i = 0; i < this.savedPlaylists.length; i++) {
        if (i != idx) next.push(this.savedPlaylists[i]);
      }
      this.savedPlaylists = next;
      // 这里刻意不 persist()（增量拉取的循环外统一落盘），只置脏；
      // 若调用方中途异常退出，脏标记会留给下一次 persist() 兜底
      this.playlistsDirty = true;
      return;
    }
    if (idx >= 0) {
      const local = this.savedPlaylists[idx];
      const localSeq = local.likeSeq != null ? local.likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      // 补 pid：增量路径下歌单可能只有 id，pid 缺失会导致收藏时匹配不上
      if (change.pid != null && change.pid.length > 0) local.pid = change.pid;
      else if (local.pid == null || local.pid.length == 0) local.pid = change.id;
      local.name = change.name;
      if (change.picUrl.length > 0) local.picUrl = change.picUrl;
      local.likeSeq = change.updatedSeq;
      this.savedPlaylists[idx] = local;
      this.playlistsDirty = true;
      return;
    }
    // 本机自建歌单：服务器的这条变更只回写元数据，不再另建一条 savedPlaylists 记录 ——
    // 展示层是 localPlaylists + savedPlaylists 直接拼接，重复收下会出两张卡、计数多 1
    const incomingPid = change.pid != null && change.pid.length > 0 ? change.pid! : change.id;
    if (this.isLocallyOwnedPlaylist(incomingPid, change.platform)) {
      for (let i = 0; i < this.localPlaylists.length; i++) {
        const lp = this.localPlaylists[i];
        const lpid = lp.pid != null && lp.pid.length > 0 ? lp.pid! : lp.id;
        if (lpid != incomingPid || lp.platform != change.platform) continue;
        const localSeq = lp.likeSeq != null ? lp.likeSeq! : 0;
        if (localSeq > change.updatedSeq) return;
        if (change.name.length > 0) lp.name = change.name;
        if (change.picUrl.length > 0) lp.picUrl = change.picUrl;
        lp.likeSeq = change.updatedSeq;
        this.saveLocalPlaylistList();
        return;
      }
    }
    if (this.hasPendingLikeOp("playlist", change.id, change.platform)) return;
    this.savedPlaylists.push({
      id: change.id,
      name: change.name,
      picUrl: change.picUrl,
      playCount: "",
      platform: change.platform,
      description: null,
      likeSeq: change.updatedSeq,
      pid: incomingPid,
    });
    this.playlistsDirty = true;
  }

  /** 全量分页拉取（首次登录 / 游标丢失兜底，LIKE_SYNC_DESIGN.md §2.4/§5.6） */
  private async doFullPull(): Promise<void> {
    const serverSongs: Song[] = [];
    const serverPlaylists: Playlist[] = [];
    let maxSeq = 0;
    let page = 1;
    while (page <= 100) {
      const res = await fetchAllLikes(page, 500);
      if (res == null) break;
      for (let i = 0; i < res.songs.length; i++) serverSongs.push(res.songs[i]);
      for (let i = 0; i < res.playlists.length; i++) serverPlaylists.push(res.playlists[i]);
      if (res.maxSeq > maxSeq) maxSeq = res.maxSeq;
      if (res.songs.length == 0 && res.playlists.length == 0) break;
      page++;
    }
    // 一首歌属于多个歌单时，服务器会返回多条（同 sid、不同 pid），
    // 先按 id + platform 合并成一条，把各个 pid 收进 pids 数组
    const collapsedSongs: Song[] = [];
    for (let i = 0; i < serverSongs.length; i++) {
      const s = serverSongs[i];
      const hit = this.findCollectedSongInList(collapsedSongs, s.id, s.platform);
      if (hit < 0) {
        collapsedSongs.push(s);
        continue;
      }
      const target = collapsedSongs[hit];
      if (s.pids != null) {
        for (let k = 0; k < s.pids.length; k++) this.addPidToSong(target, s.pids[k]);
      }
      // 同歌多 pid 的多行里可能只有一行带封面，合并时优先保留非空图片
      if ((target.picUrl == null || target.picUrl.length == 0) && s.picUrl.length > 0) {
        target.picUrl = s.picUrl;
      }
      const sSeq = s.likeSeq != null ? s.likeSeq! : 0;
      const tSeq = target.likeSeq != null ? target.likeSeq! : 0;
      if (sSeq > tSeq) target.likeSeq = sSeq;
    }
    // 以服务器为准重建；本地「有待推送操作」或「seq 更新」的条目保留（LWW）
    const mergedSongs: Song[] = [];
    for (let i = 0; i < collapsedSongs.length; i++) mergedSongs.push(collapsedSongs[i]);
    for (let i = 0; i < this.likedSongs.length; i++) {
      const local = this.likedSongs[i];
      let serverSeq = 0;
      let foundIdx = -1;
      for (let j = 0; j < mergedSongs.length; j++) {
        const s = mergedSongs[j];
        const sSeq = s.likeSeq != null ? s.likeSeq! : 0;
        if (s.id == local.id && s.platform == local.platform) {
          foundIdx = j;
          serverSeq = sSeq;
          break;
        }
      }
      const localSeq = local.likeSeq != null ? local.likeSeq! : 0;
      if (this.hasPendingLikeOp("song", local.id, local.platform) || localSeq > serverSeq) {
        if (foundIdx >= 0) mergedSongs[foundIdx] = local;
        else mergedSongs.push(local);
      }
    }
    this.likedSongs = mergedSongs;
    this.likedDirty = true;
    const mergedPlaylists: Playlist[] = [];
    for (let i = 0; i < serverPlaylists.length; i++) {
      const pl = serverPlaylists[i];
      // 本机自建、已推送上去的歌单在本地以 localPlaylists 里的原条目为准，
      // 服务器那份不重复收下（否则「我的收藏歌单」出两张卡、计数多 1）
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (this.isLocallyOwnedPlaylist(pid, pl.platform)) continue;
      mergedPlaylists.push(pl);
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const local = this.savedPlaylists[i];
      // 历史版本的全量拉取可能已把本机自建歌单写进 savedPlaylists，与 localPlaylists
      // 形成重复条目；这里一并剔除，避免下面按「本地 seq 更新」的规则又把它加回来
      const localPid = local.pid != null && local.pid.length > 0 ? local.pid! : local.id;
      if (this.isLocallyOwnedPlaylist(localPid, local.platform)) continue;
      let serverSeq = 0;
      let foundIdx = -1;
      for (let j = 0; j < mergedPlaylists.length; j++) {
        const pl = mergedPlaylists[j];
        const plSeq = pl.likeSeq != null ? pl.likeSeq! : 0;
        if (pl.id == local.id && pl.platform == local.platform) {
          foundIdx = j;
          serverSeq = plSeq;
          break;
        }
      }
      const localSeq = local.likeSeq != null ? local.likeSeq! : 0;
      if (this.hasPendingLikeOp("playlist", local.id, local.platform) || localSeq > serverSeq) {
        if (foundIdx >= 0) mergedPlaylists[foundIdx] = local;
        else mergedPlaylists.push(local);
      }
    }
    this.savedPlaylists = mergedPlaylists;
    this.playlistsDirty = true;
    if (maxSeq > this.likeCursor) this.likeCursor = maxSeq;
    this.saveLikeSync();
    this.persist();
  }

  /** 从服务器加载收藏列表（登录/启动触发）：按游标增量拉取，游标缺失转全量分页 */
  async syncLikedFromServer(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    // 先把数据库里缺失的本地歌单元数据补上（历史版本新建歌单不上送，
    // 这里按 likeSeq 判断补推一次；服务器按 pid upsert 幂等）
    this.backfillLocalPlaylistsSync();
    await this.pullChanges();
  }

  /**
   * 登录后的收藏同步：登录页不再 await 它（全量拉取可能好几秒，卡在登录页
   * 体感很差），后台跑；超过 600ms 还没完成才弹全局加载框提示，完成后收回——
   * 快网下一闪而过的加载框反而是噪音。失败静默（登录跳转不受影响）。
   *
   * 启动前先等 700ms：登录侧 500ms 后才跳转，而 uni.showLoading 的共享数据
   * 绑定「调用时的前台页面」——在随后销毁的登录页上调，框架会把已销毁的
   * Activity 钉进全局注册表（UniShowLoadingPageSharedData 泄漏，真机
   * LeakCanary 实测 7.8KB）。延后启动，加载框绑到跳转后的活页面上。
   */
  async syncLikedFromServerInBackground(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, 700) as number);
    let shown = false;
    const showTimer = setTimeout(() => {
      shown = true;
      uni.showLoading({ title: "正在同步收藏" });
    }, 600) as number;
    try {
      await this.syncLikedFromServer();
    } catch (_) {
      // 忽略同步失败（与旧登录流程同语义）
    } finally {
      clearTimeout(showTimer);
      if (shown) uni.hideLoading();
    }
  }

  /**
   * 本地自建歌单元数据补推：只推「从未成功同步过（无 likeSeq）且当前不在待推送队列」的歌单。
   * 推送成功后 markPlaylistLikedSeq 会把 seq 记回本地歌单，之后不再重复。
   */
  private backfillLocalPlaylistsSync(): void {
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const pl = this.localPlaylists[i];
      if (pl == null) continue;
      if (pl.likeSeq != null && pl.likeSeq! > 0) continue;
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (this.hasPendingLikeOp("playlist", pid, pl.platform)) continue;
      this.enqueueLikeOp({ type: "playlist", action: "add", dataJson: this.likePlaylistPayloadJson(pl) });
    }
  }

  /**
   * 启动时收藏同步：先增量拉取（把其他端先发生的删除/修改落到本地，避免下面的
   * 补推把已删除的收藏"复活"），再与服务器做一次存在性对账补推。
   */
  async syncLikesOnLaunch(): Promise<void> {
    await this.syncLikedFromServer();
    const count = await this.reconcileLikesWithServer();
    if (count > 0) console.log('[Player] 启动对账补推收藏 ' + count + ' 项');
  }

  /**
   * 启动对账：全量拉取服务器收藏，本地有而服务器没有的条目补推（存在性 diff）。
   *
   * 背景：likeSeq 是「该条在服务器上的版本号」，客户端据此判断已同步；服务器
   * 整库重建后 seq 重新从 1 计、或只删了部分数据（seq 不倒退），版本号对比都
   * 发现不了缺失。这里只按「服务器是否存在」判断，不比较版本号，两类场景都能
   * 自愈。增量拉取先行，所以其他端删除的收藏本地已移除，不会被误补。
   * 歌曲按 sid+platform 整档判断（不按 pid 行级判断，避免补出重复归属行）。
   * 服务器按 sid/pid upsert，重复执行幂等。返回补推条数。
   */
  private async reconcileLikesWithServer(): Promise<number> {
    const token = getAccessToken();
    if (!token) return 0;
    const serverPlaylistKeys: string[] = [];
    const serverSongKeys: string[] = [];
    let page = 1;
    while (page <= 100) {
      const res = await fetchAllLikes(page, 500);
      if (res == null) break;
      for (let i = 0; i < res.playlists.length; i++) {
        const pl = res.playlists[i];
        const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
        serverPlaylistKeys.push(pl.platform + "|" + pid);
      }
      for (let i = 0; i < res.songs.length; i++) {
        const s = res.songs[i];
        serverSongKeys.push(s.platform + "|" + s.id);
      }
      if (res.songs.length == 0 && res.playlists.length == 0) break;
      page++;
    }
    let count = 0;
    let removedCount = 0;
    // 歌单按「云端确认点」（likeSeq，推送成功时由服务器分配回写）三分
    //（机制 B，见 LIKE_SYNC_DESIGN.md §5）：likeSeq = 0 从未上送 → 补推；
    // 有 likeSeq 而云端集合没有 → 他端已删 → 本地跟随移除，否则本机建、
    // 他端删的歌单会被对账无条件补推，云端复活后全端又收回来
    // 歌单补推/跟随删：收藏的在线歌单 + 本地自建，一个歌单一条记录（按 pid upsert）
    for (let i = this.savedPlaylists.length - 1; i >= 0; i--) {
      const pl = this.savedPlaylists[i];
      if (pl == null) continue;
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (serverPlaylistKeys.indexOf(pl.platform + "|" + pid) >= 0) continue;
      if (this.hasPendingLikeOp("playlist", pid, pl.platform)) continue;
      const localSeq = pl.likeSeq != null ? pl.likeSeq! : 0;
      if (localSeq > 0) {
        // 云端确认过、现在没了 → 他端取消收藏/删除，本地跟随
        removedCount++;
        this.savedPlaylists.splice(i, 1);
        this.playlistsDirty = true;
        if (pl.platform === 'local') this.removeSongsOfPlaylistLocal(pl);
        continue;
      }
      this.enqueueLikeOp({ type: "playlist", action: "add", dataJson: this.likePlaylistPayloadJson(pl) });
      count++;
    }
    for (let i = this.localPlaylists.length - 1; i >= 0; i--) {
      const pl = this.localPlaylists[i];
      if (pl == null) continue;
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (serverPlaylistKeys.indexOf(pl.platform + "|" + pid) >= 0) continue;
      if (this.hasPendingLikeOp("playlist", pid, pl.platform)) continue;
      const localSeq = pl.likeSeq != null ? pl.likeSeq! : 0;
      if (localSeq > 0) {
        removedCount++;
        this.localPlaylists.splice(i, 1);
        this.removeSongsOfPlaylistLocal(pl);
        continue;
      }
      this.enqueueLikeOp({ type: "playlist", action: "add", dataJson: this.likePlaylistPayloadJson(pl) });
      count++;
    }
    if (removedCount > 0) {
      this.saveLocalPlaylistList();
      this.persist();
      console.log("[Player] 对账跟随云端移除歌单 " + removedCount + " 个");
    }
    // 歌曲补推：同一首歌属于 N 个歌单就推 N 条（服务器按 sid+pid 建模），无 pid 推一条默认归属
    for (let i = 0; i < this.likedSongs.length; i++) {
      const song = this.likedSongs[i];
      if (song == null || song.id.length == 0) continue;
      if (song.platform.length == 0) continue;
      if (serverSongKeys.indexOf(song.platform + "|" + song.id) >= 0) continue;
      if (this.hasPendingLikeOp("song", song.id, song.platform)) continue;
      const pids = song.pids != null && song.pids.length > 0 ? song.pids! : [""];
      for (let j = 0; j < pids.length; j++) {
        const opPid = pids[j] as string;
        // 主归属歌单刚被跟随删除的，成员行云端已级联软删，
        // 再补推会把刚删的歌单连歌一起复活
        if (opPid.length > 0 && !this.playlistExistsLocally(opPid)) continue;
        this.enqueueLikeOp({
          type: "song",
          action: "add",
          dataJson: this.likeSongPayloadJson(song, opPid),
        });
        count++;
      }
    }
    if (count > 0 || removedCount > 0) {
      this.persist();
      await this.flushPendingOps();
    }
    return count;
  }

  /** 该 pid 的歌单本地是否还存在（两个存储都查；对账歌曲补推的准入检查） */
  private playlistExistsLocally(pid: string): boolean {
    for (let i = 0; i < this.localPlaylists.length; i++) {
      const lp = this.localPlaylists[i];
      if (lp == null) continue;
      const lpid = lp.pid != null && lp.pid.length > 0 ? lp.pid! : lp.id;
      if (lpid == pid) return true;
    }
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const sp = this.savedPlaylists[i];
      if (sp == null) continue;
      const spid = sp.pid != null && sp.pid.length > 0 ? sp.pid! : sp.id;
      if (spid == pid) return true;
    }
    return false;
  }

  /** 退出登录时重置收藏同步状态：清空游标与待推送队列，避免串到下一个账号 */
  resetLikeSync(): void {
    this.likeCursor = 0;
    this.pendingOps = [];
    this.saveLikeSync();
  }

  /**
   * 切换账号时清空本地收藏缓存（账号归属标记检测到换号时调用）。
   * 服务器是数据源，A 的数据留在 A 的服务器账号里；新账号登录后
   * syncLikedFromServer 游标为 0 会自动全量拉取本账号数据恢复本地。
   * 不动播放历史、下载等设备级数据。
   */
  clearLocalLikeData(): void {
    this.likedSongs = [];
    this.savedPlaylists = [];
    this.localPlaylists = [];
    this.likedDirty = true;
    this.playlistsDirty = true;
    this.localPlaylistsDirty = true;
    this.persist();
    this.resetLikeSync();
    console.log("[Player] 检测到切换账号，已清空本地收藏缓存");
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
      uni.showToast({ title: "还没有歌单，请先新建", icon: "none" });
      return;
    }
    const names: string[] = [];
    for (let i = 0; i < lists.length; i++) names.push(lists[i].name);
    uni.showActionSheet({
      itemList: names,
      success: (res: any) => {
        const tap = res != null ? (res.tapIndex as number) : -1;
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
          uni.showModal({
            title: "同名歌曲提示",
            content: collectDupMessage(this.playlistNameOf(targetId), dups),
            confirmText: "继续收藏",
            cancelText: "取消",
            success: (m: any) => {
              const ok = m != null && (m.confirm as boolean);
              if (ok) this.applyPickerSelection(song, next);
            },
          });
          return;
        }
        this.applyPickerSelection(song, next);
      },
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

  /**
   * 更新收藏歌单的自定义封面（UPDATE_DESIGN.md §5.3）。
   * 服务端已由 cover/complete 直写 qt_like_playlist.pic_url，这里只同步本地缓存；
   * 后续 likePlaylist add 重放会带上新 URL，两端一致。
   */
  setSavedPlaylistCover(platform: string, pid: string, picUrl: string): void {
    for (let i = 0; i < this.savedPlaylists.length; i++) {
      const pl = this.savedPlaylists[i];
      // 在线歌单的 pid 就是平台歌单号（与 id 相同），两个键都兜一下
      if (pl.platform === platform && (pl.id === pid || pl.pid === pid)) {
        pl.picUrl = picUrl;
        this.savePlaylistList();
        return;
      }
    }
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
}

const player = reactive(new PlayerStore()) as PlayerStore;

export function usePlayerStore(): PlayerStore {
  return player;
}
