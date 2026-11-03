/**
 * 音源账号登录（v9 数据包契约）：凭据的持久真源（uni storage）+「数据/播放
 * 两面是否使用登录态」**按源独立**的开关 + 向数据包引擎的懒注入 + 登录动作
 * 门面 + 凭据轮换/后台保活。与 qt-pc/src/lib/source-auth.ts + source-scripts
 * 的 auth 门面同语义（v2 迁移：per-source 开关、extras 副键、refreshAll-
 * SourceAccounts 三件套一并对齐）。
 *
 * 职责边界（与数据包内 auth-store 分工）：
 * - 这里是**持久层**：Cookie 与用户信息只存本机 uni storage（不进任何网络
 *   上报），卸载重装数据包、重启应用都不丢；数据包内只有引擎内存工作副本，
 *   引擎每次（重）装 meta（冷启动预热/换包/引擎重建，全部经 loadMetaIntoEngine）
 *   都从零开始，所以注入必须跟着「meta 装载成功」重放（setMetaAuthHook 钩子）。
 * - 「是否使用登录态」体现在**灌不灌**：某源的某面开关关闭 = 只 clear 该源
 *   该面的凭据（数据包收到的是「这个源的这类请求一律匿名」），别的源不受
 *   牵连——关一个源的播放登录态不再连带收回其他源的官方档位。
 *
 * 开关解析链（生效值 = readSourceAuthTogglesFor）：
 *   per-source 表（TOGGLES_NS，带口径后缀）→ 缺省（数据开 / 播放关）。
 * - 缺省口径（对齐 PC 2026-10-27，用户 2026-10-31 定案）：数据面缺省常开，
 *   与是否登录无关（登录与否只决定开关能不能点）；播放面缺省关。
 *   「以修改后的为准」：旧版本物化的手点值一律作废，不再从旧全局键继承。
 * - 旧全局键（USE_META_KEY/USE_PLAY_KEY）只在口径迁移时删除，不再参与解析。
 * - 物化时机：登录成功（saveSourceAuthAccount，该源开关未在表时）与切换开关
 *   （setSourceAuthToggle）。
 *
 * 本文件是 .ts（编译后走原生 JSON.parse，产物无 .get）：存储/引擎应答的
 * 解析一律经 parseJsonToUtso 重建 UTSJSONObject（见 music-api.ts 同款说明）。
 * UTS 无 Record<string,string>：凭据副键（如 bili 的 refresh_token）以
 * extrasJson（JSON 字符串）随账号记录落库，注入时重建 UTSJSONObject。
 */
import { parseJsonToUtso } from "./http";
import { invokeSource, setMetaAuthHook } from "./source-engine";

// ---------- 键与事件 ----------

/** 已登录账号表（JSON：{ 源id: {cookie,user,savedAt,extras?} }；凭据只存本机） */
const ACCOUNTS_KEY = "qt-source-auth-accounts";
/** 两面开关表（JSON：{ 源id: {useMeta,usePlay} }；生效值解析链见文件头） */
const TOGGLES_KEY = "qt-source-auth-toggles";
/**
 * 开关表的实际读写键：带口径后缀。换口径时直接换后缀，让旧表整体失效——
 * 不能只靠 removeStorageSync：真机上卸载重装/切基座都可能保留 storage，
 * 2026-10-31 用户复测「卸载重装后仍显示关闭」即此因（旧表里的 false 一直生效）。
 */
const TOGGLES_NS = TOGGLES_KEY + "-v3";
/** 旧全局数据面开关（"true"/"false"；只读：未物化源的一次性继承源） */
const USE_META_KEY = "qt-source-auth-use-meta";
/** 旧全局播放面开关（同上，只读不写） */
const USE_PLAY_KEY = "qt-source-auth-use-play";
/** 开关表口径版本：旧值只体现「当次手点」，会永久盖住新缺省，故一次性作废 */
const TOGGLES_SCHEMA_KEY = "qt-source-auth-schema";
/** 2 = 数据面缺省常开（与是否登录、与旧全局键都无关），播放面缺省仍为关
 *  3 = 再清一次：用户设备可能已经跑过 2（升级前的老安装里点过「关」的值会被物化成
 *      永久 false，盖住缺省），单纯改缺省对它们无效。2026-10-31 用户复述「数据请求
 *      使用登录态默认打开」时发现仍显示关闭，故抬版强制重置一次。 */
const TOGGLES_SCHEMA_VERSION = "3";

/** 后台保活节流水位（epoch ms 字符串）：距上次实际运行不足 24h 跳过 */
const KEEPALIVE_AT_KEY = "qt-source-auth-keepalive-at";
/** 后台保活节流窗口：24 小时（App 每次回前台都会触发，节流防耗电） */
const KEEPALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 冷启动窗口：非强制保活在本模块装载后 25s 内跳过（启动 20s 首检独占冷启动，
 *  避免同一轮冷启动跑两遍） */
const KEEPALIVE_COLD_START_MS = 25000;

