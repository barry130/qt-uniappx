/**
 * 排行榜视图的小型预览队列。全量歌曲仍由MusicApi负责；本层只保留前三首+总数。
 * 网络不取消已在飞请求，但跨音源/隐藏/卸载时先失效意图，不继续排离屏工作。
 * 页面仍是一棵unkeyed scroll-view树；本服务不创建recycler或隐藏音源子树。
 */
import { ref } from "vue";
import { musicApi, type Chart } from "@/services/music-api";
import type { Song } from "@/types/music";

const PREVIEW_ROWS = 3;
const PREVIEW_CONCURRENCY = 2;
const PREVIEW_CACHE_CAP = 80;
const PREVIEW_TTL_MS = 12 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 1000;

type PreviewSnapshot = { songs: Song[]; total: number; expiresAt: number };
const previewCache = new Map<string, PreviewSnapshot>();
export type ChartListSnapshot = { charts: Chart[]; savedAt: number; expiresAt: number };
const listCache = new Map<string, ChartListSnapshot>();
const LIST_CACHE_CAP = 12;

function listKey(identity: string, source: string): string {
  return JSON.stringify([identity, source]);
}
/** 热切源在下一帧直接复用完整榜单清单；不等待异步TTL/引擎往返。 */
export function readChartListSnapshot(source: string): ChartListSnapshot | null {
  const key = listKey(musicApi.chartCacheIdentity(), source);
  const cached = listCache.get(key);
  if (cached == null) return null;
  if (Date.now() >= cached.expiresAt) {
    // 到期空清单保留短标记，仍受12项容量限制；不能被API的60s空缓存再次填回。
    if (cached.charts.length > 0) listCache.delete(key);
    return null;
  }
  return cached;
}
/** 仅短空清单到期强制取新数据；其余冷/热清单仍使用API的正常TTL。 */
export function chartListRequiresNetwork(source: string): boolean {
  const cached = listCache.get(listKey(musicApi.chartCacheIdentity(), source));
  return cached != null && cached.charts.length == 0 && Date.now() >= cached.expiresAt;
}
/** 调用方必须在await前捕获identity；迟到的旧包结果不能写新scope。 */
export function rememberChartList(source: string, charts: Chart[], identity: string): ChartListSnapshot | null {
  if (identity != musicApi.chartCacheIdentity()) return null;
  const savedAt = Date.now();
  const snapshot: ChartListSnapshot = { charts, savedAt,
    expiresAt: savedAt + (charts.length > 0 ? PREVIEW_TTL_MS : EMPTY_TTL_MS) };
  const key = listKey(identity, source);
  listCache.delete(key);
  listCache.set(key, snapshot);
  if (listCache.size > LIST_CACHE_CAP) listCache.delete(Array.from(listCache.keys())[0]);
  return snapshot;
}

function previewKey(identity: string, chart: Chart): string {
  return JSON.stringify([identity, chart.platform, chart.id]);
}
function cachedPreview(key: string): PreviewSnapshot | null {
  const cached = previewCache.get(key);
  if (cached == null) return null;
  if (Date.now() >= cached.expiresAt) {
    // 保留短空结果的到期标记（仍受80项上限）；下一次需求需穿透API的60s空缓存。
    if (cached.total > 0) previewCache.delete(key);
    return null;
  }
  return cached;
}
function storePreview(key: string, songs: Song[]): PreviewSnapshot {
  const top: Song[] = [];
  for (let i = 0; i < songs.length && i < PREVIEW_ROWS; i++) top.push(songs[i]);
  const snapshot: PreviewSnapshot = {
    songs: top,
    total: songs.length,
    expiresAt: Date.now() + (songs.length > 0 ? PREVIEW_TTL_MS : EMPTY_TTL_MS),
  };
  previewCache.delete(key);
  previewCache.set(key, snapshot);
  if (previewCache.size > PREVIEW_CACHE_CAP) previewCache.delete(Array.from(previewCache.keys())[0]);
  return snapshot;
}

