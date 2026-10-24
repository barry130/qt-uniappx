import { computed } from "vue";
import { useQtLayout } from "@/uni_modules/qt-ui/composables/use-qt-layout";
import {
  qtContentWidth,
  QT_GUTTER_PX,
  QT_MIN_COLUMN_WIDTH,
} from "@/uni_modules/qt-ui/composables/use-qt-widths";

/**
 * 分组卡片页「拆成两列」的公共口径。
 *
 * 为什么不是每页自己算：37 个页面里 12 个是「分组卡片」型（设置、关于、权限、缓存、
 * 下载设置、播放设置、播放页展示、桌面歌词、主题、意见反馈、通知列表、我的）。
 * 它们的共同点是一行一个入口、行高固定、行尾右侧还有值或开关 —— 单列在 1920 下
 * 每行 1312px 只放一个入口，右侧 600px 全是空白，而纵向要滚两屏。
 *
 * **门限按可用宽度判，不按窗口宽度判**。早前写的是「sizeClass==desktop 或
 * 窗口 ≥1280」，在设置页族的三栏模式下会算错：窗口仍是 1280，但右栏只有约 600，
 * 于是照样判成两列 —— 每列约 270 被下限夹成 320，两列合计 704 溢出右栏。
 * 现在直接问「这条内容列能不能放下两个最小列宽」，三栏收窄后自然退回单列，
 * 而整页宽度足够时照旧两列（1280 窗口下 inner = 1024−48−16 = 960，
 * 两列各 480，远高于 420 的最小列宽）。
 *
 * 两个必须由调用方遵守的约束：
 * 1. **两列时分组自身不能再带左右外边距**（页面 CSS 里那套 `margin-left:24px` 是为
 *    单列设计的）。列宽已经把「两侧 24px 留白 + 中间 16px 间距」扣掉了，分组再带
 *    24px 会变成双重缩进，右列还会被挤出内容列。用 `.group-col{margin:0 24px→0}` 覆盖。
 * 2. **两列容器用 `align-items: flex-start`**。Vapor 里 flex 默认 `stretch`，两列会被
 *    拉成等高，矮的那列底部露出分组背景色的空白条。
 */
export function useQtTwoColumn() {
  const layout = useQtLayout();

  /** 两列可用宽度：内容列宽 − 两侧 24px 留白 − 中间 16px 间距 */
  const innerColumnPx = computed((): number => qtContentWidth("flow") - QT_GUTTER_PX * 2 - 16);

  /**
   * 能否两列：每个最小列宽仍要 ≥ `QT_MIN_COLUMN_WIDTH.group`（420）。
   * 900~1279 这一档内容列本身只有 900 左右，对半切开每列 420 上下，
   * 「标题 + 行尾值 + 箭头」就开始换行，比单列更差 —— 宽度判据自然把它排除。
   */
  const twoColumn = computed((): boolean => innerColumnPx.value >= QT_MIN_COLUMN_WIDTH.group * 2);

  /**
   * 两列时每列的宽度。内容列宽 − 两侧 24px 留白 − 中间 16px 间距，再对半分。
   * 下限 320px 兜底：防止 rail 宽度或 gutter 调整后算出负数。
   */
  const columnWidthPx = computed((): number => {
    const w = Math.floor(innerColumnPx.value / 2);
    return w > 320 ? w : 320;
  });

  /**
   * 直接绑到两个 `<view class="col">` 上。
   *
   * `flex-shrink:0` 必须写：两列宽度是上面算好的确定值，合计正好等于内容列宽。
   * 但 flex 默认 `flex-shrink:1`，一旦某个列的内联内容（行尾值、长标题）撑出
   * min-content，两列就按比例收缩 —— 结果是「内容窄的那列被压扁、内容宽的那列
   * 反而更宽」，两列宽度肉眼可见地不等（实测 1280dp 下 481dp 的两列渲染成
   * 554px 与 905px）。禁掉收缩后两列严格相等。
   */
  const colStyle = computed((): string => "width:" + columnWidthPx.value + "px;flex-shrink:0;");

  /** 两列容器：横向排列 + 顶端对齐 + 左右留白（列自身不再带外边距） */
  const colsStyle = computed((): string => "padding-left:" + QT_GUTTER_PX + "px;padding-right:" + QT_GUTTER_PX + "px;");

  return { layout, twoColumn, columnWidthPx, colStyle, colsStyle };
}