/** 账号/开关变化后广播；账号页与其他关心登录态的界面监听刷新 */
export const SOURCE_AUTH_CHANGED_EVENT = "qt-source-auth-changed";

/** 本模块装载时刻（冷启动窗口判定用；模块随 App.uvue import 而装载） */
const moduleLoadAtMs = Date.now();

// ---------- 类型 ----------

/** 登录态生效面：meta = 数据接口（搜索/歌单/歌词），play = 取链（在线播放） */
export type SourceAuthScope = "meta" | "play";

/** 已登录用户信息（数据包 authUser/authQrPoll 下发的 user 字段，宿主只做展示） */
export type SourceAuthUser = {
  id: string;
  nickname: string;
  avatar: string;
  vip: boolean;
  vipLabel: string;
};

/** 一个已登录账号的持久记录（cookie 是官方下发的凭据本体） */
export type SourceAuthAccount = {
  cookie: string;
  user: SourceAuthUser;
  /** ISO 时间：排障用（「我什么时候登的」），不参与任何逻辑判断 */
  savedAt: string;
  /** 凭据副键（JSON 字符串，如 bili 的 {"refresh_token":"…"}）：登录/轮换时随
   *  credential 下发，校验时原样透传回包入口供 refreshCredential 使用。
   *  "" = 旧记录或该源无副键，向后兼容。 */
  extrasJson: string;
};

/** 账号条目（source = 源 id；数组形状便于页面直接 v-for） */
export type SourceAuthEntry = { source: string; account: SourceAuthAccount };

/** 两面开关（按源独立；生效值解析链见文件头） */
export type SourceAuthToggles = { useMeta: boolean; usePlay: boolean };

/** 扫码会话（image 为包内生成的 PNG data URI，凭据不外发第三方） */
export type SourceQrSession = { key: string; image: string; expiresInSec: number };

/**
 * 扫码轮询结果。confirmed 必带 cookie 与 user；无效确认（缺凭据/缺用户）
 * 归一成 expired，页面按「引导重新生成二维码」处理。不用可辨识联合：
 * UTS 对字面量联合的收窄不可靠，扁平 + nullable 字段是全仓 .ts 的稳妥形状。
 * refreshToken：confirmed 时随 credential 下发的凭据副键（"" = 无），调用方
 * 落库时并入 extrasJson 持久化。
 */
export type SourceQrPoll = {
  status: string; // waiting / scanned / expired / confirmed
  cookie: string;
  user: SourceAuthUser | null;
  refreshToken: string;
};

/**
 * 凭据校验结果（authCheckUser，对齐 PC authUser 门面）：ok=false 表示凭据
 * 失效（页面标灰引导重登，绝不自动删账号）；credential 非空 = 包侧已用
 * refresh_key 轮换出新 cookie（QQ 短期 musickey 保活），调用方必须持久化；
 * refreshToken 随轮换下发并入 extrasJson。扁平 + 空值哨兵，同上理由。
 */
export type SourceAuthCheck = {
  ok: boolean;
  user: SourceAuthUser | null;
  credential: string;
  refreshToken: string;
};

/** 一轮后台保活的简单统计（checked = 尝试的源数，rotated = 轮换落库数） */
export type KeepaliveStats = { checked: number; rotated: number };

// ---------- 小工具 ----------

/** 源 id 形状校验：数据包下发的源 id 都是短标识（wyy/bili 这类），脏数据直接丢 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 上限：留余量防止脏数据把存储撑爆 */
const MAX_ACCOUNTS = 16;

function storageText(key: string): string | null {
  try {
    const raw = uni.getStorageSync(key);
    return typeof raw == "string" ? (raw as string) : null;
  } catch (_) {
    return null;
  }
}

function storageWrite(key: string, value: string): void {
  try {
    uni.setStorageSync(key, value);
  } catch (_) {
    // 静默：存不进去时本次会话内调用方已拿到返回值，重启后回到缺省
  }
}

function nowIso(): string {
  const d = new Date();
  return d.toISOString();
}

/** 数据包下发的 user 对象 → 展示模型；nickname 缺失按「不是有效用户」返回 null */
function normalizeUser(raw: UTSJSONObject | null): SourceAuthUser | null {
  if (raw == null) return null;
  const nickname = raw.get("nickname");
  if (nickname == null || nickname.toString().length == 0) return null;
  const id = raw.get("id");
  const avatar = raw.get("avatar");
  const vip = raw.get("vip");
  const vipLabel = raw.get("vipLabel");
  return {
    id: id == null ? "" : id.toString(),
    nickname: nickname.toString(),
    avatar: avatar == null ? "" : avatar.toString(),
    vip: vip != null && vip.toString() == "true",
    vipLabel: vipLabel == null ? "" : vipLabel.toString(),
  };
}

// ---------- 持久层：账号表 ----------

/**
 * 读已登录账号表。任何形状问题都按「该条丢弃」处理：一条坏存储不该让
 * 「已登录的源」全部掉登录态，更不能因此抛错打断页面。
 */
