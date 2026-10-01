/**
 * 收藏同步服务（LIKE_SYNC_DESIGN.md §5.1）
 *
 * 对接后端 astral-plugin-qt 的新收藏接口（/api/v1/app/user/like/**）：
 * - 收藏/取消收藏单曲、歌单：单条推送，替代旧的全量 uploadLikeList
 * - 增量拉取：since 游标，用于多端同步
 * - 全量分页拉取：首次登录 / 游标丢失时兜底
 *
 * 响应均为 QtRestResp{code,msg,data}，apiRequest 已解包 data。
 */
import { apiRequest } from "./http";
import type { Song, Playlist, LikeChange } from "@/types/music";

/**
 * pid 最大长度（后端约束 ≤64）
 */
const PID_MAX_LEN = 64;

/**
 * 单曲收藏/取消收藏（POST /app/user/like/song）
 *
 * pid 是可选字段：表示这次操作针对的是「这首歌在哪个歌单里的那一条记录」。
 * 一首歌可以同时属于多个歌单（每个歌单一条记录），所以：
 * - add 时带上目标歌单的 pid，落库/复活那一条
 * - remove 时也带 pid，后端按 (sid, pid) 定位，**只删这一条**，
 *   否则会把同一首歌在其他歌单里的记录一起删掉
 * pid 为空或超长时不上送，交给后端按无归属处理。
 */
export async function likeSong(
  song: Song,
  action: "add" | "remove",
  pid?: string
): Promise<number> {
  const data = new UTSJSONObject();
  data.set("action", action);
  data.set("sid", song.id);
  data.set("platform", song.platform);
  data.set("name", song.name);
  data.set("singer", song.singer);
  data.set("album", song.album);
  if (song.musicId != null && song.musicId.length > 0) {
    data.set("hash", song.musicId);
  }
  if (pid != null && pid.length > 0 && pid.length <= PID_MAX_LEN) {
    data.set("pid", pid);
  }
  // 封面地址仅 add 且非空时上送（remove 没有图片语义，空值不上送避免覆盖云端已有图）
  if (action == "add" && song.picUrl != null && song.picUrl.length > 0) {
    data.set("picUrl", song.picUrl);
  }
  const res = await apiRequest("app/user/like/song", data, "POST", true);
  return seqOf(res);
}

/** 歌单收藏/取消收藏（POST /app/user/like/playlist） */
export async function likePlaylist(
  playlist: Playlist,
  action: "add" | "remove"
): Promise<number> {
  const data = new UTSJSONObject();
  data.set("action", action);
  data.set("pid", playlist.pid != null && playlist.pid.length > 0 ? playlist.pid! : playlist.id);
  data.set("platform", playlist.platform);
  data.set("name", playlist.name);
  if (playlist.picUrl != null && playlist.picUrl.length > 0) {
    data.set("picUrl", playlist.picUrl);
  }
  const res = await apiRequest("app/user/like/playlist", data, "POST", true);
  return seqOf(res);
}

/**
 * 批量推送收藏操作（POST /app/user/like/batch）
 *
 * opsJson 是各操作请求体的 JSON 文本数组（字段与单条接口一致，另带 type 判别字段：
 * song|playlist），按数组原始顺序上送——后端按序执行，保证「歌单删除级联软删」
 * 先于其后的「歌曲收藏」这类先后语义。整批原子：成功返回整批占用的最大 seq
 * （本批是连续 seq 区段，客户端游标直接推进到该值是安全的），失败整批不落库，
 * 由调用方把整批退回队首保序重试（upsert 幂等，重放无害）。
 *
 * 入参收 JSON 文本而不是 UTSJSONObject：bytecode 运行时里 UTSJSONObject 是原生
 * 注册实例（每次 .set 都跨桥），一次导入几百首时整批构造实例曾触发原生侧注册
 * 丢失（「UTS instance is not registered」）。这里整批拼成一段 JSON 文本一次
 * parse，跨桥的只有一个普通 JS 对象。
 */
export async function likeBatch(opsJson: string[]): Promise<number> {
  const data = JSON.parse('{"ops":[' + opsJson.join(",") + ']}') as UTSJSONObject;
  const res = await apiRequest("app/user/like/batch", data, "POST", true);
  return seqOf(res);
}

/** 增量拉取（GET /app/user/like/changes?since=），返回变更与新的游标 */
export async function fetchChanges(
  since: number
): Promise<{ changes: LikeChange[]; maxSeq: number } | null> {
  const data = new UTSJSONObject();
  data.set("since", since);
  const res = await apiRequest("app/user/like/changes", data, "GET", true);
  if (res == null) return null;
  const changesRaw = res.get("changes") as UTSJSONObject[] | null;
  const changes: LikeChange[] = [];
  if (changesRaw != null) {
    for (let i = 0; i < changesRaw.length; i++) {
      const change = parseChange(changesRaw[i] as UTSJSONObject);
      if (change != null) changes.push(change);
    }
  }
  const maxSeq = numOf(res.get("maxSeq"));
  return { changes, maxSeq };
}

/**
 * 全量分页拉取（GET /app/user/like/list?page=&size=）。
 * 返回 null 表示已无更多页（当前页歌曲与歌单都为空时视为结束）。
 */
