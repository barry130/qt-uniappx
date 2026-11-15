/**
 * 私人 FM：复用画像排序，分批推荐，喜欢/不喜欢与下一首反馈继续生效。
 * PlayerStore 持有会话归属及进入前快照，和播放状态同键持久化。
 * 退出恢复普通队列与模式；冷启动结束 FM 并恢复普通队列，保持暂停。
 * 用户另选歌曲/歌单立即让位；旧异步开始请求不得重新接管播放器。
 * 推荐去重仅在本轮有效，上一轮键用于下次避让；不自动恢复旧 FM 推荐会话。
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
import {
  readRecommendationChoice,
  recommendationChoiceCurrent,
  recommendationChoiceRevision,
  RECOMMENDATION_SOURCE_CHANGED_EVENT,
} from "@/stores/recommendation-source";
import type { RecommendationChoice } from "@/stores/recommendation-source";
import {
  prepareAccountRecommendationContext,
  accountRecommendationContextCurrent,
  fetchAccountFmNext,
  accountRecommendationErrorMessage,
} from "@/services/account-recommendation";
import type { AccountRecommendationContext } from "@/services/account-recommendation";
import { SOURCE_AUTH_CHANGED_EVENT } from "@/services/source-auth";
import { SOURCE_PACKS_CHANGED_EVENT } from "@/services/source-update";
import { SOURCE_POLICY_CHANGED_EVENT } from "@/services/source-policy";

/** Official supply probes are bounded, including empty/duplicate-only batches. */
const ACCOUNT_FM_MAX_PROBES = 3;

type AccountRadioSupply = { songs: Song[]; cursor: string | null; exhausted: boolean };

/** A copied queue signature detects user removals/reordering, not only foreign song IDs. */
function radioQueueKeys(queue: Song[]): string[] {
  return queue.map((song: Song): string => radioTrackKey(song));
}
function radioQueueMatches(queue: Song[], expected: string[]): boolean {
  if (queue.length == 0 || queue.length != expected.length) return false;
  for (let i = 0; i < queue.length; i++) {
    if (radioTrackKey(queue[i]) != expected[i]) return false;
  }
  return true;
}
function retryableAccountRadioError(err: any): boolean {
  const message = errMsg(err);
  return message.indexOf("ACCOUNT_RECOMMENDATIONS_NETWORK") >= 0 ||
    message.indexOf("ACCOUNT_RECOMMENDATIONS_RATE_LIMIT") >= 0 ||
    message.indexOf("ACCOUNT_RECOMMENDATIONS_UPSTREAM") >= 0;
}

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

class RadioStore {
  private generation = 0;
  private sessionChoice: RecommendationChoice | null = null;
  private sessionChoiceRevision = 0;
  private accountContext: AccountRecommendationContext | null = null;
  private accountQueueKeys: string[] = [];
  private accountFailures = 0;
  private startPlaybackRevision = 0;
  private nextSupplyRetryAt = 0;
  /** Only a cursor from a batch actually accepted by the player is committed. */
  accountCursor: string | null = null;
  origin: "app" | "account" = "app";
  get accountMode(): boolean { return readRecommendationChoice("fm").origin == "account"; }

  private sessionCurrent(generation: number): boolean {
    if (generation != this.generation || this.sessionChoice == null) return false;
    if (!recommendationChoiceCurrent("fm", this.sessionChoice, this.sessionChoiceRevision)) return false;
    return this.origin != "account" || this.accountContext == null || accountRecommendationContextCurrent(this.accountContext);
  }

  private ownsQueue(): boolean {
    const player = usePlayerStore();
    if (!player.radioActive) return false;
    return this.origin == "account"
      ? radioQueueMatches(player.queue, this.accountQueueKeys)
      : queueBelongsToRadio(player.queue, this.usedKeys);
  }

