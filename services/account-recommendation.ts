import type { Song } from "@/types/music";
import type { RecommendationKind } from "@/stores/recommendation-source";
import { useSourceRegistryStore } from "@/stores/source-registry";
import { readSourceMetaAuthIdentity, sourceMetaAuthCurrent, sourceMetaAuthAcknowledged, ensureSourceMetaAuthInjected } from "./source-auth";
import type { SourceMetaAuthIdentity } from "./source-auth";
import { ensureDataEngine, invokeSource, sourceEngineEpoch, sourceMetaRevision, sourceMetaCurrent } from "./source-engine";
import { activeMetaPack, ensureLocalStateRestored } from "./source-bundle-fs";
import { sourceEnabled, sourcePolicyRevision } from "./source-policy";
import { parseJsonToUtso } from "./http";

/** No credential, credential hash, native working value or package payload may enter this context. */
export type AccountRecommendationContext = {
  sourceId: string;
  kind: RecommendationKind;
  accountId: string;
  nickname: string;
  accountSession: string;
  authRevision: number;
  metaAuthRevision: number;
  metaRevision: string;
  policyRevision: number;
  engineEpoch: string;
};
export type AccountRecommendationBatch = {
  source: string;
  kind: RecommendationKind;
  accountId: string;
  items: Song[];
  fetchedAt: number;
  cursor?: string;
  expiresAt?: number;
  exhausted?: boolean;
};
const REQUEST_TIMEOUT_MS = 30000;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const ERROR_CODES = ["UNSUPPORTED", "AUTH_REQUIRED", "AUTH_EXPIRED", "ACCOUNT_MISMATCH", "AUTH_CHANGED",
  "NETWORK", "RATE_LIMIT", "UPSTREAM", "MALFORMED_RESPONSE", "INVALID_ARGS", "TIMEOUT", "SOURCE_DISABLED"];
function failure(code: string): Error {
  return new Error("ACCOUNT_RECOMMENDATIONS_" + (ERROR_CODES.indexOf(code) >= 0 ? code : "UPSTREAM"));
}
function errorCode(error: any): string {
  let message = "";
  if (typeof error == "string") message = error;
  else if (error != null && typeof error.message == "string") message = error.message;
  const match = /^(?:Error:\s*)?ACCOUNT_RECOMMENDATIONS_([A-Z_]+)(?::|$)/.exec(message);
  if (match != null && ERROR_CODES.indexOf(match[1]) >= 0) return match[1];
  if (message.indexOf("入口不存在") >= 0 || message.indexOf("缺少") >= 0 || message.indexOf("数据包版本过旧") >= 0) return "UNSUPPORTED";
  return "UPSTREAM";
}
/** Display only this whitelist; package/native exception suffixes may contain URLs or credentials. */
export function accountRecommendationErrorMessage(error: any): string {
  const code = errorCode(error);
  if (code == "UNSUPPORTED") return "该音源暂不支持此账号推荐能力，请更新数据包或使用应用算法";
  if (code == "AUTH_REQUIRED") return "账号推荐需要先登录并授权数据请求使用登录态";
  if (code == "AUTH_EXPIRED") return "账号登录态已失效，请重新登录";
  if (code == "ACCOUNT_MISMATCH") return "平台校验身份与所选账号不一致";
  if (code == "AUTH_CHANGED") return "推荐请求期间账号授权或数据包已变化，请重试";
  if (code == "NETWORK") return "账号推荐网络请求失败，请稍后重试";
  if (code == "RATE_LIMIT") return "账号推荐平台限制请求频率，请稍后重试";
  if (code == "MALFORMED_RESPONSE") return "账号推荐平台应答结构无效";
  if (code == "INVALID_ARGS") return "账号推荐参数无效";
  if (code == "TIMEOUT") return "账号推荐请求超时，请稍后重试";
  if (code == "SOURCE_DISABLED") return "该音乐源已关闭，请在音乐源设置中启用后重试";
  return "账号推荐平台应答失败，请稍后重试";
}
export function isAccountRecommendationStale(error: any): boolean { return errorCode(error) == "AUTH_CHANGED"; }
function identityOf(context: AccountRecommendationContext): SourceMetaAuthIdentity {
  return { sourceId: context.sourceId, accountId: context.accountId, nickname: context.nickname,
    accountSession: context.accountSession, authRevision: context.authRevision, metaAuthRevision: context.metaAuthRevision };
}
function contextIdentityCurrent(context: AccountRecommendationContext): boolean {
  return context != null && (context.kind == "daily" || context.kind == "fm")
    && sourceEnabled(context.sourceId) && context.policyRevision == sourcePolicyRevision()
    && context.engineEpoch == sourceEngineEpoch() && sourceMetaCurrent(context.metaRevision)
    && sourceMetaAuthCurrent(identityOf(context));
}
export function accountRecommendationContextCurrent(context: AccountRecommendationContext): boolean {
  return contextIdentityCurrent(context) && sourceMetaAuthAcknowledged(identityOf(context))
    && useSourceRegistryStore().supportsAccountRecommendation(context.sourceId, context.kind);
}
function activePackRevision(): string {
  const pack = activeMetaPack();
  return pack == null ? "" : JSON.stringify([pack.id, pack.versionCode, pack.updatedAt]);
}

