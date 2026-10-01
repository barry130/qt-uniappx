/**
 * 首屏守卫（Boot Guard）
 *
 * 背景：有用户反馈三星 S24 Ultra 全屏启动后首页一直白屏（半屏正常、清缓存无效）——
 * 上滑直接退出应用，既没有侧栏也没有底部导航，说明首页的视图树从未挂载，
 * 而 JS 层收不到任何异常（onError 无日志）。这类问题本地复现不了，
 * 所以这里放一个「探针 + 兜底」：
 *
 * 1) 探针：首页 onMounted 打标记；启动 8s 后仍未打标记，就上报一条 error 事件
 *    （errorType=boot-guard，带窗口尺寸与系统主题），用于确认「首屏没挂上」是否真的发生；
 * 2) 兜底：上报后用 reLaunch 强制重建首页，最多 2 轮，避免在挂不上的设备上死循环。
 *
 * 结果判定（看统计数据里的 boot-guard 错误组）：
 * - 白屏消失且没有 boot-guard 上报 → 首屏本来就正常，pageOrientation 配置是根因；
 * - 白屏消失但出现 boot-guard 上报 → 首屏确实没挂上，是守卫重建救回来的；
 * - 仍然白屏且没有 boot-guard 上报 → JS 层没跑起来，问题在启动图 / 窗口层。
 */
import { qtTrackError } from "@/uni_modules/qt-stat";
import { recreateActivity } from "@/uni_modules/qt-app-native";

/** 首屏路由：既是判定目标，也是重建目标 */
const HOME_ROUTE = "/pages/home/index";
/** 冷启动 onLaunch 之后首页挂载是毫秒级的，给足余量再判定 */
const CHECK_DELAY_MS = 8000;
/** 最多重建次数，防止在「重建也挂不上」的设备上死循环 */
const MAX_ATTEMPTS = 2;

let firstPageReady = false;
let installed = false;
let attempts = 0;

/** 首页 onMounted 调用：首屏已挂载，守卫不再干预 */
export function markFirstPageReady(): void {
  firstPageReady = true;
}

/** App onLaunch 末尾调用（须在 initQtStat 之后，保证上报可用）。重复调用无副作用 */
export function installBootGuard(): void {
  if (installed) return;
  installed = true;
  scheduleCheck();
}

function scheduleCheck(): void {
  setTimeout(() => {
    if (firstPageReady) return;
    attempts++;
    reportNotMounted(attempts);
    if (attempts >= MAX_ATTEMPTS) {
      // reLaunch 只重建页面、不重建窗口：S24 Ultra 手势导航白屏实测 reLaunch
      // 救不回（attempt=2 仍挂不上）——窗口级竞态必须重建 Activity 才有救。
      // 失败（老基座/平台不支持）静默，保持原有 reLaunch 行为兜底。
      recreateActivity();
      return;
    }
    // 首屏没挂上时界面不可交互，把首页整个重建一次作为最后手段
    try {
      uni.reLaunch({ url: HOME_ROUTE, fail: (_: any) => {} });
    } catch (_) {}
    scheduleCheck();
  }, CHECK_DELAY_MS);
}

/** 上报「首屏未挂载」，附带窗口尺寸/安全区等现场信息，便于比对机型/显示模式/导航方式 */
function reportNotMounted(attempt: number): void {
  let detail = "";
  try {
    const info = uni.getSystemInfoSync();
    detail = " window=" + info.windowWidth + "x" + info.windowHeight;
    // 底部 inset 为 0 是手势导航（edge-to-edge）的特征，用于和三键导航区分开
    const insets = info.safeAreaInsets as any | null;
    if (insets != null) {
      detail = detail + " inset=" + insets.top + "/" + insets.bottom;
    }
    const osTheme = info.osThemeName as string | null;
    if (osTheme != null) detail = detail + " theme=" + osTheme;
  } catch (_) {}
  qtTrackError("boot-guard", HOME_ROUTE + " not mounted, attempt=" + attempt + detail, "", HOME_ROUTE);
}
