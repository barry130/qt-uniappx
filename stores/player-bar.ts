import { reactive } from "vue";

const PLAYER_BAR_VISIBLE_KEY = "qt-player-bar-visible";

/**
 * 硬上限：进度条上方那一行最多同时展示 5 个工具按钮（用户要求「可以限制死」）。
 *
 * **与 qt-pc 的 10 不是笔误，别对齐**：PC 是鼠标操作、按钮行有整行宽度；手机进度条
 * 上方那一行要给歌词让位，5 个按钮（约 5×40px + 间距 ≈ 240px）才不挤。改大之前先在
 * 紧凑屏（≤360dp）上数一遍宽度。
 */
export const PLAYER_BAR_MAX_VISIBLE = 5;

/**
 * 播放页工具按钮开关（进度条上方那一行；横屏是控制行右侧那一组）。
 *
 * 与 qt-pc 的 `playerBar.visibleButtons` 同口径：存**展示哪些**（可见 id 白名单）、
 * 有名额上限、名额满了拒绝开启。旧键 `qt-player-bar-hidden`（存被关掉的 id）作废：
 * 新口径下「默认只开六个」只能用白名单表达，用黑名单会在新增按钮时错位。
 *
 * 新增按钮不在白名单里 = 默认不展示；用户开了才写进去。
 */
export interface PlayerBarToolMeta {
  id: string;
  label: string;
  hint: string;
  /** 设置页那一行的图标名（必须在 uni_modules/qt-ui/services/icons.ts 里已定义） */
  icon: string;
  /** 仅 qt_admin 可见（播放页模板里另有一道 showPlayUrlEntry 门） */
  adminOnly: boolean;
}

/** 顺序 = 设置页顺序 = 播放页从左到右的渲染顺序 */
export const PLAYER_BAR_TOOLS: PlayerBarToolMeta[] = [
  { id: "like", label: "收藏", hint: "收藏 / 取消收藏当前歌曲", icon: "heart", adminOnly: false },
  { id: "download", label: "下载", hint: "下载当前歌曲", icon: "download", adminOnly: false },
  { id: "artist", label: "歌手", hint: "打开当前歌曲的歌手页", icon: "user", adminOnly: false },
  { id: "quality", label: "音质", hint: "切换当前歌曲音质", icon: "music", adminOnly: false },
  { id: "dislike", label: "屏蔽", hint: "屏蔽当前歌曲 / 歌手", icon: "ban", adminOnly: false },
  { id: "speed", label: "倍速", hint: "循环切换播放倍速", icon: "gauge", adminOnly: false },
  { id: "sleep", label: "定时关闭", hint: "定时停止播放（开启时按钮显示剩余时间）", icon: "clock", adminOnly: false },
  { id: "share", label: "分享", hint: "生成当前歌曲的分享卡片", icon: "share", adminOnly: false },
  { id: "equalizer", label: "均衡器", hint: "打开均衡器页面", icon: "sliders", adminOnly: false },
  { id: "source", label: "换源", hint: "在其他音源里找这首歌并切换", icon: "refresh", adminOnly: false },
  { id: "playUrl", label: "播放链接", hint: "仅管理员：查看 / 复制当前播放地址", icon: "copy", adminOnly: true },
];

/** 首次运行（存储里没有这个键）时的默认展示集：与原行为一致 */
const DEFAULT_VISIBLE: string[] = ["like", "download", "artist", "quality", "playUrl"];

export function playerBarTool(id: string): PlayerBarToolMeta | null {
  for (let i = 0; i < PLAYER_BAR_TOOLS.length; i++) {
    if (PLAYER_BAR_TOOLS[i].id == id) return PLAYER_BAR_TOOLS[i];
  }
  return null;
}

/**
 * 名额口径（全端唯一定义，别再各处手写一遍）：
 * 某个 id 在当前身份下**是否真的会渲染**，也就是是否消耗名额。
 * 非管理员的 adminOnly 项（播放链接）不渲染、不占名额。
 */
export function playerBarCounted(id: string, isAdmin: boolean): boolean {
  const meta = playerBarTool(id);
  if (meta != null && meta.adminOnly && !isAdmin) return false;
  return true;
}

