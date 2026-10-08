/**
 * 官方网站地址（全站唯一来源）
 *
 * 「关于轻听」与「音源包管理」里的用户协议、隐私政策、意见反馈、项目介绍与
 * 音源设置教程都指向官网，不在各页面各自硬编码 URL。
 * 官网源码见 quietMusic-site 仓库，构建与托管在腾讯云 EdgeOne Pages。
 * 打开方式统一走 services/app-native.ts 的 openInBrowser（系统浏览器）。
 */

/** 官网首页：项目介绍与开源地址入口 */
export const OFFICIAL_SITE_URL = "https://quietmusic.canace.cn";

/** 意见反馈：GitHub / CNB 双渠道的 Issue 与 PR 入口 */
export const OFFICIAL_FEEDBACK_URL = OFFICIAL_SITE_URL + "/feedback";

/** 用户协议 */
export const OFFICIAL_AGREEMENT_URL = OFFICIAL_SITE_URL + "/agreement";

/** 隐私政策 */
export const OFFICIAL_PRIVACY_URL = OFFICIAL_SITE_URL + "/privacy";

/** 如何设置音源（装包、换源、音质与故障速查） */
export const OFFICIAL_SOURCE_SETUP_URL = OFFICIAL_SITE_URL + "/source-setup";
