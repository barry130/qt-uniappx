/**
 * 宽屏内容宽度 / 控件尺寸令牌（qt-ui 统一契约）。
 *
 * 为什么需要这个文件：改造前 `qt-page-frame` 用 `Math.max(maxWidth, 1360)` 把所有
 * 页面强行拉到同一个宽度（设置页 11 行入口也占 1360，排行榜也占 1360），页面自己
 * 传的 `max-width=640` 完全不生效。结果宽屏下窄内容页空出两侧大片空白、长列表页
 * 行宽 1312px 一行只放一条内容。
 *
 * 这里把「内容宽度」按**内容形态**分档，并由窗口宽度连续夹紧：
 *   form   560-720   单个表单（登录 / 找回密码 / 均衡器 / 提交反馈）
 *   prose  560-640   长文本正文（公告详情 / 反馈详情）—— 行长超过约 80 字符后阅读吃力
 *   flow   900-1440  分组卡片流（设置 / 关于 / 权限 / 我的 / 缓存）
 *   list   720-1440  列表（歌曲 / 历史 / 下载 / 反馈列表）
 *   detail 720-1080  主从双栏详情（歌手 / 歌单 / 榜单 / 统计）
 *   grid   900-1600  卡片栅格（歌单广场 / 收藏 / 首页）
 *   full   不限      沉浸媒体页（播放页）
 *
 * 关键规则：**不再有「更宽才算对」的下限**。每档都有真实上限，超过就居中留白；
 * 窄窗口下先取窗口宽度（减 rail、减边距），再夹到 [min, max]。
 *
 * 只读模块级单例 layout，不发挂载副作用，因此可以在 computed 里直接被追踪。
 */
import { ref } from "vue";
import { qtLayout, qtRailWidth } from "./use-qt-layout";

/**
 * 内容宽度上限（px，0 = 不限制）—— 给「一屏多栏」的外壳用。
 *
 * 使用场景：设置页族 / 我的页族在宽屏下是「rail + 族总览 + 子页内容」三栏（见 qt-page-frame）。
 * 子页自己仍按全屏内容宽（flow = 1024dp）算列宽与栅格列数，直接塞进右栏必然溢出。
 * 框架挂载时把上限设成右栏宽度，页面里的 qtContentWidth() 读到的就是右栏可用宽，
 * 列宽/列数自动收窄，11 个设置页一行代码都不用改。
 *
 * 为什么是**栈**而不是单值：页面栈里多个页面的框架实例同时存活（返回时上一页并不会
 * 提前销毁）。单值 + 卸载清除会让状态错位 —— 例如「播放设置 → 均衡器」跳出去再返回，
 * 均衡器（非设置页，上限 0）比播放设置晚挂载，它卸载后若直接清零，回到播放设置时
 * 三栏还在但页面已按全宽排版，右列被裁。
 *
 * 栈的语义：每层框架 push 自己需要的一次上限；生效值取**最后一个仍存活的条目**
 * （= 页面栈最上层那页的诉求）。0 表示该页不限宽，它压在上面时就确实不限宽。
 *
 * 框架自己（qt-page-frame）必须走 qtContentWidthRaw —— 否则会读到自己设的上限，
 * 内容列被越缩越小（限 → 缩 → 再限）。
 */
type CapEntry = { token: number; px: number };

/** 存活的上限条目，按挂载先后排列 */
let capEntries: CapEntry[] = [];
/** 版本号：条目数组是普通数组，靠它触发 computed 重算 */
const capVersion = ref<number>(0);
let capTokenSeq = 1;

/** 申请一层上限：返回 owner token，卸载时原样传给 qtClearContentWidthCap */
export function qtPushContentWidthCap(px: number): number {
  const token = capTokenSeq++;
  capEntries.push({ token: token, px: px > 0 ? Math.floor(px) : 0 });
  capVersion.value = capVersion.value + 1;
  return token;
}

/** 就地更新某层上限（窗口尺寸、栏宽变化时用，不能再 push 否则栈会一直涨） */
export function qtUpdateContentWidthCap(token: number, px: number): void {
  const next = px > 0 ? Math.floor(px) : 0;
  for (let i = 0; i < capEntries.length; i++) {
    if (capEntries[i].token == token) {
      capEntries[i].px = next;
      capVersion.value = capVersion.value + 1;
      return;
    }
  }
}

/** 释放某层上限（按 token 定位，允许非 LIFO 顺序销毁） */
export function qtClearContentWidthCap(token: number): void {
  const kept: CapEntry[] = [];
  let removed = false;
  for (let i = 0; i < capEntries.length; i++) {
    if (capEntries[i].token == token) {
      removed = true;
      continue;
    }
    kept.push(capEntries[i]);
  }
  if (!removed) return;
  capEntries = kept;
  capVersion.value = capVersion.value + 1;
}