export function readSourceAuthEntries(): SourceAuthEntry[] {
  const out: SourceAuthEntry[] = [];
  try {
    const text = storageText(ACCOUNTS_KEY);
    if (text == null || text.length == 0) return out;
    const obj = parseJsonToUtso(text);
    // UTSJSONObject 取键用静态 keys()（全仓同款）；实例 .keys() 编译期不保证存在
    const keys = UTSJSONObject.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const source = keys[i];
      if (!ID_PATTERN.test(source)) continue;
      const raw = obj.get(source) as UTSJSONObject | null;
      if (raw == null) continue;
      const cookie = raw.get("cookie");
      if (cookie == null || cookie.toString().length == 0) continue;
      const user = normalizeUser(raw.get("user") as UTSJSONObject | null);
      if (user == null) continue;
      const savedAt = raw.get("savedAt");
      const extras = raw.get("extras") as UTSJSONObject | null;
      out.push({
        source: source,
        account: {
          cookie: cookie.toString(),
          user: user,
          savedAt: savedAt == null ? "" : savedAt.toString(),
          extrasJson: extras == null ? "" : JSON.stringify(extras),
        },
      });
      if (out.length >= MAX_ACCOUNTS) break;
    }
    return out;
  } catch (_) {
    return out;
  }
}

function writeEntries(entries: SourceAuthEntry[]): void {
  const obj = new UTSJSONObject();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const user = new UTSJSONObject();
    user.set("id", e.account.user.id);
    user.set("nickname", e.account.user.nickname);
    user.set("avatar", e.account.user.avatar);
    user.set("vip", e.account.user.vip);
    user.set("vipLabel", e.account.user.vipLabel);
    const account = new UTSJSONObject();
    account.set("cookie", e.account.cookie);
    account.set("user", user);
    account.set("savedAt", e.account.savedAt);
    // extras：空串不写键，账号记录形状与旧版本保持一致（解析侧同样口径）
    if (e.account.extrasJson.length > 0) {
      account.set("extras", parseJsonToUtso(e.account.extrasJson));
    }
    obj.set(e.source, account);
  }
  storageWrite(ACCOUNTS_KEY, JSON.stringify(obj));
}

// ---------- 持久层：按源开关表 ----------

/** 读开关表原文（形状问题归一成空表：坏设置只影响「记住的开关选择」，
 *  退回解析链下一级，不该让注入整体失效） */
function readTogglesMapObj(): UTSJSONObject {
  try {
    const text = storageText(TOGGLES_NS);
    if (text == null || text.length == 0) return new UTSJSONObject();
    const obj = parseJsonToUtso(text);
    if (obj == null) return new UTSJSONObject();
    return obj;
  } catch (_) {
    return new UTSJSONObject();
  }
}

/** 覆写一个源的开关表条目（物化：此后旧全局键不再影响这个源） */
function writeTogglesEntry(source: string, toggles: SourceAuthToggles): void {
  const obj = readTogglesMapObj();
  const entry = new UTSJSONObject();
  entry.set("useMeta", toggles.useMeta);
  entry.set("usePlay", toggles.usePlay);
  obj.set(source, entry);
  storageWrite(TOGGLES_NS, JSON.stringify(obj));
}

/**
 * 开关表口径迁移（进程内一次）：数据面缺省常开，与登录与否无关。旧版本把用户
 * 每次手点都物化成 per-source 条目（还有更早的全局键），这些值会永久盖住缺省——
 * 按「以修改后的为准」一次性清空，让所有源回到新缺省（数据开 / 播放关）。
 * 注意：实际读写键已换成带后缀的 TOGGLES_NS，即使 removeStorageSync 未生效，
 * 旧表也不会再被读到；旧全局键同样不再参与继承（legacyGlobalToggles 已移除）。
 */
function ensureTogglesSchema(): void {
  if (storageText(TOGGLES_SCHEMA_KEY) == TOGGLES_SCHEMA_VERSION) return;
  try {
    uni.removeStorageSync(TOGGLES_NS);
    uni.removeStorageSync(USE_META_KEY);
    uni.removeStorageSync(USE_PLAY_KEY);
  } catch (_) {
    // 静默：删不掉也只影响本次升级的继承来源，读取侧仍会回落到缺省
  }
  storageWrite(TOGGLES_SCHEMA_KEY, TOGGLES_SCHEMA_VERSION);
}

/**
 * 单源生效开关（同步读）：per-source 表（TOGGLES_NS 命名空间）→ 缺省。
 * 旧全局键不再参与继承：它们的 false 会把新缺省永久盖住，而缺省本身就是
 * 「以修改后的为准」的定案（2026-10-31）。
 */
export function readSourceAuthTogglesFor(source: string): SourceAuthToggles {
  const map = readTogglesMapObj();
  const hit = map.get(source) as UTSJSONObject | null;
  if (hit != null) {
    const m = hit.get("useMeta");
    const p = hit.get("usePlay");
    if (m != null && p != null) {
      return { useMeta: m.toString() == "true", usePlay: p.toString() == "true" };
    }
  }
  return { useMeta: true, usePlay: false };
}

