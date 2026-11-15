/** Device-owned platform preferences. Empty enabled means all off; null means the untouched default. */
export type SourcePolicy = { version: number; enabled: string[] | null; order: string[] };
export const SOURCE_POLICY_KEY = "source.platformPolicy.v1";
export const SOURCE_POLICY_CHANGED_EVENT = "qt-source-policy-changed";
export const SOURCE_POLICY_CHANGED_MESSAGE = "音乐源设置已变化，请重试";
export const SOURCE_POLICY_UPGRADE_MESSAGE = "当前音源包不支持平台总开关，请到音源包管理更新";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
function idsOf(value: any): string[] {
  if (!Array.isArray(value)) throw new Error("音乐源设置格式无效");
  const out: string[] = [];
  for (let i = 0; i < value.length && out.length < 128; i++) {
    const id = value[i];
    if (typeof id == "string" && id != "local" && ID_PATTERN.test(id) && out.indexOf(id) < 0) out.push(id);
  }
  return out;
}
export function parseSourcePolicy(raw: string): SourcePolicy {
  if (raw.trim().length == 0) return { version: 1, enabled: null, order: [] };
  const value = JSON.parse(raw) as SourcePolicy;
  if (value == null || value.version != 1) throw new Error("不支持的音乐源设置版本");
  return { version: 1, enabled: value.enabled === null ? null : idsOf(value.enabled), order: idsOf(value.order) };
}
let policy: SourcePolicy = { version: 1, enabled: null, order: [] };
let loaded = false;
let revision = 0;
let error = "";
/** 音源包平台总开关能力：null=尚未探测，false=当前包不支持（此时一律视为全部平台开启） */
let capability: boolean | null = null;
export function setSourcePolicyCapability(supported: boolean | null): void { capability = supported; }
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = uni.getStorageSync(SOURCE_POLICY_KEY);
    if (raw != null && raw !== "" && typeof raw != "string") throw new Error("音乐源设置格式无效");
    policy = parseSourcePolicy(typeof raw == "string" ? raw as string : "");
  } catch (_) {
    // A broken preference must never silently enable platforms.
    policy = { version: 1, enabled: [], order: [] };
    error = "音乐源设置无法读取，请在音源平台管理中重新选择";
  }
}
export function sourcePolicySnapshot(): SourcePolicy {
  load();
  return { version: 1, enabled: policy.enabled == null ? null : policy.enabled.slice(), order: policy.order.slice() };
}
export function sourcePolicyRevision(): number { load(); return revision; }
export function sourcePolicyError(): string { load(); return error; }
export function sourcePolicyFingerprint(): string { load(); return JSON.stringify(policy); }
export function sourcePolicyConfigured(): boolean {
  load();
  if (capability === false) return false;
  return policy.enabled != null || policy.order.length > 0;
}
export function sourceEnabled(id: string): boolean {
  load();
  if (id == "local" || id == "podcast") return true;
  // 当前音源包不支持平台总开关时，旧偏好不再生效：默认全部平台开启。
  if (capability === false) return true;
  return error.length == 0 && (policy.enabled == null || policy.enabled.indexOf(id) >= 0);
}
export function assertSourceEnabled(id: string): void {
  if (!sourceEnabled(id)) throw new Error("该音乐源已关闭，可在音源平台管理中启用");
}
export function assertSourcePolicyCurrent(token: number): void {
  if (token != sourcePolicyRevision()) throw new Error(SOURCE_POLICY_CHANGED_MESSAGE);
}
export function isSourcePolicyError(error: any): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /音乐源.*(?:关闭|设置)|平台总开关/.test(text);
}
export function orderedSourceIds(catalog: string[], enabledOnly: boolean = true): string[] {
  load();
  const out: string[] = [];
  const candidates = policy.order.concat(catalog);
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    if (catalog.indexOf(id) >= 0 && out.indexOf(id) < 0 && (!enabledOnly || sourceEnabled(id))) out.push(id);
  }
  return out;
}
export function saveSourcePolicy(next: SourcePolicy): void {
  const value = parseSourcePolicy(JSON.stringify(next));
  const text = JSON.stringify(value);
  uni.setStorageSync(SOURCE_POLICY_KEY, text);
  if (text == JSON.stringify(policy) && error.length == 0) return;
  policy = value; loaded = true; error = ""; revision++;
  uni.$emit(SOURCE_POLICY_CHANGED_EVENT);
}
export function toggleSource(id: string, catalog: string[]): void {
  const current = sourcePolicySnapshot();
  const enabled = current.enabled == null ? catalog.slice() : current.enabled.slice();
  const index = enabled.indexOf(id);
  if (index >= 0) enabled.splice(index, 1); else enabled.push(id);
  const order = current.order.slice();
  for (let i = 0; i < catalog.length; i++) if (order.indexOf(catalog[i]) < 0) order.push(catalog[i]);
  saveSourcePolicy({ version: 1, enabled, order });
}
/** Reorder the full installed card list atomically, retaining absent IDs in their saved slots. */
export function reorderSources(ids: string[], catalog: string[]): boolean {
  const current = sourcePolicySnapshot();
  const visible = orderedSourceIds(catalog, false);
  if (ids.length != visible.length) return false;
  for (let i = 0; i < ids.length; i++) {
    if (visible.indexOf(ids[i]) < 0 || ids.indexOf(ids[i]) != i) return false;
  }
  if (ids.every((id: string, index: number): boolean => id == visible[index])) return false;
  const order = current.order.slice();
  for (let i = 0; i < visible.length; i++) if (order.indexOf(visible[i]) < 0) order.push(visible[i]);
  let slot = 0;
  for (let i = 0; i < order.length; i++) {
    if (visible.indexOf(order[i]) >= 0) { order[i] = ids[slot]; slot++; }
  }
  saveSourcePolicy({ version: 1, enabled: current.enabled, order });
  return true;
}
export function moveSource(id: string, catalog: string[], direction: number): void {
  const current = sourcePolicySnapshot();
  const order = current.order.slice();
  for (let i = 0; i < catalog.length; i++) if (order.indexOf(catalog[i]) < 0) order.push(catalog[i]);
  const visible = orderedSourceIds(catalog);
  const index = visible.indexOf(id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= visible.length) return;
  const target = visible[targetIndex];
  const a = order.indexOf(id), b = order.indexOf(target);
  order[a] = target; order[b] = id;
  saveSourcePolicy({ version: 1, enabled: current.enabled == null ? catalog.slice() : current.enabled.slice(), order });
}
