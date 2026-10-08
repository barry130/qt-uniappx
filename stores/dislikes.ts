/**
 * 不喜欢列表（qt-uniappx 端）
 *
 * 与 qt-pc 的 Rust 实现（src-tauri/src/db/store/dislikes.rs）同语义：
 * - 按「归一化歌名 + 归一化歌手」匹配，绝不按曲目 id —— id 是各平台私有的，
 *   跨源换歌后 platform/id 都会变，只有名字跟得住；
 * - 屏蔽语义 = 「别自动出现」，不是「禁止聆听」：用户点播的那首永远保留，
 *   判定失败/无规则时一律返回 false（宁可漏屏蔽，不能搞坏自动切歌）；
 * - 歌名先剥括号附注再归一化（`稻香 (Live)` 与 `稻香` 互相命中）；
 *   歌手串按分隔符拆词，多歌手之一命中即屏蔽。
 *
 * 本端没有 SQLite（qt-pc 的规则表在 Rust 侧），归一化算法是 Rust 版的
 * UTS 移植，两端语义由 `stores/dislike-match.ts` + `tools/dislike-parity.json`
 * 这张跨端向量表守住（`npm run check:dislike` 与对端 cargo test 读同一份文件）。
 */
import { reactive } from "vue";
import type { Song } from "@/types/music";
import {
  normalizeKey,
  singerTokensOf,
  songNameKeyOf,
  splitSingers,
  tokensIntersect,
} from "@/stores/dislike-match";

const DISLIKES_KEY = "qt-dislikes";

/**
 * 规则变化事件：player 监听后无损重推原生时间线（syncTimeline），
 * 让新增屏蔽立即对 media3 自动衔接生效——自动衔接走的是时间线，
 * 只改 JS 侧队列的话原生层还会把屏蔽的歌带回来。
 */
export const DISLIKES_CHANGED_EVENT = "qt-dislikes-changed";

export type DislikeKind = "song" | "singer";
export type DislikeRule = {
  id: number;
  kind: DislikeKind;
  /** 归一化匹配键：小写、全角折半角、只留字母数字（song：剥附注后的歌名；singer：单个歌手词） */
  name: string;
  /** 回显原文（song：原始歌名；singer：原始歌手词） */
  nameRaw: string;
  /** song：完整歌手串的归一化（空 = 忽略歌手、同名全屏）；singer：恒为空 */
  singer: string;
  /** song：原始歌手串；singer：恒为空 */
  singerRaw: string;
  createdAt: number;
};

class DislikesStore {
  rules: DislikeRule[] = [];
  private nextId = 1;