export async function fetchAllLikes(
  page: number,
  size: number
): Promise<{ songs: Song[]; playlists: Playlist[]; maxSeq: number } | null> {
  const data = new UTSJSONObject();
  data.set("page", page);
  data.set("size", size);
  const res = await apiRequest("app/user/like/list", data, "GET", true);
  if (res == null) return null;
  const songsRaw = res.get("songs") as UTSJSONObject[] | null;
  const playlistsRaw = res.get("playlists") as UTSJSONObject[] | null;
  const songs: Song[] = [];
  if (songsRaw != null) {
    for (let i = 0; i < songsRaw.length; i++) {
      const song = parseServerSong(songsRaw[i] as UTSJSONObject);
      if (song != null) songs.push(song);
    }
  }
  const playlists: Playlist[] = [];
  if (playlistsRaw != null) {
    for (let i = 0; i < playlistsRaw.length; i++) {
      const pl = parseServerPlaylist(playlistsRaw[i] as UTSJSONObject);
      if (pl != null) playlists.push(pl);
    }
  }
  const maxSeq = numOf(res.get("maxSeq"));
  return { songs, playlists, maxSeq };
}

// ==================== 内部解析 ====================

function seqOf(res: UTSJSONObject): number {
  const seq = res.get("seq");
  return numOf(seq);
}

function numOf(value: any): number {
  if (value == null) return 0;
  const n = parseFloat(value.toString());
  return n != null && !isNaN(n) ? n : 0;
}

function strOrEmpty(value: any): string {
  if (value == null) return "";
  if (value instanceof String) return value as string;
  return value.toString();
}

/** 解析单条变更（QtLikeChangeVo） */
function parseChange(item: UTSJSONObject): LikeChange | null {
  const typeRaw = strOrEmpty(item.get("type"));
  if (typeRaw != "song" && typeRaw != "playlist") return null;
  const type = typeRaw as "song" | "playlist";
  // 优先用 id 字段（后端已把 sid/pid 归一到 id），缺失时回退 sid/pid
  let id = strOrEmpty(item.get("id"));
  if (id.length == 0) {
    id = type == "song" ? strOrEmpty(item.get("sid")) : strOrEmpty(item.get("pid"));
  }
  if (id.length == 0) return null;
  const deletedRaw = item.get("deleted");

  // 歌单的全局唯一键是 pid：优先取 pid，缺失时回退 id。
  // 不能只信 id —— 后端有的接口把自增主键也放在 id 里，那样拿到的就不是 pid，
  // 会导致歌单同步回来后无法用它去匹配收藏歌曲。
  let pid = strOrEmpty(item.get("pid"));
  if (pid.length == 0) pid = id;
  const change: LikeChange = {
    type,
    id,
    pid,
    platform: strOrEmpty(item.get("platform")),
    name: strOrEmpty(item.get("name")),
    singer: strOrEmpty(item.get("singer")),
    album: strOrEmpty(item.get("album")),
    hash: strOrEmpty(item.get("hash")),
    picUrl: strOrEmpty(item.get("picUrl")),
    deleted: deletedRaw == true,
    updatedSeq: numOf(item.get("updatedSeq")),
  };
  return change;
}

/** 解析服务器歌曲（QtLikeSong 实体：sid/name/singer/album/hash/platform/updatedSeq） */
function parseServerSong(item: UTSJSONObject): Song | null {
  const id = strOrEmpty(item.get("sid"));
  if (id.length == 0) return null;
  const hash = strOrEmpty(item.get("hash"));
  const song: Song = {
    id,
    name: strOrEmpty(item.get("name")),
    singer: strOrEmpty(item.get("singer")),
    album: strOrEmpty(item.get("album")),
    picUrl: strOrEmpty(item.get("picUrl")),
    platform: strOrEmpty(item.get("platform")),
  };
  if (hash.length > 0 && hash.toLowerCase() != "nohash") song.musicId = hash;
  const seq = numOf(item.get("updatedSeq"));
  if (seq > 0) song.likeSeq = seq;
  // /like/list 的 songs[] 里 pid 由实体序列化直接返回（可空）。
  // 一首歌属于多个歌单时服务器会返回多条（同 sid、不同 pid），
  // 这里先原样带上单个 pid，由上层合并进该歌曲的 pids 列表。
  const songPid = strOrEmpty(item.get("pid"));
  if (songPid.length > 0) song.pids = [songPid];
  return song;
}

/** 解析服务器歌单（QtLikePlaylist 实体：pid/name/picUrl/platform/updatedSeq） */
function parseServerPlaylist(item: UTSJSONObject): Playlist | null {
  // 歌单实体的主键就是 pid：优先取 pid，有些接口可能只回了 id，两者都兜一下
  let id = strOrEmpty(item.get("pid"));
  if (id.length == 0) id = strOrEmpty(item.get("id"));
  if (id.length == 0) return null;
  const playlist: Playlist = {
    id,
    name: strOrEmpty(item.get("name")),
    picUrl: strOrEmpty(item.get("picUrl")),
    playCount: "",
    platform: strOrEmpty(item.get("platform")),
    description: null,
    // 歌单实体的主键就是 pid，这里回填一份便于上层直接用它做归属匹配
    pid: id,
  };
  const seq = numOf(item.get("updatedSeq"));
  if (seq > 0) playlist.likeSeq = seq;
  return playlist;
}