/**
 * 读「全部已登录源」的聚合开关（过渡期账号页批量 UI 用）：所有已登录源的
 * 该面都开才算开（与批量关停的语义互补：关 = 全关，开 = 全开，展示取交集
 * 不撒谎）。无账号 = 缺省（页面在无账号时禁用开关行）。阶段4 账号页改每源
 * 卡片后本函数随之退役。
 */
export function readSourceAuthToggles(): SourceAuthToggles {
  const entries = readSourceAuthEntries();
  if (entries.length == 0) return { useMeta: true, usePlay: false };
  let useMeta = true;
  let usePlay = true;
  for (let i = 0; i < entries.length; i++) {
    const toggles = readSourceAuthTogglesFor(entries[i].source);
    if (!toggles.useMeta) useMeta = false;
    if (!toggles.usePlay) usePlay = false;
  }
  return { useMeta: useMeta, usePlay: usePlay };
}

/**
 * 保存/覆盖一个源的登录：落库 + 该源开关未物化时按解析链初始化（旧全局值
 * 优先继承，避免升级后新登录的源绕过用户已调过的全局关闭）+ 立即注入该源。
 * extrasJson 为登录/轮换时随 credential 下发的凭据副键（"" = 无，记录形状
 * 与旧版本一致）。注入失败不回滚存储：装载成功钩子会在引擎可用后重放对账。
 */
export async function saveSourceAuthAccount(
  source: string,
  cookie: string,
  user: SourceAuthUser,
  extrasJson: string,
): Promise<void> {
  const account: SourceAuthAccount = { cookie: cookie, user: user, savedAt: nowIso(), extrasJson: extrasJson };
  const entries = readSourceAuthEntries();
  const next: SourceAuthEntry[] = [];
  let replaced = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].source == source) {
      next.push({ source: source, account: account });
      replaced = true;
    } else {
      next.push(entries[i]);
    }
  }
  if (!replaced) next.push({ source: source, account: account });
  writeEntries(next);
  // 刚登录成功：该源开关未物化时按解析链初始化（旧全局继承 → 缺省数据开/播放关）
  const map = readTogglesMapObj();
  if (map.get(source) == null) {
    writeTogglesEntry(source, readSourceAuthTogglesFor(source));
  }
  uni.$emit(SOURCE_AUTH_CHANGED_EVENT);
  try {
    await applySourceAuthForSource(source);
  } catch (_) {
    // 静默：引擎未就绪/旧包缺入口，装载成功钩子会在引擎可用后重放对账
  }
}

/** 退出一个源的登录：清凭据 + 两面都清掉该源的注入。开关表条目保留——
 *  重新登录后还原用户之前的开关习惯。 */
export async function removeSourceAuthAccount(source: string): Promise<void> {
  const entries = readSourceAuthEntries();
  const next: SourceAuthEntry[] = [];
  let found = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].source == source) {
      found = true;
    } else {
      next.push(entries[i]);
    }
  }
  if (!found) return;
  writeEntries(next);
  uni.$emit(SOURCE_AUTH_CHANGED_EVENT);
  try {
    await authClearCredential("meta", source);
    await authClearCredential("play", source);
  } catch (_) {
    // 静默：引擎未就绪/旧包缺入口，内存副本随下次注入自然对齐（库里已删）
  }
}

/**
 * 切换一个源的一面开关并立即生效：先把该源在解析链上的生效值物化进表
 * （此后旧全局键不再影响这个源），再按新值对该源逐面 set/clear。失败抛给
 * 调用方决定提示（页面还原 UI）。
 */
export async function setSourceAuthToggle(
  source: string,
  scope: SourceAuthScope,
  on: boolean,
): Promise<void> {
  const current = readSourceAuthTogglesFor(source);
  const next: SourceAuthToggles =
    scope == "meta" ? { useMeta: on, usePlay: current.usePlay } : { useMeta: current.useMeta, usePlay: on };
  if (next.useMeta == current.useMeta && next.usePlay == current.usePlay) return;
  writeTogglesEntry(source, next);
  uni.$emit(SOURCE_AUTH_CHANGED_EVENT);
  await applySourceAuthForSource(source);
}

/**
 * 批量切换全部已登录源的一面开关（过渡期账号页全局开关行用）：逐源物化 +
 * 逐源应用，单 emit。失败抛给调用方（页面还原 UI）——引擎不可用时整批
 * 一起失败，不存在半批状态。阶段4 每源卡片 UI 上线后退役。
 */
export async function setSourceAuthToggleAll(scope: SourceAuthScope, on: boolean): Promise<void> {
  const entries = readSourceAuthEntries();
  for (let i = 0; i < entries.length; i++) {
    const source = entries[i].source;
    const current = readSourceAuthTogglesFor(source);
    const next: SourceAuthToggles =
      scope == "meta"
        ? { useMeta: on, usePlay: current.usePlay }
        : { useMeta: current.useMeta, usePlay: on };
    writeTogglesEntry(source, next);
  }
  uni.$emit(SOURCE_AUTH_CHANGED_EVENT);
  for (let i = 0; i < entries.length; i++) {
    await applySourceAuthForSource(entries[i].source);
  }
}