  restore(): void {
    try {
      const raw = uni.getStorageSync(DISLIKES_KEY) as string;
      if (raw == null || raw.length == 0) return;
      const arr = JSON.parse(raw) as DislikeRule[];
      const rules: DislikeRule[] = [];
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i];
        if (r == null || (r.kind != "song" && r.kind != "singer")) continue;
        if (r.name == null || r.name.length == 0) continue;
        // id 顺序重排即可：只在本设备的管理页里用，不跨端不落库对齐
        rules.push({
          id: rules.length + 1,
          kind: r.kind,
          name: r.name,
          nameRaw: r.nameRaw != null && r.nameRaw.length > 0 ? r.nameRaw : r.name,
          singer: r.singer != null ? r.singer : "",
          singerRaw: r.singerRaw != null ? r.singerRaw : "",
          createdAt: r.createdAt != null ? r.createdAt : 0,
        });
      }
      this.rules = rules;
      this.nextId = rules.length + 1;
    } catch (_) {
      this.rules = [];
      this.nextId = 1;
    }
  }

  private save(): void {
    try {
      uni.setStorageSync(DISLIKES_KEY, JSON.stringify(this.rules));
    } catch (_) {}
  }

  private emitChanged(): void {
    uni.$emit(DISLIKES_CHANGED_EVENT);
  }

  /** 清空内存态（存储键由调用方删除，见设置页「清除全部数据」） */
  reset(): void {
    this.rules = [];
    this.nextId = 1;
  }

  hasRules(): boolean {
    return this.rules.length > 0;
  }

  /** 这首歌是否命中任何规则（歌手规则也命中）。无规则/歌名空 → 尽量给 false */
  isDisliked(song: Song): boolean {
    if (this.rules.length == 0 || song == null) return false;
    const tokens = singerTokensOf(song.singer);
    const nameKey = songNameKeyOf(song.name);
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.kind == "singer") {
        if (tokens.indexOf(r.name) >= 0) return true;
        continue;
      }
      // 歌曲规则：名字必须相等；歌手为空 = 同名全屏，否则歌手词要有交集
      if (nameKey.length == 0 || r.name != nameKey) continue;
      if (r.singer.length == 0) return true;
      const ruleTokens = singerTokensOf(r.singerRaw);
      for (let j = 0; j < ruleTokens.length; j++) {
        if (tokens.indexOf(ruleTokens[j]) >= 0) return true;
      }
    }
    return false;
  }

  /** 是否存在针对这首歌的歌曲规则（行内「取消屏蔽」按钮的显隐依据，不含歌手规则） */
  hasSongRule(song: Song): boolean {
    const nameKey = songNameKeyOf(song.name);
    if (nameKey.length == 0) return false;
    const tokens = singerTokensOf(song.singer);
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.kind != "song" || r.name != nameKey) continue;
      if (r.singer.length == 0) return true;
      const ruleTokens = singerTokensOf(r.singerRaw);
      for (let j = 0; j < ruleTokens.length; j++) {
        if (tokens.indexOf(ruleTokens[j]) >= 0) return true;
      }
    }
    return false;
  }

  /** 是否存在针对该歌手串任一词的歌手规则 */
  hasSingerRule(singer: string): boolean {
    if (singer == null || singer.length == 0) return false;
    const tokens = singerTokensOf(singer);
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.kind == "singer" && tokens.indexOf(r.name) >= 0) return true;
    }
    return false;
  }

  /** 屏蔽这首歌（按屏蔽时的歌名+歌手记规则）。歌名归一化后为空 → 拒绝 */
  banSong(song: Song): boolean {
    const nameKey = songNameKeyOf(song.name);
    if (nameKey.length == 0) return false;
    const singer = normalizeKey(song.singer);
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.kind == "song" && r.name == nameKey && r.singer == singer) {
        return false; // 已屏蔽过：不重复建
      }
    }
    this.rules = [
      ...this.rules,
      {
        id: this.nextId++,
        kind: "song",
        name: nameKey,
        nameRaw: song.name,
        singer,
        singerRaw: song.singer != null ? song.singer : "",
        createdAt: Date.now(),
      },
    ];
    this.save();
    this.emitChanged();
    return true;
  }

  /** 取消屏蔽这首歌：删掉所有能命中它的歌曲规则。返回是否有删除 */
  unbanSong(song: Song): boolean {
    const nameKey = songNameKeyOf(song.name);
    if (nameKey.length == 0) return false;
    const tokens = singerTokensOf(song.singer);
    const kept: DislikeRule[] = [];
    let removed = false;
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.kind == "song" && r.name == nameKey) {
        const hit =
          r.singer.length == 0 ||
          tokensIntersect(singerTokensOf(r.singerRaw), tokens);
        if (hit) {
          removed = true;
          continue;
        }
      }
      kept.push(r);
    }
    if (removed) {
      this.rules = kept;
      this.save();
      this.emitChanged();
    }
    return removed;
  }

  /** 屏蔽该歌手（串里的每个词各建一条规则，与 PC 端 add_dislike_singer 同语义） */
  banSinger(singer: string): boolean {
    if (singer == null || singer.length == 0) return false;
    const parts = splitSingers(singer);
    const fresh: DislikeRule[] = [];
    for (let i = 0; i < parts.length; i++) {
      const key = normalizeKey(parts[i]);
      if (key.length == 0) continue;
      let exists = false;
      for (let j = 0; j < this.rules.length; j++) {
        const r = this.rules[j];
        if (r.kind == "singer" && r.name == key) {
          exists = true;
          break;
        }
      }
      if (exists) continue;
      fresh.push({
        id: this.nextId++,
        kind: "singer",
        name: key,
        nameRaw: parts[i],
        singer: "",
        singerRaw: "",
        createdAt: Date.now(),
      });
    }
    if (fresh.length == 0) return false;
    this.rules = [...this.rules, ...fresh];
    this.save();
    this.emitChanged();
    return true;
  }

  /** 取消屏蔽该歌手：删掉串内任一词对应的歌手规则 */
  unbanSinger(singer: string): boolean {
    if (singer == null || singer.length == 0) return false;
    const tokens = singerTokensOf(singer);
    const kept: DislikeRule[] = [];
    let removed = false;
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.kind == "singer" && tokens.indexOf(r.name) >= 0) {
        removed = true;
        continue;
      }
      kept.push(r);
    }
    if (removed) {
      this.rules = kept;
      this.save();
      this.emitChanged();
    }
    return removed;
  }

  /** 删除单条规则（管理页） */
  removeById(id: number): boolean {
    const kept: DislikeRule[] = [];
    let removed = false;
    for (let i = 0; i < this.rules.length; i++) {
      if (this.rules[i].id == id) {
        removed = true;
        continue;
      }
      kept.push(this.rules[i]);
    }
    if (removed) {
      this.rules = kept;
      this.save();
      this.emitChanged();
    }
    return removed;
  }

  clearAll(): void {
    if (this.rules.length == 0) return;
    this.rules = [];
    this.save();
    this.emitChanged();
  }

  /**
   * 过滤队列：剔除命中规则的歌，keep（用户点播的那首）永远保留。
   * 无规则时原样返回（不复制数组，避免无谓的响应式更新）。
   * 判定异常/空数据兜底为不过滤——宁可漏屏蔽，不能让播放列表打不开。
   */
  filterQueue(songs: Song[], keep: Song): Song[] {
    if (this.rules.length == 0) return songs;
    const out: Song[] = [];
    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      if (s == null) continue;
      if (s.id == keep.id && s.platform == keep.platform) {
        out.push(s);
        continue;
      }
      if (!this.isDisliked(s)) out.push(s);
    }
    return out;
  }
}

const dislikes = reactive(new DislikesStore()) as DislikesStore;

export function useDislikesStore(): DislikesStore {
  return dislikes;
}
