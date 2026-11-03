/**
 * 收藏同步引擎（设计文档 docs/LIKE_SYNC_DESIGN.md）。
 * 从 stores/player.ts 原样抽出：pendingOps 断网暂存/联网重放、游标增量拉取、
 * 全量对账、多端 LWW 合并。行为零变化，只是把 ~950 行同步机制移出 PlayerStore。
 *
 * host 持有的是 player.ts 模块级的 reactive 代理（usePlayerStore() 返回的那个），
 * 引擎对 host.likedSongs 等数组的读写仍走响应式代理，页面依赖的 computed 不受影响。
 * 引擎自身状态（游标/待推送队列）是纯机器状态，不参与渲染，故意不做响应式。
 * 本文件只 import player.ts 的类型（import type），运行期无循环依赖。
 */
import { likeBatch, fetchChanges, fetchAllLikes } from "@/services/like";
import { parseJsonToUtso } from "@/services/http";
import { getAccessToken } from "@/services/auth";
import { logMsg } from "@/services/logger";
import { generateGlobalPid } from "@/services/global-pid";
import type { LikeChange, PendingLikeOp, Playlist, Song } from "@/types/music";
import type { PlayerStore } from "@/stores/player";

/** 收藏同步游标（LIKE_SYNC_DESIGN.md：多端增量拉取 since） */
const LIKE_CURSOR_KEY = "qt-like-cursor";
/** 待推送收藏操作队列（断网时暂存，联网后按序重放） */
const LIKE_OPS_KEY = "qt-like-pending-ops";
/** 收藏批量推送的单批上限（与后端 /like/batch 的 200 对齐，qt-stat 分片同款先例） */
const LIKE_BATCH_LIMIT = 200;
/**
 * 单条隔离重推的失败上限：探针证明网络通、单条仍连续失败这么多次，
 * 就认定为服务端不收的毒丸数据，剔除并记日志（2026-11-03 加）。
 * 取 3：一次失败可能是偶发，两次仍在概率上基本排除抖动，三次才动数据。
 */
const LIKE_POISON_FAIL_LIMIT = 3;

/**
 * 这个封面地址能不能同步给服务端。
 *
 * 只认 http(s)：本地歌的内嵌封面落在设备私有目录（unifile://usr/local-cover-*.jpg），
 * 推到服务端后别的设备/网页端只会拿到一条打不开的路径（2026-11-03 加）。
 */
function portablePicUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.indexOf("http://") == 0 || lower.indexOf("https://") == 0;
}

export class LikeSyncEngine {
  private host: PlayerStore;
  /** 收藏同步游标（服务器 updated_seq 最大值，LIKE_SYNC_DESIGN.md D3） */
  private likeCursor = 0;
  /** 待推送收藏操作队列（断网暂存，联网后按序重放） */
  private pendingOps: PendingLikeOp[] = [];
  /** 收藏同步进行中标记（防止 flush 与 pull 并发交错） */
  private likeSyncBusy = false;

  constructor(host: PlayerStore) {
    this.host = host;
  }