/** Preparation never validates an account via HTTP: only local registry and existing setAuth injection. */
export function prepareAccountRecommendationContext(sourceId: string, kind: RecommendationKind): Promise<AccountRecommendationContext> {
  return new Promise<AccountRecommendationContext>((resolve, reject) => {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      active = false;
      reject(failure("TIMEOUT"));
    }, REQUEST_TIMEOUT_MS);
    const work = async (): Promise<AccountRecommendationContext> => {
      if (!SOURCE_ID.test(sourceId) || (kind != "daily" && kind != "fm")) throw failure("INVALID_ARGS");
      // 用户 2026-11-14：账号日推/私人 FM 对齐桌面四源口径，不再单独禁用 KG FM——
      // 能力只认注册表 accountRecommendations 的显式声明（supportsAccountRecommendation 仍 fail-closed）；
      // KG FM 由音源包内只读 login 批次供给，无 play/hash/playtime 反馈。
      if (!sourceEnabled(sourceId)) throw failure("SOURCE_DISABLED");
      const identity = readSourceMetaAuthIdentity(sourceId);
      if (identity == null || !sourceMetaAuthCurrent(identity)) throw failure("AUTH_REQUIRED");
      if (identity.accountId.length == 0 || identity.accountId != identity.accountId.trim()) throw failure("INVALID_ARGS");
      const policyRevision = sourcePolicyRevision();
      const epoch = sourceEngineEpoch();
      const identityCurrent = (): boolean => active && Date.now() < deadline && sourceMetaAuthCurrent(identity)
        && sourceEnabled(sourceId) && policyRevision == sourcePolicyRevision() && epoch == sourceEngineEpoch();
      const checkIdentity = (): void => {
        if (Date.now() >= deadline) throw failure("TIMEOUT");
        if (!identityCurrent()) throw failure("AUTH_CHANGED");
      };
      checkIdentity();
      await ensureLocalStateRestored();
      checkIdentity();
      const packRevision = activePackRevision();
      if (packRevision.length == 0) throw failure("UNSUPPORTED");
      if (!(await ensureDataEngine())) throw failure("UNSUPPORTED");
      checkIdentity();
      if (packRevision != activePackRevision()) throw failure("AUTH_CHANGED");
      const context: AccountRecommendationContext = { sourceId, kind, accountId: identity.accountId,
        nickname: identity.nickname, accountSession: identity.accountSession, authRevision: identity.authRevision,
        metaAuthRevision: identity.metaAuthRevision, metaRevision: sourceMetaRevision(), policyRevision, engineEpoch: epoch };
      const current = (): boolean => active && Date.now() < deadline && contextIdentityCurrent(context);
      if (!current()) throw failure("AUTH_CHANGED");
      const registry = useSourceRegistryStore();
      await registry.ensure();
      if (!current()) throw failure("AUTH_CHANGED");
      if (!registry.supportsAccountRecommendation(sourceId, kind)) throw failure("UNSUPPORTED");
      await ensureSourceMetaAuthInjected(identity, current);
      if (!active || !accountRecommendationContextCurrent(context)) throw failure("AUTH_CHANGED");
      return context;
    };
    void work().then((context: AccountRecommendationContext) => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      if (Date.now() >= deadline) reject(failure("TIMEOUT"));
      else if (!accountRecommendationContextCurrent(context)) reject(failure("AUTH_CHANGED"));
      else resolve(context);
    }, (error: any) => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      reject(failure(Date.now() >= deadline ? "TIMEOUT" : errorCode(error)));
    });
  });
}

