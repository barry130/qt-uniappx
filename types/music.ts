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
export type LyricLine = {
  time: number;
  text: string;
  translation?: string;
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
