import { reactive } from "vue";
import type { Notice, NoticeDispatch } from "@/types/notice";
import {
  dispatchNotices,
  fetchActiveNotices,
  fetchMessageCenter,
  fetchUnreadCount,
  isNoticeEffective,
  isNoticeVersionMatch,
  isNoticeVisibleForUser,
  isFirstLogin,
  markFirstLoginShown,
  sortNotices,
  stripHtml,
} from "@/services/notice";
import { unreadCountOf } from "@/services/notice-read";
import { isLoggedIn } from "@/services/auth";

/** 开屏“今日不显示”存储 key */
function SplashHideKey(id: number): string {
  return "qt-notice-splash-hidden-" + id;
}

/**
 * 开屏公告去重键：先转纯文本（去 HTML 标签、反转义实体），再去掉全部空白字符。
 * 只比原文不够——后端富文本里 <p> 换行、缩进、&nbsp; 之类的差异会让「看起来
 * 一模一样」的两条公告绕过精确比较：点「我知道了」后弹出的下一条内容相同，
 * 用户会以为「点了没反应」。
 */
function splashDedupeKey(n: Notice): string {
  const text = stripHtml(n.title ?? "") + "\n" + stripHtml(n.content ?? "");
  return text.replace(/\s+/g, "");
}

/** 当天日期字符串 YYYY-M-D（跨天即自动恢复） */
function todayStr(): string {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

/** 通知状态管理：拉取生效通知、按展示位分发、跟踪未读数、管理全局浮层 */
class NoticeStore {
  /** 当前生效的全部通知（已过滤版本/时效/人群） */
  notices: Notice[] = [];
  /** 按展示位分发的通知 */
  dispatch: NoticeDispatch = {
    splash: [],
    noticeBar: [],
    messageCenter: [],
  };
  /** 消息中心未读数（候选总数 − 本地已读数，D6 前端缓存方案） */
  unreadCount = 0;
  /** 是否已加载过通知（避免重复拉取） */
  loaded = false;

  /** 当前应展示的开屏弹窗（全局，跨所有页面） */
  splashNotice: Notice | null = null;
  /** 开屏弹窗展示队列（创建时间由近及远） */
  splashQueue: Notice[] = [];
  /** 开屏弹窗当前队列下标 */
  splashIndex = 0;

  /** 拉取并分发生效通知，随后刷新全局浮层 */
  async load(): Promise<void> {
    const list = await fetchActiveNotices();
    const visible: Notice[] = [];
    for (const n of list) {
      if (isNoticeEffective(n) && isNoticeVersionMatch(n) && isNoticeVisibleForUser(n)) {
        visible.push(n);
      }
    }
    this.notices = visible;
    this.dispatch = dispatchNotices(visible);
    this.loaded = true;
    this.buildSplashQueue();
    this.refreshUnread();
  }

  /**
   * 构建开屏弹窗队列：
   *  - 按创建时间由近及远排序，全部展示；
   *  - 跳过“今日不显示”的（勾选过复选框）与不满足首次登录条件的；
   */
  buildSplashQueue(): void {
    // 置顶优先，多个置顶按创建时间由近及远
    const splashes = sortNotices(this.dispatch.splash);
    const queue: Notice[] = [];
    // 标题+正文相同的开屏公告只保留一条（归一化后比较，见 splashDedupeKey）：
    // 后端若存在重复记录，点「我知道了」后弹出的下一条长得一模一样，
    // 用户会以为“点了没反应”，只能再点一次。
    const seen = new Set<string>();
    for (const s of splashes) {
      if (this.isHiddenToday(s.id)) continue;
      if ((s.firstLoginOnly ?? 0) == 1) {
        if (!(isLoggedIn() && isFirstLogin())) continue;
      }
      const key = splashDedupeKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(s);
    }
    this.splashQueue = queue;
    this.splashIndex = 0;
    this.splashNotice = queue.length > 0 ? (queue[0] as Notice) : null;
  }

  /**
   * 关闭开屏弹窗并进入下一条：
   *  @param hideToday 勾选“今日不显示”时，本条当天不再展示（次日恢复）
   */
  dismissSplash(hideToday: boolean): void {
    const current = this.splashNotice;
    if (current != null) {
      if (hideToday) this.markHiddenToday(current.id);
      if ((current.firstLoginOnly ?? 0) == 1) markFirstLoginShown();
    }
    this.splashIndex++;
    this.splashNotice =
      this.splashIndex < this.splashQueue.length
        ? (this.splashQueue[this.splashIndex] as Notice)
        : null;
  }

  /** 某条开屏是否已勾选“今日不显示” */
  isHiddenToday(id: number): boolean {
    try {
      const saved = uni.getStorageSync(SplashHideKey(id)) as string;
      return saved == todayStr();
    } catch (_) {
      return false;
    }
  }

  /** 勾选“今日不显示”，记录当天日期 */
  markHiddenToday(id: number): void {
    try {
      uni.setStorageSync(SplashHideKey(id), todayStr());
    } catch (_) {}
  }

  /**
   * 刷新未读数（需登录）
   * 候选总数（后端 unread-count）为基准；不为 0 时拉取消息中心列表，
   * 与本地已读缓存求差得到精确未读数（后端不判已读，D6）。
   */
  async refreshUnread(): Promise<void> {
    if (!isLoggedIn()) {
      this.unreadCount = 0;
      return;
    }
    const total = await fetchUnreadCount();
    if (total <= 0) {
      this.unreadCount = 0;
      return;
    }
    try {
      const list = await fetchMessageCenter();
      this.unreadCount = unreadCountOf(list);
    } catch (_) {
      // 消息中心拉取失败时保守显示候选总数
      this.unreadCount = total;
    }
  }

  /** 拉取消息中心列表（已读状态由前端缓存判断） */
  async fetchMessageCenterList(): Promise<Notice[]> {
    return await fetchMessageCenter();
  }
}

const noticeStore = reactive(new NoticeStore()) as NoticeStore;

export function useNoticeStore(): NoticeStore {
  return noticeStore;
}