  load(): void {
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
        } catch (_) {
          // 静默：单条积压操作损坏时跳过该条，其余照常按序重放
        }
      }
      this.pendingOps = ops;
    } catch (_) {
      this.pendingOps = [];
    }
  }

  save(): void {
    try {
      uni.setStorageSync(LIKE_CURSOR_KEY, this.likeCursor.toString());
    } catch (_) {
      // 静默：游标写失败时下次 save 再试，重放语义幂等不会重复上送
    }
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
    } catch (_) {
      // 静默：积压队列写失败时内存队列仍在，下次落盘窗口重写
    }
  }

  /**
   * 单曲收藏 payload：只携带服务器需要的字段（不含 url 等本地字段）。
   * pid 为可选归属：收藏到哪个本地歌单就带上谁的 pid，为空表示不归属任何歌单。
   * 普通对象直出不建 UTSJSONObject：导入几百首时逐首建原生实例纯属浪费，
   * 还会放大 bytecode 运行时的实例注册表压力（曾触发「UTS instance is not registered」）。
   */
  likeSongPayloadJson(song: Song, pid?: string): string {
    const obj: any = {
      sid: song.id,
      platform: song.platform,
      name: song.name,
      singer: song.singer,
      album: song.album,
    };
    if (song.musicId != null && song.musicId.length > 0) obj["hash"] = song.musicId;
    if (pid != null && pid.length > 0) obj["pid"] = pid;
    // 封面一并入 payload：在线收藏和离线重放共用，断网期间入队的收藏恢复后仍能带图。
    // 但**只同步网络缩略图**：本地歌的内嵌封面在私有目录里（unifile://usr/local-cover-*.jpg），
    // 那种路径换台设备就是破图，推给服务端等于把脏数据写进数据库（2026-11-03）。
    if (song.picUrl != null && song.picUrl.length > 0 && portablePicUrl(song.picUrl)) {
      obj["picUrl"] = song.picUrl;
    }
    return JSON.stringify(obj);
  }

  /** 歌单收藏 payload（pid 兜底：自建歌单缺 pid 时生成并写回本地缓存） */
  likePlaylistPayloadJson(playlist: Playlist): string {
    // 歌单的 pid 就是它的全局唯一键，本地歌单用生成的 pid，其余沿用平台歌单号
    const pid = this.ensurePlaylistPid(playlist);
    const obj: any = {
      pid: pid,
      platform: playlist.platform,
      name: playlist.name,
    };
    // 与歌曲侧同口径（portablePicUrl）：设备本地封面路径不上送，
    // 否则旧脏数据会把 unifile://usr/... 写进服务端歌单表（2026-11-03）
    if (playlist.picUrl != null && playlist.picUrl.length > 0 && portablePicUrl(playlist.picUrl)) {
      obj["picUrl"] = playlist.picUrl;
    }
    return JSON.stringify(obj);
  }

  /** 本地变更入队并尝试推送（断网暂存，联网后自动补推） */
  enqueueLikeOp(op: PendingLikeOp): void {
    this.pendingOps.push(op);
    this.save();
    this.flushPendingOps().catch(() => {});
  }

  /**
   * 批量入队（导入/移除歌单场景）：一次落盘一次推送。
   * 逐条 enqueueLikeOp 会 save×N、flush×N（flush 被 busy 标记拦住大半，
   * 但 save 每条都要序列化整个队列），导入几百首时纯属放大开销；
   * 更要紧的是保持整批入队的**顺序可见性**——全部入队后再推，
   * 拉取合并的 hasPendingLikeOp 判断一次就能覆盖整批。
   */
  enqueueLikeOps(ops: PendingLikeOp[]): void {
    if (ops.length == 0) return;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op != null) this.pendingOps.push(op);
    }
    this.save();
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
  pushSongPid(song: Song, pid: string, action: "add" | "remove"): void {
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
      } catch (_) {
        // 静默：单条 payload 解析失败按「不在队列」处理，宁可重推一次（幂等）
      }
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
          logMsg("[Player] 收藏批量推送丢弃无效操作 type=" + op.type + " action=" + op.action);
        }
        invalidIdx.push(scan);
        scan++;
      }
      // 无效 op 从后往前剔除（不影响前面的下标），并落盘
      for (let i = invalidIdx.length - 1; i >= 0; i--) {
        this.pendingOps.splice(invalidIdx[i], 1);
      }
      if (invalidIdx.length > 0) this.save();
      if (batch.length == 0) continue;
      let seq = 0;
      try {
        seq = await likeBatch(bodies);
        logMsg("[Player] 收藏批量推送成功 " + batch.length + " 条 seq=" + seq);
      } catch (e) {
        logMsg("[Player] 收藏批量推送失败 " + batch.length + " 条 err=" + (e != null ? e.toString() : "unknown"));
        // 整批留队保序重放是断网场景的正解；但若失败来自某条服务端不收的数据，
        // 毒丸会永久堵住队首（游标停摆、defer 拉取死循环）——交给毒丸隔离判定：
        // 探针证明网络通才拆批单发隔离，网络不通什么都不动（绝不丢数据）
        await this.isolatePoisonOps(batch, bodies);
        return;
      }
      // 成功：整批出队并盖章
      this.retireOps(batch, seq);
    }
  }

  /**
   * 一批操作成功上送后的收尾：整批出队并盖章。本批占用连续 seq 区段，
   * 统一盖整批最大 seq 不会误判 LWW（其他端这期间的变更 seq 必然更大）。
   * 从整批成功路径抽出（2026-11-03），单条隔离重推成功后复用同一口径。
   */
  private retireOps(batch: PendingLikeOp[], seq: number): void {
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
    this.save();
  }

  /**
   * 批量推送失败后的毒丸隔离（2026-11-03 加）。
   *
   * 背景：/like/batch 整批原子，一条服务端不收的 op 会让整批永远失败，
   * 队列堵在队首、游标停摆、isDeferredLikeChange 的 defer 拉取死循环。
   *
   * 判定分两级，保守优先：
   * 1. 先发一次增量拉取当**探针**——它和 /like/batch 同令牌同网络，
   *    探针都失败说明是网络/鉴权问题，整批原样留队重放（不丢数据，直接返回）；
   * 2. 探针通过后把整批拆成单条逐个推：成功的单条立即出队盖章，
   *    失败的单条累计 failCount，连续失败 LIKE_POISON_FAIL_LIMIT 次才剔除。
   *    剔除是最后手段——扔掉的是「服务器明确拒绝过的数据」，不是用户输入本身，
   *    本地收藏表里的记录不受影响，只是这条变更不再上送。
   */
  private async isolatePoisonOps(batch: PendingLikeOp[], bodies: string[]): Promise<void> {
    let probeOk = false;
    try {
      const probe = await fetchChanges(this.likeCursor);
      probeOk = probe != null;
    } catch (_) {
      probeOk = false;
    }
    if (!probeOk) return;
    logMsg("[Player] 收藏批量推送失败但网络探针通过，拆批单发隔离毒丸 " + batch.length + " 条");
    for (let i = 0; i < batch.length; i++) {
      const op = batch[i];
      const body = bodies[i];
      if (op == null || body == null) continue;
      let singleSeq = 0;
      try {
        singleSeq = await likeBatch([body]);
      } catch (_) {
        const fails = (op.failCount != null ? op.failCount : 0) + 1;
        op.failCount = fails;
        if (fails >= LIKE_POISON_FAIL_LIMIT) {
          const idx = this.pendingOps.indexOf(op);
          if (idx >= 0) this.pendingOps.splice(idx, 1);
          this.save();
          logMsg("[Player] 收藏推送剔除毒丸条目 type=" + op.type + " action=" + op.action + " 连续失败 " + fails + " 次 dataJson=" + op.dataJson);
        } else {
          logMsg("[Player] 收藏单条重推失败 " + fails + "/" + LIKE_POISON_FAIL_LIMIT + " type=" + op.type + " action=" + op.action);
        }
        continue;
      }
      this.retireOps([op], singleSeq);
      logMsg("[Player] 收藏单条重推成功 type=" + op.type + " action=" + op.action + " seq=" + singleSeq);
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
      // 封面仅 add 且非空时上送（remove 没有图片语义，空值不上送避免覆盖云端已有图）。
      // portablePicUrl：存量队列里可能残留修复前入队的设备本地路径，重建时一并拦下
      if (op.action == "add") {
        const picUrl = obj["picUrl"] as string | null;
        if (picUrl != null && picUrl.length > 0 && portablePicUrl(picUrl)) body["picUrl"] = picUrl;
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
      logMsg("[Player] 歌单批量推送 pid 缺失，已生成 " + finalPid);
    }
    body["pid"] = finalPid;
    body["platform"] = playlistPlatform;
    const name = obj["name"] as string | null;
    if (name != null && name.length > 0) body["name"] = name;
    if (op.action == "add") {
      const picUrl = obj["picUrl"] as string | null;
      // 与歌曲侧同口径（portablePicUrl）：设备本地路径不上送
      if (picUrl != null && picUrl.length > 0 && portablePicUrl(picUrl)) body["picUrl"] = picUrl;
    }
    return JSON.stringify(body);
  }

  /** 在收藏总表里按 sid + platform 找本地歌曲条目，找不到返回 null */
  private findLikedSongEntry(sid: string, platform: string): Song | null {
    for (let i = 0; i < this.host.likedSongs.length; i++) {
      const s = this.host.likedSongs[i];
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
        this.host.addPidToSong(entry, pid);
        this.host.persistNow();
      }
      return pid;
    }
    return "";
  }

  /** 按 pid 或 id 在自建歌单与收藏歌单里找歌单，找不到返回 null */
  private findPlaylistByPidOrId(key: string): Playlist | null {
    if (key.length == 0) return null;
    for (let i = 0; i < this.host.localPlaylists.length; i++) {
      const lp = this.host.localPlaylists[i];
      if (lp == null) continue;
      if (lp.id == key || (lp.pid != null && lp.pid == key)) return lp;
    }
    for (let i = 0; i < this.host.savedPlaylists.length; i++) {
      const pl = this.host.savedPlaylists[i];
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
    for (let i = 0; i < this.host.localPlaylists.length; i++) {
      const lp = this.host.localPlaylists[i];
      if (lp != null && lp.id == pl.id) {
        lp.pid = generateGlobalPid();
        this.host.saveLocalPlaylistsNow();
        logMsg("[Player] 自建歌单 pid 缺失，已生成并写回本地 " + pl.name + " → " + lp.pid!);
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
      for (let i = 0; i < this.host.likedSongs.length; i++) {
        const song = this.host.likedSongs[i];
        if (song.id == sid && song.platform == platform) {
          song.likeSeq = seq;
          // 推送成功后回写 seq：这里没有跟着 persist()，靠脏标记留给下一次落盘
          this.host.likedDirty = true;
          return;
        }
      }
    } catch (_) {
      // 静默：回写 likeSeq 失败仅影响补推去重，下次同步幂等重写
    }
  }

  private markPlaylistLikedSeq(dataJson: string, seq: number): void {
    try {
      const obj = parseJsonToUtso(dataJson);
      const pid = obj.get("pid") as string | null;
      const platform = obj.get("platform") as string | null;
      if (pid == null || platform == null) return;
      for (let i = 0; i < this.host.savedPlaylists.length; i++) {
        const pl = this.host.savedPlaylists[i];
        if (pl.id == pid && pl.platform == platform) {
          pl.likeSeq = seq;
          this.host.playlistsDirty = true;
          return;
        }
      }
      // 本地自建歌单也记 likeSeq（按 pid 匹配），否则每次启动补推都会重复上送
      for (let i = 0; i < this.host.localPlaylists.length; i++) {
        const pl = this.host.localPlaylists[i];
        if (pl != null && pl.pid == pid && pl.platform == platform) {
          pl.likeSeq = seq;
          this.host.saveLocalPlaylistsNow();
          return;
        }
      }
    } catch (_) {
      // 静默：歌单 likeSeq 回写失败仅影响补推去重，下次同步幂等重写
    }
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
          logMsg("[Player] 检测到服务器收藏版本号倒退（数据库可能被重建），游标对齐 " + this.likeCursor + " → " + res.maxSeq);
          this.likeCursor = res.maxSeq;
          this.save();
          break;
        }
        if (res.changes.length == 0) {
          if (res.maxSeq > this.likeCursor) this.likeCursor = res.maxSeq;
          break;
        }
        let maxApplied = this.likeCursor;
        let deferred = false;
        for (let i = 0; i < res.changes.length; i++) {
          const change = res.changes[i];
          // 这一条现在不能收（本地改名/封面的 pending 还没推成功）：游标必须停在它
          // 之前，等下一轮 pending 出队后再取。若照旧推过游标，这条服务器版本会被
          // 永久跳过 —— 用户在新设备/重装后看不到自己改过的歌单名与封面。
          if (this.isDeferredLikeChange(change)) {
            deferred = true;
            break;
          }
          if (change.updatedSeq > maxApplied) maxApplied = change.updatedSeq;
          this.applyLikeChange(change);
        }
        this.likeCursor = maxApplied;
        this.save();
        this.host.persistNow();
        // 有变更被推迟：立刻重取只会又拿到同一条，直接交给下一轮同步
        if (deferred) break;
      }
    } catch (e) {
      logMsg("[Player] 收藏增量同步失败", e);
    } finally {
      this.likeSyncBusy = false;
    }
  }

  /**
   * 这条变更现在必须留到下一轮再收吗？
   *
   * 本地歌单的改名/封面走 `playlist/add` 的 pending 队列，推成功之前服务器上仍是
   * 旧版本。此刻若把旧版本收下会覆盖本地刚改的名字/封面；更严重的是拉取游标会被
   * 推过这条变更 —— 即使之后 pending 成功，这条也永久跳过，换个设备/重装后
   * 看到的还是旧名旧封面（2026-11-02 审阅）。返回 true 时调用方必须停在它之前。
   */
  private isDeferredLikeChange(change: LikeChange): boolean {
    if (change.type != "playlist") return false;
    if (change.platform != "local") return false;
    const pid = change.pid != null && change.pid.length > 0 ? change.pid! : change.id;
    if (pid.length == 0) return false;
    return this.hasPendingLikeOp("playlist", pid, change.platform);
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
    const idx = this.host.findCollectedSongById(change.id, change.platform);
    if (change.deleted) {
      if (idx < 0) return;
      const entry = this.host.likedSongs[idx];
      const localSeq = entry.likeSeq != null ? entry.likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      // 只摘变更里指定的那一个 pid
      if (change.pid != null && change.pid.length > 0) {
        this.host.removePidFromSong(entry, change.pid);
        if (entry.pids != null && entry.pids.length > 0) {
          entry.likeSeq = change.updatedSeq;
          this.host.likedDirty = true;
          this.host.persistNow();
          return;
        }
      }
      const next: Song[] = [];
      for (let i = 0; i < this.host.likedSongs.length; i++) {
        if (i != idx) next.push(this.host.likedSongs[i]);
      }
      this.host.likedSongs = next;
      this.host.likedDirty = true;
      this.host.persistNow();
      return;
    }
    if (idx >= 0) {
      const entry = this.host.likedSongs[idx];
      const localSeq = entry.likeSeq != null ? entry.likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      entry.name = change.name;
      entry.singer = change.singer;
      entry.album = change.album;
      if (change.hash.length > 0 && change.hash.toLowerCase() != "nohash") entry.musicId = change.hash;
      // 封面「非空覆盖、空值保留」：空图变更不清掉本地已有封面
      if (change.picUrl != null && change.picUrl.length > 0) entry.picUrl = change.picUrl;
      if (change.pid != null && change.pid.length > 0) this.host.addPidToSong(entry, change.pid);
      entry.likeSeq = change.updatedSeq;
      this.host.likedDirty = true;
      this.host.persistNow();
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
    this.host.likedSongs.push(song);
    this.host.likedDirty = true;
    this.host.persistNow();
  }

  private applyPlaylistChange(change: LikeChange): void {
    // platform=local 的删除是「自建歌单被删」（本机或他端操作）：
    // 本机建的在 localPlaylists、他端建的在 savedPlaylists，两处都查、
    // 摘成员归属并落盘，否则歌单以幽灵形态残留、下次对账还会把它复活
    if (change.deleted && change.platform === 'local') {
      const pid = change.pid != null && change.pid.length > 0 ? change.pid! : change.id;
      if (pid.length > 0) {
        this.host.removeLocalPlaylistEverywhere(pid, change.updatedSeq);
      }
      return;
    }
    // 本地自建歌单的重命名也走 playlist/add（按 pid upsert）。离线改名时，
    // 当前游标之后仍可能收到服务器里「改名前」的同 pid 增量；pending 未成功前
    // 必须保留本地新名，不能让旧变更覆盖。成功推送会先出队并回写 likeSeq，
    // 下一轮拉取即可正常接收服务端确认的版本。
    const incomingPid = change.pid != null && change.pid.length > 0 ? change.pid! : change.id;
    if (change.platform === "local" && this.hasPendingLikeOp("playlist", incomingPid, change.platform)) return;
    let idx = -1;
    for (let i = 0; i < this.host.savedPlaylists.length; i++) {
      const pl = this.host.savedPlaylists[i];
      if (pl.id == change.id && pl.platform == change.platform) {
        idx = i;
        break;
      }
    }
    if (change.deleted) {
      if (idx < 0) return;
      const localSeq = this.host.savedPlaylists[idx].likeSeq != null ? this.host.savedPlaylists[idx].likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      const next: Playlist[] = [];
      for (let i = 0; i < this.host.savedPlaylists.length; i++) {
        if (i != idx) next.push(this.host.savedPlaylists[i]);
      }
      this.host.savedPlaylists = next;
      // 这里刻意不 persist()（增量拉取的循环外统一落盘），只置脏；
      // 若调用方中途异常退出，脏标记会留给下一次 persist() 兜底
      this.host.playlistsDirty = true;
      return;
    }
    if (idx >= 0) {
      const local = this.host.savedPlaylists[idx];
      const localSeq = local.likeSeq != null ? local.likeSeq! : 0;
      if (localSeq > change.updatedSeq) return;
      // 补 pid：增量路径下歌单可能只有 id，pid 缺失会导致收藏时匹配不上
      if (change.pid != null && change.pid.length > 0) local.pid = change.pid;
      else if (local.pid == null || local.pid.length == 0) local.pid = change.id;
      local.name = change.name;
      if (change.picUrl.length > 0) local.picUrl = change.picUrl;
      local.likeSeq = change.updatedSeq;
      this.host.savedPlaylists[idx] = local;
      this.host.playlistsDirty = true;
      return;
    }
    // 本机自建歌单：服务器的这条变更只回写元数据，不再另建一条 savedPlaylists 记录 ——
    // 展示层是 localPlaylists + savedPlaylists 直接拼接，重复收下会出两张卡、计数多 1
    if (this.host.isLocallyOwnedPlaylist(incomingPid, change.platform)) {
      for (let i = 0; i < this.host.localPlaylists.length; i++) {
        const lp = this.host.localPlaylists[i];
        const lpid = lp.pid != null && lp.pid.length > 0 ? lp.pid! : lp.id;
        if (lpid != incomingPid || lp.platform != change.platform) continue;
        const localSeq = lp.likeSeq != null ? lp.likeSeq! : 0;
        if (localSeq > change.updatedSeq) return;
        if (change.name.length > 0) lp.name = change.name;
        if (change.picUrl.length > 0) lp.picUrl = change.picUrl;
        lp.likeSeq = change.updatedSeq;
        this.host.saveLocalPlaylistsNow();
        return;
      }
    }
    if (this.hasPendingLikeOp("playlist", change.id, change.platform)) return;
    this.host.savedPlaylists.push({
      id: change.id,
      name: change.name,
      picUrl: change.picUrl,
      playCount: "",
      platform: change.platform,
      description: null,
      likeSeq: change.updatedSeq,
      pid: incomingPid,
    });
    this.host.playlistsDirty = true;
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
      const hit = this.host.findCollectedSongInList(collapsedSongs, s.id, s.platform);
      if (hit < 0) {
        collapsedSongs.push(s);
        continue;
      }
      const target = collapsedSongs[hit];
      if (s.pids != null) {
        for (let k = 0; k < s.pids.length; k++) this.host.addPidToSong(target, s.pids[k]);
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
    for (let i = 0; i < this.host.likedSongs.length; i++) {
      const local = this.host.likedSongs[i];
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
      // 本地歌不上服务器（buildLikeOpBodyJson 对 platform=="local" 返回 null，
      // 服务器永远没有它的记录），按 pending/seq 判定必然双双落空 → 无条件保留。
      // 否则换设备登录触发一次全量拉取，收藏总表里的本地歌就被整批清掉（2026-11-03）。
      if (local.platform == "local" || this.hasPendingLikeOp("song", local.id, local.platform) || localSeq > serverSeq) {
        if (foundIdx >= 0) mergedSongs[foundIdx] = local;
        else mergedSongs.push(local);
      }
    }
    this.host.likedSongs = mergedSongs;
    this.host.likedDirty = true;
    const mergedPlaylists: Playlist[] = [];
    for (let i = 0; i < serverPlaylists.length; i++) {
      const pl = serverPlaylists[i];
      // 本机自建、已推送上去的歌单在本地以 localPlaylists 里的原条目为准，
      // 服务器那份不重复收下（否则「我的收藏歌单」出两张卡、计数多 1）
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (this.host.isLocallyOwnedPlaylist(pid, pl.platform)) continue;
      mergedPlaylists.push(pl);
    }
    for (let i = 0; i < this.host.savedPlaylists.length; i++) {
      const local = this.host.savedPlaylists[i];
      // 历史版本的全量拉取可能已把本机自建歌单写进 savedPlaylists，与 localPlaylists
      // 形成重复条目；这里一并剔除，避免下面按「本地 seq 更新」的规则又把它加回来
      const localPid = local.pid != null && local.pid.length > 0 ? local.pid! : local.id;
      if (this.host.isLocallyOwnedPlaylist(localPid, local.platform)) continue;
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
    this.host.savedPlaylists = mergedPlaylists;
    this.host.playlistsDirty = true;
    if (maxSeq > this.likeCursor) this.likeCursor = maxSeq;
    this.save();
    this.host.persistNow();
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
   * 加载框走 services/ui-loading.uts 的安全包装：框架 uni-showLoading 绑定
   * 「调用时的前台页面」，对已销毁页面调 show/hide 会抛内部空指针
   * （NativeLoading.updateUI index.kt:84）。这里延后 700ms 起跑，让登录跳转
   * （500ms）先完成，是第二道保险；第一道是包装层的判活 + 令牌。
   */
  async syncLikedFromServerInBackground(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, 700) as number);
    let token = 0;
    let shown = false;
    const showTimer = setTimeout(() => {
      token = beginLoading("正在同步收藏");
      shown = token > 0;
    }, 600) as number;
    try {
      await this.syncLikedFromServer();
    } catch (_) {
      // 静默：忽略同步失败（与旧登录流程同语义）
    } finally {
      clearTimeout(showTimer);
      if (shown) finishLoading(token);
    }
  }

  /**
   * 本地自建歌单元数据补推：只推「从未成功同步过（无 likeSeq）且当前不在待推送队列」的歌单。
   * 推送成功后 markPlaylistLikedSeq 会把 seq 记回本地歌单，之后不再重复。
   */
  private backfillLocalPlaylistsSync(): void {
    for (let i = 0; i < this.host.localPlaylists.length; i++) {
      const pl = this.host.localPlaylists[i];
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
    if (count > 0) logMsg('[Player] 启动对账补推收藏 ' + count + ' 项');
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
    for (let i = this.host.savedPlaylists.length - 1; i >= 0; i--) {
      const pl = this.host.savedPlaylists[i];
      if (pl == null) continue;
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (serverPlaylistKeys.indexOf(pl.platform + "|" + pid) >= 0) continue;
      if (this.hasPendingLikeOp("playlist", pid, pl.platform)) continue;
      const localSeq = pl.likeSeq != null ? pl.likeSeq! : 0;
      if (localSeq > 0) {
        // 云端确认过、现在没了 → 他端取消收藏/删除，本地跟随
        removedCount++;
        this.host.savedPlaylists.splice(i, 1);
        this.host.playlistsDirty = true;
        if (pl.platform === 'local') this.host.removeSongsOfPlaylistLocal(pl);
        continue;
      }
      this.enqueueLikeOp({ type: "playlist", action: "add", dataJson: this.likePlaylistPayloadJson(pl) });
      count++;
    }
    for (let i = this.host.localPlaylists.length - 1; i >= 0; i--) {
      const pl = this.host.localPlaylists[i];
      if (pl == null) continue;
      const pid = pl.pid != null && pl.pid.length > 0 ? pl.pid! : pl.id;
      if (serverPlaylistKeys.indexOf(pl.platform + "|" + pid) >= 0) continue;
      if (this.hasPendingLikeOp("playlist", pid, pl.platform)) continue;
      const localSeq = pl.likeSeq != null ? pl.likeSeq! : 0;
      if (localSeq > 0) {
        removedCount++;
        this.host.localPlaylists.splice(i, 1);
        this.host.removeSongsOfPlaylistLocal(pl);
        continue;
      }
      this.enqueueLikeOp({ type: "playlist", action: "add", dataJson: this.likePlaylistPayloadJson(pl) });
      count++;
    }
    if (removedCount > 0) {
      this.host.saveLocalPlaylistsNow();
      this.host.persistNow();
      logMsg("[Player] 对账跟随云端移除歌单 " + removedCount + " 个");
    }
    // 歌曲补推：同一首歌属于 N 个歌单就推 N 条（服务器按 sid+pid 建模），无 pid 推一条默认归属
    for (let i = 0; i < this.host.likedSongs.length; i++) {
      const song = this.host.likedSongs[i];
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
      this.host.persistNow();
      await this.flushPendingOps();
    }
    return count;
  }

  /** 该 pid 的歌单本地是否还存在（两个存储都查；对账歌曲补推的准入检查） */
  private playlistExistsLocally(pid: string): boolean {
    for (let i = 0; i < this.host.localPlaylists.length; i++) {
      const lp = this.host.localPlaylists[i];
      if (lp == null) continue;
      const lpid = lp.pid != null && lp.pid.length > 0 ? lp.pid! : lp.id;
      if (lpid == pid) return true;
    }
    for (let i = 0; i < this.host.savedPlaylists.length; i++) {
      const sp = this.host.savedPlaylists[i];
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
    this.save();
  }

  /**
   * 切换账号时清空本地收藏缓存（账号归属标记检测到换号时调用）。
   * 服务器是数据源，A 的数据留在 A 的服务器账号里；新账号登录后
   * syncLikedFromServer 游标为 0 会自动全量拉取本账号数据恢复本地。
   * 不动播放历史、下载等设备级数据。
   */
  clearLocalLikeData(): void {
    this.host.likedSongs = [];
    this.host.savedPlaylists = [];
    this.host.localPlaylists = [];
    this.host.likedDirty = true;
    this.host.playlistsDirty = true;
    this.host.localPlaylistsDirty = true;
    this.host.persistNow();
    this.resetLikeSync();
    logMsg("[Player] 检测到切换账号，已清空本地收藏缓存");
  }
}
