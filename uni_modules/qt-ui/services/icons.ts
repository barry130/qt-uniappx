/**
 * 统一图标服务
 *
 * 全站唯一的图标来源：自绘线性图标（24x24 视图框，2px 描边，圆角端点）。
 * 不使用图标字体、第三方图标库或文字符号，保证所有页面风格一致。
 *
 * 用法：
 *   import { iconSrc } from "@/uni_modules/qt-ui/services/icons";
 *   iconSrc("play", "#ffffff")
 * 或在模板中使用 `components/qt-icon.uvue`。
 */

/** 描边宽度占位符，生成时替换为实际颜色 */
const COLOR_TOKEN = "__COLOR__";

/**
 * 图标路径表。所有图标共用同一套视觉规范：
 * - 24x24 视图框
 * - 线性描边，stroke-width 2，圆角端点与拐角
 * - 需要实心表达的图标用 COLOR_TOKEN 填充
 */
const ICON_BODIES: Record<string, string> = {
  // 导航与通用
  "chevron-left": '<polyline points="15 18 9 12 15 6"/>',
  "chevron-right": '<polyline points="9 18 15 12 9 6"/>',
  "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
  "arrow-up": '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  "arrow-down": '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="' + COLOR_TOKEN + '" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="' + COLOR_TOKEN + '" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="' + COLOR_TOKEN + '" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="16.2" y1="16.2" x2="21" y2="21"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  // 设置：滑块形态，纯基本图元，小尺寸下比齿轮更清晰
  settings: '<line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="17" x2="21" y2="17"/><circle cx="9" cy="7" r="2.6"/><circle cx="16" cy="17" r="2.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="12" y1="7.6" x2="12.01" y2="7.6"/>',
  // 复制：双层圆角矩形，用于复制播放地址等操作
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><polyline points="15.5 5 4.5 5 4.5 16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>',
  edit: '<path d="M17 3.5a2.1 2.1 0 0 1 3 3L8.5 18l-4.5 1.5L5.5 15z"/>',

  // 播放控制
  play: '<polygon points="6 4 20 12 6 20" fill="' + COLOR_TOKEN + '" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="' + COLOR_TOKEN + '" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="' + COLOR_TOKEN + '" stroke="none"/>',
  "skip-back": '<polygon points="19 20 9 12 19 4" fill="' + COLOR_TOKEN + '" stroke="none"/><line x1="5" y1="19" x2="5" y2="5"/>',
  "skip-forward": '<polygon points="5 4 15 12 5 20" fill="' + COLOR_TOKEN + '" stroke="none"/><line x1="19" y1="5" x2="19" y2="19"/>',
  repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  "repeat-1": '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M11 10.6l1.5-1v5.9"/>',
  shuffle: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3.5" y1="6" x2="3.51" y2="6"/><line x1="3.5" y1="12" x2="3.51" y2="12"/><line x1="3.5" y1="18" x2="3.51" y2="18"/>',

  // 音乐业务
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  // 意见反馈：对话气泡
  feedback: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  // 不喜欢列表：禁止符（圆 + 斜杠），用于设置入口与不喜欢管理页
  ban: '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>',
  "heart-fill": '<path fill="' + COLOR_TOKEN + '" stroke="none" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  // 播放页工具按钮：分享（三点连线）/ 倍速（仪表盘）/ 均衡器（推子）
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1.5" y1="14" x2="6.5" y2="14"/><line x1="9.5" y1="8" x2="14.5" y2="8"/><line x1="17.5" y1="16" x2="22.5" y2="16"/>',
  // compass / music / user 同时被 tools/gen-tab-icons.mjs 用作 tabBar 图标的几何来源
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="15.6 8.4 13.8 13.8 8.4 15.6 10.2 10.2" fill="' + COLOR_TOKEN + '" stroke="none"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="12" y1="14.5" x2="12" y2="17.5"/>',
  trending: '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
  chart: '<line x1="5" y1="21" x2="5" y2="13"/><line x1="12" y1="21" x2="12" y2="4"/><line x1="19" y1="21" x2="19" y2="9"/>',
  folder: '<path d="M3 8a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><line x1="12" y1="18" x2="12" y2="21"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  // 眼睛：密码明文切换（睁眼=明文，闭眼=隐藏）
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M2 12s3.5-6.5 10-6.5 10 6.5 10 6.5"/><line x1="4" y1="4" x2="20" y2="20"/><circle cx="12" cy="12" r="3"/>',
  // 地球：官网 / 项目介绍与开源地址入口（外圆 + 本初子午线椭圆 + 赤道）
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M12 2.5a14.5 14.5 0 0 0 0 19a14.5 14.5 0 0 0 0-19z"/><line x1="2.5" y1="12" x2="21.5" y2="12"/>',
  // 桌面歌词设置页：锁定 / 文字颜色 / 字号
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  droplet: '<path d="M12 3.2c3.6 3.9 6 6.9 6 10.1a6 6 0 0 1-12 0c0-3.2 2.4-6.2 6-10.1z"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  // 品牌标识不再走图标体系：全站 logo 直接用 /static/icon/xxxhdpi.png 真图
  // （about / 忘记密码 / 侧边栏 / 升级弹窗 / 登录页），避免出现手绘的近似图形。
  // 加载指示器：一段圆弧 + 端点，配合旋转动画构成转圈效果
  loader: '<path d="M12 3a9 9 0 0 1 8.5 6"/><line x1="20.5" y1="9" x2="20.6" y2="9.1"/>',
  // 火箭：列表「回到顶部」悬浮按钮使用（单头朝上，竖立火箭）
  rocket: '<path d="M12 2.8c2.6 2 4 4.8 4 7.7l-1.1 3.9H9.1L8 10.5c0-2.9 1.4-5.7 4-7.7z"/><circle cx="12" cy="9.4" r="1.6"/><path d="M8.6 14.4 5.8 18M15.4 14.4 18.2 18"/><path d="M9.4 18.2h5.2"/>',
};

/**
 * data URI 结果缓存。
 * 长列表里每个行组件都带 1~2 个图标（150 行就是 300 次），而每次 iconSrc() 都要
 * 拼接 SVG 字符串再做一次 encodeURIComponent；同一 (name,color,strokeWidth) 结果
 * 完全一致，缓存下来即可。图标名固定 48 个、颜色取自主题调色板，缓存规模有界。
 */
const srcCache = new Map<string, string>();

/**
 * 生成图标的 data URI。
 * @param name 图标名，必须存在于 ICON_BODIES
 * @param color 描边/填充颜色
 * @param strokeWidth 描边宽度，默认 2
 */
export function iconSrc(name: string, color: string = "#ffffff", strokeWidth: number = 2): string {
  const stroke = color.length > 0 ? color : "#ffffff";
  const cacheKey = name + "|" + stroke + "|" + strokeWidth;
  const cached = srcCache.get(cacheKey);
  if (cached != null) return cached;
  const raw = ICON_BODIES[name] ?? "";
  const body = raw.split(COLOR_TOKEN).join(stroke);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' +
    stroke +
    '" stroke-width="' +
    strokeWidth +
    '" stroke-linecap="round" stroke-linejoin="round">' +
    body +
    "</svg>";
  const src = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  srcCache.set(cacheKey, src);
  return src;
}

/** 判断图标是否已定义，便于开发期自检 */
export function hasIcon(name: string): boolean {
  return (ICON_BODIES[name] ?? "").length > 0;
}
