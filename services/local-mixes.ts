import type { ListenSong } from "@/stores/listen-stats";
import type { Song } from "@/types/music";

export type LocalMixKey = "recent" | "most_played" | "favorite_picks" | "late_night" | "nostalgic";

export type LocalMix = {
  key: LocalMixKey;
  title: string;
  subtitle: string;
  coverUrls: string[];
  songs: Song[];
};

const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const NOSTALGIC_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SONGS = 5;
const MAX_SONGS = 20;

function songKey(song: Song): string {
  return song.platform + ":" + song.id;
}

function plays(row: ListenSong): number {
  // count already includes legacyCount + effectiveCount in the v2 stats contract.
  return Number.isFinite(row.count) ? Math.floor(Math.max(0, row.count)) : 0;
}

function hasDate(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function recentFirst(a: ListenSong, b: ListenSong): number {
  return b.lastPlayedAt - a.lastPlayedAt;
}

function byPlaysThenRecent(a: ListenSong, b: ListenSong): number {
  const diff = plays(b) - plays(a);
  return diff !== 0 ? diff : recentFirst(a, b);
}

function takeSongs(rows: ListenSong[]): Song[] {
  const out: Song[] = [];
  for (let i = 0; i < Math.min(MAX_SONGS, rows.length); i++) out.push(rows[i].song);
  return out;
}

function finish(key: LocalMixKey, title: string, subtitle: string, rows: ListenSong[]): LocalMix | null {
  if (rows.length < MIN_SONGS) return null;
  const songs = takeSongs(rows);
  const coverUrls: string[] = [];
  // 卡面是 2×2 的四格拼贴，收满 4 张才够铺；不足时组件按缺省图标补位。
  for (let i = 0; i < songs.length && coverUrls.length < 4; i++) {
    if (songs[i].picUrl.length > 0) coverUrls.push(songs[i].picUrl);
  }
  return { key, title, subtitle, coverUrls, songs };
}

function validFavoriteKeys(likedSongs: Song[], validLikedPids: string[]): Set<string> {
  const valid = new Set<string>(validLikedPids);
  const keys = new Set<string>();
  for (let i = 0; i < likedSongs.length; i++) {
    const song = likedSongs[i];
    if (song.pids == null || song.pids.length === 0) continue;
    let actual = false;
    for (let j = 0; j < song.pids.length; j++) {
      if (valid.has(song.pids[j])) {
        actual = true;
        break;
      }
    }
    if (actual) keys.add(songKey(song));
  }
  return keys;
}

/**
 * Build the fixed-order, local-only recommendation mixes.
 * `validLikedPids` must come from currently existing local playlists so stale
 * likedSongs rows cannot make a removed favorite appear again.
 */
export function buildLocalMixes(
  stats: ListenSong[],
  likedSongs: Song[],
  validLikedPids: string[],
  now: number = Date.now(),
): LocalMix[] {
  const rows: ListenSong[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stats.length; i++) {
    const row = stats[i];
    if (row == null) continue;
    const key = songKey(row.song);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  const datedRows = rows.filter((row) => hasDate(row.lastPlayedAt));
  const mixes: LocalMix[] = [];
  const recent = datedRows.filter((row) => row.lastPlayedAt > now - RECENT_MS && row.lastPlayedAt <= now).sort(recentFirst);
  const recentMix = finish("recent", "最近在听", "近 14 天听过 " + recent.length + " 首", recent);
  if (recentMix != null) mixes.push(recentMix);

  const most = rows.filter((row) => plays(row) >= 2).sort(byPlaysThenRecent);
  const mostTop = most.slice(0, MAX_SONGS);
  let totalPlays = 0;
  for (let i = 0; i < mostTop.length; i++) totalPlays += plays(mostTop[i]);
  const mostMix = finish("most_played", "循环最多的歌", "这 " + mostTop.length + " 首歌一共听了 " + totalPlays + " 次", mostTop);
  if (mostMix != null) mixes.push(mostMix);

  const favoriteKeys = validFavoriteKeys(likedSongs, validLikedPids);
  const favorites = rows.filter((row) => favoriteKeys.has(songKey(row.song))).sort(byPlaysThenRecent);
  const favoriteTop = favorites.slice(0, MAX_SONGS);
  const favoriteMix = finish("favorite_picks", "收藏里的常客", "收藏里循环最多的 " + favoriteTop.length + " 首", favoriteTop);
  if (favoriteMix != null) mixes.push(favoriteMix);

  const late = datedRows.filter((row) => {
    const hour = new Date(row.lastPlayedAt).getHours();
    return hour >= 22 || hour < 6;
  }).sort(recentFirst);
  const lateMix = finish("late_night", "深夜歌单", "22:00–次日 06:00 听过 " + late.length + " 首", late);
  if (lateMix != null) mixes.push(lateMix);

  const cutoff = now - NOSTALGIC_MS;
  const nostalgic = datedRows.filter((row) => plays(row) >= 3 && row.lastPlayedAt <= cutoff).sort((a, b) => a.lastPlayedAt - b.lastPlayedAt);
  const nostalgicMix = finish("nostalgic", "久未重温", "有 " + nostalgic.length + " 首歌超过 30 天没听了", nostalgic);
  if (nostalgicMix != null) mixes.push(nostalgicMix);

  return mixes;
}

/** 「为你整理」整区出场所需的最小合辑数。 */
export const MIN_SHOWN_LOCAL_MIXES = 2;

/**
 * 「为你整理」的出场条件：统计已就绪，且凑够了 MIN_SHOWN_LOCAL_MIXES 类。
 *
 * 这里刻意不按「五类全齐」判定。五类各有各的门槛（新用户还没在深夜听过歌、
 * 旧歌没攒够 30 天、收藏还没归进现存歌单……），硬凑五类会让这一区长期消失，
 * 攒了半年的记录也换不来一张卡片；反过来只出一类又像数据坏了。所以取折中：
 * 凑够两类就展示，凑不满就整区不渲染，不摆半成品区域。
 */
export function shouldShowLocalMixes(ready: boolean, mixes: LocalMix[]): boolean {
  return ready && mixes.length >= MIN_SHOWN_LOCAL_MIXES;
}
