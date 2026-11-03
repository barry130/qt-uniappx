/**
 * 音源/解析平台选择的全站唯一入口。
 * 必须走全局 qtShowActionSheet host，避免触发器祖先裁切蒙层。
 * 文案是原始名称；选择只由 selectedIndex 表达，统一红色并自动定位。
 */
import { qtShowActionSheet } from "@/services/action-sheet";
import { qtShowToast } from "@/services/toast";
import { platformLabel } from "@/services/platform";
import { useSourceStore } from "@/stores/source";
import { useSourceRegistryStore } from "@/stores/source-registry";

export const SOURCE_SHEET_TITLE_SWITCH = "切换音源";
export const SOURCE_SHEET_TITLE_DEFAULT = "默认音源";
const NO_PACK_TIP = "请先在 设置→音源包管理 安装数据包";

/** Ask only: individual callers retain their existing post-selection behavior. */
export function showSourceSheet(title?: string): Promise<string> {
  const registry = useSourceRegistryStore();
  const store = useSourceStore();
  const list = registry.sourceIds();
  if (list.length == 0) {
    qtShowToast({ title: NO_PACK_TIP, icon: "none" });
    return Promise.resolve("");
  }
  const names: string[] = [];
  for (let i = 0; i < list.length; i++) names.push(platformLabel(list[i]));
  return qtShowActionSheet({
    title: title != null && title.length > 0 ? title : SOURCE_SHEET_TITLE_SWITCH,
    itemList: names,
    selectedIndex: list.indexOf(store.current),
  }).then((index: number): string => {
    if (index < 0 || index >= list.length) return "";
    return list[index];
  });
}

/** Cancel, empty registry and selecting the current source remain no-ops. */
export function pickSourceFromSheet(title?: string): Promise<boolean> {
  const store = useSourceStore();
  const before = store.current;
  return showSourceSheet(title).then((source: string): boolean => {
    if (source.length == 0 || source == before) return false;
    store.setSource(source);
    return true;
  });
}

export const PLATFORM_SHEET_AUTO_LABEL = "自动识别（链接）";
/** 0=automatic, i>0=registry[i-1], -1=cancel. Unknown IDs select nothing. */
export function showPlatformSheet(title: string, selected: string): Promise<number> {
  const list = useSourceRegistryStore().sourceIds();
  const names: string[] = [PLATFORM_SHEET_AUTO_LABEL];
  for (let i = 0; i < list.length; i++) names.push(platformLabel(list[i]));
  const sourceIndex = list.indexOf(selected);
  return qtShowActionSheet({
    title: title,
    itemList: names,
    selectedIndex: selected.length == 0 ? 0 : sourceIndex < 0 ? -1 : sourceIndex + 1,
  });
}
