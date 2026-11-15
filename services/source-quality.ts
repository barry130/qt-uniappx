/**
 * 各平台独立的音质选择（2026-10-28 与 qt-pc 对齐：音质从「播放/下载设置」的
 * 全局单值改为按平台管理，入口在音源平台管理页每个平台账号卡片 + 播放页音质菜单）+
 * v12 生效档位清单的引擎门面与宿主缓存。
 *
 * ── 与 qt-pc/src/lib/source-quality.ts 的异同 ──
 * 相同（语义完全一致）：
 *  - 存储：{平台: 档位} 全量表，播放/下载两个独立键；
 *  - 形状校验：平台 id / 档位 id 都只收短字母数字下划线（脏数据整条丢弃）；
 *  - 读取口径：进程内缓存 + 同步 getter，回落链「平台独立 → 全局默认」；
 *  - 变更事件：SOURCE_QUALITIES_CHANGED_EVENT（菜单高亮/账号页下拉订阅刷新）；
 *  - v12：fetchSourceQualityProfile——生效档位清单由数据包判定（它持有播放面
 *    凭据与 officialQualities 自述），宿主只把会员档作为数据传入并缓存展示。
 *  - 2026-11-14 网络面别拆分：播放/下载表各拆成 WIFI 与移动网络两张
 *    （用户需求「分别独立管理」），读写都按当前网络面别（./network-kind）
 *    选表；旧「不分网络」表一次性平移进两张网络表后删除。
 * 不同（平台架构差异，非语义差异）：
 *  - PC 把全量表推给 Rust 引擎（engine.rs effective_quality_for 自己取值）；
 *    uniappx 取链是**参数式**的（playUrl(song, quality)），引擎不需要持有表：
 *    播放/下载档位在调用点用 sourcePlayQualityOf / sourceDownloadQualityOf
 *    现算（stores/player.effQualityOf、stores/downloads.runTaskInner）。
 *  - getter 带显式 fallback 参数（调用方传入自己的全局默认值）：本模块不反向
 *    import stores/player（会成环），「平台独立 → 全局默认」链由持有方传入，
 *    效果与 PC 的「平台表 → 旧全局键 → 320」一致。
 *
 * v12 缓存的刷新时机在 stores/source-registry（登录态变化 250ms 去抖重查 +
 * 换包清缓存 + 注册表加载后首拉，见其模块尾部绑定）；消费方三处同步切换：
 * source-registry.sourceQualities（展示）、music-api.supportedQualitiesOf /
 * normalizeOfficialQuality（钳位/归一）。profile 没拉到（旧包缺入口/引擎
 * 空窗）时全部回落 v10/v11 宿主判定，行为与升级前一致，不弹提示。
 */
import { parseJsonToUtso } from "./http";
import { invokeSource } from "./source-engine";
import { sourceVipTierOf } from "./source-auth";
import {
  currentNetworkKind,
  NETWORK_KIND_CHANGED_EVENT,
  NETWORK_KIND_WIFI,
  NETWORK_KIND_CELLULAR,
} from "./network-kind";

// ---------- 键与事件 ----------

/** 平台独立播放音质表（JSON：{源id: 档位id}；用户在账号页/播放页选定后落这里） */
/** 播放档位表的实际读写键：带口径后缀，让 v2 之前的旧手选表整体失效。
 *  真机上卸载重装/换基座都可能保留 storage（2026-10-31 用户复测：改了缺省
 *  仍旧显示母带），只靠 removeStorageSync 不可靠，换键最稳。 */
const PLAY_QUALITIES_KEY = "qt-source-play-qualities-v3";
/** 平台独立下载音质表（JSON：{源id: 档位id}） */
const DOWNLOAD_QUALITIES_KEY = "qt-source-download-qualities";

/**
 * 2026-11-14 网络面别拆分：上面两个旧键是「不分网络」时代的表，只在一次性
 * 迁移（ensureNetworkSchema）里读入、复制到下面的网络表后删除；新读写一律
 * 走四个网络键，WIFI 与移动网络互不覆盖。
 */