/** 当前生效上限（0 表示无限制）；诊断与外壳计算用 */
export function qtContentWidthCap(): number {
  // 读版本号建立依赖，否则 computed 追踪不到条目变化
  const v = capVersion.value;
  if (v < 0) return 0;
  return capEntries.length == 0 ? 0 : capEntries[capEntries.length - 1].px;
}

/**
 * 宽屏三栏（设置页族 / 我的页族）的几何契约（px）：中栏宽、栏间距、右栏最小可用宽。
 * 中栏 400 放得下「外观与皮肤」这类五字标题 + 图标；右栏比 460 更窄时子页内部的
 * 两列 / 栅格只能堆成一列，与其挤着难看不如不拆三栏（退回整页形态）。
 */
export const QT_SPLIT_NAV_WIDTH = 400;
export const QT_SPLIT_NAV_GAP = 16;
export const QT_SPLIT_PANE_MIN = 460;

/**
 * 宽屏三栏是否启用：宽屏 + flow 内容列放得下「中栏 + 间距 + 右栏最小宽」（876 起）。
 * 框架与 hub 页共用这一个判据（框架画中栏、hub 页决定自己的整页总览还画不画），
 * 数字必须同源，否则会出现「框架画了中栏、页面又铺了一份整页总览」的双份并存。
 */
export function qtSplitActive(isWide: boolean): boolean {
  if (!isWide) return false;
  return qtContentWidthRaw("flow") >= QT_SPLIT_NAV_WIDTH + QT_SPLIT_NAV_GAP + QT_SPLIT_PANE_MIN;
}

export type QtWidthKind = "form" | "prose" | "flow" | "list" | "detail" | "grid" | "full";

/** 内容列左右最小留白（px）：宽屏下内容列不贴 rail、不贴窗口右缘 */
export const QT_GUTTER_PX = 24;

type WidthRange = { min: number; max: number };

const WIDTH_RANGES: Record<QtWidthKind, WidthRange> = {
  form: { min: 560, max: 720 },
  prose: { min: 560, max: 640 },
  flow: { min: 900, max: 1440 },
  list: { min: 720, max: 1440 },
  detail: { min: 720, max: 1080 },
  grid: { min: 900, max: 1600 },
  full: { min: 0, max: 0 },
};

/** 两列布局的最小列宽（px）：不满足就退回单列，不做「挤成两列」 */
export const QT_MIN_COLUMN_WIDTH = {
  /** 分组卡片（设置项：图标 + 标题 + 值 + 箭头） */
  group: 420,
  /** 歌曲行（勾选 + 标题/歌手 + 时长 + 更多） */
  song: 440,
  /** 歌单卡片（封面 + 两行标题） */
  card: 168,
  /** 主从双栏的左侧信息栏 */
  aside: 260,
} as const;

/**
 * 内容列可用宽度（px）—— 已经减掉 rail、状态栏无关，但**含**页面自身的内边距。
 * 调用方要算「能放几列」时继续减自己的 padding。
 *
 * kind 收 string 而不是联合类型：页面模板里 `width-kind="flow"` 传进来时静态类型是
 * string，收窄类型会让 UTS 编译器在组件边界报错。未知值按 flow 兜底。
 */
export function qtContentWidth(kind: string = "flow"): number {
  const raw = qtContentWidthRaw(kind);
  const cap = qtContentWidthCap();
  if (cap <= 0) return raw;
  return cap < raw ? cap : raw;
}

/**
 * 不受「外壳设限」影响的原始内容宽度 —— 只给 qt-page-frame 自己用。
 * 框架算内容列的居左位置必须基于窗口可用区，不能读外壳设的上限。
 */
export function qtContentWidthRaw(kind: string = "flow"): number {
  const l = qtLayout();
  const range = rangeOf(kind);
  if (kind == "full") return l.windowWidth;
  const rail = qtRailWidth();
  const avail = l.windowWidth - rail - QT_GUTTER_PX * 2;
  // 可用宽度不足档位下限时，**必须回落到真实可用宽度**。
  // 早前这里返回 range.min（flow 是 900），在 900dp 的 wide 档（900-208-48=644）
  // 和 240dp 的矮横窗里都会把内容列写成比窗口还宽，症状是右侧内容被挤出屏幕。
  // 档位区间只用来「限宽」，不能用来「撑宽」。
  if (avail <= 0) return l.windowWidth > 0 ? l.windowWidth : range.min;
  if (avail < range.min) return avail;
  return avail < range.max ? avail : range.max;
}

/** 档位 -> 宽度区间；未知档位按 flow 处理 */
function rangeOf(kind: string): WidthRange {
  if (kind == "form") return WIDTH_RANGES.form;
  if (kind == "prose") return WIDTH_RANGES.prose;
  if (kind == "list") return WIDTH_RANGES.list;
  if (kind == "detail") return WIDTH_RANGES.detail;
  if (kind == "grid") return WIDTH_RANGES.grid;
  if (kind == "full") return WIDTH_RANGES.full;
  return WIDTH_RANGES.flow;
}

