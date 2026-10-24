/**
 * 页面 chrome 元信息（标题 / 自带头部 / 设置与我的三栏路由）。
 *
 * 背景：`pages.json` 已把 **全局** `navigationStyle` 改成 `custom`（Android 上
 * 运行期改不了 navigationStyle，只能静态配置，见 uni-app x 文档 api/unipage.md 的
 * PageStyle 支持表：Android 是 x）。原生导航栏因此全站消失，标题栏改由
 * `qt-page-frame` 负责：
 *   - 宽屏：不画标题栏（rail 就是导航），内容只让出状态栏；
 *   - 窄屏：画一条与原生等高的标题栏（返回 + 标题）。
 *
 * 标题只能从这张表取 —— custom 模式下 `navigationBarTitleText` 不再渲染，
 * 运行时也读不到页面 style。两边用**平行数组**而不是 Map/Record：
 * UTS 对对象字面量的键索引支持不稳，indexOf 查询是确定行为。
 */

import { ref } from "vue";

/** 路由表（顺序与 QT_TITLES 一一对应） */
const QT_ROUTES: string[] = [
  "/pages/home/index",
  "/pages/search/index",
  "/pages/collection/index",
  "/pages/local/index",
  "/pages/user/index",
  "/pages/profile/index",
  "/pages/player/index",
  "/pages/playlist/index",
  "/pages/login/index",
  "/pages/download/index",
  "/pages/chart/index",
  "/pages/daily/index",
  "/pages/artist/index",
  "/pages/history/index",
  "/pages/dislikes/index",
  "/pages/settings/index",
  "/pages/source-pack/index",
  "/pages/theme/index",
  "/pages/desktop-lyric/index",
  "/pages/stats/index",
  "/pages/about/index",
  "/pages/playlists/index",
  "/pages/notice/list/index",
  "/pages/notice/detail/index",
  "/pages/feedback/index",
  "/pages/feedback/submit",
  "/pages/playlist-import/index",
  "/pages/share-card/index",
  "/pages/equalizer/index",
  "/pages/feedback/detail",
  "/pages/forget-password/index",
  "/pages/profile/edit/index",
  "/pages/player-bar/index",
  "/pages/permissions/index",
  "/pages/cache/index",
  "/pages/logs/index",
  "/pages/download-settings/index",
  "/pages/play-settings/index",
  "/pages/ai-assistant/index",
];

const QT_TITLES: string[] = [
  "发现",
  "搜索音乐",
  "我的收藏",
  "本地音乐",
  "个人信息",
  "我的",
  "正在播放",
  "歌单",
  "账号登录",
  "下载管理",
  "排行榜",
  "每日新歌",
  "歌手",
  "最近播放",
  "不喜欢列表",
  "设置",
  "音源包管理",
  "外观与皮肤",
  "桌面歌词",
  "听歌统计",
  "关于",
  "歌单广场",
  "消息中心",
  "公告详情",
  "意见反馈",
  "提交反馈",
  "导入歌单",
  "分享卡片",
  "均衡器",
  "反馈详情",
  "忘记密码",
  "编辑资料",
  "播放页展示",
  "权限管理",
  "清除缓存与数据",
  "运行日志",
  "下载设置",
  "播放设置",
  "音乐助手",
];

/**
 * 自己画顶部区域的页面：框架不再叠一条标题栏（否则双层标题）。
 * 这三页本来就是 `navigationStyle: custom`：首页自带 音源/搜索/通知 头、
 * 「我的」自带状态栏留白、播放页是沉浸式全屏。
 */
const QT_SELF_HEADER_ROUTES: string[] = [
  "/pages/home/index",
  "/pages/profile/index",
  "/pages/player/index",
];

/**
 * 设置页族：宽屏下按「rail + 设置导航 + 子页内容」三栏渲染。
 * 设置总览本身也在表内 —— 它的右栏是空态提示，这样从总览点进子页时
 * 中间导航栏的位置与宽度完全不变（看起来是同一个界面在换右栏内容）。
 */
export const QT_SETTINGS_ROUTES: string[] = [
  "/pages/settings/index",
  "/pages/source-pack/index",
  "/pages/theme/index",
  "/pages/play-settings/index",
  "/pages/download-settings/index",
  "/pages/player-bar/index",
  "/pages/permissions/index",
  "/pages/cache/index",
  "/pages/logs/index",
  "/pages/desktop-lyric/index",
  "/pages/dislikes/index",
];

