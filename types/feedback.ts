/**
 * 问题反馈类型定义
 * 对齐后端 astral-plugin-feedback 实体（sys_feedback / sys_feedback_reply）
 */

/** 反馈类型：issue 问题 | request 需求 */
export type FeedbackType = "issue" | "request";

/** 反馈状态：pending提出 → received已接收 → resolved已解决 → published已发布；任意状态可 → deprecated已废弃 */
export type FeedbackStatus = "pending" | "received" | "resolved" | "published" | "deprecated";

/** 反馈条目 */
export interface FeedbackItem {
  id: number;
  /** 提交用户ID（sys_user.id） */
  userId?: number;
  /** 类型：issue 问题 | request 需求 */
  type?: string;
  /** 标题 */
  title?: string;
  /** 内容 */
  content?: string;
  /** 联系方式（可空） */
  contact?: string;
  /** 状态：pending|received|resolved|published|deprecated */
  status?: string;
  /** 是否公开（published 时 App 才展示在公开列表） */
  isPublic?: boolean;
  /** 设备型号（服务端从请求头自动补） */
  device?: string;
  /** 系统版本 */
  os?: string;
  /** App 版本 */
  appVersion?: string;
  /** 平台：android | ios */
  platform?: string;
  /** 提交时间 */
  createTime?: string;
  /** 更新时间 */
  updateTime?: string;
}

/** 反馈回复（双向、扁平；nickname/userType 为后端 JOIN sys_user 填充） */
export interface FeedbackReplyItem {
  id: number;
  /** 所属反馈ID */
  feedbackId?: number;
  /** 发送者ID（用户/管理员都是 sys_user.id） */
  userId?: number;
  /** 回复内容 */
  content?: string;
  /** 回复时间 */
  replyTime?: string;
  /** 发送者昵称 */
  nickname?: string;
  /** 发送者用户类型：ADMIN 官方 | APP 用户 */
  userType?: string;
}

/** 分页结果（MyBatis-Plus Page 序列化结构） */
export interface FeedbackPageResult {
  records: FeedbackItem[];
  total: number;
  current: number;
  pages: number;
}
