/**
 * 列表批量选择状态（QT UI 库）。
 *
 * 只做「哪些行被勾上」这一件事，**不认识歌曲业务**：调用方自己决定键怎么算
 * （歌用 `platform:id`，本地文件用文件 id），也自己决定勾上之后干什么。
 * 抽出来的理由与 PC 侧 `qt-pc/src/components/discovery/BatchBar.tsx` 一致：
 * 歌单详情 / 每日新歌 / 榜单详情各写一份「进入选择态 + 全选 + 勾选 + 退出」
 * 必然漂移（一处按 id 判重、一处按下标，一处退出忘了清空），所以只留一份。
 *
 * 两条容易踩的约定：
 * - `exit()` **必须清空**勾选集。只把 `selecting` 置 false 的话，下次进入选择态
 *   上次勾的行会原地复活，用户会以为列表记住了他的选择。
 * - 勾选集是**键数组**而不是 Map/对象：判断勾选在模板里每行都要跑一次，
 *   几十到几百条量级下 `indexOf` 足够快，且顺序稳定（全选的顺序 = 传入顺序）。
 */
import { computed, ref } from "vue";
import type { Song } from "@/types/music";

/**
 * 歌曲在列表里的唯一键。
 *
 * 必须带 platform：不同音源各自有独立的 id 空间，同一串 id 在两处完全可能
 * 是两首不相干的歌（本地文件与在线歌曲更是如此），只按 id 判重会串选。
 * 与 `pages/playlist/index.uvue` 的 `list-item :key` 同口径。
 */
export function qtSongKey(song: Song): string {
  return song.platform + ":" + song.id;
}

export function useBatchSelect() {
  /** 是否处于批量选择态：false 时列表行点击走原有的播放/打开行为 */
  const selecting = ref(false);
  /** 已勾选行的键 */
  const keys = ref<string[]>([]);

  const count = computed((): number => keys.value.length);

  function enter(): void {
    selecting.value = true;
  }

  /** 退出选择态并清空勾选（见文件头：残留的键会在下次进入时复活） */
  function exit(): void {
    selecting.value = false;
    keys.value = [];
  }

  function isSelected(key: string): boolean {
    return keys.value.indexOf(key) >= 0;
  }

  function toggle(key: string): void {
    const index = keys.value.indexOf(key);
    if (index >= 0) {
      keys.value.splice(index, 1);
      return;
    }
    keys.value.push(key);
  }

  function clear(): void {
    keys.value = [];
  }

  /**
   * 全选 / 取消全选。以传入的全量键为准 —— 页面有筛选时传**可见集合**，
   * 不要传原始列表，否则「全选」会把筛掉的行也勾上。
   */
  function toggleAll(allKeys: string[]): void {
    if (allSelected(allKeys)) {
      keys.value = [];
      return;
    }
    keys.value = allKeys.slice();
  }

  function allSelected(allKeys: string[]): boolean {
    return allKeys.length > 0 && keys.value.length == allKeys.length;
  }

  return {
    selecting,
    keys,
    count,
    enter,
    exit,
    clear,
    isSelected,
    toggle,
    toggleAll,
    allSelected,
  };
}