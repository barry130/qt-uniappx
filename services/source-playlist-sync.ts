/**
 * 账号歌单同步（v18）：把登录账户在平台侧的歌单清单拉下来，
 * 与本地「我的歌单」对账——勾选 = 收藏到本地，取消勾选 = 从本地移除。
 *
 * 语义与 PC 版 lib/source-playlist-sync.ts 一致：
 * - 只动**本地收藏关系**，不碰平台侧（不像平台发起收藏/取消收藏）；
 * - 平台侧清单是全量的，本地「我的歌单」里它没有的条目 = 待收藏，
 *   本地有而用户取消勾选的 = 待移除；
 * - collect / uncollect 逐个顺序执行，单个失败只计数不中断（部分成功是
 *   正常结果，UI 汇总展示）。
 *
 * UTS 侧差异：PC 用 AccountSyncNeedsMetaLoginError 异常分流「已登录但
 * 数据面开关关着」，这里拍平成 needMetaLogin 布尔（UTS 自定义 Error
 * 子类跨端不可靠）；autoSync 对所有失败统一静默返回空清单（PC 区分
 * NeedsMetaLogin 静默 / 其余上抛由页面 console.warn，移动端调用方在
 * 登录成功的 toast 流里，任何打扰都不合适——净效果等价）。
 */
import { usePlayerStore } from "@/stores/player";
import type { Playlist } from "@/types/music";
import {
  accountPlaylists,
  readSourceAuthEntries,
  readSourceAuthTogglesFor,
  type SourceAccountPlaylist,
} from "./source-auth";

/** 平台侧一行：歌单本体 + 本地「我的歌单」里是否已收藏（同平台同键） */
export type AccountSyncRow = {
  playlist: SourceAccountPlaylist;
  favorited: boolean;
};

/**
 * 预览结果（拍平形状，不用判别联合）：ok=false 时 message 为用户文案；
 * needMetaLogin=true = 该源已登录但「数据请求使用登录态」关着——
 * 包侧只会回「未登录」，先给可一键开启重试的提示而不是报错。
 */
export type AccountSyncPreview = {
  ok: boolean;
  needMetaLogin: boolean;
  message: string;
  /** 平台侧全量清单逐条标记本地收藏态 */
  rows: AccountSyncRow[];
  /** 平台侧有、本地还没收藏的（登录后自动提示用） */
  missing: SourceAccountPlaylist[];
  total: number;
};

/** 收藏 / 取消收藏的执行计数（部分成功是正常结果） */
export type AccountSyncApplyResult = {
  changed: number;
  skipped: number;
  failed: number;
};

/** 本地「我的歌单」里该平台是否已收藏此键（在线歌单 id 即平台歌单号；pid 兜底，
 *  like-sync pullChanges 合并同样按 id 或 pid 双键查——同款口径） */
function isFavoritedHere(saved: Playlist[], source: string, key: string): boolean {
  for (let i = 0; i < saved.length; i++) {
    const pl = saved[i];
    if (pl == null) continue;
    if (pl.platform != source) continue;
    if (pl.id == key) return true;
    if (pl.pid != null && pl.pid == key) return true;
  }
  return false;
}

/** 找本地已收藏的原条目（取消收藏要把它本体交给 toggleSavePlaylist） */
function findSavedEntry(saved: Playlist[], source: string, key: string): Playlist | null {
  for (let i = 0; i < saved.length; i++) {
    const pl = saved[i];
    if (pl == null) continue;
    if (pl.platform != source) continue;
    if (pl.id == key) return pl;
    if (pl.pid != null && pl.pid == key) return pl;
  }
  return null;
}

/**
 * 预览：平台侧全量歌单 vs 本地收藏态。门控先行——已登录但数据面开关
 * 关着时包侧只会回「未登录」，换成 needMetaLogin 让 UI 一键开启重试。
 */
export async function accountSyncPreview(source: string): Promise<AccountSyncPreview> {
  const entries = readSourceAuthEntries();
  let hasAccount = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].source == source) {
      hasAccount = true;
      break;
    }
  }
  if (hasAccount && !readSourceAuthTogglesFor(source).useMeta) {
    return {
      ok: false,
      needMetaLogin: true,
      message: "该账户已登录，但「数据请求使用登录态」未开启——读取平台侧歌单需要它把凭据交给数据请求",
      rows: [],
      missing: [],
      total: 0,
    };
  }
  try {
    const remote = await accountPlaylists(source);
    const saved = usePlayerStore().savedPlaylists;
    const rows: AccountSyncRow[] = [];
    const missing: SourceAccountPlaylist[] = [];
    for (let i = 0; i < remote.length; i++) {
      const favorited = isFavoritedHere(saved, source, remote[i].id);
      rows.push({ playlist: remote[i], favorited: favorited });
      if (!favorited) missing.push(remote[i]);
    }
    return { ok: true, needMetaLogin: false, message: "", rows: rows, missing: missing, total: remote.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, needMetaLogin: false, message: message, rows: [], missing: [], total: 0 };
  }
}

/**
 * 把勾选的平台侧歌单逐个收藏进本地「我的歌单」。已在的跳过（幂等），
 * 单个失败只计数不中断。收藏走 player.toggleSavePlaylist（插入头部 +
 * playlistsDirty + persist + like-sync 队列，与歌单详情页同一条链路）。
 */
export async function collectAccountPlaylists(
  source: string,
  picks: SourceAccountPlaylist[],
): Promise<AccountSyncApplyResult> {
  const player = usePlayerStore();
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    try {
      if (isFavoritedHere(player.savedPlaylists, source, pick.id)) {
        skipped += 1;
        continue;
      }
      const meta: Playlist = {
        id: pick.id,
        name: pick.name,
        picUrl: pick.picUrl,
        playCount: pick.trackCount >= 0 ? String(pick.trackCount) : "",
        platform: source,
        description: null,
      };
      player.toggleSavePlaylist(meta);
      changed += 1;
    } catch (e) {
      failed += 1;
    }
  }
  return { changed: changed, skipped: skipped, failed: failed };
}

/**
 * 把取消勾选的从本地「我的歌单」移除。本地已找不到的按跳过计（幂等），
 * 单个失败只计数不中断。
 */
export async function uncollectAccountPlaylists(
  source: string,
  picks: SourceAccountPlaylist[],
): Promise<AccountSyncApplyResult> {
  const player = usePlayerStore();
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    try {
      const entry = findSavedEntry(player.savedPlaylists, source, pick.id);
      if (entry == null) {
        skipped += 1;
        continue;
      }
      player.toggleSavePlaylist(entry);
      changed += 1;
    } catch (e) {
      failed += 1;
    }
  }
  return { changed: changed, skipped: skipped, failed: failed };
}

/**
 * 登录成功后的自动同步决策：平台侧有、本地还没收藏的清单。
 * 任何失败（数据面开关关 / 包旧 / 网络）一律静默返回空——自动同步只是
 * 登录成功的附带动作，不干扰登录反馈；用户可随时从账号行手动打开。
 */
export async function autoSyncMissingAfterLogin(source: string): Promise<SourceAccountPlaylist[]> {
  try {
    const preview = await accountSyncPreview(source);
    if (!preview.ok) return [];
    return preview.missing;
  } catch (e) {
    return [];
  }
}
