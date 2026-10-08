/**
 * 「进页一次拉完」的全量取数（2026-10-07，与 qt-pc 的 src/lib/paged-all.ts 同口径）。
 *
 * 为什么搬出页面：
 * - 取数一旦跟着页面销毁一起取消，来回进同一个歌手页就要重头再拉一遍上千首；
 *   这里把任务挂在模块上，页面销毁只是退订，**任务继续跑到收尾**，下次进同一个
 *   key 直接拿到全量（体感：第二次进页是瞬时的）。
 * - 进度（`done`）与「是否收尾」（`finished`）由任务自己维护，结束一定置 finished，
 *   页面据此收掉进度条 —— 以前只看「还有下一页」，翻页失效时永远停不下来
 *   （用户看到的就是「条数不涨了，但一直在转」）。
 *
 * 只缓存到进程退出（不做持久化）：歌曲对象是活的、且带播放态引用，落盘没意义。
 *
 * UTS 约束：不写自定义泛型（函数/类型一律绑 Song），LRU 用「平行数组 + indexOf」
 * 而不是 Map —— 与 services/source-switch.ts 同招，避免两端容器键序差异。
 */
import type { Song } from "@/types/music";

/** 一页的返回：歌曲 + 附带信息（歌手头像只跟第 1 页回来，用 meta 带出来） */
export type PagedAllPage = {
  songs: Song[];
  meta: string;
  /**
   * 本页之后是否还有（数据包给的权威值；包没给时由调用方按「本页非空」兜底）。
   *
   * 2026-10-07：**不要**再用「本页条数 < 每页期望」推断到底 —— 歌手作品是按名字搜一批、
   * 再按歌手 id 过滤出来的**过滤型**列表，逐页条数天然不齐（实测 QQ 周杰伦
   * 100/90/96/93/77/70/61/52/37/23），拿页大小一比就会在真正到底之前收尾。
   */
  hasMore: boolean;
};

export type PagedAllState = {
  items: Song[];
  /** 首屏加载中（一页都没拿到时为 true） */
  loading: boolean;
  error: string;
  /** 已取完的页数 */
  done: number;
  /** 已知总页数；-1 = 上游不给总数（搜索类接口常态） */
  total: number;
  /** 是否收尾（正常到底 / 出错 / 触及上限）。为 false 就还在跑 */
  finished: boolean;
  /** 第 1 页带回来的附加信息（歌手头像） */
  meta: string;
};

export type PagedAllListener = (state: PagedAllState) => void;

export type PagedAllOptions = {
  fetchPage: (page: number) => Promise<PagedAllPage>;
  keyOf: (item: Song) => string;
  /** 每页条数：用它判断「满页 = 可能还有下一页」 */
  pageSize: number;
  /** 并发在飞请求数，默认 4（移动端比 PC 保守） */
  concurrency?: number;
  /** 页数上限（安全阀），默认 40 */
  maxPages?: number;
};

/** 缓存任务上限（LRU）：一个歌手全量可能上千首，移动端内存更紧 */
export const PAGED_ALL_JOB_CAP = 8;

function emptyState(): PagedAllState {
  const state: PagedAllState = {
    items: [],
    loading: true,
    error: "",
    done: 0,
    total: -1,
    finished: false,
    meta: "",
  };
  return state;
}

export class PagedAllJob {
  key: string = "";
  state: PagedAllState = emptyState();
  listeners: PagedAllListener[] = [];
  cancelled: boolean = false;
  /** 登记在缓存表里的任务：没人订阅也要跑完（一次性任务没人听就取消） */
  cached: boolean = false;

  snapshot(): PagedAllState {
    return this.state;
  }

  /** 订阅；回调立刻收到当前状态 */
  subscribe(fn: PagedAllListener): void {
    this.listeners.push(fn);
    fn(this.state);
  }

