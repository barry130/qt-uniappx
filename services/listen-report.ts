import type { Song } from "@/types/music";
import type { ListenDay, ListenSong } from "@/stores/listen-stats";

export type ReportEntry = {
  id: string; name: string; subtitle: string; platform: string;
  count: number; seconds: number; tracks: number; song: Song | null;
};

export function reportSongKey(song: Song): string { return song.platform + ":" + song.id; }

/** 与首页 Top 5 一致：歌手按存档 singer 原值归并，音源按 platform 归并。 */
export function reportEntries(records: ListenSong[], kind: string, order: string): ReportEntry[] {
  const groups = new Map<string, ReportEntry>();
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.count <= 0 && row.seconds <= 0) continue;
    const song = row.song;
    const id = kind == "artists" ? song.singer : kind == "sources" ? song.platform : reportSongKey(song);
    if (id.length == 0) continue;
    let entry = groups.get(id);
    if (entry == null) {
      entry = { id, name: kind == "songs" ? song.name : id,
        subtitle: kind == "songs" ? song.singer : "", platform: song.platform,
        count: 0, seconds: 0, tracks: 0, song: kind == "songs" ? song : null };
      groups.set(id, entry);
    }
    entry.count += row.count;
    entry.seconds += row.seconds;
    entry.tracks++;
  }
  const rows = Array.from(groups.values());
  rows.sort((a, b) => {
    const difference = order == "seconds" ? b.seconds - a.seconds : b.count - a.count;
    if (difference != 0) return difference;
    const secondary = order == "seconds" ? b.count - a.count : b.seconds - a.seconds;
    return secondary != 0 ? secondary : a.id.localeCompare(b.id);
  });
  return rows;
}

export function reportTracks(records: ListenSong[], kind: string, target: string): ListenSong[] {
  return records.filter((row) => kind == "artists" ? row.song.singer == target :
    kind == "sources" ? row.song.platform == target : reportSongKey(row.song) == target);
}

export function reportDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value >= 3600) return Math.floor(value / 3600) + "小时" + Math.floor(value % 3600 / 60) + "分";
  if (value >= 60) return Math.floor(value / 60) + "分" + value % 60 + "秒";
  return value + "秒";
}

export function reportSourceIcon(id: string): string {
  return ["wyy", "qq", "kw", "kg", "bili"].indexOf(id) >= 0 ? "/static/source/" + id + ".png" : "";
}

/**
 * 把若干天的桶按 kind 归并成一张榜，口径与 `reportEntries` 完全一致
 * （歌手按 singer 原值、音源按 platform、歌曲按 platform:id），
 * 这样日榜里的歌手名和总榜 Top 歌手点进去看到的是同一批歌。
 */
export function reportDayEntries(days: Map<string, ListenDay>, keys: string[], kind: string): ReportEntry[] {
  const records: ListenSong[] = [];
  for (let i = 0; i < keys.length; i++) {
    const day = days.get(keys[i]);
    if (day == null) continue;
    const songKeys = Array.from(day.songs.keys());
    for (let j = 0; j < songKeys.length; j++) {
      const row = day.songs.get(songKeys[j]);
      if (row == null) continue;
      records.push({ song: row.song, count: row.count, effectiveCount: row.count, seconds: row.seconds,
        legacyCount: 0, completed: 0, firstPlayedAt: 0, lastPlayedAt: 0 } as ListenSong);
    }
  }
  return reportEntries(records, kind, "count");
}
