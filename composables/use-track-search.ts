/**
 * 列表内搜索（歌单详情 / 歌手详情 / 每日推荐 / 榜单详情共用一个口子）。
 *
 * 口径照抄 PC 侧 `qt-pc/src/lib/track-selection.ts:53` 的 `filterTracks`：
 * - 关键词按**空白切成多个词**，全部命中才算匹配（多词 AND），不是把整串当一个词；
 * - 只查 标题 / 歌手 / 专辑 三个字段，大小写不敏感；
 * - 空关键词原样返回原列表（调用方拿到的引用不变，computed 不会白算一遍）。
 *
 * 为什么不用正则：本仓 UTS 侧没有 `.split(/regex/)` 的任何用例（见 `services/artist-id.ts:35`
 * 用的是 `split(" ")`），正则字面量在 UTS 编译链上容易踩坑，所以用 `split(" ")` +
 * 逐词 trim 过滤空串。
 *
 * 注意：过滤**不改变**批量选择态里的键。页面要在 `visible` 变化时自己剪掉
 * 已经看不见的勾选（`useBatchSelect` 的 `toggleAll` 头注释同一件事），
 * 否则「全选」与批量操作会作用到筛掉的行上。
 */
import { computed, ref } from "vue";
import type { Song } from "@/types/music";

/**
 * 多词 AND 过滤。`query` 全是空白时返回原列表。
 */
export function qtFilterSongs(list: Song[], query: string): Song[] {
  const terms = query.trim().toLowerCase().split(" ");
  const words: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i].trim();
    if (term.length > 0) words.push(term);
  }
  if (words.length == 0) return list;
  const out: Song[] = [];
  for (let i = 0; i < list.length; i++) {
    const song = list[i];
    const text = (song.name + "\n" + song.singer + "\n" + song.album).toLowerCase();
    let hit = true;
    for (let j = 0; j < words.length; j++) {
      if (text.indexOf(words[j]) < 0) {
        hit = false;
        break;
      }
    }
    if (hit) out.push(song);
  }
  return out;
}

/**
 * 页面级的列表内搜索状态。
 *
 * `list` 传取值函数（`() => tracks.value`）而不是数组本身：computed 要能跟着
 * 列表刷新（换音源 / 翻页 / 本地歌单增删）重新算，传快照就只算一次。
 */
export function useTrackSearch(list: () => Song[]) {
  /** 输入框里的原始文本 */
  const query = ref("");
  /** 过滤后的可见列表；没有关键词时就是原列表 */
  const visible = computed((): Song[] => qtFilterSongs(list(), query.value));
  /** 是否处于过滤态（只认非空白关键词，输入一串空格不算） */
  const filtering = computed((): boolean => query.value.trim().length > 0);

  function onInput(e: InputEvent): void {
    query.value = String((e.detail as any).value ?? "");
  }

  function clear(): void {
    query.value = "";
  }

  return { query, visible, filtering, onInput, clear };
}