// ---------- 官方线路档位（v10：登录态下档位展示整体切官方清单） ----------

/**
 * 该源播放面登录态是否生效（同步读，与包侧官方前置线路的启用口径一致）：
 * 有该源账号 且 该源播放面开关开着。开关按源独立：关 A 源的播放登录态
 * 只收回 A 源的官方档位展示，B 源不受牵连。账号/开关变化时调用方已广播
 * SOURCE_AUTH_CHANGED_EVENT，档位展示监听它重算。
 */
export function sourcePlayLoginActive(source: string): boolean {
  const entries = readSourceAuthEntries();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].source == source) {
      return readSourceAuthTogglesFor(source).usePlay;
    }
  }
  return false;
}

/**
 * 该源登录账号的会员档（v11：官方档位按账号等级展示——VIP 展示到 VIP 级
 * 档位，SVIP 展示到 SVIP 级）。判定读账号记录里数据包 authUser/authQrPoll
 * 下发的 vipLabel（wyy：黑胶VIP/黑胶SVIP）。
 * 返回 null = 档位未知（没登录/记录里没有会员信息）——调用方按「不过滤」
 * 处理（多展示不隐藏，官方接口拿不到的档会降档/试听回落，功能不坏）。
 */
export function sourceVipTierOf(source: string): string | null {
  const entries = readSourceAuthEntries();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].source == source) {
      const label = entries[i].account.user.vipLabel;
      if (label == "黑胶SVIP") return "svip";
      if (label == "黑胶VIP" || entries[i].account.user.vip) return "vip";
      return "none";
    }
  }
  return null;
}

// ---------- 引擎门面（v9 数据包入口） ----------

/** 数据包缺入口（旧包）与「引擎未就绪」「接口执行失败」区分开：只有前者换成「该更新包了」 */
function isMissingEntryError(message: string): boolean {
  return message.indexOf("缺少") >= 0 || message.indexOf("入口不存在") >= 0;
}

function packOutdatedV9(entry: string): Error {
  return new Error(
    "数据包版本过旧：缺少 " + entry + " 入口（需要 2026.10.24.1 / META_REVISION 9 及以上的数据包），请到「设置 → 音源包管理」更新后重试",
  );
}

/** 包装 v9 入口调用：缺入口（旧包）换成「该更新包了」，其余错误原样抛 */
async function authInvoke(name: string, args: UTSJSONObject): Promise<UTSJSONObject> {
  try {
    const raw = await invokeSource(name, JSON.stringify([args]));
    return parseJsonToUtso(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isMissingEntryError(message)) throw packOutdatedV9(name);
    throw e;
  }
}

/** 创建扫码会话（登录动作直连官方端点，不经凭据包装器——防旧凭据污染新会话） */
export async function authQrCreate(source: string): Promise<SourceQrSession> {
  const args = new UTSJSONObject();
  args.set("source", source);
  const r = await authInvoke("authQrCreate", args);
  const key = r.get("key");
  const image = r.get("image");
  if (key == null || key.toString().length == 0 || image == null || image.toString().indexOf("data:image/png;base64,") != 0) {
    throw new Error("数据包返回的二维码会话不合法");
  }
  const expires = r.get("expiresInSec");
  const expiresNum = expires == null ? 180 : parseInt(expires.toString());
  return { key: key.toString(), image: image.toString(), expiresInSec: expiresNum > 0 ? expiresNum : 180 };
}

/** 扫码轮询（页面 2s 一次；confirmed 后由调用方落存储并注入） */
export async function authQrPoll(source: string, key: string): Promise<SourceQrPoll> {
  const args = new UTSJSONObject();
  args.set("source", source);
  args.set("key", key);
  const r = await authInvoke("authQrPoll", args);
  const status = r.get("status");
  const s = status == null ? "expired" : status.toString();
  if (s == "waiting" || s == "scanned") return { status: s, cookie: "", user: null, refreshToken: "" };
  if (s != "confirmed") return { status: "expired", cookie: "", user: null, refreshToken: "" };
  const credential = r.get("credential") as UTSJSONObject | null;
  const cookie = credential != null ? credential.get("cookie") : null;
  const refreshToken = credential != null ? credential.get("refresh_token") : null;
  const user = normalizeUser(r.get("user") as UTSJSONObject | null);
  // 确认了却缺凭据/缺用户：按过期处理，页面引导重新生成二维码
  if (cookie == null || cookie.toString().length == 0 || user == null) {
    return { status: "expired", cookie: "", user: null, refreshToken: "" };
  }
  return {
    status: "confirmed",
    cookie: cookie.toString(),
    user: user,
    refreshToken: refreshToken == null ? "" : refreshToken.toString(),
  };
}