const PLAY_WIFI_KEY = "qt-source-play-qualities-wifi";
const PLAY_CELLULAR_KEY = "qt-source-play-qualities-cellular";
const DOWNLOAD_WIFI_KEY = "qt-source-download-qualities-wifi";
const DOWNLOAD_CELLULAR_KEY = "qt-source-download-qualities-cellular";

/** 播放档位口径版本：v2 起「播放音质」缺省跟随该源下载音质，旧手选值一次性作废；
 *  v3 再清一次（用户设备可能已跑过 v2，老安装里手选的高档位仍会盖住缺省，
 *  2026-10-31 用户复述「播放音质默认 320K」时发现 QQ 仍显示母带） */
const PLAY_SCHEMA_KEY = "qt-source-play-quality-schema";
const PLAY_SCHEMA_VERSION = "3";

/** 网络面别拆分的迁移标记：没见过就把旧表复制进四个网络键（两个网络先各拿
 *  一份与拆分前一致的值，用户之后再独立改），并删旧键防双写口径漂移 */
const NETWORK_SCHEMA_KEY = "qt-source-quality-network-schema";
const NETWORK_SCHEMA_VERSION = "1";

/** 平台音质表变化后广播；播放页音质标注/账号页下拉等 UI 监听刷新 */
export const SOURCE_QUALITIES_CHANGED_EVENT = "qt-source-qualities-changed";

// ---------- 校验 ----------

/** 平台 id 形状校验（与 source-auth 的 ID_PATTERN 同款：数据包下发的源 id 都是短标识） */
const SOURCE_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** 档位 id 形状校验：第三方档（128/320/flac/flac24bit…）与官方 level（standard…jymaster）都是短标识 */
const QUALITY_RE = /^[A-Za-z0-9_-]{1,24}$/;

// ---------- v12 类型 ----------

/** 官方线路的单个音质档（包侧 getSourceQualities 下发；min = none/vip/svip） */
export type SourceOfficialQuality = { id: string; name: string; min: string };

/**
 * 某源当前生效的音质档位清单（v12 契约；包侧 getSourceQualities 应答）。
 * mode 用 string 常量而非字面量联合：UTS 对字面量联合的收窄不可靠，扁平 +
 * 判等比较是全仓 .ts 的稳妥形状（见 source-auth 的 SourceQrPoll.status）。
 * mode=official：官方清单生效（qualities 为按会员档过滤后的官方档，
 * aliases 把存量第三方档名归一到官方 level id）；mode=platform：未生效，
 * 调用方继续用注册表普通子集。
 */
export type QualityProfile = {
  mode: string;
  /** 官方档（低→高；mode=official 时非空）；展示名随包下发 */
  qualities: SourceOfficialQuality[];
  /** 存量第三方档名 → 官方 level id（mode=official 时用于请求档归一） */
  aliases: UTSJSONObject;
};

/** v12 应答的两种生效面（mode 字段的取值） */
export const PROFILE_MODE_OFFICIAL = "official";
export const PROFILE_MODE_PLATFORM = "platform";

// ---------- 平台独立音质表（存储 + 进程内缓存） ----------

/** {源id: 档位id} 的内存副本（首次读后缓存，写入同步更新；UTSJSONObject 便于 get/keys）
 *  2026-11-14 起按网络面别分表：WIFI 与移动网络各一张，互不覆盖 */
let cachedPlayWifi: UTSJSONObject | null = null;
let cachedPlayCellular: UTSJSONObject | null = null;
let cachedDownloadWifi: UTSJSONObject | null = null;
let cachedDownloadCellular: UTSJSONObject | null = null;

function readQualityTable(key: string): UTSJSONObject {
  try {
    const raw = uni.getStorageSync(key);
    if (typeof raw != "string" || (raw as string).length == 0) return new UTSJSONObject();
    const obj = parseJsonToUtso(raw as string);
    // 形状过滤：只收 {短id: 短id}，一条脏数据不让整张表失效
    const out = new UTSJSONObject();
    const keys = UTSJSONObject.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = obj.get(k);
      if (v == null) continue;
      const q = v.toString();
      if (!SOURCE_RE.test(k) || !QUALITY_RE.test(q)) continue;
      out.set(k, q);
    }
    return out;
  } catch (_) {
    // 静默：坏存储按空表处理，写入路径会把它修回来
    return new UTSJSONObject();
  }
}

