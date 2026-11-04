/**
 * 私人 FM 的状态机（2026-11-03 移植自 qt-pc src/stores/radio.ts，m04914「将qt-pc的私人FM移植到qt-uniappx」）。
 *
 * ## 和每日推荐的关系
 * 每日推荐是「一次生成 50 首 + 落缓存 + 可复现」，FM 是「一直听下去」。
 * 两者共用同一套画像（`loadPreference()`）与打分引擎（`radio-queue.ts` / `recommend-rank.ts`），
 * 区别只在**取数节奏**：FM 每次补 `RADIO_BATCH` 首，靠 `usedKeys` 保证一轮里不重复。
 *
 * ## 队列放在哪
 * FM 的「接下来几首」就是播放器队列本身 —— 不另建影子队列，否则「下一首」按钮、
 * 队列面板、本页三处会各说各话。所以：
 * - 第一批 `player.play(batch[0], batch)` —— 整队替换、从头播；
 * - 后续批次 `player.enqueueMany(batch, true)` —— **追加到队尾，不打断当前曲目**
 *   （silent=true：补歌不该弹「已加入 N 首」的 toast）。
 *
 * 进 FM 之前正在放的那份播放列表会被整份抄进 `stash`（曲目 + 序号 + 播放位置 +
 * 播放/暂停），用户点「停止 FM」时按原样放回去 —— 对齐网易云：退出 FM 仍能接着放
 * 原来的播放列表。让位退出（用户自己换了队列）不还原：那是用户的选择。
 *
 * ## 队列归属（queueClaimed）
 * 只有整队替换真正落地 FM 才算「持有」这个队列：`queueClaimed` 记这一点，
 * `tick()` / `ensure()` / `refill()` 都会先核对当前播放器队列是否还是 FM 推过的那批
 * （每首的 key 都在 `usedKeys` 里）。用户双击别的歌单 / 清空队列 → FM 主动让位（stop），
 * 绝不往别人家的队列里追加推荐歌。
 *
 * ## 播放模式
 * FM 的语义是「沿队列顺序一直听下去」：随机 / 单曲循环模式下「下一首」会跳到队列里
 * 任意一首，页面上的「接下来」当场换成另一批。所以 FM 持有队列期间强制顺序播放
 * （player.mode = "sequence" + syncRepeatMode），并把用户原来的模式记在 `restoreMode`，
 * 停止或让位时还回去。
 *
 * ## 心跳放在本 store
 * 补歌不绑页面可见性：页面留（离开页面也要继续补）。`start()` 起一个 1s 定时器调
 * `tick()`，`stop()` 清掉；跨页面、跨 tab 都在跑，与 qt-pc 挂 AppShell 的
 * `useRadioRefill` 同语义（本端没有 AppShell，放 store 里最省一处生命周期）。
 *
 * ## 为什么不缓存推荐结果（但记一份「上一轮排过的键」）
 * FM 的推荐结果是一次性的：缓存下来既没有复现价值，又会让下一次进 FM 时听到同一批 ——
 * 这也是每次开始都要换一个会话种子（`sessionVariant()`）的原因。所以 `usedKeys` 只活在
 * 本会话内存里。唯一落到存储的是**上一轮会话排过的键**（`LAST_SESSION_KEY`）：引擎排序
 * 是确定性的，新会话额外避开上一轮那十来首，用户才不会看到「每次重新打开 FM 播放的歌曲
 * 全都一模一样」（2026-11-02 qt-pc 反馈）。
 */

import { reactive } from "vue";
import type { Song } from "@/types/music";
import { usePlayerStore } from "@/stores/player";
import { useDislikesStore } from "@/stores/dislikes";
import { useDownloadsStore } from "@/stores/downloads";
import { loadPreference, readTaste, saveTaste } from "@/services/daily-recommend";
import type { DailyPreference } from "@/services/daily-recommend";
import type { DailyTaste } from "@/services/recommend-types";
import {
  RADIO_BATCH,
  RADIO_SEED_LANE,
  buildRadioBatch,
  markUsed,
  radioTrackKey,
  seedLane,
  sessionVariant,
  shouldRefill,
} from "@/services/radio-queue";
import { logMsg, logMsgWarn } from "@/services/logger";