  /** Account/source revocation clears old supply immediately, without overriding a user's new queue. */
  onRecommendationEnvironmentChanged(): void {
    if (this.sessionChoice == null || this.sessionCurrent(this.generation)) return;
    const restore = this.ownsQueue();
    this.stop(restore);
    this.error = "推荐来源或账号授权已变化，请重新开始收听";
  }
  /** 是否正在 FM 模式（用户停止、或队列被换走让位后变 false） */
  get active(): boolean { return usePlayerStore().radioActive; }
  /** 整队替换落地后才 true：FM 持有当前播放器队列的凭证 */
  queueClaimed = false;
  loading = false;
  error = "";
  /** 用户选的口味档 */
  taste: DailyTaste = readTaste();
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
    const generation = ++this.generation;
    const player = usePlayerStore();
    const revision = player.playbackRevision();
    this.startPlaybackRevision = revision;
    this.loading = true;
    this.error = "";
    this.exhausted = false;
    this.seed = seed;
    this.sessionChoice = readRecommendationChoice("fm");
    this.sessionChoiceRevision = recommendationChoiceRevision("fm");
    this.origin = this.sessionChoice.origin;
    this.accountContext = null;
    this.accountCursor = null;
    this.accountFailures = 0;
    this.nextSupplyRetryAt = 0;
    try {
      if (this.origin == "account") {
        await this.startAccount(this.sessionChoice.sourceId, generation, revision);
        return;
      }
      const pref = await loadPreference();
      if (!this.sessionCurrent(generation)) return;
      if (player.playbackRevision() != revision) { this.loading = false; return; }
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
        this.error = "曲库里的歌都被筛掉了，试试放宽屏蔽列表";
        return;
      }
      // 记下这一轮排过的键：下一轮会话据此避让（落盘，进程重启也还在）
      const sessionKeys: string[] = [];
      for (let i = 0; i < batch.length; i++) sessionKeys.push(radioTrackKey(batch[i]));
      writeLastSessionKeys(sessionKeys);
      markUsed(usedKeys, rest);