function playKeyOf(network: string): string {
  return network == NETWORK_KIND_WIFI ? PLAY_WIFI_KEY : PLAY_CELLULAR_KEY;
}

function downloadKeyOf(network: string): string {
  return network == NETWORK_KIND_WIFI ? DOWNLOAD_WIFI_KEY : DOWNLOAD_CELLULAR_KEY;
}

function playTable(network: string): UTSJSONObject {
  if (network == NETWORK_KIND_WIFI) {
    if (cachedPlayWifi == null) cachedPlayWifi = readQualityTable(PLAY_WIFI_KEY);
    return cachedPlayWifi as UTSJSONObject;
  }
  if (cachedPlayCellular == null) cachedPlayCellular = readQualityTable(PLAY_CELLULAR_KEY);
  return cachedPlayCellular as UTSJSONObject;
}

function downloadTable(network: string): UTSJSONObject {
  if (network == NETWORK_KIND_WIFI) {
    if (cachedDownloadWifi == null) cachedDownloadWifi = readQualityTable(DOWNLOAD_WIFI_KEY);
    return cachedDownloadWifi as UTSJSONObject;
  }
  if (cachedDownloadCellular == null) cachedDownloadCellular = readQualityTable(DOWNLOAD_CELLULAR_KEY);
  return cachedDownloadCellular as UTSJSONObject;
}

/**
 * 平台的播放音质（同步读，按**当前网络面别**选表）。回落链：该网络播放表 →
 * 调用方传入的全局默认。uniappx 的全局默认常驻在 player.quality（PC 是旧
 * 全局键迁移，这里不需要：持有方直接传入，避免本模块反向 import
 * stores/player 成环）。
 */
export function sourcePlayQualityOf(source: string, fallback: string): string {
  return sourcePlayQualityForNetwork(source, fallback, currentNetworkKind());
}

/** 指定网络面别（wifi/cellular）的播放音质：账号页 WIFI/移动网络两行独立展示用 */
export function sourcePlayQualityForNetwork(source: string, fallback: string, network: string): string {
  const table = playTable(network);
  const v = table.get(source);
  if (v != null) {
    const q = v.toString();
    if (QUALITY_RE.test(q)) return q;
  }
  return fallback.length > 0 ? fallback : "320";
}

/** 平台的下载音质（同步读，当前网络面别）。回落链同 sourcePlayQualityOf。 */
export function sourceDownloadQualityOf(source: string, fallback: string): string {
  return sourceDownloadQualityForNetwork(source, fallback, currentNetworkKind());
}

/** 指定网络面别的下载音质：账号页 WIFI/移动网络两行独立展示用 */
export function sourceDownloadQualityForNetwork(source: string, fallback: string, network: string): string {
  const table = downloadTable(network);
  const v = table.get(source);
  if (v != null) {
    const q = v.toString();
    if (QUALITY_RE.test(q)) return q;
  }
  return fallback.length > 0 ? fallback : "320";
}

/**
 * 写入公共路径：校验 → 更新对应网络面别的内存表 → 落库 → 广播。返回 false =
 * 形状非法（调用方提示「非法的音质设置」）。**同值短路**：不落库不广播——
 * 清单翻面迁移（source-registry 的 migrateStaleQualities）会对大量平台×两个
 * 网络重写档位，值没变时短路避免事件风暴与无谓写盘。
 */
function setSourceQualityImpl(isPlay: boolean, source: string, quality: string, network: string): boolean {
  if (!SOURCE_RE.test(source) || !QUALITY_RE.test(quality)) return false;
  const table = isPlay ? playTable(network) : downloadTable(network);
  const existing = table.get(source);
  if (existing != null && existing.toString() == quality) return true;
  table.set(source, quality);
  if (isPlay) {
    if (network == NETWORK_KIND_WIFI) cachedPlayWifi = table;
    else cachedPlayCellular = table;
  } else {
    if (network == NETWORK_KIND_WIFI) cachedDownloadWifi = table;
    else cachedDownloadCellular = table;
  }
  try {
    uni.setStorageSync(isPlay ? playKeyOf(network) : downloadKeyOf(network), JSON.stringify(table));
  } catch (_) {
    // 静默：内存表已更新（本次会话生效），重启后回到旧值
  }
  uni.$emit(SOURCE_QUALITIES_CHANGED_EVENT);
  return true;
}

