/**
 * 首次启动免责声明（qt-uniappx 端）
 *
 * 与 qt-pc 的 `src/stores/disclaimer.ts` 同语义，差别只在存储介质：
 * PC 写 SQLite 的 settings 表，这里写 uni storage。
 *
 * **文案不在代码里**：后台「消息管理」发一条开屏公告（展示位含「开屏」，
 * 并填「条款版本号」）即可改，不用发版。改判定规则见下。
 *
 * 哪条公告算这份声明：**开屏位 + `termsVersion` 非空**。这是唯一判据
 * （服务端不认这个字段，它只负责把带版本号的公告渠道改写成 App 六端并强制可关闭）。
 * 普通公告千万别填版本号，否则会被当成声明从开屏队列里摘走（见 stores/notice.ts 的
 * buildSplashQueue），用户就再也看不到那条公告了。
 *
 * 「我知道了」默认要**读满 N 秒**才可点（N 由后端给，0 = 不读秒）：
 * 声明最怕的就是被顺手点掉。读秒时长只是防手滑，不是法律要件，后台可调。
 */
import { reactive } from "vue";
import { fetchActiveNotices, sortNotices } from "@/services/notice";
import type { Notice } from "@/types/notice";

/** 开屏展示位（同 types/notice.ts 的 NoticeChannel = 1） */
const DISPLAY_SPLASH = 1;

/**
 * 读秒上限 60 秒。
 *
 * 这个弹窗全屏遮罩、遮罩不可点、没有关闭键，读秒是唯一能锁住用户的开关，
 * 所以必须夹一道上限。三处口径一致：后台表单 `max=60`、astral 的
 * `FeedbackNoticeService.clampReadSeconds` 夹 [0,60]、这里再夹一次 ——
 * 绕过表单直接调接口写 600，等于让新用户首次启动干等十分钟。
 */
const MAX_READ_SECONDS = 60;

/** 接受记录（含已接受的条款版本号）。改键名等于让所有用户重弹一次 */
const DISCLAIMER_KEY = "qt-disclaimer-accepted";

export interface DisclaimerNotice {
  id: number;
  title: string;
  content: string;
  readSeconds: number;
  termsVersion: string;
  url: string;
}

/** 落库的接受记录 */
interface AcceptanceRecord {
  /** 已接受的条款版本号；空串 = 接受过但版本号未知（存储读不出来时的兜底） */
  termsVersion: string;
  acceptedAt: string;
}

/**
 * 这条公告是不是免责声明：开屏位 + 版本号非空。
 *
 * 这个判据有两个消费方，**必须共用一份**：
 * ① 本文件的 `pickDisclaimer`（认领）；
 * ② `stores/notice.ts` 的 `buildSplashQueue`（把声明从普通开屏队列里摘掉）。
 * 两边写岔了会出现「声明弹两次」或「声明被当成普通开屏公告弹出来」。
 */
export function isDisclaimerNotice(n: Notice): boolean {
  const display = n.display != null ? n.display : (n.type != null ? n.type : 0);
  if ((display & DISPLAY_SPLASH) == 0) return false;
  const terms = n.termsVersion != null ? n.termsVersion.trim() : "";
  return terms.length > 0;
}

/**
 * 从通知列表里挑出免责声明：开屏位 + 版本号非空，按 isTop / createTime 取第一条。
 * 复用 `sortNotices`（置顶优先、其次新的在前），与开屏公告同一套排序口径。
 */
export function pickDisclaimer(notices: Notice[]): DisclaimerNotice | null {
  const hits: Notice[] = [];
  for (let i = 0; i < notices.length; i++) {
    const n = notices[i];
    if (n == null) continue;
    if (!isDisclaimerNotice(n)) continue;
    hits.push(n);
  }
  if (hits.length == 0) return null;
  const first = sortNotices(hits)[0];
  const raw = first.readSeconds != null ? first.readSeconds : 0;
  return {
    id: first.id,
    title: first.title != null ? first.title : "",
    content: first.content != null ? first.content : "",
    readSeconds: Math.min(MAX_READ_SECONDS, Math.max(0, raw)),
    termsVersion: first.termsVersion != null ? first.termsVersion.trim() : "",
    url: first.url != null ? first.url : "",
  };
}