/** 上一轮 FM 会话排过的键：只用来让下一轮避开它们（见文件头） */
const LAST_SESSION_KEY = "qt-radio-last-session";

/** 补歌心跳间隔（毫秒）：与 qt-pc useRadioRefill 一致，1s 足够细 */
const RADIO_TICK_MS = 1000;

function errMsg(err: any): string {
  const msg = (err as Error).message;
  return msg != null && msg.length > 0 ? msg : "" + err;
}

/** 按 `radioTrackKey` 去重，保留先出现的 */
function dedupe(songs: Song[]): Song[] {
  const seen = new Set<string>();
  const out: Song[] = [];
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    if (song == null || song.id.length == 0 || song.name.length == 0) continue;
    const key = radioTrackKey(song);
    if (key.length == 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(song);
  }
  return out;
}

/** FM 是否仍持有当前播放器队列：队列非空，且每一首都是 FM 自己推过的（key ∈ usedKeys） */
function queueBelongsToRadio(queue: Song[], usedKeys: Set<string>): boolean {
  if (queue.length == 0) return false;
  for (let i = 0; i < queue.length; i++) {
    const song = queue[i];
    if (song == null || !usedKeys.has(radioTrackKey(song))) return false;
  }
  return true;
}

/** 用换行分隔存键：不走 JSON（App 端 JSON.parse 的产物与 UTS 容器不同源，见 ai-assistant-history 注释） */
function readLastSessionKeys(): string[] {
  try {
    const raw = uni.getStorageSync(LAST_SESSION_KEY) as string;
    if (raw == null || raw.length == 0) return [];
    const parts = raw.split("\n");
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i].trim();
      if (key.length > 0) out.push(key);
    }
    return out;
  } catch (err) {
    // 读不出来（已被清掉 / 存的是坏数据）就当没有：只是少一次避让，不是错误
    logMsgWarn("[radio] 读取上一轮会话键失败：" + errMsg(err));
    return [];
  }
}

function writeLastSessionKeys(keys: string[]): void {
  try {
    uni.setStorageSync(LAST_SESSION_KEY, keys.join("\n"));
  } catch (err) {
    // 写不进去也无碍：下一次最多是「没避开」，不会打断 FM
    logMsgWarn("[radio] 写入上一轮会话键失败：" + errMsg(err));
  }
}

/**
 * 进入 FM 前正在播放的东西：FM 只是「接管」播放器队列，退出时要原样还回去
 * （对齐网易云：退出 FM 后还能接着放原来的播放列表，曲目、播放位置、暂停状态都不变）。
 */
export type RadioStash = {
  /** 被接管那一刻的播放列表 */
  queue: Song[];
  /** 当时放到第几首 */
  index: number;
  /** 当时的播放位置（毫秒） */
  positionMs: number;
  /** 当时是否正在播放：不是的话，恢复后保持暂停 */
  playing: boolean;
};

class RadioStore {
  /** 是否正在 FM 模式（用户停止、或队列被换走让位后变 false） */
  active = false;
  /** 整队替换落地后才 true：FM 持有当前播放器队列的凭证 */
  queueClaimed = false;
  /** FM 开始时用户原本的播放模式（"random" / "single"）：FM 期间强制顺序播放，停止/让位时还回去 */
  restoreMode: string | null = null;
  /**
   * 进入 FM 那一刻抄下来的原播放列表：退出 FM（stop）时放回去。
   * 让位退出（用户自己换了队列）不会还原 —— 那是用户的选择，不该被我们改回去。
   */
  stash: RadioStash | null = null;
  loading = false;
  error = "";
  /** 用户选的口味档 */
  taste: DailyTaste = "heart";
  /** 本次 FM 的种子（「以这首歌为种子开始」时传入） */
  seed: Song | null = null;
  /** 本轮已经排过的键：跨批次硬去重 */
  usedKeys: Set<string> = new Set<string>();
  /** 候选池与同序屏蔽标记 —— 补歌复用，避免每批都重读曲库 */
  pool: Song[] = [];
  disliked: boolean[] = [];
  /** 收听偏好（画像 + 质量 + 收藏键）：补歌时直接复用，不重复 loadPreference */
  pref: DailyPreference | null = null;
  /** 曲库/收藏/歌单全被排空：不再自动补 */
  exhausted = false;