/**
 * 写平台的播放音质（落库 + 广播；形状非法返回 false 由调用方提示）。
 * 落到**当前网络**的面别表：播放页音质菜单只改用户此刻所连网络的那一行，
 * 另一个网络的档位不受影响。
 */
export function setSourcePlayQuality(source: string, quality: string): boolean {
  return setSourceQualityImpl(true, source, quality, currentNetworkKind());
}

/** 写平台指定网络面别的播放音质：账号页 WIFI/移动网络两行独立设置用 */
export function setSourcePlayQualityForNetwork(source: string, quality: string, network: string): boolean {
  return setSourceQualityImpl(true, source, quality, network);
}

/**
 * 写平台的下载音质（落库 + 广播；下载不走引擎无需推送，PC 同款）。
 * 落到当前网络的面别表，口径与播放侧一致。
 */
export function setSourceDownloadQuality(source: string, quality: string): boolean {
  return setSourceQualityImpl(false, source, quality, currentNetworkKind());
}

/** 写平台指定网络面别的下载音质：账号页 WIFI/移动网络两行独立设置用 */
export function setSourceDownloadQualityForNetwork(source: string, quality: string, network: string): boolean {
  return setSourceQualityImpl(false, source, quality, network);
}

/**
 * 恢复默认（设置→存储清理「恢复默认设置」用）：删全部新旧表 + 清缓存 + 广播。
 * 广播让打开中的菜单/下拉立刻回到全局默认档位。
 */
export function resetSourceQualities(): void {
  try {
    uni.removeStorageSync(PLAY_QUALITIES_KEY);
    uni.removeStorageSync(DOWNLOAD_QUALITIES_KEY);
    uni.removeStorageSync(PLAY_WIFI_KEY);
    uni.removeStorageSync(PLAY_CELLULAR_KEY);
    uni.removeStorageSync(DOWNLOAD_WIFI_KEY);
    uni.removeStorageSync(DOWNLOAD_CELLULAR_KEY);
  } catch (_) {
    // 静默：remove 失败时缓存已清，本次会话内读到的已是默认值
  }
  cachedPlayWifi = null;
  cachedPlayCellular = null;
  cachedDownloadWifi = null;
  cachedDownloadCellular = null;
  uni.$emit(SOURCE_QUALITIES_CHANGED_EVENT);
}

/**
 * 播放档位口径迁移（进程内一次）：账号页「播放音质」缺省改为跟随该源的
 * 下载音质（下载缺省 = 音源第二档，如 320k）。旧版本用户在账号页/播放页点过
 * 的档位会永久盖住缺省，按「以修改后的为准」一次性清空播放表；下载表不动。
 */
function ensurePlaySchema(): void {
  let seen = "";
  try {
    seen = uni.getStorageSync(PLAY_SCHEMA_KEY).toString();
  } catch (_) {
    seen = "";
  }
  if (seen == PLAY_SCHEMA_VERSION) return;
  try {
    uni.removeStorageSync(PLAY_QUALITIES_KEY);
  } catch (_) {
    // 静默：删不掉也只是本次会话仍读到旧值，下次启动重试
  }
  cachedPlayWifi = null;
  cachedPlayCellular = null;
  try {
    uni.setStorageSync(PLAY_SCHEMA_KEY, PLAY_SCHEMA_VERSION);
  } catch (_) {
    // 静默：标记写不进时下次启动会再清一次，幂等
  }
  uni.$emit(SOURCE_QUALITIES_CHANGED_EVENT);
}