/**
 * 是否要弹。三种「不弹」：后端没下发声明 / 已经接受过同一版本 /
 * 记录里版本号为空（接受过但版本未知 —— 宁可漏弹一次，不要每次启动都拦一道）。
 */
export function shouldShow(saved: AcceptanceRecord | null, notice: DisclaimerNotice | null): boolean {
  if (notice == null) return false;
  if (saved == null) return true;
  if (saved.termsVersion.length == 0) return false;
  return saved.termsVersion != notice.termsVersion;
}

/** 读接受记录：没有记录返回 null；读坏了当作「没接受过」（会重弹一次，比永久漏弹安全） */
function readAcceptance(): AcceptanceRecord | null {
  let raw = "";
  try {
    raw = uni.getStorageSync(DISCLAIMER_KEY) as string;
  } catch (_) {
    // 存储读不出来时按「已接受」处理：这是本机存储异常，不该拦用户
    return { termsVersion: "", acceptedAt: "" };
  }
  if (raw == null || raw.length == 0) return null;
  const text = raw.trim();
  if (text.length == 0) return null;
  if (text.charAt(0) != "{") {
    // 兼容早期只写 ISO 时刻的裸字符串：当作「接受过但没有版本号」
    return { termsVersion: "", acceptedAt: text };
  }
  try {
    const rec = JSON.parse(text) as AcceptanceRecord;
    if (rec == null) return null;
    const version = rec.termsVersion != null ? rec.termsVersion : "";
    return { termsVersion: version, acceptedAt: rec.acceptedAt != null ? rec.acceptedAt : "" };
  } catch (_) {
    return null;
  }
}

/** 拉一次通知列表并挑出声明（拉取失败返回 null，调用方按「不弹」处理） */
async function fetchDisclaimer(): Promise<DisclaimerNotice | null> {
  const notices = await fetchActiveNotices();
  return pickDisclaimer(notices);
}

class DisclaimerStore {
  /**
   * null = 还没查过（此时不展示，避免首帧闪一下）；true = 要弹；false = 不弹。
   * 与 qt-pc 同义：初值必须是 null，否则冷启动会先渲染一个空弹窗再消失。
   */
  pending: boolean | null = null;
  /** 设置页「重新查看」时为 true：只展示，不改接受记录 */
  reopened = false;
  inited = false;
  notice: DisclaimerNotice | null = null;

  /** 是否展示：没拿到声明一律不展示（否则弹空壳） */
  get visible(): boolean {
    return this.notice != null && (this.pending == true || this.reopened);
  }

  /** 启动时调一次：拉声明 + 比对接受记录，决定要不要弹 */
  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;
    try {
      const notice = await fetchDisclaimer();
      this.notice = notice;
      this.pending = shouldShow(readAcceptance(), notice);
    } catch (_) {
      // 拉不到（离线 / 后台没发布）就不弹：不能因为一次网络失败把启动流程卡住
      this.pending = false;
    }
  }

  /** 「我知道了」：先关弹窗再落库，写失败也放行（下次启动重弹一次，不算事故） */
  accept(): void {
    const notice = this.notice;
    this.pending = false;
    this.reopened = false;
    if (notice == null) return;
    const rec: AcceptanceRecord = {
      termsVersion: notice.termsVersion,
      acceptedAt: new Date().toISOString(),
    };
    try {
      uni.setStorageSync(DISCLAIMER_KEY, JSON.stringify(rec));
    } catch (_) {}
  }

  /**
   * 设置页 / 关于页「重新查看」：只展示，不写接受记录（要重新读满秒数）。
   * 返回是否真的打开了 —— 取不到声明时返回 false，调用方据此提示一句，
   * 不留下「点了没反应」的死按钮。
   */
  async reopen(): Promise<boolean> {
    if (this.notice == null) {
      try {
        this.notice = await fetchDisclaimer();
      } catch (_) {
        this.notice = null;
      }
    }
    if (this.notice == null) return false;
    this.reopened = true;
    return true;
  }
}

const disclaimer = reactive(new DisclaimerStore()) as DisclaimerStore;

export function useDisclaimerStore(): DisclaimerStore {
  return disclaimer;
}