/** 导入 Cookie：先经官方登录态接口校验，user=null 表示 Cookie 无效（不落存储） */
export async function authImportCookie(source: string, cookie: string): Promise<SourceAuthUser | null> {
  const args = new UTSJSONObject();
  args.set("source", source);
  args.set("cookie", cookie);
  const r = await authInvoke("authImportCookie", args);
  const ok = r.get("ok");
  if (ok == null || ok.toString() != "true") return null;
  return normalizeUser(r.get("user") as UTSJSONObject | null);
}

/** 短信验证码挑战（v14 契约）：key 打包了手机号/服务端 tm/设备身份，登录时必须原样回传 */
export type SourceSmsChallenge = { key: string; message: string };

/** 短信登录成功后的凭据形状（与扫码 confirmed 同形） */
export type SourceAuthLogin = { cookie: string; user: SourceAuthUser; refreshToken: string };

/**
 * 发送短信验证码（v14，酷我）：返回一次性挑战 key。
 * 不声明 "sms" 能力的源会抛「该音源不支持短信登录」，宿主按 auth.methods 显隐入口。
 */
export async function authSendSms(source: string, phone: string): Promise<SourceSmsChallenge> {
  const args = new UTSJSONObject();
  args.set("source", source);
  args.set("phone", phone);
  const r = await authInvoke("authSendSms", args);
  const key = r.get("key");
  if (key == null || key.toString().length == 0) {
    throw new Error("数据包未返回短信挑战，请稍后重试");
  }
  const msg = r.get("message");
  return { key: key.toString(), message: msg == null ? "" : msg.toString() };
}

/** 解析 {credential:{cookie,refresh_token}, user} —— 短信登录与密码登录共用 */
function parseLoginResult(r: UTSJSONObject): SourceAuthLogin {
  const credential = r.get("credential") as UTSJSONObject | null;
  const cookie = credential != null ? credential.get("cookie") : null;
  const refreshToken = credential != null ? credential.get("refresh_token") : null;
  const user = normalizeUser(r.get("user") as UTSJSONObject | null);
  if (cookie == null || cookie.toString().length == 0 || user == null) {
    throw new Error("登录失败：数据包应答缺凭据");
  }
  return { cookie: cookie.toString(), user: user, refreshToken: refreshToken == null ? "" : refreshToken.toString() };
}

/** 短信验证码登录（v14）：key = authSendSms 的挑战 key 原样带回 */
export async function authLoginByPhone(source: string, key: string, code: string): Promise<SourceAuthLogin> {
  const args = new UTSJSONObject();
  args.set("source", source);
  args.set("key", key);
  args.set("code", code);
  return parseLoginResult(await authInvoke("authLoginByPhone", args));
}

/** 账号密码登录（v14，酷我官方客户端形制） */
export async function authLoginByPassword(source: string, account: string, password: string): Promise<SourceAuthLogin> {
  const args = new UTSJSONObject();
  args.set("source", source);
  args.set("account", account);
  args.set("password", password);
  return parseLoginResult(await authInvoke("authLoginByPassword", args));
}

/**
 * 用已存凭据查登录态（进账号页校验 + 后台保活主流程都走这里）。
 * ok=false = 凭据失效（调用方标灰引导重登，绝不自动删）；credential 非空 =
 * 包侧已用 refresh_key 轮换出新 cookie（QQ 短期 musickey 保活），调用方必须
 * 持久化（saveSourceAuthAccount）；refreshToken 随轮换下发，落库时并入
 * extrasJson。extrasJson 原样透传给包入口供 refreshCredential 使用。
 */
export async function authCheckUser(
  source: string,
  cookie: string,
  extrasJson: string,
): Promise<SourceAuthCheck> {
  const args = new UTSJSONObject();
  args.set("source", source);
  args.set("cookie", cookie);
  if (extrasJson.length > 0) {
    args.set("extras", parseJsonToUtso(extrasJson));
  }
  const r = await authInvoke("authUser", args);
  const ok = r.get("ok");
  const user = normalizeUser(r.get("user") as UTSJSONObject | null);
  const credential = r.get("credential") as UTSJSONObject | null;
  const credentialCookie = credential != null ? credential.get("cookie") : null;
  const refreshToken = credential != null ? credential.get("refresh_token") : null;
  return {
    ok: ok != null && ok.toString() == "true",
    user: user,
    credential: credentialCookie == null ? "" : credentialCookie.toString(),
    refreshToken: refreshToken == null ? "" : refreshToken.toString(),
  };
}

/**
 * 灌入/清除登录态（数据包引擎的内存工作副本）。持久真源在 uni storage，
 * 这里只是把「当前该不该用」投给数据包。
 */
export async function authSetCredential(scope: SourceAuthScope, source: string, cookie: string): Promise<void> {
  const args = new UTSJSONObject();
  args.set("scope", scope);
  args.set("source", source);
  args.set("cookie", cookie);
  await authInvoke("setAuth", args);
}

/** 清除登录态：source=null = 清整个面（历史口径保留；按源开关时代不再使用） */
export async function authClearCredential(scope: SourceAuthScope, source: string | null): Promise<void> {
  const args = new UTSJSONObject();
  args.set("scope", scope);
  if (source != null) args.set("source", source);
  await authInvoke("clearAuth", args);
}

