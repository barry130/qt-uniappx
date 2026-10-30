/**
 * 播放器持久化编解码器（从 stores/player.ts 拆出）。
 *
 * Song / Playlist 与本地存储 JSON 文本之间的互转。格式是**落盘契约**：
 * 已有用户设备上存着按当前字段序列化的文本，这里做兼容读取（旧字段缺失回
 * undefined、脏数据回 null），任何字段增减都要保持「旧文本仍可解析」。
 *
 * 注意 stores/downloads.ts 里另有一份 songToJson（下载任务落盘用，字段口径
 * 不同：不含 pids/likeSeq），不要为了「去重」把它合并过来——两份的稳定性
 * 约束不同。
 */
import { parseJsonToUtso } from "@/services/http";
import type { Song, Playlist } from "@/types/music";

export function songToJson(song: Song): string {
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

export function songFromJson(text: string): Song | null {
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
    // 静默：脏文本按「无此条」处理，调用方对 null 已有兜底（跳过该条继续恢复其余）
    return null;
  }
}

export function playlistToJson(playlist: Playlist): string {
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

export function playlistFromJson(text: string): Playlist | null {
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
    // 静默：脏文本按「无此条」处理，调用方对 null 已有兜底（跳过该条继续恢复其余）
    return null;
  }
}