      // 进入 FM 前把用户原来的播放列表整份抄下来：FM 只是「接管」播放器队列，
      // 退出（停止 FM）时要原样还回去。已经在 FM 里（queueClaimed）时不再抄一次。
      // FM 期间强制顺序播放：随机/单曲循环下「下一首」会跳到队列任意一首，
      // 页面上的「接下来」当场换成另一批。原模式记下来，停止/让位时还回去。
      this.usedKeys = usedKeys;
      player.beginRadio();
      await player.play(batch[0], batch, false, false, true);
      if (generation != this.generation) return;
      if (!this.sessionCurrent(generation)) { this.onRecommendationEnvironmentChanged(); return; }
      if (!player.radioActive) { this.loading = false; this.queueClaimed = false; return; }
      this.usedKeys = usedKeys;
      this.pool = pool;
      this.disliked = disliked;
      this.pref = pref;
      this.loading = false;
      this.queueClaimed = true;
      this.exhausted = false;
      startHeartbeat(this);
      logMsg("[radio] FM 开始：池子 " + pool.length + " 首，本批 " + batch.length + " 首");
    } catch (err) {
      if (generation != this.generation) return;
      this.loading = false;
      // A failed account start must not restore a snapshot over a later user choice.
      player.endRadio(this.origin == "account" ? this.ownsQueue() : true);
      this.queueClaimed = false;
      this.error = this.origin == "account" ? accountRecommendationErrorMessage(err) : errMsg(err);
      this.accountContext = null;
      this.sessionChoice = null;
      logMsgWarn("[radio] FM 开始失败：" + this.error);
    } finally {
      if (generation == this.generation) this.loading = false;
    }
  }

  /** Only the source package supplies account FM songs; no local ranking or account feedback. */
  private async startAccount(sourceId: string, generation: number, playbackRevision: number): Promise<void> {
    const player = usePlayerStore();
    const context = await prepareAccountRecommendationContext(sourceId, "fm");
    if (!this.sessionCurrent(generation)) return;
    if (player.playbackRevision() != playbackRevision) { this.loading = false; return; }
    this.accountContext = context;
    this.usedKeys = new Set<string>();
    this.seed = null;
    const supply = await this.fetchAccountSupply(context, generation);
    if (generation != this.generation) return;
    if (!this.sessionCurrent(generation)) { this.onRecommendationEnvironmentChanged(); return; }
    if (supply == null) {
      this.stop(this.ownsQueue());
      this.error = "账号推荐请求已失效，请重新开始收听";
      return;
    }
    if (player.playbackRevision() != playbackRevision) { this.loading = false; return; }
    if (supply.songs.length == 0) {
      this.loading = false;
      this.exhausted = true;
      this.error = "官方私人 FM 暂时没有新的歌曲，可稍后重新开始";
      return;
    }
    this.pool = [];
    this.disliked = [];
    this.pref = null;
    const usedKeys = new Set<string>();
    for (let i = 0; i < supply.songs.length; i++) usedKeys.add(radioTrackKey(supply.songs[i]));
    this.usedKeys = usedKeys;
    this.accountQueueKeys = radioQueueKeys(supply.songs);
    player.beginRadio();
    const playing = player.play(supply.songs[0], supply.songs, false, false, true);
    // play commits the JavaScript queue synchronously, then awaits playback resources.
    if (player.radioActive && queueBelongsToRadio(player.queue, usedKeys)) this.accountQueueKeys = radioQueueKeys(player.queue);
    await playing;
    if (generation != this.generation) return;
    if (!this.sessionCurrent(generation)) { this.onRecommendationEnvironmentChanged(); return; }
    if (!this.ownsQueue()) { this.stop(false); return; }
    // The player accepted this queue. Only now publish cursor/ownership/supply state.
    this.accountCursor = supply.cursor;
    this.queueClaimed = true;
    this.exhausted = supply.exhausted;
    this.loading = false;
    startHeartbeat(this);
    logMsg("[radio] 账号 FM 开始，本批 " + supply.songs.length + " 首");
  }

  private async fetchAccountSupply(context: AccountRecommendationContext, generation: number): Promise<AccountRadioSupply | null> {
    let cursor = this.accountCursor;
    for (let probe = 0; probe < ACCOUNT_FM_MAX_PROBES; probe++) {
      if (!this.sessionCurrent(generation)) return null;
      const current = (): boolean => this.sessionCurrent(generation) && (this.queueClaimed ? this.ownsQueue() : usePlayerStore().playbackRevision() == this.startPlaybackRevision);
      const batch = await fetchAccountFmNext(context, cursor == null ? undefined : cursor, current);
      if (!this.sessionCurrent(generation)) return null;
      // An expired official batch cannot claim or append to the player, nor commit a cursor.
      if (batch.expiresAt != null && batch.expiresAt <= Date.now()) throw new Error("ACCOUNT_RECOMMENDATIONS_UPSTREAM");
      if (batch.cursor != null) cursor = batch.cursor;
      const songs: Song[] = [];
      const seen = new Set<string>();
      const dislikes = useDislikesStore();
      for (let i = 0; i < batch.items.length; i++) {
        const song = batch.items[i];
        const key = radioTrackKey(song);
        if (this.usedKeys.has(key) || seen.has(key) || dislikes.isDisliked(song)) continue;
        seen.add(key);
        songs.push(song);
      }
      if (songs.length > 0) return { songs, cursor, exhausted: batch.exhausted == true };
      if (batch.exhausted == true) break;
    }
    // A probe that admitted nothing must not advance the committed cursor.
    return { songs: [], cursor: this.accountCursor, exhausted: true };
  }

  private async refillAccount(): Promise<void> {
    const context = this.accountContext;
    if (context == null || !this.sessionCurrent(this.generation)) { this.onRecommendationEnvironmentChanged(); return; }
    if (Date.now() < this.nextSupplyRetryAt) return;
    const generation = this.generation;
    const player = usePlayerStore();
    const expectedQueue = this.accountQueueKeys.slice();
    this.loading = true;
    let appendAttempted = false;
    try {
      const supply = await this.fetchAccountSupply(context, generation);
      if (generation != this.generation) return;
      if (!this.sessionCurrent(generation)) { this.onRecommendationEnvironmentChanged(); return; }
      if (!player.radioActive || !radioQueueMatches(player.queue, expectedQueue)) { this.stop(false); return; }
      if (supply == null) return;
      if (supply.songs.length == 0) { this.exhausted = true; return; }
      appendAttempted = true;
      // No await between the ownership check and synchronous enqueue; external queues win.
      const added = player.enqueueMany(supply.songs, true, true);
      this.accountQueueKeys = radioQueueKeys(player.queue);
      if (added > 0) {
        const usedKeys = new Set<string>();
        for (let i = 0; i < this.accountQueueKeys.length; i++) usedKeys.add(this.accountQueueKeys[i]);
        this.usedKeys = usedKeys;
        this.accountCursor = supply.cursor;
        this.accountFailures = 0;
        this.nextSupplyRetryAt = 0;
        this.error = "";
      }
      this.exhausted = supply.exhausted || added == 0;
    } catch (err) {
      if (generation != this.generation) return;
      if (!this.sessionCurrent(generation)) { this.onRecommendationEnvironmentChanged(); return; }
      const message = accountRecommendationErrorMessage(err);
      if (appendAttempted) {
        // Transport outcome after queue mutation is uncertain: no retry or snapshot rollback.
        this.stop(false);
        this.error = "私人 FM 补歌未能确认，已停止供给；可重新开始";
      } else if (retryableAccountRadioError(err) && this.accountFailures < 2) {
        this.accountFailures++;
        this.nextSupplyRetryAt = Date.now() + this.accountFailures * 5000;
        this.error = message;
      } else {
        const restore = this.ownsQueue();
        this.stop(restore);
        this.error = message;
      }
      logMsgWarn("[radio] 账号 FM 补歌失败：" + this.error);
    } finally {
      if (generation == this.generation) this.loading = false;
    }
  }

  /** Check actual queue ownership before a delayed page-row click can dispatch playback. */
  playQueued(song: Song): void {
    if (!this.sessionCurrent(this.generation)) { this.onRecommendationEnvironmentChanged(); return; }
    if (!this.active || !this.queueClaimed) return;
    if (!this.ownsQueue()) { this.stop(false); return; }
    const key = radioTrackKey(song);
    if (!this.usedKeys.has(key)) return;
    const player = usePlayerStore();
    for (let i = 0; i < player.queue.length; i++) {
      const queued = player.queue[i];
      if (queued != null && radioTrackKey(queued) == key) {
        void player.play(queued, [], false, false, true);
        return;
      }
    }
  }

  /** Next is local playback only. At the tail, wait for one bounded supply before advancing. */
  async next(): Promise<void> {
    const player = usePlayerStore();
    const generation = this.generation;
    const revision = player.playbackRevision();
    if (!this.sessionCurrent(generation)) { this.onRecommendationEnvironmentChanged(); return; }
    if (!this.active || !this.queueClaimed || !this.ownsQueue()) return;
    if (player.currentIndex() >= player.queue.length - 1 && !this.exhausted) await this.refill();
    if (generation != this.generation || player.playbackRevision() != revision || !this.active || !this.ownsQueue()) return;
    player.next();
  }

  /**
   * 退出 FM。`restoreOriginal` 为真（默认，用户点「停止 FM」）时把进入前抄下来的
   * 播放列表放回去；让位退出（队列被用户换走）时传 false，只清状态不动播放器。
   */
  stop(restoreOriginal = true): void {
    // Account FM may restore only the queue it still owns, including during initial play.
    const restore = restoreOriginal && (this.origin != "account" || this.ownsQueue());
    this.generation++;
    stopHeartbeat();
    this.queueClaimed = false;
    this.loading = false;
    this.error = "";
    this.exhausted = false;
    this.seed = null;
    this.sessionChoice = null;
    this.accountContext = null;
    this.accountCursor = null;
    this.accountQueueKeys = [];
    this.accountFailures = 0;
    this.nextSupplyRetryAt = 0;
    // 归还原模式；让位退出不拿旧快照覆盖用户另选的播放列表。
    usePlayerStore().endRadio(restore);
    this.pool = [];
    this.disliked = [];
    this.usedKeys = new Set<string>();
    this.pref = null;
  }

  setTaste(taste: DailyTaste): void {
    if (this.taste == taste) return;
    this.taste = taste;
    saveTaste(taste);
    // 口味变了下一批就该按新口味排；已经在队列里的歌不动（不打断正在听的东西）
  }

  /** 立刻补一批（「换一批」按钮） */
  async refill(count = RADIO_BATCH): Promise<void> {
    if (!this.active || !this.queueClaimed || this.loading || this.exhausted) return;
    if (!this.sessionCurrent(this.generation)) { this.onRecommendationEnvironmentChanged(); return; }
    const player = usePlayerStore();
    // 用户换队列、删除或改序后让位，不向新队列追加，也不恢复覆盖它。
    if (!this.ownsQueue()) { this.stop(false); return; }
    if (this.origin == "account") { await this.refillAccount(); return; }
    if (this.pref == null) return;
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
      const added = player.enqueueMany(batch, true, true);
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
    // Official FM has no independently authorised feedback action; even hidden UI cannot invoke it.
    if (this.origin == "account" || this.accountMode) return;
    const generation = this.generation;
    const revision = usePlayerStore().playbackRevision();
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
    if (this.active && !this.exhausted) await this.refill(1);
    if (generation != this.generation || usePlayerStore().playbackRevision() != revision) return;
    usePlayerStore().next();
  }

  /** 播放器队列余量不足时补一批；先核对 FM 是否仍持有队列（tick 的实际执行者） */
  async ensure(remaining: number): Promise<void> {
    if (!this.active || !this.queueClaimed) return;
    if (!this.sessionCurrent(this.generation)) { this.onRecommendationEnvironmentChanged(); return; }
    // 归属核对在阈值之前；账号供给也拒绝用户删除/改序后的旧快照。
    if (!this.ownsQueue()) { this.stop(false); return; }
    if (!shouldRefill(remaining)) return;
    await this.refill();
  }

  /** 全局心跳：暂停时仍检查授权和归属，只有播放中才自动拉取下一批。 */
  async tick(): Promise<void> {
    if (this.sessionChoice != null && !this.sessionCurrent(this.generation)) {
      this.onRecommendationEnvironmentChanged();
      return;
    }
    if (!this.active) { this.stop(false); return; }
    if (!this.queueClaimed) return;
    if (!this.ownsQueue()) { this.stop(false); return; }
    const player = usePlayerStore();
    if (!player.playing) return;
    const index = player.currentIndex();
    const remaining = player.queue.length - (index < 0 ? 0 : index) - 1;
    await this.ensure(remaining);
  }
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

// Singleton lifecycle checks are independent of the FM page (including background/paused FM).
function onRecommendationEnvironmentChanged(): void { radio.onRecommendationEnvironmentChanged(); }
uni.$on(RECOMMENDATION_SOURCE_CHANGED_EVENT, onRecommendationEnvironmentChanged);
uni.$on(SOURCE_AUTH_CHANGED_EVENT, onRecommendationEnvironmentChanged);
uni.$on(SOURCE_PACKS_CHANGED_EVENT, onRecommendationEnvironmentChanged);
uni.$on(SOURCE_POLICY_CHANGED_EVENT, onRecommendationEnvironmentChanged);

export function useRadioStore(): RadioStore {
  return radio;
}