/**
 * 页面自己有标题文字、但**没有**返回按钮的页面（框架只补返回箭头，不画标题）。
 *
 * 目前只有音乐助手：它的 `.topbar` 里已经有「音乐助手」+ 副标题 + 两个操作按钮，
 * 框架再叠一条带标题的栏就是双标题；但那一页没有返回键，手机档必须有路可退。
 */
const QT_TITLELESS_ROUTES: string[] = [
  "/pages/ai-assistant/index",
];

/** 该路由是否由框架只补返回键、不画标题 */
export function qtPageTitleless(route: string): boolean {
  return QT_TITLELESS_ROUTES.indexOf(route) >= 0;
}

/** 页面标题；未知路由返回空串（框架就不画标题文字） */
export function qtPageTitle(route: string): string {
  const i = QT_ROUTES.indexOf(route);
  if (i < 0 || i >= QT_TITLES.length) return "";
  return QT_TITLES[i];
}

/** 该路由是否自带顶部区域（框架不再画标题栏） */
export function qtPageHasSelfHeader(route: string): boolean {
  return QT_SELF_HEADER_ROUTES.indexOf(route) >= 0;
}

/** 该路由是否属于设置页族（宽屏三栏） */
export function qtIsSettingsRoute(route: string): boolean {
  return QT_SETTINGS_ROUTES.indexOf(route) >= 0;
}

/**
 * 我的页族（宽屏三栏，与设置页族同一套机制）：「我的」总览 + 从总览点开的子页。
 * 宽屏下按「rail + 我的总览 + 子页内容」三栏渲染（见 qt-page-frame），
 * 中栏复用 qt-profile-overview 组件，子页只占右栏。
 * 登录页不属于族（表单页整页居中）；设置属于设置页族自己的三栏。
 */
export const QT_PROFILE_ROUTES: string[] = [
  "/pages/profile/index",
  "/pages/collection/index",
  "/pages/local/index",
  "/pages/download/index",
  "/pages/history/index",
  "/pages/stats/index",
  "/pages/ai-assistant/index",
  "/pages/feedback/index",
  "/pages/about/index",
  "/pages/user/index",
];

/** 该路由是否属于我的页族（宽屏三栏） */
export function qtIsProfileRoute(route: string): boolean {
  return QT_PROFILE_ROUTES.indexOf(route) >= 0;
}

/**
 * 运行期标题覆盖（少数页面标题要跟数据走）。
 *
 * 原生 `uni.setNavigationBarTitle` 在 `navigationStyle: custom` 下不再有任何可见效果
 * —— 页面自己画的标题栏读不到它。所以动态标题必须另开一条通道：
 * `pages/playlist/index` 在 onLoad 里按类型调 `qtSetPageTitle("专辑")`，
 * 框架渲染标题时优先取这条覆盖值。用「路由 + 标题」成对存储，切页时只认当前路由，
 * 避免上一个页面的标题串到下一页。
 */
const titleOverrideRoute = ref<string>("");
const titleOverrideText = ref<string>("");

/** 覆盖当前页标题（只对当前栈顶路由生效；传空串清除覆盖） */
export function qtSetPageTitle(title: string): void {
  titleOverrideRoute.value = qtTopRoute();
  titleOverrideText.value = title;
}

/** 当前页最终标题：覆盖值优先，其次静态表 */
export function qtCurrentPageTitle(route: string): string {
  if (route.length > 0 && route == titleOverrideRoute.value && titleOverrideText.value.length > 0) {
    return titleOverrideText.value;
  }
  return qtPageTitle(route);
}

/**
 * 页面栈顶路由。
 * 返回不带前导斜杠的原生 route，这里统一补成 `/pages/x/index` 形态，
 * 与 QT_ROUTES 的写法一致。取不到时返回空串。
 */
export function qtTopRoute(): string {
  try {
    const pages = getCurrentPages();
    if (pages.length > 0) {
      const r = pages[pages.length - 1].route;
      if (r != null && r.length > 0) return r.charAt(0) == "/" ? r : "/" + r;
    }
  } catch (_) {}
  return "";
}

/** 页面栈深度：用于决定是否画返回按钮（栈底没有上一页） */
export function qtPageStackDepth(): number {
  try {
    return getCurrentPages().length;
  } catch (_) {
    return 1;
  }
}