/**
 * 内容列在窗口内的左边距（px）—— **含 rail**，直接当 margin-left 用。
 *
 * 可用区是「rail 右侧到窗口右缘」这一条，内容列在可用区里居中：
 *   left = rail + (可用区宽 - 内容宽) / 2
 *
 * 改造前页面各自写 `padding-left: qtSideNavPad(w, 1360)`，和框架各算一套宽度，
 * 框架改成连续宽度后两边必然对不上。现在页面不再写，框架只调这一个函数。
 */
export function qtContentPadLeft(kind: string = "flow"): number {
  const l = qtLayout();
  if (!l.isWide) return 0;
  const rail = qtRailWidth();
  // 用 raw 而不是 qtContentWidth：这个函数的语义是「框架内容列在窗口里的位置」。
  // 设置页族三栏外壳会用 qtPushContentWidthCap 把内容宽收窄成右栏宽（给页面内部
  // 排列用），框架这一层的位置不能跟着缩 —— 否则居中余量越来越大，内容列持续右移。
  const width = qtContentWidthRaw(kind);
  const avail = l.windowWidth - rail;
  const slack = avail - width;
  return rail + (slack > 0 ? Math.floor(slack / 2) : 0);
}

/**
 * 能否排两列（分组卡片 / 歌曲行 / 栅格卡片）。
 * @param kind 列类型
 * @param avail 可用宽度（px），通常是 qtContentWidth() 减页面自身 padding
 */
export function qtCanTwoColumn(kind: keyof typeof QT_MIN_COLUMN_WIDTH, avail: number, gap: number = 16): boolean {
  const need = QT_MIN_COLUMN_WIDTH[kind] * 2 + gap;
  return avail >= need;
}

/**
 * 按最小列宽推导列数（栅格用）。
 * @param avail 可用宽度（已减页面 padding）
 * @param minCard 单卡最小宽度（默认 168）
 * @param gap 卡间距
 * @param maxColumns 列数上限（默认 8，防止超宽屏上卡片碎成一片）
 */
export function qtColumnCount(avail: number, minCard: number = QT_MIN_COLUMN_WIDTH.card, gap: number = 12, maxColumns: number = 8): number {
  if (avail <= 0) return 1;
  const n = Math.floor((avail + gap) / (minCard + gap));
  if (n < 1) return 1;
  return n > maxColumns ? maxColumns : n;
}

/**
 * 浮层宽度契约（px）：贴内容列，不贴窗口。
 *   modal  居中对话框
 *   dialog 小型确认框
 *   drawer 侧边抽屉（贴内容列右缘）
 */
export const QT_SHEET_WIDTH = { modal: 560, dialog: 420, drawer: 420 } as const;

export function qtSheetWidth(kind: keyof typeof QT_SHEET_WIDTH = "modal"): number {
  const l = qtLayout();
  const want = QT_SHEET_WIDTH[kind];
  const avail = l.windowWidth - QT_GUTTER_PX * 2;
  return avail < want ? avail : want;
}

export type QtListItem = { id: number };

/**
 * 把数组切两列（按顺序对半分，左列在前）。
 * 注意：**不用 flex-wrap 自动分列** —— 分组高度不等时会走成锯齿（左列塞 4 个矮组、
 * 右列只剩 1 个高组）。切分必须在数据层做，这样键盘顺序与视觉顺序一致。
 */
export function qtSplitTwoColumn<T>(items: T[]): [T[], T[]] {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/**
 * 按可用高度均衡切两列（分组卡片用：组高不等时按累计高度找平衡点）。
 * @param heights 每组的高度（px），与 items 一一对应
 *
 * 找的是「两列高度差最小」的切点，不是「累计过半就切」——后者会稳定地切成 7/3
 * 这种偏斜（设置页 10 个 cell、播放设置组占 3 行时，累计过半恰好落在第 4 组之后），
 * 视觉上左列长、右列短。改成遍历所有切点取最小差，同样输入会切成 4/6。
 * 切点仍只落在组边界，不拆断任何一组。
 */
export function qtSplitByHeight<T>(items: T[], heights: number[]): [T[], T[]] {
  const n = items.length;
  if (n <= 1) return [items.slice(0, n), []];
  let total = 0;
  for (let i = 0; i < n; i++) total += i < heights.length ? heights[i] : 0;
  let acc = 0;
  let bestCut = 1;
  let bestDiff = -1;
  for (let i = 0; i < n - 1; i++) {
    acc += i < heights.length ? heights[i] : 0;
    const diff = acc * 2 > total ? acc * 2 - total : total - acc * 2;
    if (bestDiff < 0 || diff < bestDiff) {
      bestDiff = diff;
      bestCut = i + 1;
    }
  }
  return [items.slice(0, bestCut), items.slice(bestCut)];
}
