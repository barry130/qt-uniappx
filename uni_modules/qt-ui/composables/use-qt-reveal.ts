/**
 * 骨架屏 ↔ 真实内容的错峰浮现（淡入 / 淡出）。
 *
 * ── 为什么用 CSS transition 而不是 UniElement.animate() ──────────────────────
 * 进场动画需要「延迟期间元素保持透明」。animate() 的延迟靠 options.delay，
 * 但延迟期间要停在第一帧就必须用 fill:"backwards"，而 IUniElement.d.ts:3022 的
 * UniAnimationOptionFill 里 "backwards" 在 android / ios 上都是 unixVer "x"
 * （App 端未支持，harmony 整段没有声明）。fill:"forwards" 只解决收尾不解决起手，
 * 同样会让元素在 delay 期间以 opacity:1 提前露脸。
 *
 * 改用「CSS 基准 opacity:0 + transition:opacity」：元素从挂载起就是透明的，
 * 到点后把 opacity 改成 1，由 transition 补间。transition 在本仓库已有真机
 * 先例（qt-loading.uvue:43 的 `transition:opacity 0.3s ease;`），且
 * transition.md 标注 HarmonyOS 4.61 起支持，是这条链路上证据最硬的一环。
 *
 * 错峰 60ms 由 JS 定时器给出：每一块的延迟都写进 setTimeout 的时刻，
 * 而不是写进 CSS —— transition-delay 在仓库里使用数为 0，且在
 * app-harmony 的 uni-app-x-vapor-runtime 类型树里查不到任何声明。
 *
 * ── 为什么骨架和内容用同一个 index ──────────────────────────────────────────
 * 同一个 index 下，第 i 块的骨架淡出与第 i 块的内容淡入同时开始，透明度互补，
 * 叠加后不会出现「两边都半透明」的中间灰。前提是两者形状一致、并且骨架层用
 * 绝对定位盖在内容层上，否则两份内容同时占位会把页面撑高。
 */

import { ref, nextTick, onUnmounted, type Ref } from "vue";

/** 单块淡入 / 淡出时长（毫秒） */
export const QT_REVEAL_DURATION_MS = 320;
/**
 * 淡入淡出的 transition 声明，字面量写死。
 * 不拼 QT_REVEAL_DURATION_MS：仓库里两条 transition 先例（qt-loading.uvue:43、
 * pages/download/index.uvue:222）用的都是 `0.3s` 这种秒制字面量，`320ms` 没有先例；
 * 而把 320 换算成 "0.32" 又要依赖 UTS 的浮点字符串化行为，同样没有先例。
 */
const QT_REVEAL_TRANSITION = "opacity 0.32s ease-out";
/** 相邻两块的错峰间隔（毫秒） */
export const QT_REVEAL_STEP_MS = 60;
/** 首块起跑前多等一帧，确保 opacity:0 已经被渲染，否则 transition 没有起点 */
const QT_REVEAL_LEAD_MS = 32;
/** 「全部可见」的哨兵值。不用 Number.MAX_SAFE_INTEGER：UTS 的数值语义与 JS 不完全一致 */
const QT_REVEAL_ALL = 999999;

export type QtRevealHandle = {
  /** 已经浮现的块数；等于 QT_REVEAL_ALL 表示全部可见 */
  revealedCount: Ref<number>;
  /** 是否正在错峰浮现 */
  revealing: Ref<boolean>;
  /** 开始错峰浮现：第 i 块在 i * 60ms 后变为可见；全部结束后回调 onDone */
  startReveal: (count: number, onDone?: () => void) => void;
  /** 取消未触发的定时器，并把所有块直接置为可见 */
  finishReveal: () => void;
  /** 回到初始状态（全部透明），用于下一次加载 */
  resetReveal: () => void;
  /** 真实内容第 index 块的 opacity 样式（未浮现时透明） */
  itemStyle: (index: number, extra?: string) => string;
  /** 骨架第 index 块的 opacity 样式（浮现后透明，与 itemStyle 互补） */
  skeletonStyle: (index: number, extra?: string) => string;
};

function opacityStyle(visible: boolean, extra?: string): string {
  const base = "opacity:" + (visible ? "1" : "0") + ";transition:" + QT_REVEAL_TRANSITION + ";";
  return extra != null && extra.length > 0 ? base + extra : base;
}

/**
 * 按「这块现在该不该可见」直接拼透明度样式。
 *
 * 给不持有 QtRevealHandle 的组件用：骨架组件只需要一个 revealed 计数，
 * 不该为此在组件内部再建一份定时器。transition 字面量仍然只有这里一份。
 */
export function qtRevealFadeStyle(visible: boolean, extra?: string): string {
  return opacityStyle(visible, extra);
}

export function useQtReveal(): QtRevealHandle {
  // 默认全部可见：没调用 startReveal 的页面行为与改造前完全一致
  const revealedCount = ref<number>(QT_REVEAL_ALL);
  const revealing = ref<boolean>(false);
  let timers: number[] = [];

  function clearTimers(): void {
    for (let i = 0; i < timers.length; i++) {
      clearTimeout(timers[i]);
    }
    timers = [];
  }

  function startReveal(count: number, onDone?: () => void): void {
    clearTimers();
    if (count <= 0) {
      revealedCount.value = QT_REVEAL_ALL;
      revealing.value = false;
      if (onDone != null) onDone!();
      return;
    }
    revealedCount.value = 0;
    revealing.value = true;
    // 等一帧再排定时器：先把 opacity:0 渲染出来，transition 才有起点可补
    nextTick(() => {
      for (let i = 0; i < count; i++) {
        const at = QT_REVEAL_LEAD_MS + i * QT_REVEAL_STEP_MS;
        const isLast = i == count - 1;
        timers.push(
          setTimeout(() => {
            // 最后一拍直接置哨兵而不是 count：触底加载追加的条目索引 >= count，
            // 若停在 count 它们会永远停在 opacity:0
            revealedCount.value = isLast ? QT_REVEAL_ALL : i + 1;
            if (isLast) {
              // 收尾要再等一个淡出时长才能算「结束」。最后一行的骨架正是这一拍
              // 才开始淡出，若此刻就把 revealing 置 false，调用方（骨架层 v-if）
              // 会立刻卸载整层，收尾那一下变成硬切 —— 前面所有行的淡出也一起被砍断。
              timers.push(
                setTimeout(() => {
                  revealing.value = false;
                  if (onDone != null) onDone!();
                }, QT_REVEAL_DURATION_MS) as number
              );
            }
          }, at) as number
        );
      }
    });
  }

  function finishReveal(): void {
    clearTimers();
    revealedCount.value = QT_REVEAL_ALL;
    revealing.value = false;
  }

  function resetReveal(): void {
    clearTimers();
    revealedCount.value = 0;
    revealing.value = false;
  }

  function itemStyle(index: number, extra?: string): string {
    return opacityStyle(index < revealedCount.value, extra);
  }

  function skeletonStyle(index: number, extra?: string): string {
    return opacityStyle(index >= revealedCount.value, extra);
  }

  onUnmounted(() => {
    clearTimers();
  });

  return {
    revealedCount,
    revealing,
    startReveal,
    finishReveal,
    resetReveal,
    itemStyle,
    skeletonStyle,
  };
}