function finiteNumber(value: any): boolean { return typeof value == "number" && Number.isFinite(value); }
function hasField(value: UTSJSONObject, name: string): boolean { return UTSJSONObject.keys(value).indexOf(name) >= 0; }
/** Reject the entire malformed batch rather than silently dropping, sorting or deduplicating songs. */
function songFromAccount(item: UTSJSONObject, source: string): Song {
  if (item == null || typeof item != "object" || Array.isArray(item)) throw failure("MALFORMED_RESPONSE");
  const id = item.get("id");
  const name = item.get("name");
  const singer = item.get("singer");
  const album = item.get("album");
  const picUrl = item.get("picUrl");
  const interval = item.get("interval");
  if (typeof id != "string" || id.length == 0 || typeof name != "string" || typeof singer != "string"
    || typeof album != "string" || typeof picUrl != "string" || !finiteNumber(interval)) throw failure("MALFORMED_RESPONSE");
  const song: Song = { id, name, singer, album, picUrl, platform: source, duration: interval as number };
  if (hasField(item, "musicId")) {
    const value = item.get("musicId");
    if (value != null && typeof value != "string") throw failure("MALFORMED_RESPONSE");
    // MusicInfo permits an explicitly supplied null; absence is kept distinct.
    song.musicId = value == null ? null : value as string;
  }
  if (hasField(item, "version")) {
    const value = item.get("version");
    if (typeof value != "string") throw failure("MALFORMED_RESPONSE");
    song.version = value;
  }
  if (hasField(item, "isrc")) {
    const value = item.get("isrc");
    if (typeof value != "string") throw failure("MALFORMED_RESPONSE");
    song.isrc = value;
  }
  if (hasField(item, "durationReliable")) {
    const value = item.get("durationReliable");
    if (typeof value != "boolean") throw failure("MALFORMED_RESPONSE");
    song.durationReliable = value;
  }
  return song;
}
function batchFromAccount(raw: string, context: AccountRecommendationContext): AccountRecommendationBatch {
  let response: UTSJSONObject;
  try { response = parseJsonToUtso(raw); } catch (_) { throw failure("MALFORMED_RESPONSE"); }
  if (response == null || typeof response != "object" || Array.isArray(response)) throw failure("MALFORMED_RESPONSE");
  if (response.get("source") !== context.sourceId || response.get("kind") !== context.kind
    || response.get("accountId") !== context.accountId) throw failure("ACCOUNT_MISMATCH");
  const items = response.get("items") as UTSJSONObject[] | null;
  const fetchedAt = response.get("fetchedAt");
  if (!Array.isArray(items) || !finiteNumber(fetchedAt)) throw failure("MALFORMED_RESPONSE");
  const songs: Song[] = [];
  for (let i = 0; i < items.length; i++) songs.push(songFromAccount(items[i], context.sourceId));
  const batch: AccountRecommendationBatch = { source: context.sourceId, kind: context.kind,
    accountId: context.accountId, items: songs, fetchedAt: fetchedAt as number };
  if (hasField(response, "cursor")) {
    const cursor = response.get("cursor");
    if (typeof cursor != "string") throw failure("MALFORMED_RESPONSE");
    batch.cursor = cursor;
  }
  if (hasField(response, "expiresAt")) {
    const expiresAt = response.get("expiresAt");
    if (!finiteNumber(expiresAt)) throw failure("MALFORMED_RESPONSE");
    batch.expiresAt = expiresAt as number;
  }
  if (hasField(response, "exhausted")) {
    const exhausted = response.get("exhausted");
    if (typeof exhausted != "boolean") throw failure("MALFORMED_RESPONSE");
    batch.exhausted = exhausted;
  }
  return batch;
}
function snapshotContext(context: AccountRecommendationContext): AccountRecommendationContext {
  return { sourceId: context.sourceId, kind: context.kind, accountId: context.accountId, nickname: context.nickname,
    accountSession: context.accountSession, authRevision: context.authRevision, metaAuthRevision: context.metaAuthRevision,
    metaRevision: context.metaRevision, policyRevision: context.policyRevision, engineEpoch: context.engineEpoch };
}
async function fetchAccount(context: AccountRecommendationContext, kind: RecommendationKind, cursor?: string,
  extraCurrent: (() => boolean) | null = null): Promise<AccountRecommendationBatch> {
  if (context == null || context.kind != kind || (cursor != null && typeof cursor != "string")) throw failure("INVALID_ARGS");
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const owned = snapshotContext(context);
  const current = (): boolean => {
    try { return Date.now() < deadline && accountRecommendationContextCurrent(owned) && (extraCurrent == null || extraCurrent()); }
    catch (_) { return false; }
  };
  const expiredOrStale = (): Error => failure(Date.now() >= deadline ? "TIMEOUT" : "AUTH_CHANGED");
  if (!current()) throw expiredOrStale();
  const args = new UTSJSONObject();
  args.set("source", owned.sourceId);
  args.set("accountId", owned.accountId);
  if (cursor != null) args.set("cursor", cursor);
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure("TIMEOUT");
    const raw = await invokeSource(kind == "daily" ? "accountDailySongs" : "accountFmNext", JSON.stringify([args]), remaining, current);
    if (!current()) throw expiredOrStale();
    const batch = batchFromAccount(raw, owned);
    if (!current()) throw expiredOrStale();
    return batch;
  } catch (error) {
    throw failure(Date.now() >= deadline ? "TIMEOUT" : !current() ? "AUTH_CHANGED" : errorCode(error));
  }
}
export function fetchAccountDailySongs(context: AccountRecommendationContext, extraCurrent: (() => boolean) | null = null): Promise<AccountRecommendationBatch> {
  return fetchAccount(context, "daily", undefined, extraCurrent);
}
export function fetchAccountFmNext(context: AccountRecommendationContext, cursor?: string, extraCurrent: (() => boolean) | null = null): Promise<AccountRecommendationBatch> {
  return fetchAccount(context, "fm", cursor, extraCurrent);
}
