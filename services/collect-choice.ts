import { ref } from "vue";
import type { Song } from "@/types/music";
import { findCrossSourceDup } from "./collect-dup";

export type CollectChoiceGroup = { id: string; songs: Song[]; existingKeys: string[] };
export type CollectChoicePlan = { groups: CollectChoiceGroup[]; adds: Song[]; removes: Song[] };
export function collectKey(song: Song): string { return song.platform + ":" + song.id; }

/** 连通分组覆盖已有重复与同一批新增项之间的重复；只展示涉及此次新增的组。 */
export function buildCollectChoice(existing: Song[], incoming: Song[]): CollectChoicePlan {
  const existingKeys = existing.map((s: Song): string => collectKey(s));
  const groups: CollectChoiceGroup[] = [];
  const unique: Song[] = [];
  const seen = new Set<string>();
  for (const song of incoming) if (!seen.has(collectKey(song))) { seen.add(collectKey(song)); unique.push(song); }
  for (const song of unique) {
    const matches = findCrossSourceDup(song, [...existing, ...unique]);
    if (matches.length == 0) continue;
    const candidates = [song, ...matches];
    const keys = new Set(candidates.map((s: Song): string => collectKey(s)));
    const merged: Song[] = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (!group.songs.some((s: Song): boolean => keys.has(collectKey(s)))) continue;
      for (const s of group.songs) { candidates.push(s); keys.add(collectKey(s)); }
      groups.splice(i, 1);
    }
    const added = new Set<string>();
    for (const s of candidates) if (!added.has(collectKey(s))) { added.add(collectKey(s)); merged.push(s); }
    groups.push({ id: collectKey(song), songs: merged, existingKeys: merged.filter((s: Song): boolean => existingKeys.includes(collectKey(s))).map((s: Song): string => collectKey(s)) });
  }
  return { groups, adds: unique.filter((s: Song): boolean => !existingKeys.includes(collectKey(s))), removes: [] };
}
export function resolveCollectChoice(plan: CollectChoicePlan, selected: string[]): CollectChoicePlan {
  const scope = new Set<string>();
  const adds: Song[] = [], removes: Song[] = [];
  for (const group of plan.groups) {
    if (!group.songs.some((s: Song): boolean => selected.includes(collectKey(s)))) throw new Error("每组至少保留一个版本");
    for (const song of group.songs) {
      const key = collectKey(song); scope.add(key);
      if (selected.includes(key) && !group.existingKeys.includes(key)) adds.push(song);
      if (!selected.includes(key) && group.existingKeys.includes(key)) removes.push(song);
    }
  }
  for (const song of plan.adds) if (!scope.has(collectKey(song))) adds.push(song);
  return { groups: plan.groups, adds, removes };
}

const visible = ref(false), title = ref("");
const groups = ref<CollectChoiceGroup[]>([]), selected = ref<string[]>([]);
const requestId = ref(0);
let resolvePending: ((plan: CollectChoicePlan | null) => void) | null = null;
let pending: CollectChoicePlan | null = null;
export function chooseCollectSongs(name: string, existing: Song[], incoming: Song[]): Promise<CollectChoicePlan | null> {
  finishCollectChoice(false);
  const plan = buildCollectChoice(existing, incoming);
  if (plan.groups.length == 0) return Promise.resolve(plan);
  pending = plan; title.value = name; groups.value = plan.groups;
  selected.value = [];
  for (const group of plan.groups) selected.value.push(...(group.existingKeys.length > 0 ? group.existingKeys : [collectKey(group.songs[0])]));
  requestId.value++; visible.value = true;
  return new Promise((resolve) => { resolvePending = resolve; });
}
export function toggleCollectChoice(key: string): void {
  selected.value = selected.value.includes(key) ? selected.value.filter((k: string): boolean => k != key) : [...selected.value, key];
}
export function finishCollectChoice(ok: boolean): void {
  const callback = resolvePending, plan = pending;
  let result: CollectChoicePlan | null = null;
  if (ok && plan != null) result = resolveCollectChoice(plan, selected.value);
  visible.value = false; resolvePending = null; pending = null;
  if (callback != null) callback(result);
}
export function collectChoiceState() { return { visible, title, groups, selected, requestId }; }
