/**
 * 消息中心本地已读缓存（既定决策 D6）
 * 后端不存已读状态（qt_app_notice_read 停用），由前端 storage 控制已读；
 * 缓存被清 → 全部视为未读；支持一键已读；上限滚动保留最近 1000 条。
 */
import type { Notice } from "@/types/notice";

const KEY = "qt-notice-read-ids";
/** 已读集合滚动上限 */
const MAX_KEEP = 1000;

/** 内存缓存（避免每次渲染都读 storage） */
let cache: number[] | null = null;

function load(): number[] {
  if (cache != null) return cache;
  try {
    const raw = uni.getStorageSync(KEY) as string;
    if (raw != null && raw.length > 0) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const ids: number[] = [];
        for (let i = 0; i < parsed.length; i++) {
          const n = parseFloat(parsed[i] as string);
          if (!isNaN(n) && n > 0) ids.push(Math.trunc(n));
        }
        cache = ids;
        return cache;
      }
    }
  } catch (_) {
    // 数据损坏时按空处理
  }
  cache = [];
  return cache;
}

function persist(): void {
  try {
    uni.setStorageSync(KEY, JSON.stringify(load()));
  } catch (_) {}
}

/** 读取全部已读通知 ID */
export function getReadIds(): Set<number> {
  return new Set(load());
}

/** 标记单条已读（加入并持久化，超上限时淘汰最旧） */
export function markRead(id: number): void {
  if (id <= 0) return;
  const ids = load();
  if (ids.indexOf(id) >= 0) return;
  ids.push(id);
  if (ids.length > MAX_KEEP) {
    // 滚动保留最近 MAX_KEEP 条
    ids.splice(0, ids.length - MAX_KEEP);
  }
  persist();
}

/** 一键已读：批量标记并持久化 */
export function markAllRead(ids: number[]): void {
  const target = load();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id > 0 && target.indexOf(id) < 0) target.push(id);
  }
  if (target.length > MAX_KEEP) {
    target.splice(0, target.length - MAX_KEEP);
  }
  persist();
}

/** 是否已读（缓存被清 → 天然全部未读） */
export function isRead(n: Notice): boolean {
  return load().indexOf(n.id) >= 0;
}

/** 未读数：候选总数（后端） − 已读数（本地，仅统计仍在候选里的） */
export function unreadCountOf(notices: Notice[]): number {
  const read = load();
  let unread = 0;
  for (let i = 0; i < notices.length; i++) {
    if (read.indexOf(notices[i].id) < 0) unread++;
  }
  return unread;
}
