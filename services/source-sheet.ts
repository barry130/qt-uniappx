/**
 * 音源切换操作表（全站唯一口径）。
 *
 * 为什么收成一个文件：音源切换在四处出现——首页切换器（qt-source-switcher）、
 * 设置页「默认音源」、搜索结果页标题栏药丸、歌单导入页「平台」下拉。此前各写一套，
 * 差异全落在「用户能感知但说不清」的细节上：设置页那条没传 selectedIndex，所以列表
 * 打开时不会滚到当前源；搜索页那条是内联 <qt-action-sheet>（绝对定位锚父节点，
 * 2026-10-25 真机被裁过）。统一到这里后，四个入口共用同一份清单口径、同一套
 * 「当前项 accent 高亮 + 打开即滚到选中项」的行为。
 *
 * 必须走 qtShowActionSheet（全局 host，挂在 qt-page-frame 根）而不是内联组件：
 * 内联时蒙层只有父节点那么高，弹层从底部溢出被屏幕裁掉（2026-10-25 真机教训）。
 *
 * 选中项自动滚动定位：qt-action-sheet 的 watch(visible) 在 selectedIndex 落在
 * 折叠区外（窄屏前 5 行、宽屏前 9 行之外）时设 scroll-into-view 滚到该项，
 * 所以这里必须把 selectedIndex 喂进去——不传就退化成「打开永远停在顶部」。
 */
import { qtShowActionSheet } from "@/services/action-sheet";
import { qtShowToast } from "@/services/toast";
import { platformLabel } from "@/services/platform";
import { useSourceStore } from "@/stores/source";
import { useSourceRegistryStore } from "@/stores/source-registry";
import { useThemeStore } from "@/uni_modules/qt-ui/stores/theme";

/** 默认标题（设置页用「默认音源」，其余入口用「切换音源」） */
export const SOURCE_SHEET_TITLE_SWITCH = "切换音源";
export const SOURCE_SHEET_TITLE_DEFAULT = "默认音源";

/** 未装数据包时的统一提示 */
const NO_PACK_TIP = "请先在 设置→音源包管理 安装数据包";

/**
 * 弹出音源选择操作表。
 *
 * @param title 顶部标题，缺省「切换音源」
 * @returns 选中的音源 id；取消、点蒙层、或未装包（清单为空）时返回空串
 *
 * 只负责「问用户选哪个」，不写 store——各入口选完的后续动作不同
 * （首页要 emit change、搜索页要重拉结果、设置页要 toast），由调用方自己接。
 */
export function showSourceSheet(title?: string): Promise<string> {
  const registry = useSourceRegistryStore();
  const store = useSourceStore();
  const theme = useThemeStore();
  // 清单来自数据包注册表：未装包时为空，提示去设置页安装而不是弹一个空表
  const list = registry.sourceIds();
  if (list.length == 0) {
    qtShowToast({ title: NO_PACK_TIP, icon: "none" });
    return Promise.resolve("");
  }
  const names: string[] = [];
  const colors: (string | null)[] = [];
  for (let i = 0; i < list.length; i++) {
    names.push(platformLabel(list[i]));
    // 当前源用主题色标出（弹层还会给选中项补「✓」，颜色与勾互为冗余）
    colors.push(list[i] == store.current ? theme.skin.accent : null);
  }
  const current = store.current;
  return qtShowActionSheet({
    title: title != null && title.length > 0 ? title : SOURCE_SHEET_TITLE_SWITCH,
    itemList: names,
    // 关键：把当前源下标交出去，列表才会在它落到折叠区外时自动滚过去
    selectedIndex: list.indexOf(current),
    colors: colors,
  }).then((index: number): string => {
    if (index < 0 || index >= list.length) return "";
    return list[index];
  });
}

/**
 * 弹出音源选择表并落库为当前音源。
 *
 * @returns 是否真的发生了切换（取消、未装包、选中的就是当前源都算「没切换」）
 */
export function pickSourceFromSheet(title?: string): Promise<boolean> {
  const store = useSourceStore();
  const before = store.current;
  return showSourceSheet(title).then((source: string): boolean => {
    if (source.length == 0 || source == before) return false;
    store.setSource(source);
    return true;
  });
}

/** 「自动识别（链接）」选项文案（歌单导入页平台选择的首项） */
export const PLATFORM_SHEET_AUTO_LABEL = "自动识别（链接）";

/**
 * 弹出「解析平台」选择表：首项是「自动识别（链接）」，其后是数据包注册表里的音源。
 *
 * 歌单导入页的平台选择不是纯粹的「当前音源」切换（它只影响这次链接解析），
 * 但交互形态必须和别处一致，所以复用同一个弹层，只多一个自动识别项。
 *
 * 返回的是**选中项在弹层里的下标**（0 = 自动识别，i>0 = 第 i-1 个音源），
 * 取消返回 -1。不返回音源 id 是因为「自动识别」与「取消」都对应空 id，
 * 用下标才能把两者分开。
 *
 * @param selected 当前选中的音源 id（空串 = 自动识别）
 */
export function showPlatformSheet(title: string, selected: string): Promise<number> {
  const registry = useSourceRegistryStore();
  const theme = useThemeStore();
  const list = registry.sourceIds();
  // 未装包时仍要能选「自动识别」（链接解析走包内 parseSheet，装包后才可用，
  // 但这里是选解析平台，不该把用户挡在弹层外）
  const names: string[] = [PLATFORM_SHEET_AUTO_LABEL];
  const colors: (string | null)[] = [selected.length == 0 ? theme.skin.accent : null];
  for (let i = 0; i < list.length; i++) {
    names.push(platformLabel(list[i]));
    colors.push(list[i] == selected ? theme.skin.accent : null);
  }
  return qtShowActionSheet({
    title: title,
    itemList: names,
    // 当前平台在折叠区外时打开即滚到它（与音源切换同一能力）
    selectedIndex: selected.length == 0 ? 0 : list.indexOf(selected) + 1,
    colors: colors,
  });
}
