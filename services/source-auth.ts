/**
 * 音源账号登录（v9 数据包契约）：凭据的持久真源（uni storage）+
 * 「数据/播放两面是否使用登录态」开关 + 向数据包引擎的懒注入 + 登录动作门面。
 * 与 qt-pc/src/lib/source-auth.ts + source-scripts 的 auth 门面同语义。
 * v10 追加：sourcePlayLoginActive（播放面登录态判定）——注册表声明
 * officialQualities 的源，登录态生效时音质选择整体切官方档位清单
 * （stores/source-registry.ts 消费），本模块无独立音质配置表。
 *
 * 职责边界（与数据包内 auth-store 分工）：
 * - 这里是**持久层**：Cookie 与用户信息只存本机 uni storage（不进任何网络
 *   上报），卸载重装数据包、重启应用都不丢；数据包内只有引擎内存工作副本，
 *   引擎每次（重）装 meta（冷启动预热/换包/引擎重建，全部经 loadMetaIntoEngine）
 *   都从零开始，所以注入必须跟着「meta 装载成功」重放（setMetaAuthHook 钩子）。
 * - 「是否使用登录态」体现在**灌不灌**：开关关闭 = clearAuth 整面（数据包
 *   收到的是「这些请求一律匿名」），不是灌了再让包内忽略。
 * - 首次保存账号时把两面开关初始化为开——登录了却默认不用，用户会以为
 *   登录没生效；要不用自己关。
 *
 * 本文件是 .ts（编译后走原生 JSON.parse，产物无 .get）：存储/引擎应答的
 * 解析一律经 parseJsonToUtso 重建 UTSJSONObject（见 music-api.ts 同款说明）。
 */
import { parseJsonToUtso } from "./http";
import { invokeSource, setMetaAuthHook } from "./source-engine";

// ---------- 键与事件 ----------

/** 已登录账号表（JSON：{ 源id: {cookie,user,savedAt} }；凭据只存本机） */
const ACCOUNTS_KEY = "qt-source-auth-accounts";
/** 数据面（搜索/歌单/歌词等）是否使用登录态："true"/"false" */
const USE_META_KEY = "qt-source-auth-use-meta";
/** 播放面（在线播放取链）是否使用登录态："true"/"false" */
const USE_PLAY_KEY = "qt-source-auth-use-play";

/** 账号/开关变化后广播；账号页与其他关心登录态的界面监听刷新 */
export const SOURCE_AUTH_CHANGED_EVENT = "qt-source-auth-changed";

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
};

/** 账号条目（source = 源 id；数组形状便于页面直接 v-for） */
export type SourceAuthEntry = { source: string; account: SourceAuthAccount };

/** 两面开关（从未配置过时双 false；首次保存账号会初始化为双开） */
export type SourceAuthToggles = { useMeta: boolean; usePlay: boolean };

/** 扫码会话（image 为包内生成的 PNG data URI，凭据不外发第三方） */
export type SourceQrSession = { key: string; image: string; expiresInSec: number };

/**
 * 扫码轮询结果。confirmed 必带 cookie 与 user；无效确认（缺凭据/缺用户）
 * 归一成 expired，页面按「引导重新生成二维码」处理。不用可辨识联合：
 * UTS 对字面量联合的收窄不可靠，扁平 + nullable 字段是全仓 .ts 的稳妥形状。
 */
export type SourceQrPoll = {
  status: string; // waiting / scanned / expired / confirmed
  cookie: string;
  user: SourceAuthUser | null;
};

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
    // 存不进去时保持静默：本次会话内调用方已拿到返回值，重启后回到缺省
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

// ---------- 持久层 ----------

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
      out.push({
        source: source,
        account: { cookie: cookie.toString(), user: user, savedAt: savedAt == null ? "" : savedAt.toString() },
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
    obj.set(e.source, account);
  }
  storageWrite(ACCOUNTS_KEY, JSON.stringify(obj));
}

/** 读两面开关。未配置（从未登录过）= 双 false；首登初始化见 saveSourceAuthAccount */
export function readSourceAuthToggles(): SourceAuthToggles {
  const meta = storageText(USE_META_KEY);
  const play = storageText(USE_PLAY_KEY);
  return { useMeta: meta == "true", usePlay: play == "true" };
}

/**
 * 保存/覆盖一个源的登录：落库 + 首登初始化双开 + 按当前开关立即注入该源。
 * 注入失败不回滚存储：装载成功钩子会在引擎可用后重放对账。
 */
export async function saveSourceAuthAccount(source: string, cookie: string, user: SourceAuthUser): Promise<void> {
  const account: SourceAuthAccount = { cookie: cookie, user: user, savedAt: nowIso() };
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
  // 首登初始化双开：两键都从未写过才算「从未配置」（防手改存储造成的半配置态）
  const metaSet = storageText(USE_META_KEY);
  const playSet = storageText(USE_PLAY_KEY);
  if (metaSet == null && playSet == null) {
    storageWrite(USE_META_KEY, "true");
    storageWrite(USE_PLAY_KEY, "true");
  }
  uni.$emit(SOURCE_AUTH_CHANGED_EVENT);
  await applySourceAuthForSource(source, account);
}