// ---------- 凭据轮换（副键合并） ----------

/**
 * 轮换落库时的 extras 合并：旧键保留（包侧可能还带别的副键），refresh_token
 * 有新值则覆盖；空值键一律剔除、全空 → ""（与账号解析侧口径一致：记录形状
 * 与旧版本一致，不写空对象/空值键）。
 */
export function mergeCredentialExtras(prevJson: string, refreshToken: string): string {
  const out = new UTSJSONObject();
  if (prevJson.length > 0) {
    try {
      const prev = parseJsonToUtso(prevJson);
      const keys = UTSJSONObject.keys(prev);
      for (let i = 0; i < keys.length; i++) {
        const value = prev.get(keys[i]);
        if (value != null && value.toString().length > 0) out.set(keys[i], value.toString());
      }
    } catch (_) {
      // 静默：旧 extras 坏 JSON 整体丢弃，轮换出的新副键仍会写入
    }
  }
  if (refreshToken.length > 0) out.set("refresh_token", refreshToken);
  if (UTSJSONObject.keys(out).length == 0) return "";
  return JSON.stringify(out);
}

// ---------- 注入编排 ----------

/**
 * 单源应用（按源逐面对账）：有凭据的面按开关 set，开关关的面显式 clear——
 * 清单源单面而不是整面，别的源不受牵连。无凭据时两面清干净（引擎里可能
 * 残留旧副本）。失败抛给调用方决定提示。
 */
async function applySourceAuthForSource(source: string): Promise<void> {
  const entries = readSourceAuthEntries();
  let account: SourceAuthAccount | null = null;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].source == source) {
      account = entries[i].account;
      break;
    }
  }
  if (account == null) {
    await authClearCredential("meta", source);
    await authClearCredential("play", source);
    return;
  }
  const toggles = readSourceAuthTogglesFor(source);
  if (toggles.useMeta) await authSetCredential("meta", source, account.cookie);
  else await authClearCredential("meta", source);
  if (toggles.usePlay) await authSetCredential("play", source, account.cookie);
  else await authClearCredential("play", source);
}

/**
 * 全量重灌（引擎（重）装数据包后的对账动作）：逐源按开关对账。静默失败：
 * 注入失败不该打断启动/换包流程，下一次触发时机（装载成功钩子）会再试。
 * 重灌完成后广播登录态变化：注册表据此重查包侧 getSourceQualities 判定
 * 官方清单——不广播的话，导入新包/引擎重建后音质档案会停留在重灌前那次
 * 「无凭据 → platform」的结果上（PC 2026-10-25 QQ 下拉不切官方档的根因）。
 */
export async function ensureSourceAuthInjected(): Promise<void> {
  try {
    const entries = readSourceAuthEntries();
    for (let i = 0; i < entries.length; i++) {
      await applySourceAuthForSource(entries[i].source);
    }
    uni.$emit(SOURCE_AUTH_CHANGED_EVENT);
  } catch (_) {
    // 静默：引擎未就绪/旧包缺入口，交给装载成功钩子的下一次重放
  }
}

// ---------- 后台保活（凭据轮换） ----------

/** 进行中的全量保活（模块级锁：启动首检/前台节流/账号页校验同时触发只跑
 *  一轮，进行中的调用复用同一个 Promise，拿到同一份统计结果） */
let keepaliveInFlight: Promise<KeepaliveStats> | null = null;

/**
 * 全量校验 + 凭据轮换（后台保活主流程）：逐源用已存凭据（连同 extras 副键）
 * 查登录态；包侧轮换出新 cookie 时经 saveSourceAuthAccount 落库（引擎内存副本
 * 随保存同步注入），其余情况跳过不动：
 * - 未轮换（credential 为空）：凭据仍有效，不写库；
 * - ok=false（凭据失效）：跳过且**不删账号**——绝不自动退出，账号页会标
 *   「凭据已过期」引导用户自行重新登录；
 * - 单源失败（网络/旧包缺入口）只静默跳过，不影响其余源。
 */
export function refreshAllSourceAccounts(reason: string): Promise<KeepaliveStats> {
  if (keepaliveInFlight != null) return keepaliveInFlight;
  keepaliveInFlight = doRefreshAllSourceAccounts(reason);
  keepaliveInFlight
    .then((_: KeepaliveStats): void => {
      keepaliveInFlight = null;
    })
    .catch((_: any | null): void => {
      keepaliveInFlight = null;
    });
  return keepaliveInFlight;
}

async function doRefreshAllSourceAccounts(reason: string): Promise<KeepaliveStats> {
  const entries = readSourceAuthEntries();
  let rotated = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const r = await authCheckUser(entry.source, entry.account.cookie, entry.account.extrasJson);
      // 失效跳过不删 / 未轮换跳过不写
      if (!r.ok || r.credential.length == 0) continue;
      const user = r.user != null ? r.user : entry.account.user;
      const extrasJson = mergeCredentialExtras(entry.account.extrasJson, r.refreshToken);
      await saveSourceAuthAccount(entry.source, r.credential, user, extrasJson);
      rotated += 1;
    } catch (_) {
      // 静默：单源失败（网络/旧包缺入口）跳过不打扰用户，不影响其余源
    }
  }
  return { checked: entries.length, rotated: rotated };
}

