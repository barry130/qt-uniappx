/** Account daily supply is already ordered by the official source; no app ranking. */
import {
  prepareAccountRecommendationContext,
  accountRecommendationContextCurrent,
  fetchAccountDailySongs,
  accountRecommendationErrorMessage,
} from "./account-recommendation";
import type { AccountRecommendationContext, AccountRecommendationBatch } from "./account-recommendation";
import {
  recommendationChoiceCurrent,
  readRecommendationChoice,
  recommendationChoiceRevision,
  RECOMMENDATION_SOURCE_CHANGED_EVENT,
} from "@/stores/recommendation-source";
import type { RecommendationChoice } from "@/stores/recommendation-source";
import { SOURCE_AUTH_CHANGED_EVENT } from "./source-auth";
import { SOURCE_PACKS_CHANGED_EVENT } from "./source-update";
import { SOURCE_POLICY_CHANGED_EVENT } from "./source-policy";
import { localDateKey } from "./recommend-text";
import { parseJsonToUtso } from "./http";
import type { DailyRecommendResult, GenerateOptions } from "./daily-recommend";
import type { Song } from "@/types/music";

export const ACCOUNT_DAILY_RECOMMEND_CACHE_KEY = "accountDailyRecommend.cache";
const CACHE_VERSION = 2;
const CACHE_TTL_MS = 30 * 60 * 1000;
type ReturnGuardObserver = (current: () => boolean) => void;
let generation = 0;
// Process-local slot tombstone; neither cache bodies nor credentials are retained.
let retiredGeneration: number | null = null;
function slotOwnerCurrent(choice: RecommendationChoice, revision: number, token: number): boolean {
  return token == generation && recommendationChoiceCurrent("daily", choice, revision);
}

/** Only independent lifecycle tokens, never credentials or their hashes. */
interface AccountDailyIdentity {
  sourceId: string;
  kind: "daily";
  accountId: string;
  accountSession: string;
  authRevision: number;
  metaAuthRevision: number;
  metaRevision: string;
  policyRevision: number;
  engineEpoch: string;
}
interface AccountDailyCache {
  v: number;
  identity: AccountDailyIdentity;
  choiceRevision: number;
  date: string;
  fetchedAt: number;
  receivedAt: number;
  expiresAt?: number;
  items: Song[];
}

function identityOf(context: AccountRecommendationContext): AccountDailyIdentity {
  return {
    sourceId: context.sourceId,
    kind: "daily",
    accountId: context.accountId,
    accountSession: context.accountSession,
    authRevision: context.authRevision,
    metaAuthRevision: context.metaAuthRevision,
    metaRevision: context.metaRevision,
    policyRevision: context.policyRevision,
    engineEpoch: context.engineEpoch,
  };
}
function contextOf(identity: AccountDailyIdentity): AccountRecommendationContext {
  return { ...identity, nickname: "" };
}
function sameIdentity(identity: AccountDailyIdentity, context: AccountRecommendationContext): boolean {
  return identity.sourceId == context.sourceId && context.kind == "daily" &&
    identity.accountId == context.accountId && identity.accountSession == context.accountSession &&
    identity.authRevision == context.authRevision && identity.metaAuthRevision == context.metaAuthRevision &&
    identity.metaRevision == context.metaRevision && identity.policyRevision == context.policyRevision &&
    identity.engineEpoch == context.engineEpoch;
}
function validRevision(value: any): boolean {
  return typeof value == "number" && Number.isFinite(value) && value >= 0;
}
function readIdentity(raw: UTSJSONObject | null): AccountDailyIdentity | null {
  if (raw == null || typeof raw != "object" || Array.isArray(raw)) return null;
  const sourceId = raw.get("sourceId"), kind = raw.get("kind"), accountId = raw.get("accountId");
  const accountSession = raw.get("accountSession"), metaRevision = raw.get("metaRevision"), engineEpoch = raw.get("engineEpoch");
  const authRevision = raw.get("authRevision"), metaAuthRevision = raw.get("metaAuthRevision"), policyRevision = raw.get("policyRevision");
  if (kind != "daily" || typeof sourceId != "string" || sourceId.length == 0 ||
      typeof accountId != "string" || accountId.length == 0 || typeof accountSession != "string" || accountSession.length == 0 ||
      typeof metaRevision != "string" || metaRevision.length == 0 || typeof engineEpoch != "string" || engineEpoch.length == 0 ||
      !validRevision(authRevision) || !validRevision(metaAuthRevision) || !validRevision(policyRevision)) return null;
  return { sourceId, kind: "daily", accountId, accountSession, metaRevision, engineEpoch,
    authRevision: authRevision as number, metaAuthRevision: metaAuthRevision as number, policyRevision: policyRevision as number };
}