/** 退出一个源的登录：清凭据 + 两面都清掉该源的注入 */
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
    // 引擎未就绪/旧包缺入口：内存副本随下次注入自然对齐（库里已删）
  }
}

/** 切换一面开关并立即生效：开 = 重灌该面全部账号；关 = 清整面 */
export async function setSourceAuthToggle(scope: SourceAuthScope, on: boolean): Promise<void> {
  storageWrite(scope == "meta" ? USE_META_KEY : USE_PLAY_KEY, on ? "true" : "false");
  uni.$emit(SOURCE_AUTH_CHANGED_EVENT);
  await applySourceAuthScope(scope);
}

// ---------- 官方线路档位（v10：登录态下档位展示整体切官方清单） ----------

/**
 * 该源播放面登录态是否生效（同步读，与包侧官方前置线路的启用口径一致）：
 * 有该源账号 且 播放面开关开着。开关是全局一对（uniappx 无按源开关），
 * 所以「关播放登录态」会同时收回全部源的官方档位展示。账号/开关变化时
 * 调用方已广播 SOURCE_AUTH_CHANGED_EVENT，档位展示监听它重算。
 */
export function sourcePlayLoginActive(source: string): boolean {
  const toggles = readSourceAuthToggles();
  if (!toggles.usePlay) return false;
  const entries = readSourceAuthEntries();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].source == source) return true;
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
  if (s == "waiting" || s == "scanned") return { status: s, cookie: "", user: null };
  if (s != "confirmed") return { status: "expired", cookie: "", user: null };
  const credential = r.get("credential") as UTSJSONObject | null;
  const cookie = credential != null ? credential.get("cookie") : null;
  const user = normalizeUser(r.get("user") as UTSJSONObject | null);
  // 确认了却缺凭据/缺用户：按过期处理，页面引导重新生成二维码
  if (cookie == null || cookie.toString().length == 0 || user == null) {
    return { status: "expired", cookie: "", user: null };
  }
  return { status: "confirmed", cookie: cookie.toString(), user: user };
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

/** 用已存 Cookie 查登录态（进账号页时验证凭据是否仍有效；失效标灰提示重登） */
export async function authCheckUser(source: string, cookie: string): Promise<SourceAuthUser | null> {
  const args = new UTSJSONObject();
  args.set("source", source);
  args.set("cookie", cookie);
  const r = await authInvoke("authUser", args);
  const ok = r.get("ok");
  if (ok == null || ok.toString() != "true") return null;
  return normalizeUser(r.get("user") as UTSJSONObject | null);
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

/** 清除登录态：source=null = 清整个面（对应「关掉该面开关」） */
export async function authClearCredential(scope: SourceAuthScope, source: string | null): Promise<void> {
  const args = new UTSJSONObject();
  args.set("scope", scope);
  if (source != null) args.set("source", source);
  await authInvoke("clearAuth", args);
}

// ---------- 注入编排 ----------

/** 单面应用：开 = 逐源 setAuth；关 = clearAuth 整面。失败抛给调用方决定提示 */
async function applySourceAuthScope(scope: SourceAuthScope): Promise<void> {
  const toggles = readSourceAuthToggles();
  const on = scope == "meta" ? toggles.useMeta : toggles.usePlay;
  if (!on) {
    await authClearCredential(scope, null);
    return;
  }
  const entries = readSourceAuthEntries();
  for (let i = 0; i < entries.length; i++) {
    await authSetCredential(scope, entries[i].source, entries[i].account.cookie);
  }
}

/** 单源应用：哪面开着就灌哪面（登录/导入成功后的即时生效路径） */
async function applySourceAuthForSource(source: string, account: SourceAuthAccount): Promise<void> {
  const toggles = readSourceAuthToggles();
  try {
    if (toggles.useMeta) await authSetCredential("meta", source, account.cookie);
    if (toggles.usePlay) await authSetCredential("play", source, account.cookie);
  } catch (_) {
    // 引擎未就绪/旧包缺入口：装载成功钩子会在引擎可用后重放对账
  }
}

/**
 * 全量重灌（引擎（重）装数据包后的对账动作）。静默失败：注入失败不该打断
 * 启动/换包流程，下一次触发时机（装载成功钩子）会再试。
 */
export async function ensureSourceAuthInjected(): Promise<void> {
  try {
    const entries = readSourceAuthEntries();
    if (entries.length == 0) return;
    const toggles = readSourceAuthToggles();
    if (toggles.useMeta) {
      for (let i = 0; i < entries.length; i++) {
        await authSetCredential("meta", entries[i].source, entries[i].account.cookie);
      }
    }
    if (toggles.usePlay) {
      for (let i = 0; i < entries.length; i++) {
        await authSetCredential("play", entries[i].source, entries[i].account.cookie);
      }
    }
  } catch (_) {
    // 引擎未就绪/旧包缺入口：交给装载成功钩子的下一次重放
  }
}

// 引擎每次（重）装 meta（冷启动预热/换包/引擎重建）后重灌登录态。模块级
// 注册（与 stores/source-registry.ts 的模块级监听同一套路）：只要本文件被
// import（App.uvue 启动即引用），钩子先于任何装载就位。
setMetaAuthHook((): void => {
  void ensureSourceAuthInjected();
});