/** 包态事件的同步失效入口；不清播放地址/歌词等无关缓存。 */
export function clearChartViewCache(): void {
  previewCache.clear();
  listCache.clear();
}

export type ChartDemand = { start: number; end: number };
/** 与页面固定卡片高度同源；可视行+上下各一行overscan。end为exclusive。 */
export function chartDemandWindow(scrollTop: number, viewport: number, stride: number, columns: number, count: number): ChartDemand {
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewport) && viewport > 0 ? viewport : 1;
  const step = Number.isFinite(stride) && stride > 0 ? stride : 1;
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const first = Math.max(0, Math.floor(top / step) - 1) * cols;
  const last = (Math.ceil((top + height) / step) + 1) * cols;
  return { start: Math.min(first, total), end: Math.min(last, total) };
}

export class ChartLoader {
  readonly charts = ref<Chart[]>([]);
  readonly previewStates = ref<number[]>([]); // 0按需 / 3在飞 / 1就绪 / 2失败 / 4空榜
  readonly previewSongs = ref<Song[][]>([]);
  readonly previewTotals = ref<number[]>([]);
  readonly coverSources = ref<string[]>([]);
  private source = "";
  private identity = "";
  private sequence = 0;
  private start = 0;
  private end = 0;
  private busy = 0;
  private forced = new Set<number>();
  private visible = true;
  private alive = true;