  /**
   * 开始（或「以此曲为种子」开始）私人 FM。
   * 已经在 FM 里重复点开始：按新会话重排一批（不重复抄 stash，否则会把 FM 队列当原列表）。
   */
  async start(seed: Song | null = null): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = "";
    this.exhausted = false;
    this.seed = seed;
    try {
      const pref = await loadPreference();
      // 池子 = 收藏 + 歌单 + 最近播放 + 已下载；收藏/歌单/最近可能不在本地库里
      // （云端卡片、已删文件），但只要有可播的 id 就能进队列，所以一并并进去重。
      const downloaded: Song[] = [];
      const items = useDownloadsStore().items;
      for (let i = 0; i < items.length; i++) downloaded.push(items[i].song);
      const pool = dedupe([
        ...pref.favoriteTracks,
        ...pref.playlistTracks,
        ...pref.recentTracks,
        ...downloaded,
      ]);
      if (pool.length == 0) {
        this.loading = false;
        this.active = false;
        this.error = "曲库里还没有可以播放的歌，先收藏几首或听几首再来吧";
        return;
      }
      // 屏蔽标记与池子同序：引擎按这个顺序硬排除
      const disliked: boolean[] = [];
      const dislikes = useDislikesStore();
      for (let i = 0; i < pool.length; i++) disliked.push(dislikes.isDisliked(pool[i]));
      const usedKeys = new Set<string>();
      // 种子车道先占位：同专辑/同歌手的 3 首排在最前，其余名额交给引擎
      const lane = seedLane(pool, seed, RADIO_SEED_LANE, usedKeys);
      markUsed(usedKeys, lane);
      // 上一轮会话排过的键：这一次整批避开它们（引擎排序确定性，只换种子不够）
      const rest = buildRadioBatch({
        pool,
        pref,
        taste: this.taste,
        usedKeys,
        disliked,
        count: Math.max(1, RADIO_BATCH - lane.length),
        variant: sessionVariant(),
        avoidKeys: readLastSessionKeys(),
      });
      const batch: Song[] = [];
      for (let i = 0; i < lane.length; i++) batch.push(lane[i]);
      for (let i = 0; i < rest.length; i++) batch.push(rest[i]);
      if (batch.length == 0) {
        this.loading = false;
        this.active = false;
        this.error = "曲库里的歌都被筛掉了，试试放宽屏蔽列表";
        return;
      }
      // 记下这一轮排过的键：下一轮会话据此避让（落盘，进程重启也还在）
      const sessionKeys: string[] = [];
      for (let i = 0; i < batch.length; i++) sessionKeys.push(radioTrackKey(batch[i]));
      writeLastSessionKeys(sessionKeys);
      markUsed(usedKeys, rest);

      const player = usePlayerStore();
      // 进入 FM 前把用户原来的播放列表整份抄下来：FM 只是「接管」播放器队列，
      // 退出（停止 FM）时要原样还回去。已经在 FM 里（queueClaimed）时不再抄一次。
      if (!this.queueClaimed && player.queue.length > 0) {
        const index = player.currentIndex();
        const safeIndex = Math.min(Math.max(0, index < 0 ? 0 : index), player.queue.length - 1);
        const stashQueue: Song[] = [];
        for (let i = 0; i < player.queue.length; i++) stashQueue.push(player.queue[i]);
        this.stash = {
          queue: stashQueue,
          index: safeIndex,
          positionMs: Math.max(0, Math.round(player.progress)),
          playing: player.playing,
        };
      }
      // FM 期间强制顺序播放：随机/单曲循环下「下一首」会跳到队列任意一首，
      // 页面上的「接下来」当场换成另一批。原模式记下来，停止/让位时还回去。
      const currentMode = player.mode;
      if (currentMode != "sequence") this.restoreMode = currentMode;
      player.mode = "sequence";
      player.syncRepeatMode();

      await player.play(batch[0], batch, false, false);
      this.usedKeys = usedKeys;
      this.pool = pool;
      this.disliked = disliked;
      this.pref = pref;
      this.loading = false;
      this.active = true;
      this.queueClaimed = true;
      this.exhausted = false;
      startHeartbeat(this);
      logMsg("[radio] FM 开始：池子 " + pool.length + " 首，本批 " + batch.length + " 首");
    } catch (err) {
      this.loading = false;
      this.active = false;
      this.queueClaimed = false;
      this.error = errMsg(err);
      logMsgWarn("[radio] FM 开始失败：" + errMsg(err));
    }
  }

  /**
   * 退出 FM。`restoreOriginal` 为真（默认，用户点「停止 FM」）时把进入前抄下来的
   * 播放列表放回去；让位退出（队列被用户换走）时传 false，只清状态不动播放器。
   */
  stop(restoreOriginal = true): void {
    const restore = this.restoreMode;
    const stash = this.stash;
    stopHeartbeat();
    this.active = false;
    this.queueClaimed = false;
    this.restoreMode = null;
    this.stash = null;
    this.loading = false;
    this.error = "";
    this.exhausted = false;
    this.seed = null;
    // 把 FM 期间借走的播放模式还给用户：停 FM 只停「继续推歌」，
    // 不该顺手把「随机播放」这种个人设置也一起改掉
    if (restore != null) {
      const player = usePlayerStore();
      player.mode = restore;
      player.syncRepeatMode();
    }
    // 用户点「停止 FM」= 退出 FM：把进入前那份播放列表原样放回去
    if (restoreOriginal && stash != null) void restoreStash(stash).catch((err: any) => {
      // 恢复失败不把 rejection 悬空：页面只报一句，FM 已经退出了
      this.error = "恢复原播放列表失败：" + errMsg(err);
      logMsgWarn("[radio] 恢复原播放列表失败：" + errMsg(err));
    });
  }

  setTaste(taste: DailyTaste): void {
    if (this.taste == taste) return;
    this.taste = taste;
    saveTaste(taste);
    // 口味变了下一批就该按新口味排；已经在队列里的歌不动（不打断正在听的东西）
  }

  /** 立刻补一批（「换一批」按钮） */
  async refill(count = RADIO_BATCH): Promise<void> {
    if (!this.active || !this.queueClaimed || this.loading || this.pref == null || this.exhausted) return;
    const player = usePlayerStore();
    // 队列被换走（双击别的歌单/清空队列）：FM 让位，绝不往别人的队列里追加。
    // 传 false：这是用户自己的选择，不要把我们抄下来的旧列表抢回去。
    if (!queueBelongsToRadio(player.queue, this.usedKeys)) {
      this.stop(false);
      return;
    }
    this.loading = true;
    try {
      const pref = this.pref as DailyPreference;
      const batch = buildRadioBatch({
        pool: this.pool,
        pref,
        taste: this.taste,
        usedKeys: this.usedKeys,
        disliked: this.disliked,
        count,
        // 变体种子：同一次会话里同样一批候选也要能「换一批」
        variant: "" + Date.now(),
      });
      if (batch.length == 0) {
        this.loading = false;
        this.exhausted = true;
        return;
      }
      const usedKeys = new Set<string>();
      this.usedKeys.forEach((key: string) => usedKeys.add(key));
      markUsed(usedKeys, batch);
      this.usedKeys = usedKeys;
      this.loading = false;
      // silent=true：补歌是后台动作，不弹「已加入 N 首到播放队列」
      const added = player.enqueueMany(batch, true);
      // 一首都没加进去（候选全被去重/屏蔽吃掉）：别让心跳每秒重试同一批空转
      if (added == 0) this.exhausted = true;
    } catch (err) {
      this.loading = false;
      this.error = errMsg(err);
      logMsgWarn("[radio] 补歌失败：" + errMsg(err));
    }
  }

  /** 不喜欢当前这首：落屏蔽规则 + 立刻换一首顶上 */
  async dislike(song: Song): Promise<void> {
    try {
      useDislikesStore().banSong(song);
    } catch (err) {
      // 屏蔽失败不该挡住切歌：把错误显示出来，但照常往下走
      this.error = errMsg(err);
    }
    // 池子里同键的候选就地标脏，下一批就不会再挑到它（键统一用 radioTrackKey，
    // 与池子判定口径一致 —— 双口径（歌名键）会让标记和判定对不上）
    const badKey = radioTrackKey(song);
    const nextFlags: boolean[] = [];
    for (let i = 0; i < this.pool.length; i++) {
      if (this.disliked[i] == true) {
        nextFlags.push(true);
        continue;
      }
      nextFlags.push(radioTrackKey(this.pool[i]) == badKey);
    }
    this.disliked = nextFlags;
    usePlayerStore().next();
    if (this.active && !this.exhausted) await this.refill(1);
  }

  /** 播放器队列余量不足时补一批；先核对 FM 是否仍持有队列（tick 的实际执行者） */
  async ensure(remaining: number): Promise<void> {
    if (!this.active || !this.queueClaimed) return;
    // 归属核对必须排在补歌阈值之前：队列被换走时哪怕余量还很多（用户双击了
    // 自己的长歌单），FM 也要立刻让位 —— 否则 queueClaimed 一直挂着，
    // 之后退出 FM 会把原列表盖到用户自己的队列上。
    const player = usePlayerStore();
    if (!queueBelongsToRadio(player.queue, this.usedKeys)) {
      this.stop(false);
      return;
    }
    if (!shouldRefill(remaining)) return;
    await this.refill();
  }

  /** 全局心跳（每秒一次）：读播放器余量并按需补歌 */
  async tick(): Promise<void> {
    if (!this.active || !this.queueClaimed) return;
    const player = usePlayerStore();
    const index = player.currentIndex();
    const remaining = player.queue.length - (index < 0 ? 0 : index) - 1;
    await this.ensure(remaining);
  }
}

/**
 * 退出 FM 时把进入前抄下来的播放列表放回去。
 *
 * 顺序：整队换回原列表（从当时那一首起播）→ seek 回当时的位置 → 当时是暂停就再暂停。
 * 任何一步失败都不该让 FM 退不出去，只在页面上报一句「恢复原播放列表失败」。
 */
async function restoreStash(stash: RadioStash): Promise<void> {
  const player = usePlayerStore();
  if (stash.queue.length == 0) return;
  const index = Math.min(Math.max(0, stash.index), stash.queue.length - 1);
  await player.play(stash.queue[index], stash.queue, false, false);
  if (stash.positionMs > 0) player.seek(stash.positionMs);
  if (!stash.playing) player.pause();
}

// ---- 心跳：store 级单例（不能用类字段存定时器：reactive 会给 Timer 套代理） ----
let heartbeatTimer: number | null = null;

function startHeartbeat(store: RadioStore): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    void store.tick();
  }, RADIO_TICK_MS) as number;
}

function stopHeartbeat(): void {
  if (heartbeatTimer != null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

const radio = reactive(new RadioStore()) as RadioStore;

export function useRadioStore(): RadioStore {
  return radio;
}