/** Rebuild only MusicInfo-mapped Song fields; raw credentials/playback extensions cannot persist. */
function hasField(raw: any, name: string, cached: boolean = false): boolean {
  return (cached ? UTSJSONObject.keys(raw as UTSJSONObject) : Object.keys(raw)).indexOf(name) >= 0;
}
function copySong(raw: any, cached: boolean = false): Song | null {
  if (raw == null || typeof raw != "object" || Array.isArray(raw)) return null;
  const id = cached ? (raw as UTSJSONObject).get("id") : (raw as Song).id;
  const name = cached ? (raw as UTSJSONObject).get("name") : (raw as Song).name;
  const singer = cached ? (raw as UTSJSONObject).get("singer") : (raw as Song).singer;
  const album = cached ? (raw as UTSJSONObject).get("album") : (raw as Song).album;
  const picUrl = cached ? (raw as UTSJSONObject).get("picUrl") : (raw as Song).picUrl;
  const platform = cached ? (raw as UTSJSONObject).get("platform") : (raw as Song).platform;
  const duration = cached ? (raw as UTSJSONObject).get("duration") : (raw as Song).duration;
  if (typeof id != "string" || id.length == 0 || typeof name != "string" || typeof singer != "string" ||
      typeof album != "string" || typeof picUrl != "string" || typeof platform != "string" ||
      typeof duration != "number" || !Number.isFinite(duration)) return null;
  const song: Song = { id, name, singer, album, picUrl, platform, duration };
  if (hasField(raw, "musicId", cached)) {
    const value = cached ? (raw as UTSJSONObject).get("musicId") : (raw as Song).musicId;
    if (value !== null && typeof value != "string") return null;
    song.musicId = value == null ? null : value as string;
  }
  if (hasField(raw, "version", cached)) {
    const value = cached ? (raw as UTSJSONObject).get("version") : (raw as Song).version;
    if (typeof value != "string") return null;
    song.version = value;
  }
  if (hasField(raw, "isrc", cached)) {
    const value = cached ? (raw as UTSJSONObject).get("isrc") : (raw as Song).isrc;
    if (typeof value != "string") return null;
    song.isrc = value;
  }
  if (hasField(raw, "durationReliable", cached)) {
    const value = cached ? (raw as UTSJSONObject).get("durationReliable") : (raw as Song).durationReliable;
    if (typeof value != "boolean") return null;
    song.durationReliable = value;
  }
  return song;
}
function copySongs(raw: any, cached: boolean, sourceId: string): Song[] | null {
  if (!Array.isArray(raw)) return null;
  const items: Song[] = [];
  for (let i = 0; i < raw.length; i++) {
    const song = copySong(raw[i], cached);
    if (song == null || song.platform != sourceId) return null;
    items.push(song);
  }
  return items;
}
function readRawCache(): string {
  try {
    const raw = uni.getStorageSync(ACCOUNT_DAILY_RECOMMEND_CACHE_KEY);
    return typeof raw == "string" ? raw : "";
  } catch { return ""; }
}
function removeCache(expected: string, current: () => boolean): void {
  try {
    if (readRawCache() != expected || !current()) return;
    retiredGeneration = generation;
    uni.removeStorageSync(ACCOUNT_DAILY_RECOMMEND_CACHE_KEY);
  } catch { /* 静默：存储不可用不切换供应来源，已设置的退役代次继续拒绝旧缓存。 */ }
}
function parseCache(raw: string): AccountDailyCache | null {
  if (raw.length == 0) return null;
  try {
    const parsed = parseJsonToUtso(raw);
    if (parsed == null || typeof parsed != "object" || Array.isArray(parsed) || parsed.get("v") !== CACHE_VERSION) return null;
    const identity = readIdentity(parsed.get("identity") as UTSJSONObject | null);
    const choiceRevision = parsed.get("choiceRevision"), date = parsed.get("date");
    const fetchedAt = parsed.get("fetchedAt"), receivedAt = parsed.get("receivedAt");
    if (identity == null || !validRevision(choiceRevision) || typeof date != "string" ||
        typeof fetchedAt != "number" || !Number.isFinite(fetchedAt) ||
        typeof receivedAt != "number" || !Number.isFinite(receivedAt)) return null;
    const items = copySongs(parsed.get("items"), true, identity.sourceId);
    if (items == null) return null;
    const cache: AccountDailyCache = { v: CACHE_VERSION, identity, choiceRevision: choiceRevision as number, date, fetchedAt, receivedAt, items };
    if (hasField(parsed, "expiresAt", true)) {
      const expiresAt = parsed.get("expiresAt");
      if (typeof expiresAt != "number" || !Number.isFinite(expiresAt)) return null;
      cache.expiresAt = expiresAt;
    }
    return cache;
  } catch { return null; }
}
function cacheCurrent(cache: AccountDailyCache): boolean {
  const choice = { origin: "account", sourceId: cache.identity.sourceId } as RecommendationChoice;
  const now = Date.now();
  return cache.date == localDateKey(new Date()) && cache.receivedAt <= now && now - cache.receivedAt < CACHE_TTL_MS &&
    (cache.expiresAt == null || cache.expiresAt > now) &&
    recommendationChoiceCurrent("daily", choice, cache.choiceRevision) &&
    accountRecommendationContextCurrent(contextOf(cache.identity));
}
function pruneCache(): void {
  const token = generation, choice = readRecommendationChoice("daily"), revision = recommendationChoiceRevision("daily");
  const raw = readRawCache();
  if (raw.length == 0) return;
  try {
    const cache = parseCache(raw);
    if (retiredGeneration != null || cache == null || !cacheCurrent(cache)) removeCache(raw, (): boolean => slotOwnerCurrent(choice, revision, token));
  } catch { removeCache(raw, (): boolean => slotOwnerCurrent(choice, revision, token)); }
}
function assertCurrent(choice: RecommendationChoice, revision: number, date: string, token: number, context?: AccountRecommendationContext): void {
  if (choice.origin != "account" || !recommendationChoiceCurrent("daily", choice, revision)) {
    throw new Error("每日推荐来源已变化，请重新生成。");
  }
  if (token != generation) throw new Error("本次账号每日推荐已被新的操作替代。");
  if (date != localDateKey(new Date())) throw new Error("日期已变化，请重新获取今天的账号每日推荐。");
  if (context != null && !accountRecommendationContextCurrent(context)) {
    throw new Error("音源账号或授权已变化，请重新获取账号每日推荐。");
  }
}
function resultOf(cache: AccountDailyCache, context: AccountRecommendationContext): DailyRecommendResult {
  return {
    origin: "account",
    sourceId: context.sourceId,
    accountId: context.accountId,
    accountNickname: context.nickname,
    date: cache.date,
    mode: "rule",
    requested: "rule",
    taste: null,
    generatedAt: cache.fetchedAt,
    title: "账号每日推荐",
    summary: cache.items.length > 0 ? `官方账号推荐，共 ${cache.items.length} 首，保留音源返回顺序。` : "音源暂时没有返回账号每日推荐。",
    items: cache.items.map((song): { song: Song; reason: string } => ({ song, reason: "来自音源账号的官方每日推荐" })),
    notice: cache.items.length > 0 ? null : "暂无账号推荐歌曲，未切换到应用推荐。",
    profileText: null,
    model: null,
    styleLanes: [],
    coldStart: false,
    styleOptions: [],
    styleSeeds: [],
  };
}
function cachedFor(context: AccountRecommendationContext, choice: RecommendationChoice, revision: number, date: string, token: number, onCurrent: ReturnGuardObserver | null = null): DailyRecommendResult | null {
  assertCurrent(choice, revision, date, token, context);
  const raw = readRawCache();
  const cache = parseCache(raw);
  if (retiredGeneration != null || cache == null || !cacheCurrent(cache) || !sameIdentity(cache.identity, context)) {
    removeCache(raw, (): boolean => slotOwnerCurrent(choice, revision, token));
    return null;
  }
  const result = resultOf(cache, context);
  if (onCurrent != null) onCurrent((): boolean => token == generation && cacheCurrent(cache) && sameIdentity(cache.identity, context));
  assertCurrent(choice, revision, date, token, context);
  return result;
}