  /** 只能在页面完成回顶之后换整组；此处不自行滚动或测量原生节点。 */
  display(source: string, list: Chart[]): void {
    if (!this.alive) return;
    this.sequence++;
    this.source = source;
    this.identity = musicApi.chartCacheIdentity();
    this.start = 0;
    this.end = 0;
    this.forced.clear();
    this.charts.value = list;
    const states: number[] = [];
    const songs: Song[][] = [];
    const totals: number[] = [];
    const covers: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const key = previewKey(this.identity, list[i]);
      const previous = previewCache.get(key);
      if (previous != null && previous.total == 0 && Date.now() >= previous.expiresAt) this.forced.add(i);
      const cached = cachedPreview(key);
      states.push(cached == null ? 0 : cached.total > 0 ? 1 : 4);
      songs.push(cached != null ? cached.songs : []);
      totals.push(cached != null ? cached.total : 0);
      covers.push("");
    }
    this.previewStates.value = states;
    this.previewSongs.value = songs;
    this.previewTotals.value = totals;
    this.coverSources.value = covers;
  }

  /** 热路径只在行窗口变化时发布；不按每个scroll事件重排全部详情请求。 */
  setDemand(start: number, end: number, force: boolean = false): void {
    if (!this.alive || !this.visible) return;
    const count = this.charts.value.length;
    const a = Number.isFinite(start) ? Math.min(count, Math.max(0, Math.floor(start))) : 0;
    const b = Number.isFinite(end) ? Math.min(count, Math.max(a, Math.floor(end))) : a;
    if (this.start == a && this.end == b && !force) return;
    this.start = a;
    this.end = b;
    const covers: string[] = [];
    const list = this.charts.value;
    for (let i = 0; i < list.length; i++) covers.push(i >= a && i < b ? list[i].picUrl : "");
    this.coverSources.value = covers;
    if (force) this.refreshDemand();
    else this.pump();
  }

  private current(sequence: number, identity: string, source: string): boolean {
    return this.alive && this.visible && sequence == this.sequence && identity == this.identity &&
      source == this.source && identity == musicApi.chartCacheIdentity();
  }

  private pump(): void {
    if (!this.alive || !this.visible || this.identity != musicApi.chartCacheIdentity()) return;
    const list = this.charts.value;
    for (let i = this.start; i < this.end && this.busy < PREVIEW_CONCURRENCY; i++) {
      if (i >= list.length || this.previewStates.value[i] != 0) continue;
      const states = this.previewStates.value.slice();
      states[i] = 3;
      this.previewStates.value = states;
      this.busy++;
      const force = this.forced.has(i);
      this.forced.delete(i);
      this.fetchPreview(this.sequence, this.identity, this.source, i, list[i], force);
    }
  }

  private async fetchPreview(sequence: number, identity: string, source: string, index: number, chart: Chart, force: boolean): Promise<void> {
    // 完整key在await之前捕获；不能把旧包响应归入await之后的新包身份。
    const key = previewKey(identity, chart);
    try {
      const songs = await musicApi.chartDetail(chart, force);
      if (!this.current(sequence, identity, source)) return;
      const cached = storePreview(key, songs);
      const allSongs = this.previewSongs.value.slice();
      allSongs[index] = cached.songs;
      this.previewSongs.value = allSongs;
      const totals = this.previewTotals.value.slice();
      totals[index] = cached.total;
      this.previewTotals.value = totals;
      const states = this.previewStates.value.slice();
      states[index] = cached.total > 0 ? 1 : 4;
      this.previewStates.value = states;
    } catch (_) {
      if (!this.current(sequence, identity, source)) return;
      const states = this.previewStates.value.slice();
      states[index] = 2;
      this.previewStates.value = states;
    } finally {
      // 旧scope的请求也归还slot；只pump当前可见scope，绝不恢复旧音源队列。
      this.busy--;
      this.pump();
    }
  }

  retry(index: number): void {
    if (!this.alive || !this.visible || index < this.start || index >= this.end || this.previewStates.value[index] != 2) return;
    const states = this.previewStates.value.slice();
    states[index] = 0;
    this.forced.add(index);
    this.previewStates.value = states;
    this.pump();
  }

  /** 手动刷新只强制当前需求窗口；后续离屏卡仍正常命中缓存。 */
  refreshDemand(): void {
    if (!this.alive || !this.visible) return;
    const states = this.previewStates.value.slice();
    for (let i = this.start; i < this.end; i++) {
      if (states[i] == 3) continue;
      previewCache.delete(previewKey(this.identity, this.charts.value[i]));
      states[i] = 0;
      this.forced.add(i);
    }
    this.previewStates.value = states;
    this.pump();
  }

  songLine(index: number, row: number): string {
    const state = this.previewStates.value[index] ?? 0;
    if (state == 2) return row == 0 ? "预览暂不可用 · 点按重试" : "—";
    if (state == 4) return row == 0 ? "榜单暂无歌曲" : "—";
    const songs = this.previewSongs.value[index];
    if (songs != null && row < songs.length) {
      const song = songs[row];
      return song.name + (song.singer.length > 0 ? " - " + song.singer : "");
    }
    if (state == 3) return row == 0 ? "正在读取前三首…" : "—";
    return row == 0 ? "滑动后加载前三首" : "—";
  }

  meta(index: number): string {
    const state = this.previewStates.value[index] ?? 0;
    if (state == 1) return "共 " + this.previewTotals.value[index] + " 首";
    if (state == 4) return "暂无歌曲";
    if (state == 2) return "重试预览";
    return state == 3 ? "读取中" : "按需预览";
  }

  suspend(preserveCovers: boolean = false): void {
    if (!this.alive) return;
    this.forced.clear();
    this.visible = false;
    this.sequence++;
    const states = this.previewStates.value.slice();
    for (let i = 0; i < states.length; i++) if (states[i] == 3) states[i] = 0;
    this.previewStates.value = states;
    if (!preserveCovers) this.coverSources.value = this.charts.value.map((): string => "");
    this.start = 0;
    this.end = 0;
  }
  resume(): void {
    if (this.alive) this.visible = true;
  }
  dispose(): void {
    this.suspend();
    this.alive = false;
    this.sequence++;
  }
}

export function createChartLoader(): ChartLoader {
  return new ChartLoader();
}
