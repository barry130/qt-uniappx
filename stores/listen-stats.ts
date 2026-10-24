import { reactive } from "vue";
import type { Song } from "@/types/music";
import { parseJsonToUtso } from "@/services/http";
import { musicApi } from "@/services/music-api";
import { canUseListenStatsArchive, canWriteListenStats, listenStatsPath, readListenStatsArchive, readListenStatsArchiveIndex, readListenStatsFile, removeListenStatsArchive, removeListenStatsArchiveIndex, writeListenStatsArchive, writeListenStatsArchiveIndex, writeListenStatsFile } from "@/services/listen-stats-file";

const FALLBACK_KEY = "qt-listen-stats-fallback";
export type ListenSong = { song: Song; count: number; effectiveCount: number; seconds: number; legacyCount: number; completed: number; firstPlayedAt: number; lastPlayedAt: number };

/**
 * 某一天的听歌明细（日榜 / 周榜 / 月榜的数据源）。
 *
 * `songs` 的 key 与 `keyOf()` 一致（`platform:id`），值是**当时**那份歌曲元数据：
 * 不这样存的话，归档到备份文件后某首老歌在总榜里被清掉，日榜就只剩一个 id。
 */
export type ListenDay = { songs: Map<string, ListenDayRow> };
export type ListenDayRow = { count: number; seconds: number; song: Song };

/** 上报的服务端格式：行号对应列，song 字段是完整歌曲对象。 */
type ListenDayLine = { d: string; c: number; s: number; g: Song };

type Snapshot = { updatedAt: number; resetAt: number; songs: ListenSong[]; days: Map<string, ListenDay>; daysSeeded: boolean; avatars: Map<string, string>; pendingCounts: Map<string, number>; pendingSeconds: Map<string, number>; pendingCompleted: Map<string, number>; trackingSince: number };

/*
 * 日桶的备份是**按体积**触发的（见 archiveDays()），不是按日历天数。
 * 影响启动速度的是启动时要解析多少行，而每天听的歌数差异极大：固定天数
 * 可能只占 300KB，也可能撑到 2MB。所以：超过 ARCHIVE_TRIGGER_BYTES 就把最老的
 * 若干天写进备份文件，主存档回到 ARCHIVE_TARGET_BYTES 以内；已经进过备份的天
 * 才从内存裁掉（见 pruneDays()），没备份的天一天都不删。
 */

/**
 * 主存档 `days` 文本超过这个体积就备份（约 1000 行的量级）。
 *
 * 依据：每条日明细是一小段 JSON + 一次 JSON.parse，主存档本就只是「最近一段」的
 * 视图，超过千行后每次启动的解析开销和每次落盘的重写开销都开始明显。
 */
const ARCHIVE_TRIGGER_BYTES = 256 * 1024;

/** 备份一次退到目标体积：留近 600 行，仍然远大于任何日榜/周榜/月榜窗口。 */
const ARCHIVE_TARGET_BYTES = 160 * 1024;

/**
 * 单个备份文件的原始文本上限（约 180 万行字符）。
 *
 * 只影响「合并成一份」还是「多片」的选择：不设上限的话，合并一年历史时要把整个
 * 备份读进内存再拼一遍字符串，一年下来内存峰值会到几十 MB。
 */
const ARCHIVE_PART_BYTES = 1536 * 1024;

/** 启动解析主存档超过这个耗时就算慢（毫秒），备份触发线随之收紧。 */
const LOAD_SLOW_MS = 60;

/** 收紧后的触发线下限：别让慢机子把备份做到几 KB 一次。 */
const ARCHIVE_MIN_TRIGGER_BYTES = 64 * 1024;

/** 读取时最多拼这么多分片，防止目录里残留的旧文件被无限读进来。 */
const ARCHIVE_PART_LIMIT = 64;

/** 备份版本号写进文件，以后调整结构时按版本升级；读了不认识的版本就停在原地不推进。 */
const ARCHIVE_VERSION = 1;

/** 跨文件读备份的三种结局，见 readParts()。 */
const READ_FOUND = 1;
const READ_EMPTY = 0;
const READ_ERROR = -1;

/**
 * 单日明细备份：`{v: 版本, a: 备份时刻, d: ["YYYY-MM-DD", 行...]}`
 *
 * 行是 `[songKey, count, seconds, song]` 的紧凑数组而不是对象：日桶里一行有 4 个
 * 固定字段，对象形式每个字段都要重复写一遍键名，一年几万行下来全是冗余。
 */
type ListenDayArchive = { v: number; a: number; d: (string | (string | number | Song)[])[] };

/**
 * 一次打包的结果：分片文本 + 每片覆盖的日期区间。
 *
 * 区间顺手在打包时记下，写索引就不用再回头把每片 JSON 解析一遍。
 */
type ArchivePack = { parts: string[]; first: string[]; last: string[] };

/**
 * 备份索引（`listen-stats.json.archive.index`）：`{v, m, a, p: [[首日, 末日], ...]}`。
 *
 * `m` 是存放方式：0 = 单文件 `.archive`，1 = 分片 `.archive.1`…`.N`。必须显式记下来，
 * 因为「一片」既可能是单文件也可能是 `.1`，光看 `p` 的长度分不清。
 */
type ArchiveIndex = { v: number; m: number; a: number; p: string[][] };

/**
 * 本地日期的 `YYYY-MM-DD`。
 *
 * 必须用 `getFullYear/getMonth/getDate` 手动拼，不能 `toISOString().slice(0,10)`：
 * 后者是 UTC，东八区早上 8 点前的收听会被算进前一天。
 */
export function listenDayKey(at: number): string {
  const d = new Date(at);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + "-" + (month < 10 ? "0" + month : "" + month) + "-" + (day < 10 ? "0" + day : "" + day);
}

/** 截至 `endKey` 当天（含）的最近 `count` 天，按时间升序。today / 近 7 天 / 近 30 天都从这里切。 */
export function listenDayWindow(endKey: string, count: number): string[] {
  const split = endKey.split("-");
  const base = new Date(Number(split[0]), Number(split[1]) - 1, Number(split[2]));
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() - i);
    keys.push(listenDayKey(d.getTime()));
  }
  return keys;
}

function parsePending(obj: UTSJSONObject, field: string): Map<string, number> {
  const values = new Map<string, number>();
  const data = obj.get(field) as UTSJSONObject | null;
  if (data == null) return values;
  const keys = UTSJSONObject.keys(data);
  for (let i = 0; i < keys.length; i++) values.set(keys[i], positive(data.get(keys[i]) as number | null));
  return values;
}