/** ACK/current context precedes any cached result; unavailable account is a miss, not app fallback. */
export async function loadAccountTodayResult(choice: RecommendationChoice, revision: number, onCurrent: ReturnGuardObserver | null = null): Promise<DailyRecommendResult | null> {
  const date = localDateKey(new Date()), token = generation, before = readRawCache();
  try {
    assertCurrent(choice, revision, date, token);
    const context = await prepareAccountRecommendationContext(choice.sourceId, "daily");
    assertCurrent(choice, revision, date, token, context);
    return cachedFor(context, choice, revision, date, token, onCurrent);
  } catch {
    removeCache(before, (): boolean => slotOwnerCurrent(choice, revision, token));
    return null;
  }
}

/** Clear only the independent account slot and cancel its older in-flight generation. */
export function clearAccountTodayResult(choice: RecommendationChoice, revision: number): void {
  if (choice.origin != "account" || !recommendationChoiceCurrent("daily", choice, revision)) {
    throw new Error("每日推荐来源已变化，请重新操作。");
  }
  generation += 1;
  const token = generation, previous = readRawCache();
  removeCache(previous, (): boolean => slotOwnerCurrent(choice, revision, token));
}

export async function generateAccountDailyRecommend(options: GenerateOptions, choice: RecommendationChoice, revision: number, onCurrent: ReturnGuardObserver | null = null): Promise<DailyRecommendResult> {
  generation += 1;
  const token = generation, date = localDateKey(new Date());
  assertCurrent(choice, revision, date, token);
  // Explicit refresh retires this slot before any remote/ACK failure can reveal it again.
  if (options.force == true) {
    const previous = readRawCache();
    assertCurrent(choice, revision, date, token);
    removeCache(previous, (): boolean => token == generation && recommendationChoiceCurrent("daily", choice, revision));
  }
  let context: AccountRecommendationContext;
  try { context = await prepareAccountRecommendationContext(choice.sourceId, "daily"); }
  catch (error) {
    assertCurrent(choice, revision, date, token);
    pruneCache();
    throw new Error(accountRecommendationErrorMessage(error));
  }
  assertCurrent(choice, revision, date, token, context);
  if (options.force != true) {
    const cached = cachedFor(context, choice, revision, date, token, onCurrent);
    if (cached != null) return cached;
  }
  if (options.onProgress != null) options.onProgress("正在读取账号官方每日推荐…");
  assertCurrent(choice, revision, date, token, context);
  let batch: AccountRecommendationBatch;
  let receivedAt = 0;
  try {
    batch = await fetchAccountDailySongs(context, (): boolean => token == generation &&
      recommendationChoiceCurrent("daily", choice, revision) && date == localDateKey(new Date()));
    receivedAt = Date.now();
  }
  catch (error) {
    assertCurrent(choice, revision, date, token, context);
    pruneCache();
    throw new Error(accountRecommendationErrorMessage(error));
  }
  assertCurrent(choice, revision, date, token, context);
  if (batch.source != context.sourceId || batch.kind != "daily" || batch.accountId != context.accountId) {
    throw new Error("账号每日推荐返回的身份不匹配，请重试。");
  }
  if (typeof batch.fetchedAt != "number" || !Number.isFinite(batch.fetchedAt) ||
      (hasField(batch, "expiresAt") && (typeof batch.expiresAt != "number" || !Number.isFinite(batch.expiresAt) || batch.expiresAt <= Date.now()))) {
    throw new Error("账号每日推荐已过期或时间无效，请重试。");
  }
  const items = copySongs(batch.items, false, context.sourceId);
  if (items == null) throw new Error("账号每日推荐数据无效，请重试。");
  const cache: AccountDailyCache = { v: CACHE_VERSION, identity: identityOf(context), choiceRevision: revision, date, fetchedAt: batch.fetchedAt, receivedAt, items };
  if (batch.expiresAt != null) cache.expiresAt = batch.expiresAt;
  const result = resultOf(cache, context);
  const raw = JSON.stringify(cache);
  assertCurrent(choice, revision, date, token, context);
  let stored = false;
  try {
    uni.setStorageSync(ACCOUNT_DAILY_RECOMMEND_CACHE_KEY, raw);
    stored = readRawCache() == raw;
  } catch { /* 静默：缓存写入失败不影响新鲜官方结果返回，仍执行后续当前性复验。 */ }
  try {
    assertCurrent(choice, revision, date, token, context);
    if (!cacheCurrent(cache)) throw new Error("账号每日推荐已过期，请重试。");
    if (stored && retiredGeneration != null && retiredGeneration <= token) retiredGeneration = null;
    if (onCurrent != null) onCurrent((): boolean => token == generation && cacheCurrent(cache) && sameIdentity(cache.identity, context));
    assertCurrent(choice, revision, date, token, context);
  } catch (error) { removeCache(raw, (): boolean => slotOwnerCurrent(choice, revision, token)); throw error; }
  return result;
}

// A play-only toggle keeps the meta context current and therefore keeps this slot.
uni.$on(SOURCE_AUTH_CHANGED_EVENT, () => { pruneCache(); });
uni.$on(SOURCE_PACKS_CHANGED_EVENT, () => { pruneCache(); });
uni.$on(SOURCE_POLICY_CHANGED_EVENT, () => { pruneCache(); });
uni.$on(RECOMMENDATION_SOURCE_CHANGED_EVENT, (payload: any) => {
  if (payload != null && payload.kind == "daily") {
    generation += 1;
    pruneCache();
  }
});
