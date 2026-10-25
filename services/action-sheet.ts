/**
 * 应用内底部操作表（替代 uni.showActionSheet）。
 * 原生 ActionSheet 不跟随 App 字号缩放，深色主题下是系统白底，项目里要求
 * 弹层一律自绘：渲染在 qt-action-sheet-host（qt-page-frame 内全站一个实例），
 * 复用 qt-action-sheet 组件的样式与滚动定位，这里只管全局状态与调用口。
 *
 * 用法（替代 uni.showActionSheet 的 success 回调）：
 *   qtShowActionSheet({ itemList: ["播放", "移除"] }).then((idx) => {
 *     if (idx < 0) return; // 点蒙层/取消键关闭
 *     ...
 *   });
 * 可传 title 显示顶部标题、selectedIndex 让列表打开时滚到当前项
 * （替代原生「✓ 」前缀的选中暗示时，文案里仍自行带标记）。
 */
import { ref } from "vue";

export interface QtActionSheetOptions {
  /** 选项文案，顺序即展示顺序 */
  itemList: string[];
  /** 顶部标题，可省略 */
  title?: string;
  /** 当前选中项下标（-1 = 无）。打开时若在折叠区外列表自动滚到它 */
  selectedIndex?: number;
  /**
   * 逐项自定义颜色（与 itemList 按下标对齐，缺省/null = 主题默认色）。
   * 内联 qt-action-sheet 的 actions 支持 color，宿主路径经这里补齐同一能力
   * （如歌曲菜单里「取消收藏」的高亮红）。
   */
  colors?: (string | null)[];
}

const visible = ref(false);
const items = ref<string[]>([]);
const title = ref("");
const selectedIndex = ref(-1);
const colors = ref<(string | null)[]>([]);

let resolver: ((index: number) => void) | null = null;

export function qtShowActionSheet(options: QtActionSheetOptions): Promise<number> {
  // 连续弹窗时，上一个未决的直接按取消收场，避免 promise 悬挂
  if (resolver != null) {
    const previous = resolver;
    resolver = null;
    previous(-1);
  }
  const list = options.itemList != null ? options.itemList : [];
  if (list.length == 0) return Promise.resolve(-1);
  items.value = list;
  title.value = options.title != null ? options.title : "";
  selectedIndex.value = options.selectedIndex != null ? options.selectedIndex : -1;
  colors.value = options.colors != null ? options.colors : [];
  visible.value = true;
  return new Promise<number>((resolve) => {
    resolver = resolve;
  });
}

/** 选中某项：关闭并兑现下标 */
export function qtActionSheetPick(index: number): void {
  if (!visible.value) return;
  visible.value = false;
  const settle = resolver;
  resolver = null;
  if (settle != null) settle(index);
}

/** 点蒙层/取消键：关闭并兑现 -1 */
export function qtActionSheetCancel(): void {
  if (!visible.value) return;
  visible.value = false;
  const settle = resolver;
  resolver = null;
  if (settle != null) settle(-1);
}

/** 宿主组件读取状态用 */
export function qtActionSheetState() {
  return { visible, items, title, selectedIndex, colors };
}
