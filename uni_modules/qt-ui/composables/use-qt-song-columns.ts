/**
 * 歌曲长列表的「两列列切分」宽度契约（宽屏密度改造）。
 *
 * 为什么需要：桌面端真正富余的是**高度**不是宽度。手机竖屏约 667px 高、单列一屏放
 * 8 首；1080p 桌面约 1000px 高、单列一屏 13 首 —— 只多了 55%，而改造前每行宽达
 * 1312px，横向空间全变成留白（一行只放一条内容）。改成「一个 list-item 承载两首歌」
 * 后同样的视口一屏放 26 首，且 list-item 实例数减半，虚拟滚动压力同步减半。
 *
 * 三条硬约束（改动前必读）：
 * 1. **不允许两个独立 scroll-view 并排**。那样要手动同步滚动位置、虚拟滚动全部失效、
 *    还会出现两条滚动条。正确做法是「一行两首」，滚动容器只有一个。
 * 2. **每个 list-item 的子节点数必须恒定**。uni-app x 的 list-item 复用池是按条目
 *    结构分池的，结构漂移会让复用到错误模板。所以两张卡片位永远渲染两个容器，
 *    缺数据的那格宽度仍占满（行宽不会塌陷）。
 * 3. **行高由 list-item 决定，禁止 min-height**。list-view 的虚拟滚动靠行高预估总高，
 *    用 min-height 会抖动（见 pages/download/index.uvue 的注释）。
 *
 * 本文件只算**宽度**，不负责切分数据：每个页面的条目类型不同（Song / LocalAudioItem），
 * 在页面里各自写 8 行 pairs computed 比在 UTS 组件边界上传泛型 + 回调更稳。
 */
import { computed } from "vue";
import { useQtLayout } from "./use-qt-layout";
import { qtContentWidth, qtCanTwoColumn, QT_MIN_COLUMN_WIDTH } from "./use-qt-widths";

/** 两列之间的水平间距（px） */
export const QT_PAIR_GAP_PX = 16;

/**
 * 一个 list-item 的宽度策略。
 *
 * @param pagePadPx 页面根容器自身的左右 padding（px），必须与实际样式一致，
 *                  否则算出来的 cell 宽会和真实可用宽度差几个像素
 * @param kind      内容宽度档位，与 qt-page-frame 的 width-kind 保持一致
 */
export function useQtSongColumns(pagePadPx: number = 26, kind: string = "list") {
  const layout = useQtLayout();

  /** 内容列内部可用宽度：内容列宽 - 页面左右 padding */
  const innerWidth = computed((): number => {
    const w = qtContentWidth(kind) - pagePadPx * 2;
    return w > 0 ? w : 0;
  });

  /** 是否两列：按最小歌曲行宽判定，不按 sizeClass 判定（1000px 宽也够就开） */
  const twoColumn = computed((): boolean => qtCanTwoColumn("song", innerWidth.value, QT_PAIR_GAP_PX));

  /** 单格宽度（px） */
  const cellWidth = computed((): number => {
    if (!twoColumn.value) return innerWidth.value;
    const w = Math.floor((innerWidth.value - QT_PAIR_GAP_PX) / 2);
    return w > 0 ? w : 0;
  });

  /**
   * 单格内联样式：两列时定宽，单列时留空（单列走原布局的 flex:1）。
   * `flex-shrink:0` 必须写：格子宽度是算好的确定值，合计正好等于内层宽度；
   * flex 默认 `flex-shrink:1` 会让歌名/歌手更长的那一侧抢走宽度，同排两格不等宽。
   */
  const cellStyle = computed((): string =>
    twoColumn.value ? "width:" + cellWidth.value + "px;flex-shrink:0;" : ""
  );

  /** 右格内联样式：多一个左间距（间距不写 CSS margin 是为了与 cellWidth 同源） */
  const rightCellStyle = computed((): string =>
    twoColumn.value ? "width:" + cellWidth.value + "px;flex-shrink:0;margin-left:" + QT_PAIR_GAP_PX + "px;" : ""
  );

  return { layout, innerWidth, twoColumn, cellWidth, cellStyle, rightCellStyle, QT_MIN_COLUMN_WIDTH };
}

/** 歌曲的稳定唯一键（platform + id），与各页面 rowKey 的口径一致 */
export function qtSongKey(song: { platform: string; id: string }): string {
  return song.platform + ":" + song.id;
}

/**
 * 把歌曲数组切成「每行两首」的行数组。
 *
 * 单列时每行的 right 用 left 兜底、hasRight=false —— 模板里对可空类型做判断在 UTS
 * 模板层不稳，用「永远有值 + 一个布尔位」最省心。
 *
 * @param src        已过滤/排序好的歌曲数组
 * @param twoColumn  是否两列（来自 useQtSongColumns）
 */
export function qtSongPairs<T extends { platform: string; id: string }>(
  src: T[],
  twoColumn: boolean,
): Array<{ key: string; left: T; right: T; hasRight: boolean }> {
  const out: Array<{ key: string; left: T; right: T; hasRight: boolean }> = [];
  if (!twoColumn) {
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      out.push({ key: qtSongKey(s), left: s, right: s, hasRight: false });
    }
    return out;
  }
  let i = 0;
  while (i < src.length) {
    const left = src[i];
    const has = i + 1 < src.length;
    const right = has ? src[i + 1] : left;
    out.push({ key: qtSongKey(left), left: left, right: right, hasRight: has });
    i += 2;
  }
  return out;
}