/**
 * 节流后的后台保活入口（App 启动首检 + 每次回前台触发）：
 * - force=true（启动 20s 首检）：无视节流直接跑；
 * - 其余调用：冷启动窗口（模块装载后 25s 内）跳过——冷启动归 20s 首检独占，
 *   避免同一轮冷启动跑两遍；距上次实际运行不足 24h 也跳过（App 每次回前台
 *   都会触发，节流防耗电；PC 是 6h setInterval，移动端后台定时器会被系统
 *   冻结，改 onShow 节流更可靠）。
 * 节流水位在**开跑时**落库：跑失败（断网/引擎未就绪）也消耗本窗口——保活
 * 是机会性后台卫生，防止死循环重试打死网络；用户可见的兜底是进账号页时的
 * 逐源校验（不节流）。
 */
export function keepaliveSourceAccounts(reason: string, force: boolean): void {
  if (!force) {
    if (Date.now() < moduleLoadAtMs + KEEPALIVE_COLD_START_MS) return;
    const last = storageText(KEEPALIVE_AT_KEY);
    if (last != null) {
      const lastAt = parseInt(last);
      if (!isNaN(lastAt) && Date.now() - lastAt < KEEPALIVE_INTERVAL_MS) return;
    }
  }
  storageWrite(KEEPALIVE_AT_KEY, String(Date.now()));
  void refreshAllSourceAccounts(reason).catch((_: any | null): void => {
    // 总失败（读库等）静默：下一轮 onShow 节流窗口后再试
  });
}

// ---------- 账号歌单（v18 / 包 meta-entries v14） ----------

/**
 * 平台侧一条歌单（accountPlaylists 的条目形状）。
 * picUrl 空串 = 包侧没给封面；trackCount < 0 = 包侧没给数量——
 * PC 侧这两个字段是可选的，UTS 的可选字段赋值坑多，拍平成哨兵值更稳。
 */
export type SourceAccountPlaylist = {
  id: string;
  name: string;
  picUrl: string;
  trackCount: number;
  /** true = 平台侧自建歌单；false = 平台侧收藏的（别人的）歌单 */
  owned: boolean;
};

/** v18 入口的缺包提示：accountPlaylists 需要 2026.10.26.3 / META_REVISION 14 及以上的包 */
function packOutdatedV18(entry: string): Error {
  return new Error(
    "数据包版本过旧：缺少 " +
      entry +
      " 入口（需要 2026.10.26.3 / META_REVISION 14 及以上的数据包），请到「设置 → 音源包管理」更新后重试",
  );
}

/**
 * 拉取登录账户在平台侧的歌单清单（v18）。包侧应答 { list: [...] }：
 * 只收 id/name 非空串的条目（形状坏/字段缺的丢弃），顺序保持包侧下发序。
 * 未登录 / 包旧 / 网络错误原样抛，由调用方决定文案——本函数不做兜底。
 */
export async function accountPlaylists(source: string): Promise<SourceAccountPlaylist[]> {
  const args = new UTSJSONObject();
  args.set("source", source);
  let raw = "";
  try {
    raw = await invokeSource("accountPlaylists", JSON.stringify([args]));
  } catch (e) {
    // 缺入口 = 包旧：换 v18 专用提示（带需要的包版本），其余错误原样上抛
    const message = e instanceof Error ? e.message : String(e);
    if (isMissingEntryError(message)) throw packOutdatedV18("accountPlaylists");
    throw e;
  }
  const response = parseJsonToUtso(raw);
  const list = response.get("list") as UTSJSONObject[] | null;
  const out: SourceAccountPlaylist[] = [];
  if (list == null) return out;
  for (let i = 0; i < list.length; i++) {
    const item = list[i] as UTSJSONObject;
    const id = item.get("id");
    const name = item.get("name");
    if (id == null || id.toString().length == 0) continue;
    if (name == null || name.toString().length == 0) continue;
    const picUrl = item.get("picUrl");
    const trackCount = item.get("trackCount");
    const countNum = trackCount == null ? -1 : parseInt(trackCount.toString());
    const owned = item.get("owned");
    out.push({
      id: id.toString(),
      name: name.toString(),
      picUrl: picUrl == null ? "" : picUrl.toString(),
      trackCount: !isNaN(countNum) && countNum >= 0 ? countNum : -1,
      owned: owned != null && owned.toString() == "true",
    });
  }
  return out;
}

// 引擎每次（重）装 meta（冷启动预热/换包/引擎重建）后重灌登录态。模块级
// 注册（与 stores/source-registry.ts 的模块级监听同一套路）：只要本文件被
// import（App.uvue 启动即引用），钩子先于任何装载就位。
setMetaAuthHook((): void => {
  void ensureSourceAuthInjected();
});

// 模块初始化即做口径迁移（先于任何读取）
ensureTogglesSchema();