/**
 * 清洗一份已解析的白名单：只留认得且不重复的 id，并按上限截断（多出来的丢弃）。
 *
 * counted 判断某个 id 当前**是否真的会渲染**（非管理员的 adminOnly 项不渲染）。
 * 名额只由「会渲染的项」消耗，不渲染的项既不占名额、也绝不能被名额截断丢掉 ——
 * 否则会出现：非管理员开第 5 个按钮 → 存盘 6 条（5 个能渲染 + 不渲染的 playUrl）
 * → 下次 restore 按前 5 条截断，刚好把刚开的那个（追加在末尾）吃掉，表现为
 * 「设置了但返回又没设置」。
 */
export function sanitizeVisibleTools(ids: string[], counted?: (id: string) => boolean): string[] {
  const out: string[] = [];
  if (ids == null) return out;
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id == null || id.length == 0) continue;
    if (playerBarTool(id) == null) continue;
    if (out.indexOf(id) >= 0) continue;
    const isCounted = counted == null ? true : counted(id);
    if (isCounted) {
      // 用 continue 而不是 break：超额的会渲染项跳过就好，
      // 后面不占名额的项仍要保留
      if (n >= PLAYER_BAR_MAX_VISIBLE) continue;
      n++;
    }
    out.push(id);
  }
  return out;
}

class PlayerBarStore {
  visible: string[] = DEFAULT_VISIBLE.slice();

  /**
   * 从存储恢复。三种情况分得很清：
   *  · 没写过 / 读不到 → 默认集（旧用户升级进来看到的是原来那几个）；
   *  · 写过合法的 JSON 数组（含空数组 = 用户全关了）→ 照用，空就是空；
   *  · 脏数据（解析失败）→ 退回默认集，播放页不该因为存储坏了少一排按钮。
   *
   * counted 与 toggle 同口径（判断某项当前是否真的会渲染）；不传则按「都算」处理。
   */
  restore(counted?: (id: string) => boolean): void {
    try {
      const raw = uni.getStorageSync(PLAYER_BAR_VISIBLE_KEY) as string;
      if (raw == null || raw.length == 0) {
        this.visible = DEFAULT_VISIBLE.slice();
        return;
      }
      const parsed = JSON.parse(raw) as string[];
      if (parsed == null) {
        this.visible = [];
        return;
      }
      this.visible = sanitizeVisibleTools(parsed, counted);
    } catch (_) {
      this.visible = DEFAULT_VISIBLE.slice();
    }
  }

  isVisible(id: string): boolean {
    return this.visible.indexOf(id) >= 0;
  }

  /** 已展示数量；counted 用来把当前不可能出现的项排除（如非管理员的播放链接） */
  countVisible(counted: (id: string) => boolean): number {
    let n = 0;
    for (let i = 0; i < this.visible.length; i++) {
      if (counted(this.visible[i])) n++;
    }
    return n;
  }

  /**
   * 切换某项展示。返回 false 只代表**名额已满**（调用方负责提示用户先关一个）；
   * 关掉永远成功。
   */
  toggle(id: string, counted: (id: string) => boolean): boolean {
    if (playerBarTool(id) == null) return false;
    const next: string[] = [];
    let removed = false;
    for (let i = 0; i < this.visible.length; i++) {
      if (this.visible[i] == id) {
        removed = true;
        continue;
      }
      next.push(this.visible[i]);
    }
    if (!removed) {
      if (this.countVisible(counted) >= PLAYER_BAR_MAX_VISIBLE) return false;
      next.push(id);
    }
    this.visible = next;
    this.save();
    return true;
  }

  private save(): void {
    try {
      uni.setStorageSync(PLAYER_BAR_VISIBLE_KEY, JSON.stringify(this.visible));
    } catch (_) {}
  }

  /** 回到首次运行的默认展示集（设置页「恢复默认展示」用），并落盘 */
  reset(): void {
    this.visible = DEFAULT_VISIBLE.slice();
    this.save();
  }
}

const playerBarStore = reactive(new PlayerBarStore()) as PlayerBarStore;

export function usePlayerBarStore(): PlayerBarStore {
  return playerBarStore;
}