  unsubscribe(fn: PagedAllListener): void {
    const at = this.listeners.indexOf(fn);
    if (at >= 0) this.listeners.splice(at, 1);
    if (!this.cached && this.listeners.length == 0) this.cancelled = true;
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** 广播当前 state（订阅期间可能退订，先拷一份） */
  emit(): void {
    const copy = this.listeners.slice();
    for (let i = 0; i < copy.length; i++) {
      const fn = copy[i] as PagedAllListener;
      fn(this.state);
    }
  }
}

/** key → 任务（平行数组，顺序即 LRU 新旧） */
const jobKeys: string[] = [];
const jobValues: PagedAllJob[] = [];

/** 取（或新建）一个按 key 复用的任务：页面销毁后继续跑完，结果缓存到退出 */
export function startPagedAllJob(key: string, options: PagedAllOptions): PagedAllJob {
  const at = jobKeys.indexOf(key);
  if (at >= 0) {
    const hit = jobValues[at] as PagedAllJob;
    jobKeys.splice(at, 1);
    jobValues.splice(at, 1);
    jobKeys.push(key);
    jobValues.push(hit);
    return hit;
  }
  const job = new PagedAllJob();
  job.key = key;
  job.cached = true;
  jobKeys.push(key);
  jobValues.push(job);
  trimJobs();
  runJob(job, options);
  return job;
}

/** 丢弃某个 key 的缓存（换包/重试时用：用户要的是重拉，不是拿回旧结果） */
export function clearPagedAllJob(key: string): void {
  const at = jobKeys.indexOf(key);
  if (at < 0) return;
  const hit = jobValues[at] as PagedAllJob;
  hit.cancelled = true;
  jobKeys.splice(at, 1);
  jobValues.splice(at, 1);
}

/** 清空全部缓存任务（切账号等场景） */
export function clearPagedAllJobs(): void {
  for (let i = 0; i < jobValues.length; i++) {
    const job = jobValues[i] as PagedAllJob;
    job.cancelled = true;
  }
  jobKeys.splice(0, jobKeys.length);
  jobValues.splice(0, jobValues.length);
}

function trimJobs(): void {
  while (jobKeys.length > PAGED_ALL_JOB_CAP) {
    const drop = jobValues[0] as PagedAllJob;
    drop.cancelled = true;
    jobKeys.splice(0, 1);
    jobValues.splice(0, 1);
  }
}

/** 单页取数：失败按 null 处理，不让一页的错误拖垮整批（PC 同款） */
async function fetchSafe(
  fetchPage: (page: number) => Promise<PagedAllPage>,
  page: number
): Promise<PagedAllPage | null> {
  try {
    return await fetchPage(page);
  } catch (_) {
    return null;
  }
}

/**
 * 追加去重。`seen` 就地更新（其中包含 prev 的全部 key）：
 * 每页重建一次是 O(n²) 的重复扫描，上千首 × 几十页时很明显。
 */
function appendUnique(
  prev: Song[],
  next: Song[],
  keyOf: (item: Song) => string,
  seen: Set<string>
): Song[] {
  if (seen.size != prev.length) {
    seen.clear();
    for (let i = 0; i < prev.length; i++) seen.add(keyOf(prev[i] as Song));
  }
  const out: Song[] = [];
  for (let i = 0; i < prev.length; i++) out.push(prev[i] as Song);
  for (let i = 0; i < next.length; i++) {
    const item = next[i] as Song;
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function runJob(job: PagedAllJob, options: PagedAllOptions): Promise<void> {
  const concurrency = options.concurrency != null ? options.concurrency : 4;
  const maxPages = options.maxPages != null ? options.maxPages : 40;
  // pageSize 不再参与「是否到底」的判断（见 PagedAllPage.hasMore 的注释）；
  // options 里保留它只为调用方自描述，任务本身不用。

  let done = 0;
  let total = -1;
  let failed = "";
  let acc: Song[] = [];
  let meta = "";
  let seen = new Set<string>();

  const publish = (): void => {
    const next: PagedAllState = {
      items: acc,
      loading: done == 0,
      error: failed,
      done: done,
      total: total,
      finished: false,
      meta: meta,
    };
    job.state = next;
    job.emit();
  };
  const finish = (): void => {
    const next: PagedAllState = {
      items: acc,
      loading: false,
      error: failed,
      done: done,
      total: total,
      finished: true,
      meta: meta,
    };
    job.state = next;
    job.emit();
  };

  try {
    // 第 1 页单独拉：既拿首屏（立刻出列表），也用它判「还有没有下一页」
    const first = await options.fetchPage(1);
    if (job.cancelled) return;
    if (first.meta.length > 0) meta = first.meta;
    acc = first.songs;
    seen = new Set<string>();
    for (let i = 0; i < acc.length; i++) seen.add(options.keyOf(acc[i] as Song));
    done = 1;
    publish();
    if (!first.hasMore) {
      total = 1;
      finish();
      return;
    }

    const second = await options.fetchPage(2);
    if (job.cancelled) return;
    if (second.meta.length > 0 && meta.length == 0) meta = second.meta;
    const before = acc.length;
    acc = appendUnique(acc, second.songs, options.keyOf, seen);
    done = 2;
    publish();
    // 上游翻页失效时会一直返回同一页：这一页一条都没新增就别再往下探，
    // 否则要空转到 maxPages（用户看到的就是「条数不变但一直在转」）。
    if (!second.hasMore || acc.length == before) {
      finish();
      return;
    }

    let nextPage = 3;
    while (nextPage <= maxPages) {
      const tasks: Promise<PagedAllPage | null>[] = [];
      for (let i = 0; i < concurrency && nextPage <= maxPages; i++) {
        tasks.push(fetchSafe(options.fetchPage, nextPage));
        nextPage++;
      }
      const settled = await Promise.all(tasks);
      if (job.cancelled) return;

      let added = 0;
      let stop = false;
      for (let i = 0; i < settled.length; i++) {
        const pageData = settled[i] as PagedAllPage | null;
        if (pageData == null) {
          failed = "部分页加载失败，列表可能不完整";
          stop = true;
          continue;
        }
        if (pageData.meta.length > 0 && meta.length == 0) meta = pageData.meta;
        const prevLen = acc.length;
        acc = appendUnique(acc, pageData.songs, options.keyOf, seen);
        added += acc.length - prevLen;
        done++;
        // 每拿完一页就发一次：并发在飞期间条数也要往上走
        publish();
        if (!pageData.hasMore || pageData.songs.length == 0) {
          stop = true;
          // 这一页之后的批次内页**不能再并入**：本页已经是尾页，后面的页是同一批
          // 并发发出去的「越界页」，其内容属于列表之外（对过滤型歌手列表来说就是
          // 别的歌手的搜索结果）。以前继续并入，导致同一歌手改并发数就改显示条数。
          break;
        }
      }
      if (stop || added == 0) break;
    }
    finish();
  } catch (_) {
    failed = "加载失败";
    finish();
  }
}