function positive(n: number | null): number {
  return n != null && Number.isFinite(n) && n > 0 ? n : 0;
}
function keyOf(song: Song): string { return song.platform + ":" + song.id; }
function copySong(song: Song): Song {
  // 报告存档不带临时播放地址、收藏归属或账户信息。
  return { id: song.id, name: song.name, singer: song.singer, album: song.album,
    picUrl: song.picUrl, platform: song.platform, duration: song.duration };
}
/** 日明细：一行一条「某天某首歌」，行号对应列，歌曲对象完整内嵌。 */
function parseDays(obj: UTSJSONObject): Map<string, ListenDay> {
  const days = new Map<string, ListenDay>();
  const lines = obj.get("days") as string[] | null;
  if (lines == null) return days;
  for (let i = 0; i < lines.length; i++) {
    let line: ListenDayLine | null = null;
    try { line = JSON.parse(lines[i]) as ListenDayLine; } catch (_) { line = null; }
    if (line == null) continue;
    const key = line.d;
    if (key == null || key.length != 10) continue;
    const count = positive(line.c);
    const seconds = positive(line.s);
    const song = line.g;
    if ((count == 0 && seconds == 0) || song == null) continue;
    const id = song.id;
    const platform = song.platform;
    if (id == null || id.length == 0 || platform == null || platform.length == 0) continue;
    let day = days.get(key);
    if (day == null) {
      day = { songs: new Map<string, ListenDayRow>() };
      days.set(key, day);
    }
    day.songs.set(keyOf(song), { count, seconds, song: copySong(song) } as ListenDayRow);
  }
  return days;
}

/**
 * 「无日期累计值已归到升级当天」的标记。
 *
 * 旧存档只有每首歌的累计次数/时长，没有这些数字属于哪天。新版本第一次读到旧存档时
 * 把它们整体记到当天，然后打上这个标记；之后再读到的存档一律按新格式解析，不再初始化。
 * 标记和 version 分开存：只靠 version 无法区分「刚升到 v3、日明细还是空的」。
 */
function parseSeeded(obj: UTSJSONObject): boolean {
  const value = obj.get("daysSeededAt") as number | null;
  return value != null && value > 0;
}

/**
 * 一份备份里最晚的那一天（备份内按日期升序存放，取最后一条即可）。
 *
 * 只要日期字符串，所以不走 archiveDay() 逐行解析；遇到看不懂的结构返回空串，
 * 让调用方按「没有备份」处理（少裁总比错删安全）。
 */
function latestArchiveDay(archive: ListenDayArchive): string {
  for (let i = archive.d.length - 1; i >= 0; i--) {
    const item = archive.d[i] as (string | (string | number | Song)[]);
    if (typeof item === "string") continue;
    const parts = item as (string | number | Song)[];
    if (parts.length < 1) continue;
    const day = parts[0] as string;
    if (typeof day === "string" && day.length > 0) return day;
  }
  return "";
}

