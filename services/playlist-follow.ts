import { getSessionEpoch, getUserId } from "@/services/auth";
import { registerCollectionRecovery } from "@/services/collection-transaction";
import { musicApi } from "@/services/music-api";
import { usePlayerStore } from "@/stores/player";
import { songToJson, songFromJson } from "@/stores/persist-codec";
import { parseJsonToUtso } from "@/services/http";
import type { Song, Playlist } from "@/types/music";
import { assertSourceEnabled, assertSourcePolicyCurrent, sourceEnabled, sourcePolicyRevision } from "@/services/source-policy";

export type PlaylistFollow = {
  id: string; pid: string; source: string; sourceId: string; enabled: boolean;
  baseline: string[] | null; suppressed: string[]; protectedKeys: string[];
  checkedAt: number; error: string; revision: number;
};
export type FollowPreview = {
  record: PlaylistFollow; added: Song[]; removed: Song[]; localKeys: string[];
  next: PlaylistFollow; owner: string; epoch: number; expectedJson: string; policyRevision: number;
};
export const PLAYLIST_FOLLOW_CHANGED = "qt-playlist-follow-changed";
function keyOf(song: Song): string { return JSON.stringify([song.platform, song.id]); }
function uniqueSongs(songs: Song[]): Song[] {
  const keys: string[] = [];
  return songs.filter((song: Song): boolean => { const key = keyOf(song); if (keys.indexOf(key) >= 0) return false; keys.push(key); return true; });
}
function storageKey(): string { return "qt-playlist-follow-v1:" + (getUserId().length > 0 ? getUserId() : "guest"); }
function journalKey(): string { return storageKey() + ":journal"; }
function rawRecords(): string { return (uni.getStorageSync(storageKey()) as string) || "[]"; }
function decode(raw: string): PlaylistFollow[] {
  const rows = JSON.parse<string[]>(raw);
  if (rows == null) throw new Error("歌单跟随记录无法读取");
  const out: PlaylistFollow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = parseJsonToUtso(rows[i]);
    const id = row.getString("id") ?? "";
    const pid = row.getString("pid") ?? "";
    const source = row.getString("source") ?? "";
    const sourceId = row.getString("sourceId") ?? "";
    if (id.length == 0 || pid.length == 0 || source.length == 0 || sourceId.length == 0) throw new Error("跟随记录不完整");
    out.push({ id, pid, source, sourceId, enabled: row.getBoolean("enabled") == true,
      baseline: row.get("baseline") as string[] | null,
      suppressed: (row.get("suppressed") as string[] | null) ?? [],
      protectedKeys: (row.get("protectedKeys") as string[] | null) ?? [],
      checkedAt: row.getNumber("checkedAt") ?? 0, error: row.getString("error") ?? "",
      revision: row.getNumber("revision") ?? 0 });
  }
  return out;
}
function encode(records: PlaylistFollow[]): string {
  const rows: string[] = [];
  for (let i = 0; i < records.length; i++) rows.push(JSON.stringify(records[i]));
  return JSON.stringify(rows);
}
function nextRecords(record: PlaylistFollow, raw: string): string {
  const rows = decode(raw).filter((r: PlaylistFollow): boolean => r.pid != record.pid);
  rows.push(record); return encode(rows);
}
export function playlistFollow(pid: string): PlaylistFollow | null {
  return decode(rawRecords()).find((row: PlaylistFollow): boolean => row.pid == pid) ?? null;
}
export function togglePlaylistFollow(pid: string): void {
  recoverPlaylistFollow();
  const raw = rawRecords(); const row = playlistFollow(pid);
  if (row == null) return;
  row.enabled = !row.enabled; row.revision++;
  uni.setStorageSync(storageKey(), nextRecords(row, raw));
  uni.$emit(PLAYLIST_FOLLOW_CHANGED);
}
function songsFromJournal(raw: string[]): Song[] {
  const songs: Song[] = [];
  for (let i = 0; i < raw.length; i++) {
    const song = songFromJson(raw[i]);
    if (song == null) throw new Error("跟随恢复记录中的歌曲无效");
    songs.push(song);
  }
  return songs;
}
/** Journal survives process death between membership, outbox and checkpoint storage writes. */
export function recoverPlaylistFollow(): void {
  const raw = (uni.getStorageSync(journalKey()) as string) || "";
  if (raw.length == 0) return;
  const row = parseJsonToUtso(raw);
  if (row.getString("owner") != getUserId()) throw new Error("跟随恢复记录账号不一致");
  const id = row.getString("id") ?? "";
  const player = usePlayerStore();
  const exists = player.localPlaylists.concat(player.savedPlaylists).some((p: Playlist): boolean => p.id == id && p.platform == "local");
  if (!exists) { uni.removeStorageSync(journalKey()); return; }
  const added = songsFromJournal((row.get("added") as string[] | null) ?? []);
  const removed = songsFromJournal((row.get("removed") as string[] | null) ?? []);
  player.applyFollowMembership(added, removed, id, getSessionEpoch());
  uni.setStorageSync(storageKey(), row.getString("nextJson") ?? "[]");
  uni.removeStorageSync(journalKey());
  uni.$emit(PLAYLIST_FOLLOW_CHANGED);
}
export function applyPlaylistFollow(preview: FollowPreview): void {
  recoverPlaylistFollow();
  assertSourcePolicyCurrent(preview.policyRevision);
  assertSourceEnabled(preview.record.source);
  if (preview.epoch != getSessionEpoch() || preview.owner != getUserId()) throw new Error("账号已变化，请重新检查");
  if (rawRecords() != preview.expectedJson) throw new Error("跟随设置已变化，请重新检查");
  const local = usePlayerStore().songsOfPid(preview.record.pid).map((s: Song): string => keyOf(s));
  if (JSON.stringify(local) != JSON.stringify(preview.localKeys)) throw new Error("歌曲已变化，请重新检查差异");
  const row = new UTSJSONObject();
  row.set("owner", preview.owner); row.set("id", preview.record.id);
  row.set("added", preview.added.map((s: Song): string => songToJson(s)));
  row.set("removed", preview.removed.map((s: Song): string => songToJson(s)));
  row.set("nextJson", nextRecords(preview.next, preview.expectedJson));
  uni.setStorageSync(journalKey(), JSON.stringify(row));
  recoverPlaylistFollow();
  usePlayerStore().flushPendingOps().catch(() => {});
}
export function importWithPlaylistFollow(local: Playlist, remote: Playlist, epoch: number): number {
  recoverPlaylistFollow();
  if (remote.complete != true) throw new Error("来源歌单不完整，暂不能开启跟随");
  const pid = local.pid ?? local.id;
  if (playlistFollow(pid) != null) throw new Error("目标歌单已经关联来源，请导入到另一歌单");
  const existing = usePlayerStore().songsOfPid(pid);
  const remoteSongs = uniqueSongs(remote.tracks ?? []);
  const keys = existing.map((s: Song): string => keyOf(s));
  const added = remoteSongs.filter((s: Song): boolean => keys.indexOf(keyOf(s)) < 0);
  const record: PlaylistFollow = { id: local.id, pid, source: remote.platform, sourceId: remote.id, enabled: true,
    baseline: remoteSongs.map((s: Song): string => keyOf(s)), suppressed: [], protectedKeys: keys,
    checkedAt: Date.now(), error: "", revision: Date.now() };
  applyPlaylistFollow({ record, added, removed: [], localKeys: keys, next: record, owner: getUserId(), epoch, expectedJson: rawRecords(), policyRevision: sourcePolicyRevision() });
  return added.length;
}
export async function previewPlaylistFollow(pid: string): Promise<FollowPreview> {
  recoverPlaylistFollow();
  const policyRevision = sourcePolicyRevision();
  const epoch = getSessionEpoch(); const owner = getUserId(); const expectedJson = rawRecords();
  const record = playlistFollow(pid);
  if (record == null) throw new Error("该歌单尚未关联来源");
  assertSourceEnabled(record.source);
  const remote = await musicApi.playlist(record.sourceId, record.source);
  assertSourcePolicyCurrent(policyRevision);
  if (epoch != getSessionEpoch()) throw new Error("账号已变化，请重新检查");
  if (remote.complete != true || remote.name.length == 0) throw new Error("来源未返回完整歌单，本次未修改，请更新数据包或稍后重试");
  const local = usePlayerStore().songsOfPid(pid);
  const localKeys = local.map((s: Song): string => keyOf(s));
  const remoteSongs = uniqueSongs(remote.tracks ?? []);
  const remoteKeys = remoteSongs.map((s: Song): string => keyOf(s));
  const old = record.baseline ?? remoteKeys;
  const suppressed = record.suppressed.slice();
  for (let i = 0; i < old.length; i++) if (localKeys.indexOf(old[i]) < 0 && suppressed.indexOf(old[i]) < 0) suppressed.push(old[i]);
  const nextSuppressed = suppressed.filter((key: string): boolean => localKeys.indexOf(key) < 0);
  const added = record.baseline == null ? [] : remoteSongs.filter((s: Song): boolean => old.indexOf(keyOf(s)) < 0 && localKeys.indexOf(keyOf(s)) < 0 && nextSuppressed.indexOf(keyOf(s)) < 0);
  const removed = record.baseline == null ? [] : local.filter((s: Song): boolean => old.indexOf(keyOf(s)) >= 0 && remoteKeys.indexOf(keyOf(s)) < 0 && record.protectedKeys.indexOf(keyOf(s)) < 0);
  const next: PlaylistFollow = { id: record.id, pid, source: record.source, sourceId: record.sourceId, enabled: record.enabled,
    baseline: remoteKeys, suppressed: nextSuppressed, protectedKeys: record.protectedKeys, checkedAt: Date.now(), error: "", revision: record.revision + 1 };
  return { record, added, removed, localKeys, next, owner, epoch, expectedJson, policyRevision };
}
let foreground = true;
registerCollectionRecovery(recoverPlaylistFollow);
let running = false;
export function playlistFollowForeground(value: boolean): void { foreground = value; }
export async function refreshDuePlaylistFollows(): Promise<void> {
  if (running || !foreground) return;
  running = true;
  try {
    recoverPlaylistFollow();
    const epoch = getSessionEpoch();
    const player = usePlayerStore();
    const local = player.localPlaylists.concat(player.savedPlaylists);
    const rows = decode(rawRecords()).filter((r: PlaylistFollow): boolean => r.enabled && sourceEnabled(r.source) && Date.now() - r.checkedAt >= 86400000 && local.some((p: Playlist): boolean => p.platform == "local" && p.id == r.id)).slice(0, 3);
    for (let i = 0; i < rows.length; i++) {
      if (!foreground || epoch != getSessionEpoch()) break;
      const row = rows[i];
      if (!sourceEnabled(row.source)) continue;
      const policyToken = sourcePolicyRevision();
      try {
        const preview = await previewPlaylistFollow(row.pid);
        if (foreground) applyPlaylistFollow(preview);
      } catch (e) {
        if (policyToken != sourcePolicyRevision() || !sourceEnabled(row.source)) continue;
        if (epoch != getSessionEpoch()) break;
        const current = playlistFollow(row.pid);
        if (current != null && current.revision == row.revision) {
          current.checkedAt = Date.now(); current.error = (e as Error).message;
          uni.setStorageSync(storageKey(), nextRecords(current, rawRecords()));
        }
      }
    }
  } finally { running = false; }
}