/**
 * 网络面别拆分迁移（进程内一次）：把旧「不分网络」表复制到 WIFI 与移动网络
 * 两张表——拆分前选的档位两个网络先各拿一份，用户之后在账号页/播放页再独立
 * 改——然后删旧键，防止旧代码路径或残留数据造成第二套口径。播放旧表先经
 * ensurePlaySchema（v3）处理，这里只搬「当前仍生效」的值；下载表原样平移。
 */
function ensureNetworkSchema(): void {
  let seen = "";
  try {
    seen = uni.getStorageSync(NETWORK_SCHEMA_KEY).toString();
  } catch (_) {
    seen = "";
  }
  if (seen == NETWORK_SCHEMA_VERSION) return;
  copyLegacyTable(PLAY_QUALITIES_KEY, PLAY_WIFI_KEY, PLAY_CELLULAR_KEY);
  copyLegacyTable(DOWNLOAD_QUALITIES_KEY, DOWNLOAD_WIFI_KEY, DOWNLOAD_CELLULAR_KEY);
  try {
    uni.removeStorageSync(PLAY_QUALITIES_KEY);
    uni.removeStorageSync(DOWNLOAD_QUALITIES_KEY);
  } catch (_) {
    // 静默：删不掉也只是残留（旧键不再被读写），下次启动重试
  }
  cachedPlayWifi = null;
  cachedPlayCellular = null;
  cachedDownloadWifi = null;
  cachedDownloadCellular = null;
  try {
    uni.setStorageSync(NETWORK_SCHEMA_KEY, NETWORK_SCHEMA_VERSION);
  } catch (_) {
    // 静默：标记写不进时下次启动会再搬一次，幂等
  }
  uni.$emit(SOURCE_QUALITIES_CHANGED_EVENT);
}

/** 旧表 → 两张网络表：每条只在该网络表缺位时写入（重跑幂等，且不覆盖已独立改过的值） */
function copyLegacyTable(fromKey: string, wifiKey: string, cellularKey: string): void {
  const legacy = readQualityTable(fromKey);
  const keys = UTSJSONObject.keys(legacy);
  if (keys.length == 0) return;
  const wifi = readQualityTable(wifiKey);
  const cellular = readQualityTable(cellularKey);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = legacy.get(k);
    if (v == null) continue;
    const q = v.toString();
    if (wifi.get(k) == null) wifi.set(k, q);
    if (cellular.get(k) == null) cellular.set(k, q);
  }
  try {
    uni.setStorageSync(wifiKey, JSON.stringify(wifi));
    uni.setStorageSync(cellularKey, JSON.stringify(cellular));
  } catch (_) {
    // 静默：搬不动时下次启动重试（标记未写会重跑）
  }
}

// ---------- v12 生效档位清单（包侧判定 + 宿主缓存） ----------

/**
 * 缓存分两层：qualityProfiles 只存**拉到**的 profile（QualityProfile）；
 * profileLoaded 记录哪些源已经**试过**（含失败）——两者合起来表达三态：
 * 没试过（null，消费方回落宿主判定）、试过且拉到（profile）、试过但失败
 * （null + loaded=true，同样回落宿主判定，语义上「包不可用」与「还没拉」
 * 对消费方等价，区分只为将来排障打点）。
 */
const qualityProfiles = new Map<string, QualityProfile>();
const profileLoaded = new Map<string, boolean>();

/**
 * 某源的生效清单缓存（同步读）。null = 还没拉到（启动窗口/旧包缺入口/
 * 引擎空窗），消费方回落 v10/v11 宿主判定；mode=platform 的 profile 也会
 * 返回——调用方按「官方清单未生效」处理，**跳过**宿主判定（包是权威：
 * 注入后的真实凭据状态只有它知道，宿主 storage 里可能有竞态残值）。
 */
export function cachedQualityProfileOf(source: string): QualityProfile | null {
  if (!profileLoaded.has(source)) return null;
  const p = qualityProfiles.get(source);
  return p != null ? p : null;
}

/** 判定结果的写回（refreshQualityProfiles 用；profile=null 表示该源拉取失败/旧包） */
export function storeQualityProfile(source: string, profile: QualityProfile | null): void {
  profileLoaded.set(source, true);
  if (profile != null) qualityProfiles.set(source, profile);
  else qualityProfiles.delete(source);
}