function parseSnapshot(text: string): Snapshot | null {
  if (text.length == 0) return null;
  try {
    const obj = parseJsonToUtso(text);
    const version = obj.get("version");
    if (version != 1 && version != 2 && version != 3) return null;
    const rows = obj.get("songs") as string[] | null;
    if (rows == null) return null;
    const songs: ListenSong[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const row = parseJsonToUtso(rows[i]);
      const songObj = row.get("song") as UTSJSONObject | null;
      if (songObj == null) continue;
      const id = songObj.get("id") as string | null;
      const platform = songObj.get("platform") as string | null;
      if (id == null || id.length == 0 || platform == null || platform.length == 0) continue;
      const song: Song = { id, platform, name: (songObj.get("name") as string | null) ?? "",
        singer: (songObj.get("singer") as string | null) ?? "", album: (songObj.get("album") as string | null) ?? "",
        picUrl: (songObj.get("picUrl") as string | null) ?? "", duration: positive(songObj.get("duration") as number | null) };
      const key = keyOf(song);
      if (seen.has(key)) continue;
      seen.add(key);
      // v2 起把「旧基座迁移来的次数」和「本次实际播放次数」分开存，必须分别读回再相加；
      // 只认 v2 会把 v3 存档的 effectiveCount 当 0，读一次盘就丢掉本机的播放次数。
      const effectiveRaw = row.get("effectiveCount") as number | null;
      const effectiveCount = version != 1 && effectiveRaw != null ? Math.floor(positive(effectiveRaw)) : (version != 1 ? Math.floor(positive(row.get("count") as number | null)) : 0);
      const legacyCount = Math.floor(positive(row.get(version == 1 ? "count" : "legacyCount") as number | null));
      songs.push({ song, count: effectiveCount + legacyCount, effectiveCount, legacyCount,
        seconds: positive(row.get("seconds") as number | null), completed: Math.floor(positive(row.get("completed") as number | null)),
        firstPlayedAt: positive(row.get("firstPlayedAt") as number | null), lastPlayedAt: positive(row.get("lastPlayedAt") as number | null) });
    }
    const avatars = new Map<string, string>();
    const pics = obj.get("avatars") as UTSJSONObject | null;
    if (pics != null) {
      const names = UTSJSONObject.keys(pics);
      for (let i = 0; i < names.length; i++) {
        const url = pics.get(names[i]) as string | null;
        if (url != null && /^https?:\/\//.test(url)) avatars.set(names[i], url);
      }
    }
    return { songs, days: parseDays(obj), daysSeeded: parseSeeded(obj), avatars, updatedAt: positive(obj.get("updatedAt") as number | null), resetAt: positive(obj.get("resetAt") as number | null),
      pendingCounts: version >= 2 ? parsePending(obj, "pendingCounts") : new Map<string, number>(), pendingSeconds: parsePending(obj, "pendingSeconds"),
      pendingCompleted: parsePending(obj, "pendingCompleted"), trackingSince: positive(obj.get("trackingSince") as number | null) };
  } catch (_) { return null; }
}

/** 与项目其它业务 store 一样使用 reactive 单例；完整报告独立于有长度上限的播放历史。 */
class ListenStatsStore {
  songs: ListenSong[] = [];
  /**
   * 按天明细。日榜 / 周榜 / 月榜和活跃天数都读它。
   *
   * 内存里只保留最近一段（体积触发备份后更早的天会移进备份文件），
   * 需要更早的日子时用 ensureDays() 按索引跨文件补读。
   */
  days = new Map<string, ListenDay>();
  artistPics = new Map<string, string>();
  ready = false;
  trackingSince = Date.now();
  publicSaved = false;
  storagePath = "";
  saving = false;
  private resetAt = 0;
  /** 日明细初始化标记：打过一次就不再初始化，见 seedDays()。 */
  private daysSeeded = false;
  /** 备份文件的日期水位（含）：<= 这天的日桶已经落进备份，可以从内存里裁掉。 */
  private archivedThrough = "";
  /** 备份写入串行队列，防止两次 flush 同时写同一批文件。 */
  private archiveTask: Promise<boolean> | null = null;
  /** 按需读备份的串行队列（见 ensureDays()）。 */
  private rangeTask: Promise<void> | null = null;
  /**
   * 按需从备份读进来的天（不进 `days`，见 ensureDays()）。
   *
   * 只在内存里，不落盘：主存档的职责是「最近一段」，老日子留在备份文件里，
   * 下次要看时再按索引取。`archiveQueried` 记已经问过备份的天（含确实没有的），
   * 避免每次切档都重新读一遍文件。
   */
  private archiveCache = new Map<string, ListenDay>();
  private archiveQueried = new Set<string>();
  /** 上次启动读主存档的耗时（毫秒），用于按真实成本收窄备份触发线。 */
  private loadCostMs = 0;
  /** 上次启动读到的存档文本大小。 */
  private loadedBytes = 0;
  /** 用户已清空：内存里没有数据，此时退出不能把「清空后没变化」的脏标记当成待清理。 */
  private discarded = false;
  private loadTask: Promise<void> | null = null;
  private saveTask: Promise<void> | null = null;
  private timer: number | null = null;
  private dirty = false;
  private publicLoaded = false;
  private generation = 0;
  private avatarAttempts = new Set<string>();
  // 尚未读到公共存档期间发生的增量，授权后合并时要加回，不能被旧存档覆盖。
  private sessionCounts = new Map<string, number>();
  private sessionSeconds = new Map<string, number>();
  private sessionCompleted = new Map<string, number>();

  get totalSeconds(): number {
    let total = 0;
    for (let i = 0; i < this.songs.length; i++) total += this.songs[i].seconds;
    return total;
  }

  load(history: Song[] = [], counts: Map<string, number> = new Map<string, number>()): Promise<void> {
    if (this.loadTask != null) return this.loadTask!;
    // 复制迁移输入，避免异步读盘期间历史/次数变化造成重复登记。
    const legacySongs: Song[] = [];
    for (let i = 0; i < history.length; i++) legacySongs.push(copySong(history[i]));
    const legacyCounts = new Map<string, number>(counts);
    this.loadTask = this.loadNow(legacySongs, legacyCounts);
    return this.loadTask!;
  }

  private async loadNow(history: Song[], counts: Map<string, number>): Promise<void> {
    this.storagePath = listenStatsPath();
    let fallback: Snapshot | null = null;
    try { fallback = parseSnapshot(uni.getStorageSync(FALLBACK_KEY) as string); } catch (_) {}
    const accessible = canWriteListenStats();
    const loadStarted = Date.now();
    const savedRead = await readListenStatsFile();
    const saved = parseSnapshot(savedRead.text);
    // 记下这次启动实际要解析的文件大小与解析耗时：备份触发线按真实成本校准，
    // 而不是拍一个天数。设备卡/文件大时会更早备份。
    this.loadCostMs = Date.now() - loadStarted;
    this.loadedBytes = savedRead.text.length;
    this.publicLoaded = accessible && savedRead.ok;
    const chosen = saved != null && (fallback == null || saved.updatedAt >= fallback.updatedAt) ? saved : fallback;
    if (chosen != null) {
      this.songs = chosen.songs;
      this.days = chosen.days;
      this.daysSeeded = chosen.daysSeeded;
      this.artistPics = chosen.avatars;
      this.resetAt = chosen.resetAt;
      this.trackingSince = chosen.trackingSince || Date.now();
      if (chosen == fallback) {
        this.sessionCounts = chosen.pendingCounts;
        this.sessionSeconds = chosen.pendingSeconds;
        this.sessionCompleted = chosen.pendingCompleted;
        if (accessible && saved != null) this.mergePublic(saved);
      }
    } else {
      const byKey = new Map<string, Song>();
      for (let i = 0; i < history.length; i++) byKey.set(keyOf(history[i]), history[i]);
      const keys = Array.from(counts.keys());
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const split = key.indexOf(":");
        if (split < 1) continue;
        const song = byKey.get(key) ?? { platform: key.substring(0, split), id: key.substring(split + 1), name: "历史歌曲", singer: "", album: "", picUrl: "" };
        this.songs.push({ song, count: positive(counts.get(key) ?? 0), effectiveCount: 0, legacyCount: positive(counts.get(key) ?? 0), seconds: 0, completed: 0, firstPlayedAt: 0, lastPlayedAt: 0 });
      }
    }
    if (this.publicLoaded) { this.sessionCounts.clear(); this.sessionSeconds.clear(); this.sessionCompleted.clear(); }
    // 水位必须从备份文件恢复：它只存在于内存的话，重启后 dayArchived() 恒为 false，
    // 已经备份过的天再也裁不掉，主存档会一直涨回去（体积触发瘦身只生效一次）。
    this.archivedThrough = await this.loadArchivedThrough();
    // 读到旧格式存档（没有初始化标记）时，把「没有日期的那部分累计值」一次性归到升级当天，
    // 之后的存档都带标记，不会再走这里。
    this.seedDays();
    this.publicSaved = saved != null && chosen == saved;
    this.ready = true;
    this.scheduleSave();
  }

  /**
   * 首次读到没有日期的存档时，把累计值整体记到「升级当天」。
   *
   * 为什么整体记到当天而不是平均分摊或丢掉：这些数字本来就没有日期信息，
   * 分摊出来的是编造的历史，丢掉又会让用户觉得「统计被清零了」；
   * 归到升级当天至少让日榜立刻有内容、和累计数字对得上。
   *
   * 同一天里已经存在的行（升级当天先听了歌、之后才跑到这次初始化）直接累加。
   */
  private seedDays(): void {
    if (this.daysSeeded) return;
    const today = listenDayKey(Date.now());
    for (let i = 0; i < this.songs.length; i++) {
      const row = this.songs[i];
      if (row.count <= 0 && row.seconds <= 0) continue;
      let day = this.days.get(today);
      if (day == null) {
        day = { songs: new Map<string, ListenDayRow>() };
        this.days.set(today, day);
      }
      const key = keyOf(row.song);
      const existing = day.songs.get(key);
      if (existing != null) {
        existing.count += row.count;
        existing.seconds += row.seconds;
      } else {
        day.songs.set(key, { count: row.count, seconds: row.seconds, song: copySong(row.song) } as ListenDayRow);
      }
    }
    this.daysSeeded = true;
    this.dirty = true;
  }

  private row(song: Song): ListenSong {
    const key = keyOf(song);
    for (let i = 0; i < this.songs.length; i++) {
      if (keyOf(this.songs[i].song) == key) return this.songs[i];
    }
    const row: ListenSong = { song: copySong(song), count: 0, effectiveCount: 0, seconds: 0, legacyCount: 0, completed: 0, firstPlayedAt: 0, lastPlayedAt: 0 };
    this.songs.push(row);
    return this.songs[this.songs.length - 1];
  }

  artistPic(name: string): string { return this.artistPics.get(name) ?? ""; }

  async ensureArtistPic(song: Song): Promise<void> {
    await this.load();
    const name = song.singer.trim();
    const attempt = song.platform + ":" + name;
    if (name.length == 0 || song.platform == "local" || this.artistPic(name).length > 0 || this.avatarAttempts.has(attempt)) return;
    this.avatarAttempts.add(attempt);
    const generation = this.generation;
    try {
      const result = await musicApi.artistSongs(name, song.platform, 1, 1);
      let url = result.picUrl;
      if (url.length == 0) {
        const artists = await musicApi.searchArtists(name, song.platform, 1, 5);
        for (let i = 0; i < artists.length; i++) {
          if (artists[i].name.trim().toLowerCase() == name.toLowerCase()) { url = artists[i].picUrl; break; }
        }
      }
      if (generation != this.generation || !/^https?:\/\//.test(url)) return;
      this.artistPics.set(name, url);
      this.scheduleSave();
    } catch (_) { /* 此平台失败不拦截播放；换平台播放同一歌手时仍会尝试。*/ }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.timer != null) return;
    // 固定窗口而非反复重置的 debounce：连续播放也每 5 秒落一次盘。
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 5000);
  }

  /** 记一笔到当天桶。次数与时长都为 0 的调用（只有完播标记）不建桶。 */
  private addToday(song: Song, seconds: number, count: number, at: number): void {
    if (seconds <= 0 && count <= 0) return;
    const key = listenDayKey(at);
    let day = this.days.get(key);
    if (day == null) {
      day = { songs: new Map<string, ListenDayRow>() };
      this.days.set(key, day);
    }
    const songKey = keyOf(song);
    const row = day.songs.get(songKey);
    if (row == null) {
      day.songs.set(songKey, { count, seconds, song: copySong(song) } as ListenDayRow);
      return;
    }
    row.count += count;
    row.seconds += seconds;
    // 元数据以最近一次为准：换封面、补专辑名都应该在日榜里看到。
    row.song = copySong(song);
  }

  /**
   * 合并磁盘上的日桶。
   *
   * 只在「内存里已经有这次启动记的增量」时按取大合并：那种情况下磁盘与内存记的是
   * 同一段收听，相加会把一份播放算两遍；否则（如升级后首次拿到历史日桶）必须接上，
   * 取大会把历史天数整段丢掉。
   */
  private mergeDays(saved: Map<string, ListenDay>): void {
    const delta = this.sessionCounts.size > 0 || this.sessionSeconds.size > 0;
    const keys = Array.from(saved.keys());
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const old = saved.get(key)!;
      let day = this.days.get(key);
      if (day == null) {
        day = { songs: new Map<string, ListenDayRow>() };
        this.days.set(key, day);
      }
      const songKeys = Array.from(old.songs.keys());
      for (let j = 0; j < songKeys.length; j++) {
        const oldRow = old.songs.get(songKeys[j])!;
        const row = day.songs.get(songKeys[j]);
        if (row == null) {
          day.songs.set(songKeys[j], oldRow);
          continue;
        }
        if (delta) {
          row.count = Math.max(row.count, oldRow.count);
          row.seconds = Math.max(row.seconds, oldRow.seconds);
        } else {
          row.count += oldRow.count;
          row.seconds += oldRow.seconds;
        }
      }
    }
  }

  /**
   * 已经从内存里摘掉的天桶：条件只有一个——那一天确实进了备份文件。
   *
   * 不按「超过 N 天」判断：备份是体积触发的，瘦身目标也按体积算，若再叠加日历门槛，
   * 备份完最近 90 天内的数据后主存档体积根本降不下来，自测里 404400 字节就是这么来的。
   * 反过来，没备份的天一律留着——硬删会静默丢历史。
   */
  private pruneDays(): void {
    if (this.archivedThrough.length == 0) return;
    // 今天一律不摘：它的桶还在被后续播放累加，摘掉之后新建的桶只有增量，
    // 落盘合并按取大处理会把当天已有次数压回旧值。备份那边也已经不写今天，
    // 这里再兜一层，防止旧版本留下的水位正好停在今天。
    const today = listenDayKey(Date.now());
    const keys = Array.from(this.days.keys());
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] >= today) continue;
      if (!this.dayArchived(keys[i])) continue;
      this.days.delete(keys[i]);
    }
  }

  /** 这一天是否已经写进过备份文件。 */
  private dayArchived(key: string): boolean {
    if (this.archivedThrough.length == 0) return false;
    return key <= this.archivedThrough;
  }

  /**
   * 档案体积超预算时，把最老的若干天备份出去（备份进来之前不会因为天数硬删）。
   *
   * 触发条件是**下一次启动要解析的文本大小**，不是日历天数：真正拖慢启动的是
   * 主存档里 `days` 的行数与行内容长度（每行要单独 JSON.parse），所以按体积切最准；
   * 每天听歌时长不同，固定 90 天可能只占 300KB 也可能撑到 2MB。
   *
   * 顺序 读旧备份 → 合并 → 写新备份 → 更新水位：任一步失败水位不动，
   * 下次 flush 重试，内存里的天一条都不删（宁可这次不瘦身，也不丢数据）。
   *
   * 返回是否写入了新内容（调用方据此重新落主存档）。
   */
  private async archiveDays(): Promise<boolean> {
    if (this.discarded) return false;
    if (!canUseListenStatsArchive()) return false;
    const bytes = this.daysBytes();
    if (bytes <= this.triggerBytes()) return false;
    let keepBytes = 0;
    const keys = Array.from(this.days.keys());
    keys.sort();
    for (let i = 0; i < keys.length; i++) {
      if (!this.dayArchived(keys[i])) continue;
      keepBytes += this.dayBytes(keys[i]);
    }
    // 从最老的那天开始备份，直到剩下能留的部分回到目标体积以下。
    // 今天永远不备份：它还在累加，一旦进了备份、从 `days` 摘掉，后续播放就会新建一个
    // 只有增量的空桶，落盘合并时按取大处理会把当天已有次数压回旧值（少记）。
    const today = listenDayKey(Date.now());
    const stale: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] >= today) break;
      if (bytes - keepBytes <= ARCHIVE_TARGET_BYTES) break;
      const size = this.dayBytes(keys[i]);
      stale.push(keys[i]);
      keepBytes += size;
    }
    if (stale.length == 0) return false;
    const archive = await this.loadArchive();
    // 读不到或版本不认识时不写：覆盖掉已有历史比这次不瘦身糟糕得多。
    if (archive == null) return false;
    for (let i = 0; i < stale.length; i++) {
      const day = this.days.get(stale[i]);
      if (day == null) continue;
      // 同一天可能既在备份里又在内存里（合并磁盘日桶、手动补数据）。合并取大不累加：
      // 两个来源记的是同一段收听，相加会把播放次数算两遍。
      const rows = this.archiveDay(archive, stale[i]);
      const songKeys = Array.from(day.songs.keys());
      for (let j = 0; j < songKeys.length; j++) {
        const row = day.songs.get(songKeys[j])!;
        const old = rows.get(songKeys[j]);
        if (old == null) { rows.set(songKeys[j], row); continue; }
        rows.set(songKeys[j], { count: Math.max(old.count, row.count), seconds: Math.max(old.seconds, row.seconds), song: row.song } as ListenDayRow);
      }
      this.archiveSetDay(archive, stale[i], rows);
    }
    archive.a = Date.now();
    // 这些天刚刚带着最新行写进备份，内存里按需读的旧副本立刻作废：
    // 留着的话，pruneDays() 把它们从 `days` 摘掉后，dayAt() 会退回这份更旧的副本。
    for (let i = 0; i < stale.length; i++) {
      this.archiveCache.delete(stale[i]);
      this.archiveQueried.delete(stale[i]);
    }
    // 写入串行：主存档与备份可能同时被两次 flush 触发，串行才不会互相覆盖水位。
    this.archiveTask = this.queueArchive(this.packArchive(archive), stale[stale.length - 1]);
    return await this.archiveTask!;
  }

  /** 备份是只增内容，并发写会互相覆盖：统一排到同一个 Promise 后面。 */
  private async queueArchive(pack: ArchivePack, through: string): Promise<boolean> {
    const previous = this.archiveTask;
    const run = async (): Promise<boolean> => {
      if (previous != null) { try { await previous; } catch (_) {} }
      const ok = await this.commitArchive(pack);
      if (ok && through > this.archivedThrough) this.archivedThrough = through;
      return ok;
    };
    const task = run();
    return await task;
  }

  /**
   * 把分片写成备份文件。
   *
   * 只有一个分片时写 `listen-stats-archive`；攒到多片时整体轮转成 `.1`、`.2`…，
   * 这样「合并成完整历史」和「开新文件」是同一次原子改名，任何时刻都不会出现
   * 某一段历史既不在旧文件也不在新文件里的中间状态。
   */
  private async commitArchive(pack: ArchivePack): Promise<boolean> {
    const parts = pack.parts;
    const plain = parts.length == 1 && parts[0].length <= ARCHIVE_PART_BYTES;
    try {
      if (plain) {
        const ok = await writeListenStatsArchive(parts[0], 0);
        if (!ok) return false;
        // 上次可能是多片，清掉残留分片，免得下次读回把过期内容也拼进来。
        for (let i = 1; i <= ARCHIVE_PART_LIMIT; i++) {
          if (!await removeListenStatsArchive(i)) break;
        }
        await this.writeArchiveIndex(0, pack);
        return true;
      }
      // 先收窄旧分片：本次要写几片就留几片，多出来的（上次更多）清掉。
      // 顺序很关键——先删掉更靠后的分片，再把新内容改名成 `.1`，
      // 中途失败最多留下「旧 .1..N 或新 .1..N」，不会拼出重复历史。
      for (let i = parts.length + 1; i <= ARCHIVE_PART_LIMIT; i++) {
        if (!await removeListenStatsArchive(i)) break;
      }
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].length == 0) return false;
        const ok = await writeListenStatsArchive(parts[i], i + 1);
        if (!ok) return false;
      }
      await removeListenStatsArchive(0);
      await this.writeArchiveIndex(1, pack);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 写备份索引（失败无所谓：读不到索引会退回逐片全读）。
   *
   * 放在分片全部落盘之后写，且用原子写：索引要么指向上一次完整的分片布局，
   * 要么指向这一次的，不会出现指向写到一半的中间状态。
   */
  private async writeArchiveIndex(mode: number, pack: ArchivePack): Promise<void> {
    const ranges: string[][] = [];
    for (let i = 0; i < pack.first.length; i++) ranges.push([pack.first[i], pack.last[i]]);
    const index: ArchiveIndex = { v: ARCHIVE_VERSION, m: mode, a: Date.now(), p: ranges };
    try { await writeListenStatsArchiveIndex(JSON.stringify(index)); } catch (_) {}
  }

  /** 读并校验备份索引；不可用（缺失/损坏/对不上实际分片）一律返回 null。 */
  private async loadArchiveIndex(): Promise<ArchiveIndex | null> {
    try {
      const read = await readListenStatsArchiveIndex();
      if (!read.ok || read.text.length == 0) return null;
      const index = JSON.parse(read.text) as ArchiveIndex;
      if (index == null || index.v != ARCHIVE_VERSION) return null;
      if (index.p == null || index.p.length == 0) return null;
      for (let i = 0; i < index.p.length; i++) {
        const range = index.p[i];
        if (range == null || range.length < 2) return null;
        // 日期必须是 `YYYY-MM-DD` 且首 <= 末，否则索引不可信，直接作废。
        if (range[0].length != 10 || range[1].length != 10 || range[0] > range[1]) return null;
      }
      return index;
    } catch (_) {
      return null;
    }
  }

  /** 读备份（含多分片），拼成一份；读不懂返回 null，调用方必须放弃这次备份。 */
  private async loadArchive(): Promise<ListenDayArchive | null> {
    try {
      const read = await readListenStatsArchive(0);
      if (!read.ok) return null;
      // 只有真的读到内容才认这份「整块备份」。文件不存在时 read 也是 ok+空串，
      // 若在这里就返回空档案，分片模式下（`.archive` 已被删掉）每次都会读成
      // 「没有任何备份」，新备份只写进当次那几天，历史被悄悄抹掉。
      if (read.text.length > 0) {
        const single = this.parseArchive(read.text);
        if (single != null) return single;
      }
      const merged: ListenDayArchive = { v: ARCHIVE_VERSION, a: 0, d: [] };
      let found = false;
      for (let i = 1; i <= ARCHIVE_PART_LIMIT; i++) {
        const part = await readListenStatsArchive(i);
        if (!part.ok || part.text.length == 0) break;
        const parsed = this.parseArchive(part.text);
        if (parsed == null) return null;
        found = true;
        this.appendArchive(merged, parsed);
      }
      if (!found) return { v: ARCHIVE_VERSION, a: 0, d: [] };
      return merged;
    } catch (_) {
      return null;
    }
  }

  /**
   * 按需从备份文件里读某几天的日桶（跨文件范围查询）。
   *
   * 主存档只保留最近一段（体积触发备份后老日子会被裁掉），但日榜「近 30 天」、
   * 年度回顾这类查询可能伸进备份里。这里按索引挑出覆盖这些日子的那几个分片来读，
   * 不再把所有分片都解析一遍；索引缺失或损坏时退回逐片全读，结果一样、只是慢些。
   *
   * 读进来的天放进 `archiveCache` 而不是 `days`：`days` 会被写回主存档，
   * 老日子一旦回去就会立刻被 pruneDays() 再裁一次，白折腾还多占启动解析量。
   */
  async ensureDays(keys: string[]): Promise<void> {
    if (!canUseListenStatsArchive()) return;
    const wanted: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key.length != 10) continue;
      if (this.days.has(key) || this.archiveQueried.has(key)) continue;
      wanted.push(key);
    }
    if (wanted.length == 0) return;
    // 串行：报告页与年度页可能同时请求，别让它们并发读同一批分片。
    const previous = this.rangeTask;
    const run = async (): Promise<void> => {
      if (previous != null) { try { await previous; } catch (_) {} }
      await this.readRange(wanted);
    };
    const task = run();
    this.rangeTask = task;
    await task;
  }

  private async readRange(keys: string[]): Promise<void> {
    try {
      const index = await this.loadArchiveIndex();
      const picked: number[] = [];
      const single = index != null && index.m == 0;
      if (index == null) {
        // 没有可信索引：逐片全读（0 号是单文件，1..N 是分片）。
        for (let i = 0; i <= ARCHIVE_PART_LIMIT; i++) picked.push(i);
      } else if (single) {
        picked.push(0);
      } else {
        for (let i = 0; i < index.p.length; i++) {
          const range = index.p[i];
          for (let j = 0; j < keys.length; j++) {
            if (keys[j] >= range[0] && keys[j] <= range[1]) { picked.push(i + 1); break; }
          }
        }
      }
      const found = new Set<string>();
      let outcome = await this.readParts(picked, keys, found);
      // 按索引挑片却一个字节都没读到：说明索引比实际文件旧（例如写完分片后索引落盘
      // 失败，或分片又被合并回整块备份）。这时不能把这些天当成「备份里没有」——
      // 一旦标成已查过就再也不会补读，数据会静默消失。退回逐片全读一次再下结论。
      // 索引缺失时上面本来就是全读，不必再试一遍。
      if (outcome == READ_EMPTY && index != null) {
        const all: number[] = [];
        for (let i = 0; i <= ARCHIVE_PART_LIMIT; i++) all.push(i);
        outcome = await this.readParts(all, keys, found);
      }
      // 读出错（文件打不开、内容坏了）：一个字都别标记，下次进页面再试。
      if (outcome == READ_ERROR) return;
      for (let i = 0; i < keys.length; i++) this.archiveQueried.add(keys[i]);
    } catch (_) {}
  }

  /**
   * 读指定的几份备份，把命中的天合并进 `archiveCache`。
   *
   * 三态返回，因为「读不到」有两种完全不同的含义，混在一起会丢数据：
   * 读到过内容（`READ_FOUND`）→ 没命中的天可以确定不在备份里；
   * 全都读到空（`READ_EMPTY`）→ 备份还没写过，或索引指的片已经不存在；
   * 出错（`READ_ERROR`）→ 结论不可信，这次什么都不能标记。
   */
  private async readParts(parts: number[], keys: string[], found: Set<string>): Promise<number> {
    let outcome = READ_EMPTY;
    for (let i = 0; i < parts.length; i++) {
      const read = await readListenStatsArchive(parts[i]);
      if (!read.ok) return READ_ERROR;
      if (read.text.length == 0) continue;
      const parsed = this.parseArchive(read.text);
      if (parsed == null) return READ_ERROR;
      outcome = READ_FOUND;
      for (let j = 0; j < keys.length; j++) {
        if (found.has(keys[j])) continue;
        const rows = this.archiveDay(parsed, keys[j]);
        if (rows.size == 0) continue;
        found.add(keys[j]);
        this.mergeArchiveDay(keys[j], rows);
      }
    }
    return outcome;
  }

  /** 同一天在备份里出现多次（理论上不该有）时按较大值合并，不重复累加。 */
  private mergeArchiveDay(key: string, rows: Map<string, ListenDayRow>): void {
    let day = this.archiveCache.get(key);
    if (day == null) {
      day = { songs: new Map<string, ListenDayRow>() };
      this.archiveCache.set(key, day);
    }
    const songKeys = Array.from(rows.keys());
    for (let i = 0; i < songKeys.length; i++) {
      const row = rows.get(songKeys[i])!;
      const old = day.songs.get(songKeys[i]);
      if (old == null) { day.songs.set(songKeys[i], row); continue; }
      day.songs.set(songKeys[i], { count: Math.max(old.count, row.count), seconds: Math.max(old.seconds, row.seconds), song: row.song } as ListenDayRow);
    }
  }

  /** 某一天的日桶：先看主存档，再看按需读进来的备份。 */
  dayAt(key: string): ListenDay | null {
    const day = this.days.get(key);
    if (day != null) return day;
    return this.archiveCache.get(key) ?? null;
  }

  /** 某个窗口内所有有数据的天，合成一张表交给 reportDayEntries。 */
  daysIn(keys: string[]): Map<string, ListenDay> {
    const merged = new Map<string, ListenDay>();
    for (let i = 0; i < keys.length; i++) {
      const day = this.dayAt(keys[i]);
      if (day != null) merged.set(keys[i], day);
    }
    return merged;
  }

  /**
   * 备份文件里最晚的那一天，作为「已经备份到哪」的水位。
   *
   * 启动时只读这一个值，不把整份备份解析进内存：备份可能分几十片、几 MB，
   * 为了算一个水位全解析会白白拖慢启动。所以优先用整块备份里的 `a` 字段，
   * 分片模式则读每片的头（同样要扫一遍，但只是字符串比较，不再 JSON.parse 每一天）。
   * 读不到就返回空串，等于「没有备份」，只会少裁不会多删。
   */
  private async loadArchivedThrough(): Promise<string> {
    if (!canUseListenStatsArchive()) return "";
    try {
      const read = await readListenStatsArchive(0);
      if (read.ok && read.text.length > 0) {
        const single = this.parseArchive(read.text);
        if (single != null) return latestArchiveDay(single);
      }
      let latest = "";
      for (let i = 1; i <= ARCHIVE_PART_LIMIT; i++) {
        const part = await readListenStatsArchive(i);
        if (!part.ok || part.text.length == 0) break;
        const parsed = this.parseArchive(part.text);
        if (parsed == null) return "";
        const day = latestArchiveDay(parsed);
        if (day > latest) latest = day;
      }
      return latest;
    } catch (_) {
      return "";
    }
  }

  /** 空串=没有备份；解析失败或版本不认识=null。 */
  private parseArchive(text: string): ListenDayArchive | null {
    if (text.length == 0) return { v: ARCHIVE_VERSION, a: 0, d: [] };
    let parsed: ListenDayArchive | null = null;
    try { parsed = JSON.parse(text) as ListenDayArchive; } catch (_) { parsed = null; }
    if (parsed == null || parsed.v != ARCHIVE_VERSION || parsed.d == null) return null;
    return parsed;
  }

  private appendArchive(target: ListenDayArchive, source: ListenDayArchive): void {
    for (let i = 0; i < source.d.length; i++) {
      const item = source.d[i] as (string | (string | number | Song)[]);
      if (typeof item === "string") continue;
      const parts = item as (string | number | Song)[];
      if (parts.length < 1) continue;
      this.archiveSetDay(target, parts[0] as string, this.archiveDay(source, parts[0] as string));
    }
  }

  /**
   * 打包成若干分片：每份尽量接近但不超过 ARCHIVE_PART_BYTES。
   *
   * 单条一天的行本身不会超过上限（一天最多几百首），按天切分即可。
   * 分片数硬限制在 ARCHIVE_PART_LIMIT 以内：多出来的天不再另开新片，
   * 而是继续堆进最后一片（最后一片因此允许超过 ARCHIVE_PART_BYTES）。
   * 不这么兜底的话，一次性备份几百天就会写出第 65 片，而 loadArchive()
   * 只读到 ARCHIVE_PART_LIMIT，水位算小、主存档裁不掉，还会悄悄丢历史。
   */
  private packArchive(archive: ListenDayArchive): ArchivePack {
    const head = '{"v":' + ARCHIVE_VERSION + ',"a":' + archive.a + ',"d":[';
    const parts: string[] = [];
    const first: string[] = [];
    const last: string[] = [];
    let current = head;
    let currentFirst = "";
    let currentLast = "";
    for (let i = 0; i < archive.d.length; i++) {
      const item = archive.d[i] as (string | (string | number | Song)[]);
      const piece = JSON.stringify(item);
      const full = current.length + piece.length + 2 > ARCHIVE_PART_BYTES && current != head;
      // 已经写到上限就只往最后一片里塞，宁可最后一片变大也不能多开一片。
      if (full && parts.length + 1 < ARCHIVE_PART_LIMIT) {
        parts.push(current + "]}");
        first.push(currentFirst);
        last.push(currentLast);
        current = head;
        currentFirst = "";
        currentLast = "";
      }
      // 顺手记下每片覆盖的日期区间，写索引时就不用再回头解析一遍文本。
      const key = typeof item === "string" ? "" : ((item as (string | number | Song)[])[0] as string);
      if (currentFirst.length == 0) currentFirst = key;
      currentLast = key;
      if (current != head) current += ",";
      current += piece;
    }
    if (current != head) {
      parts.push(current + "]}");
      first.push(currentFirst);
      last.push(currentLast);
    }
    return { parts, first, last } as ArchivePack;
  }

  /**
   * 本次的备份触发线。
   *
   * 默认 ARCHIVE_TRIGGER_BYTES；但上次启动实测解析耗时超过 LOAD_SLOW_MS 时，
   * 按「耗时与体积大致成正比」把它压到实测体积的 80%，让这种机子/这种数据量
   * 尽早瘦身。下限 ARCHIVE_MIN_TRIGGER_BYTES 防止极小文件也天天备份。
   */
  private triggerBytes(): number {
    if (this.loadCostMs <= LOAD_SLOW_MS || this.loadedBytes <= 0) return ARCHIVE_TRIGGER_BYTES;
    const scaled = Math.floor(this.loadedBytes * 0.8);
    return scaled < ARCHIVE_MIN_TRIGGER_BYTES ? ARCHIVE_MIN_TRIGGER_BYTES : scaled;
  }

  /** 主存档里日桶的文本体积，只算真正写进 `days` 的字段。 */
  private daysBytes(): number {
    let total = 0;
    const keys = Array.from(this.days.keys());
    for (let i = 0; i < keys.length; i++) total += this.dayBytes(keys[i]);
    return total;
  }

  private dayBytes(key: string): number {
    const day = this.days.get(key);
    if (day == null) return 0;
    let total = 40 + key.length;
    const songKeys = Array.from(day.songs.keys());
    for (let i = 0; i < songKeys.length; i++) {
      const row = day.songs.get(songKeys[i])!;
      total += songKeys[i].length + 16 + row.song.name.length + row.song.singer.length + row.song.album.length + row.song.picUrl.length;
    }
    return total;
  }

  /** 备份里某一天的行（`[songKey, count, seconds, song]`）；没有这天返回空表。 */
  private archiveDay(archive: ListenDayArchive, key: string): Map<string, ListenDayRow> {
    const rows = new Map<string, ListenDayRow>();
    for (let i = 0; i < archive.d.length; i++) {
      const entry = archive.d[i] as (string | (string | number | Song)[]);
      if (typeof entry === "string") continue;
      const parts = entry as (string | number | Song)[];
      if (parts.length < 2) continue;
      if ((parts[0] as string) != key) continue;
      for (let j = 1; j < parts.length; j++) {
        const row = parts[j] as (string | number | Song)[];
        if (typeof row === "string" || typeof row === "number") continue;
        const cells = row as (string | number | Song)[];
        if (cells.length < 4) continue;
        const song = cells[3] as Song;
        if (song == null || song.id == null || song.id.length == 0) continue;
        rows.set(cells[0] as string, { count: positive(cells[1] as number), seconds: positive(cells[2] as number), song: copySong(song) } as ListenDayRow);
      }
    }
    return rows;
  }

  /** 写入/替换快照里的某一天，日期保持升序，方便以后按区间切年度数据。 */
  private archiveSetDay(archive: ListenDayArchive, key: string, rows: Map<string, ListenDayRow>): void {
    const entry: (string | number | Song)[] = [key];
    const songKeys = Array.from(rows.keys());
    for (let i = 0; i < songKeys.length; i++) {
      const row = rows.get(songKeys[i])!;
      entry.push([songKeys[i], row.count, row.seconds, row.song]);
    }
    let at = archive.d.length;
    for (let i = 0; i < archive.d.length; i++) {
      const item = archive.d[i] as (string | (string | number | Song)[]);
      if (typeof item === "string") continue;
      if ((item as (string | number | Song)[])[0] as string > key) { at = i; break; }
    }
    for (let i = 0; i < archive.d.length; i++) {
      const item = archive.d[i] as (string | (string | number | Song)[]);
      if (typeof item === "string") continue;
      if ((item as (string | number | Song)[])[0] as string == key) {
        archive.d.splice(i, 1, entry);
        return;
      }
    }
    if (at >= archive.d.length) archive.d.push(entry);
    else archive.d.splice(at, 0, entry);
  }

  /** 清空统计时新的天桶历史一并清掉，否则日榜会残留已删除的数据。 */
  private clearDays(): void {
    this.days.clear();
    // 按需读进来的备份天同样要丢：清空后用户再翻近 30 天不该看见旧数据。
    this.archiveCache.clear();
    this.archiveQueried.clear();
  }

  private snapshot(): string {
    // 先裁掉过期日桶再落盘：单次收听带来的增长只有几十字节，裁剪才让存档不会无限长。
    this.pruneDays();
    const obj = new UTSJSONObject();
    obj.set("version", 3);
    obj.set("trackingSince", this.trackingSince);
    // 日明细初始化标记：有它就说明「没有日期的那部分累计值」已经归到过某一天，
    // 下次读到存档不会再初始化一遍（否则每次启动都会把累计值当当天数据再加一次）。
    if (this.daysSeeded) obj.set("daysSeededAt", Date.now());
    obj.set("updatedAt", Date.now());
    obj.set("resetAt", this.resetAt);
    const rows: string[] = [];
    for (let i = 0; i < this.songs.length; i++) rows.push(JSON.stringify(this.songs[i]));
    obj.set("songs", rows);
    const dayLines: string[] = [];
    const dayKeys = Array.from(this.days.keys());
    for (let i = 0; i < dayKeys.length; i++) {
      const day = this.days.get(dayKeys[i])!;
      const songKeys = Array.from(day.songs.keys());
      for (let j = 0; j < songKeys.length; j++) {
        const row = day.songs.get(songKeys[j])!;
        const line = new UTSJSONObject();
        line.set("d", dayKeys[i]);
        line.set("c", row.count);
        line.set("s", row.seconds);
        line.set("g", row.song);
        dayLines.push(JSON.stringify(line));
      }
    }
    obj.set("days", dayLines);
    const avatars = new UTSJSONObject();
    const names = Array.from(this.artistPics.keys());
    for (let i = 0; i < names.length; i++) avatars.set(names[i], this.artistPics.get(names[i]) ?? "");
    obj.set("avatars", avatars);
    // 未获授权的增量也要跨重启保存，否则先听歌再授权会少记次数/时长。
    const pendingCounts = new UTSJSONObject();
    const pendingSeconds = new UTSJSONObject();
    const countKeys = Array.from(this.sessionCounts.keys());
    const secondKeys = Array.from(this.sessionSeconds.keys());
    for (let i = 0; i < countKeys.length; i++) pendingCounts.set(countKeys[i], this.sessionCounts.get(countKeys[i]) ?? 0);
    for (let i = 0; i < secondKeys.length; i++) pendingSeconds.set(secondKeys[i], this.sessionSeconds.get(secondKeys[i]) ?? 0);
    obj.set("pendingCounts", pendingCounts);
    obj.set("pendingSeconds", pendingSeconds);
    const pendingCompleted = new UTSJSONObject();
    const completedKeys = Array.from(this.sessionCompleted.keys());
    for (let i = 0; i < completedKeys.length; i++) pendingCompleted.set(completedKeys[i], this.sessionCompleted.get(completedKeys[i]) ?? 0);
    obj.set("pendingCompleted", pendingCompleted);
    return JSON.stringify(obj);
  }

  private mergePublic(saved: Snapshot): void {
    if (saved.updatedAt > this.resetAt) {
      for (let i = 0; i < saved.songs.length; i++) {
        const old = saved.songs[i];
        const key = keyOf(old.song);
        const row = this.row(old.song);
        const plays = this.sessionCounts.get(key) ?? 0;
        const seconds = this.sessionSeconds.get(key) ?? 0;
        row.effectiveCount = Math.max(old.effectiveCount, row.effectiveCount - plays) + plays;
        row.seconds = Math.max(old.seconds, row.seconds - seconds) + seconds;
        row.legacyCount = Math.max(old.legacyCount, row.legacyCount);
        row.count = row.effectiveCount + row.legacyCount;
        const completed = this.sessionCompleted.get(key) ?? 0;
        row.completed = Math.max(old.completed, row.completed - completed) + completed;
        if (old.lastPlayedAt > row.lastPlayedAt) row.song = old.song;
        row.lastPlayedAt = Math.max(old.lastPlayedAt, row.lastPlayedAt);
        if (old.firstPlayedAt > 0 && (row.firstPlayedAt == 0 || old.firstPlayedAt < row.firstPlayedAt)) row.firstPlayedAt = old.firstPlayedAt;
      }
      this.mergeDays(saved.days);
      // 任一来源打过标记就算初始化过了：否则回落到内存存档那条路径会再初始化一次。
      if (saved.daysSeeded) this.daysSeeded = true;
      if (saved.trackingSince > 0) this.trackingSince = Math.min(this.trackingSince, saved.trackingSince);
      const names = Array.from(saved.avatars.keys());
      for (let i = 0; i < names.length; i++) if (!this.artistPics.has(names[i])) this.artistPics.set(names[i], saved.avatars.get(names[i]) ?? "");
    }
  }

  private async restorePublicIfNeeded(): Promise<boolean> {
    if (this.publicLoaded || !canWriteListenStats()) return true;
    const savedRead = await readListenStatsFile();
    if (!savedRead.ok) return false;
    const saved = parseSnapshot(savedRead.text);
    if (saved != null) this.mergePublic(saved);
    this.publicLoaded = true;
    this.sessionCounts.clear();
    this.sessionSeconds.clear();
    this.sessionCompleted.clear();
    return true;
  }

  /** 暂停/退后台/退出以及报告页重新显示时调用；写入严格串行。 */
  async flush(): Promise<void> {
    await this.load();
    if (this.timer != null) { clearTimeout(this.timer!); this.timer = null; }
    this.dirty = true;
    if (this.saveTask != null) { await this.saveTask!; return; }
    this.saveTask = this.savePending();
    try { await this.saveTask!; } finally { this.saveTask = null; }
  }

  private async savePending(): Promise<void> {
    while (this.dirty) {
      await this.saveNow();
      // 写私有兜底也失败时保留脏标记，交给下一次事件重试，避免死循环。
      if (!this.publicSaved && this.dirty && this.timer == null) break;
    }
  }

  private async saveNow(): Promise<void> {
    this.saving = true;
    try {
      // 快照必须赶在 snapshot() 里的 pruneDays() 之前：那个裁剪会把已进备份的天从
      // 内存删掉，没进快照就删等于永久丢历史。所以这里先 await，不允许并行或延后。
      const archived = await this.archiveDays();
      if (archived) this.dirty = true;
      if (!await this.restorePublicIfNeeded()) {
        this.publicSaved = false;
        this.dirty = false;
        try { uni.setStorageSync(FALLBACK_KEY, this.snapshot()); } catch (_) { this.dirty = true; }
        return;
      }
      const text = this.snapshot();
      this.dirty = false;
      this.publicSaved = await writeListenStatsFile(text);
      if (this.publicSaved) {
        // 权限恢复并成功迁移后移除私有兜底。
        try { uni.removeStorageSync(FALLBACK_KEY); } catch (_) {}
      } else {
        try { uni.setStorageSync(FALLBACK_KEY, text); } catch (_) { this.dirty = true; }
      }
    } finally { this.saving = false; }
  }

  async clear(): Promise<void> {
    await this.load();
    this.generation++;
    this.resetAt = Date.now();
    this.trackingSince = this.resetAt;
    this.songs = [];
    this.clearDays();
    // 用户主动清空后统计已经归零，没有「没有日期的旧数据」再需要初始化了，
    // 保持标记为真，避免下次启动又把空的累计值当成当天数据补一遍。
    this.daysSeeded = true;
    this.artistPics.clear();
    this.sessionCounts.clear();
    this.sessionSeconds.clear();
    this.sessionCompleted.clear();
    this.avatarAttempts.clear();
    this.dirty = true;
    await this.flush();
  }

  async recordPlay(song: Song): Promise<void> {
    await this.recordProgress(song, 0, 1, 0, Date.now());
  }

  /** 只清听歌统计本身（首页/统计页的数据源），不动收藏与歌单。
   *
   * 播放历史（`player.history`）由**调用方**一并清，不要在这里 import player：
   * `stores/player.ts` 反过来依赖本 store，在这里反向依赖会绕成循环 import。
   * 「清除听歌统计」的口径见 `pages/cache/index.uvue` 的 `stats` 分支。
   */
  async clearOnly(): Promise<void> {
    await this.clear();
  }

  async addSeconds(song: Song, seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 15) return;
    await this.recordProgress(song, seconds, 0, 0, Date.now());
  }

  /** 会话发出的增量：计时、达标与完播一次更新，授权合并时各字段均有独立增量。 */
  async recordProgress(song: Song, seconds: number, plays: number, completed: number, at: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(at) || at <= 0) return;
    const generation = this.generation;
    await this.load();
    if (generation != this.generation) return;
    const row = this.row(song);
    row.song = copySong(song);
    row.seconds += seconds;
    row.count += plays == 1 ? 1 : 0;
    row.effectiveCount += plays == 1 ? 1 : 0;
    row.completed += completed == 1 ? 1 : 0;
    if (row.firstPlayedAt == 0) row.firstPlayedAt = at;
    row.lastPlayedAt = Math.max(row.lastPlayedAt, at);
    // 同一个记账入口顺便落到当天桶：日榜 / 周榜不必再走一套计时，也不会和总榜对不上。
    this.addToday(song, seconds, plays == 1 ? 1 : 0, at);
    const key = keyOf(song);
    if (!this.publicLoaded) {
      this.sessionCounts.set(key, (this.sessionCounts.get(key) ?? 0) + (plays == 1 ? 1 : 0));
      this.sessionSeconds.set(key, (this.sessionSeconds.get(key) ?? 0) + seconds);
      this.sessionCompleted.set(key, (this.sessionCompleted.get(key) ?? 0) + (completed == 1 ? 1 : 0));
    }
    this.scheduleSave();
    if (plays == 1) this.ensureArtistPic(song);
  }

}

const stats = reactive(new ListenStatsStore()) as ListenStatsStore;
export function useListenStatsStore(): ListenStatsStore { return stats; }
