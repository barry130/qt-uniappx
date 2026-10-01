/**
 * 统一通知类型定义
 * 对齐后端 astral-plugin-feedback SysNotice 实体（qt_app_notice 超集）
 * 原 qt_app_notice 的 type 展示位掩码更名为 display，语义不变
 */

/** 展示渠道位掩码（可叠加）：1开屏 2通告栏 4消息中心 */
export type NoticeChannel =
  | 1 // 开屏弹窗
  | 2 // 首页通告栏
  | 4; // 消息中心

/** 公告可见人群 */
export type NoticeAudience = "ALL" | "LOGGED_IN" | "NOT_LOGGED_IN";

/** 通知渠道：app | web | all */
export type NoticeChannelKind = "app" | "web" | "all";

/** 通知类型：announce 公告 | feedback 反馈 | request 需求 */
export type NoticeType = "announce" | "feedback" | "request";

/** 公告实体 */
export interface Notice {
  id: number;
  /** 展示渠道位掩码（原 qt_app_notice.type 更名），按位叠加 */
  display?: number;
  /** 兼容旧字段（原 type 展示位掩码） */
  type?: number;
  /** 渠道：app | web | all */
  channel?: string;
  /** 通知类型：announce 公告 | feedback 反馈 | request 需求 */
  noticeType?: string;
  /** 点对点目标用户ID（空 = 广播） */
  userId?: number;
  /** 关联反馈ID（反馈/需求通知非空，用于点击跳转反馈详情） */
  feedbackId?: number;
  /** 点击跳转链接 */
  url?: string;
  /** 预留 uid */
  uid?: string;
  /** 公告标题 */
  title?: string;
  /** 公告正文（可包含换行和简单链接） */
  content?: string;
  /** 是否启用 0-隐藏 1-展示 */
  isShow?: number;
  /** 是否置顶 0-否 1-是 */
  isTop?: number;
  /** 开屏弹窗是否可关闭 0-不可关 1-可关 */
  dialogClosable?: number;
  /** 仅首次登录弹出 0-否 1-是 */
  firstLoginOnly?: number;
  /** 通告栏是否跑马灯 0-否 1-是 */
  marquee?: number;
  /** 生效时间 */
  effectiveStart?: string;
  /** 失效时间 */
  effectiveEnd?: string;
  /** 生效 APP 版本码下限（如 300 对应 3.0.0） */
  versionMin?: number;
  /** 生效 APP 版本码上限 */
  versionMax?: number;
  /** 可见人群 */
  audience?: NoticeAudience;
  /** 消息中心是否已读（新方案由前端缓存判断，此字段后端恒为空，仅兼容保留） */
  read?: boolean;
  /** 创建时间 */
  createTime?: string;
  /** 更新时间 */
  updateTime?: string;
}

/** 公告分发结果：按展示位分组 */
export interface NoticeDispatch {
  splash: Notice[]; // 开屏弹窗
  noticeBar: Notice[]; // 通告栏
  messageCenter: Notice[]; // 消息中心（不展示在首页，仅铃铛入口）
}

/** 消息中心列表项：通知 + 本地已读状态 */
export interface NoticeListItem {
  notice: Notice;
  /** 进入页面时的已读快照（前端缓存判断） */
  read: boolean;
}
