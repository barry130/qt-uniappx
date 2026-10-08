export type Song = {
  id: string;
  name: string;
  singer: string;
  album: string;
  picUrl: string;
  platform: string;
  url?: string;
  /** 播放地址获取时间戳（毫秒），用于判断 url 是否过期（不持久化，重启后视为过期重新获取） */
  urlFetchedAt?: number;
  /** 喜欢列表变更序号（服务器 updated_seq），用于多端同步冲突比较（last-write-wins） */
  likeSeq?: number;
  duration?: number;
  musicId?: string;
  /**
   * 这首歌被收藏进了哪些歌单（存那些歌单的 pid）。
   *
   * 一首歌可以同时属于多个歌单，所以是数组而不是单值：
   * 加入歌单 A 就推一次 add 带 A.pid，再加入 B 再推一次带 B.pid，各推各的；
   * 从 A 移除时推 remove 带 A.pid，只删 A 这一条，B 里的记录不受影响。
   *
   * 歌单展示时用 `pids.includes(歌单.pid)` 过滤，只显示属于自己的那部分，
   * 因此不同歌单之间不会串歌。
   */
  pids?: string[];
};
export type Playlist = {
  id: string;
  name: string;
  picUrl: string;
  playCount: string;
  platform: string;
  description: string | null;
  tracks?: Song[];
  /** 喜欢歌单变更序号（服务器 updated_seq），用于多端同步冲突比较（last-write-wins） */
  likeSeq?: number;
  /**
   * 歌单的全局唯一 pid。本地新建歌单时即生成（UUID v4 形态，≤64），
   * 作为收藏歌曲时上送的归属标识，也是多端同步时识别歌单的依据。
   * 注意：与 id 不同 —— id 是各平台自己的歌单号，pid 是本端生成的全局唯一键。
   */
  pid?: string;
};

/** 收藏变更记录（LIKE_SYNC_DESIGN.md §2.3：/app/user/like/changes 返回的 change） */
export type LikeChange = {
  type: "song" | "playlist";
  id: string;
  platform: string;
  name: string;
  singer: string;
  album: string;
  hash: string;
  picUrl: string;
  deleted: boolean;
  updatedSeq: number;
  /**
   * 这条变更对应的 pid（后端 /like/changes 的 pid 字段，可空）。
   * - song 类型：这首歌所属歌单的 pid
   * - playlist 类型：该歌单自己的 pid（歌单主键）
   * 注意 id 可能是后端自增主键，不要拿 id 当 pid 用。
   */
  pid?: string;
};

/** 收藏推送操作队列条目（LIKE_SYNC_DESIGN.md §5.4） */
export type PendingLikeOp = {
  type: "song" | "playlist";
  action: "add" | "remove";
  /** song 用 Song、playlist 用 Playlist（序列化为 JSON 字符串暂存） */
  dataJson: string;
};
/**
 * 逐字歌词里的一个词（音源包 `wordByWord` 解析产物，卡拉 OK 染色用）。
 *
 * 时间单位一律**毫秒**，且与 qt-pc 的 LyricWord（F:\qtMusic\qt-pc\src\lib\lrc.ts:4）同义：
 * `startMs` 是**相对行首**的起点，不是曲目的绝对时间 —— 染色时要用
 * 「当前行已过去的时间」跟它比，不要拿 player.progress（秒）直接比。
 * 命名带 Ms 后缀就是为了跟 LyricLine.time（**秒**）区分开，别混用。
 *
 * 音源包给的词时间轴本身有「行内绝对」与「相对行首」两种口径，解析出口
 * （lrc.uts 的 normalizeWordTimeline）已统一折算成本契约的相对行首，上层不判源。
 */
export type LyricWord = {
  /** 相对行首的起点，毫秒 */
  startMs: number;
  /** 时长，毫秒 */
  durationMs: number;
  /** 词文本（可能含尾部空格，音源包按原样保留） */
  text: string;
};
export type LyricLine = {
  /** 行起点，**秒**（parseLrc 里 min*60+sec+frac 的产物） */
  time: number;
  text: string;
  translation?: string;
  /** 罗马音（按时间戳就近合并进来的第二行副文本，中文歌恒为空串） */
  romanization?: string;
  /** 逐字（有则当前行按词从左到右染色的卡拉 OK 效果；没有走整行高亮） */
  words?: LyricWord[];
};
export type Artist = {
  id: string;
  name: string;
  picUrl: string;
  platform: string;
};
export type Album = {
  id: string;
  name: string;
  artist: string;
  picUrl: string;
  platform: string;
  publishTime?: number;
};
