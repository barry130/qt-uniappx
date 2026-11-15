import { createPinia, defineStore } from "pinia";
import { parseJsonToUtso } from "@/services/http";

export type RecommendationKind = "daily" | "fm";
export type RecommendationChoice = { origin: "app" | "account"; sourceId: string };
export const RECOMMENDATION_SOURCE_CHANGED_EVENT = "qt-recommendation-source-changed";
const SOURCE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DAILY_KEY = "qt-recommendation-choice-daily-v1";
const FM_KEY = "qt-recommendation-choice-fm-v1";

function normalizeChoice(value: RecommendationChoice | null): RecommendationChoice | null {
  if (value == null || typeof value != "object" || Array.isArray(value)) return null;
  if (value.origin == "app") return { origin: "app", sourceId: "" };
  if (value.origin == "account" && typeof value.sourceId == "string" && SOURCE_ID.test(value.sourceId)) {
    return { origin: "account", sourceId: value.sourceId };
  }
  return null;
}
function storedChoice(key: string): RecommendationChoice {
  try {
    const text = uni.getStorageSync(key);
    if (typeof text == "string" && text.length > 0) {
      // .ts JSON.parse returns plain objects; rebuild through the shared UTS adapter.
      const value = parseJsonToUtso(text);
      if (value != null && typeof value == "object" && !Array.isArray(value)) {
        const origin = value.getString("origin");
        const sourceId = value.getString("sourceId");
        if (origin == "app") return { origin: "app", sourceId: "" };
        if (origin == "account" && sourceId != null && SOURCE_ID.test(sourceId)) return { origin: "account", sourceId };
      }
    }
  } catch (_) {
    // 静默：初次恢复存储损坏或不可用时只保留默认应用选择，不发账号推荐请求。
  }
  return { origin: "app", sourceId: "" };
}

// This business store has an explicit Pinia instance: main.uts need not install one first.
const recommendationPinia = createPinia();
const useRecommendationStore = defineStore("qt-recommendation-choice", {
  state: () => ({
    restored: false,
    daily: { origin: "app", sourceId: "" } as RecommendationChoice,
    fm: { origin: "app", sourceId: "" } as RecommendationChoice,
    dailyRevision: 0,
    fmRevision: 0,
  }),
});
function choiceStore() {
  const store = useRecommendationStore(recommendationPinia);
  if (!store.restored) {
    store.daily = storedChoice(DAILY_KEY);
    store.fm = storedChoice(FM_KEY);
    store.restored = true;
  }
  return store;
}
function checkKind(kind: RecommendationKind): void {
  if (kind != "daily" && kind != "fm") throw new Error("ACCOUNT_RECOMMENDATIONS_INVALID_ARGS");
}
export function readRecommendationChoice(kind: RecommendationKind): RecommendationChoice {
  checkKind(kind);
  const store = choiceStore();
  const choice = kind == "daily" ? store.daily : store.fm;
  return { origin: choice.origin, sourceId: choice.sourceId };
}
export function writeRecommendationChoice(kind: RecommendationKind, choice: RecommendationChoice): void {
  checkKind(kind);
  const next = normalizeChoice(choice);
  if (next == null) throw new Error("ACCOUNT_RECOMMENDATIONS_INVALID_ARGS");
  const store = choiceStore();
  const previous = kind == "daily" ? store.daily : store.fm;
  if (previous.origin == next.origin && previous.sourceId == next.sourceId) return;
  if (kind == "daily") { store.daily = next; store.dailyRevision++; }
  else { store.fm = next; store.fmRevision++; }
  try { uni.setStorageSync(kind == "daily" ? DAILY_KEY : FM_KEY, JSON.stringify(next)); }
  catch (_) {
    // 静默：存储写入失败仍保留本次内存选择，不改变账号或授权，并继续广播选择变化。
  }
  uni.$emit(RECOMMENDATION_SOURCE_CHANGED_EVENT, { kind });
}
export function recommendationChoiceRevision(kind: RecommendationKind): number {
  checkKind(kind);
  const store = choiceStore();
  return kind == "daily" ? store.dailyRevision : store.fmRevision;
}
export function recommendationChoiceCurrent(kind: RecommendationKind, choice: RecommendationChoice, revision: number): boolean {
  const current = readRecommendationChoice(kind);
  return recommendationChoiceRevision(kind) == revision && current.origin == choice.origin && current.sourceId == choice.sourceId;
}