/**
 * 引擎重装/换包后全部作废（SOURCE_PACKS_CHANGED_EVENT）：新包的判定与旧包
 * 无从对比，清掉回落宿主判定，待注册表重新加载后由首拉重建。
 */
export function clearQualityProfiles(): void {
  qualityProfiles.clear();
  profileLoaded.clear();
}

/** 数据包缺入口（旧包）与「引擎未就绪」「接口执行失败」区分开：只有前者换「该更新包了」 */
function isMissingEntryError(message: string): boolean {
  return message.indexOf("缺少") >= 0 || message.indexOf("入口不存在") >= 0;
}

function packOutdatedV12(entry: string): Error {
  return new Error(
    "数据包版本过旧：缺少 " +
      entry +
      " 入口（需要 2026.10.24.17 / META_REVISION 12 及以上的数据包），请到「设置 → 音源包管理」更新后重试",
  );
}

/**
 * 某源当前生效的音质档位清单（v12）：登录态→官方清单的判定、会员档过滤、
 * 旧档名别名表全部由数据包决定（它持有播放面凭据与 officialQualities
 * 自述），宿主只把账号会员档作为数据传入。官方清单未生效时返回
 * mode="platform"、qualities 为空，调用方回落注册表普通子集。
 * 旧包缺入口 → 抛「数据包版本过旧」（refreshQualityProfiles 捕获记失败，
 * 消费方回落宿主判定，不打扰用户）。
 */
export async function fetchSourceQualityProfile(
  source: string,
  vip: string | null,
): Promise<QualityProfile> {
  const args = new UTSJSONObject();
  args.set("source", source);
  if (vip != null && vip.length > 0) args.set("vip", vip);
  let raw = "";
  try {
    raw = await invokeSource("getSourceQualities", JSON.stringify([args]));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isMissingEntryError(message)) throw packOutdatedV12("getSourceQualities");
    throw e;
  }
  const obj = parseJsonToUtso(raw);
  const modeV = obj.get("mode");
  const mode = modeV == null ? "" : modeV.toString();
  if (mode != PROFILE_MODE_OFFICIAL && mode != PROFILE_MODE_PLATFORM) {
    throw new Error("数据包返回的音质清单不合法");
  }
  const qualities: SourceOfficialQuality[] = [];
  const rawList = obj.get("qualities") as UTSJSONObject[] | null;
  if (rawList != null) {
    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      if (item == null) continue;
      const id = item.get("id");
      const name = item.get("name");
      // id 非空 string + name string 才收；min 收 none/vip/svip，其余归 none
      if (id == null || id.toString().length == 0 || name == null) continue;
      const minV = item.get("min");
      const min =
        minV != null && (minV.toString() == "vip" || minV.toString() == "svip")
          ? minV.toString()
          : "none";
      qualities.push({ id: id.toString(), name: name.toString(), min: min });
    }
  }
  const aliases = new UTSJSONObject();
  const rawAliases = obj.get("aliases") as UTSJSONObject | null;
  if (rawAliases != null) {
    const keys = UTSJSONObject.keys(rawAliases);
    for (let i = 0; i < keys.length; i++) {
      const from = keys[i];
      const to = rawAliases.get(from);
      if (to == null) continue;
      const toS = to.toString();
      // 键值都过形状校验才收（与 PC 的 fetchSourceQualityProfile 同款）
      if (!QUALITY_RE.test(from) || !QUALITY_RE.test(toS)) continue;
      aliases.set(from, toS);
    }
  }
  return { mode: mode, qualities: qualities, aliases: aliases };
}

// 模块初始化即做口径迁移（先于任何读取）：v3 播放口径 → 网络面别拆分
ensurePlaySchema();
ensureNetworkSchema();
// WIFI/移动网络切换 = 各取档点的生效音质整体变化，转译成音质表变化事件，
// 打开中的播放页音质菜单/账号页卡片立即跟随（同一事件名，订阅方零改动）
uni.$on(NETWORK_KIND_CHANGED_EVENT, () => {
  uni.$emit(SOURCE_QUALITIES_CHANGED_EVENT);
});
