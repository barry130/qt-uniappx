/**
 * 当前 APP 版本信息（单一数据源）
 *
 * 运行时从 `uni.getAppBaseInfo()` 读取，等价于 manifest.json 里的
 * `versionName` / `versionCode`，因此发版时只需要改 manifest.json，
 * 不需要再在代码里同步维护任何版本号常量。
 *
 * 注意：uni-app x 的 `appVersionCode` 是 string，这里统一转成 number 返回；
 * 取不到时返回 0 / 空串，调用方按“未知”处理（不要拿 0 去请求后端做版本校验）。
 */

/** 读取 manifest 版本信息；运行环境不支持时返回 null */
function readAppBaseInfo(): any | null {
  try {
    const info = uni.getAppBaseInfo() as any;
    if (info != null) return info;
  } catch (_) {
    // 降级为“未知”
  }
  return null;
}

/** 版本号文本/数字 → number；未知返回 0 */
function parseVersionCode(raw: any | null): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw > 0 ? Math.floor(raw) : 0;
  const code = parseInt(String(raw), 10);
  return isNaN(code) ? 0 : code;
}

/** 当前版本名（如 "3.0.1"）；未知返回空串 */
export function getCurrentVersionName(): string {
  const info = readAppBaseInfo();
  if (info == null) return "";
  const name = info.appVersion as string | null | undefined;
  return name != null ? name : "";
}

/** 当前版本号（如 301）；未知返回 0 */
export function getCurrentVersionCode(): number {
  const info = readAppBaseInfo();
  const fromBase = parseVersionCode(info != null ? info.appVersionCode : null);
  if (fromBase > 0) return fromBase;
  // 鸿蒙：getAppBaseInfo().appVersionCode 官方不支持（文档标注 HarmonyOS: x），
  // 退回 getSystemInfoSync().appVersionCode（鸿蒙 4.61+ 支持）。
  // 版本号拿不到时 source-update 的 manifest 请求会缺 appVersionCode 参数，
  // astral 的版本准入表会把整张 manifest 挡成空 —— 绝不能走到那一步。
  try {
    const sys = uni.getSystemInfoSync() as any;
    return parseVersionCode(sys != null ? sys.appVersionCode : null);
  } catch (_) {
    return 0;
  }
}

/** 版本名 + 版本号的组合展示（如 "3.0.1 (301)"），用于「关于」页 */
export function getVersionText(): string {
  const name = getCurrentVersionName();
  const code = getCurrentVersionCode();
  if (name.length === 0) return code > 0 ? code.toString() : "-";
  return code > 0 ? name + " (" + code + ")" : name;
}
