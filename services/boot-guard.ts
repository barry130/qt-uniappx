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
 * 2) 兜底：上报后用 reLaunch 强制重建首页，最多 MAX_ATTEMPTS 次，之后停手。
 *
 * ── 生产数据复盘（stat_error_log）：为什么这里不再重建 Activity ──
 * 旧版在 attempt 用尽后调 recreateActivity()。线上 864 条 boot-guard 证明这一步
 * 既是白屏的放大者，也是 boot-guard 无限循环的成因：
 *
 * 1) 重建 Activity 会重启整个 JS 运行时，本模块的 attempts 随之归零，
 *    installBootGuard() 又从 onLaunch 重跑一遍 —— 于是退化成
 *    「8s 上报 → reLaunch → 约 9s 后重建 → 8s 上报 …」的无限循环。
 *    实测 9266fa90（v3.0.7）在 602 分钟里产生 274 条 boot-guard，occur_time 相邻
 *    间隔众数正好是 8.008s（= CHECK_DELAY_MS）与 8.9~9.6s（多出的一次重建开销）；
 *    而该机同期只有 boot-guard 一种错误，js 异常为 0。
 * 2) 更糟的是重建会把「还能救」的启动变成永久白屏：Activity.recreate() 走
 *    detachPagePreservingLaunchActivity → removeAllViews()，页面树若没重新挂上，
 *    android.R.id.content 的宽度就永远停在 0。设备 4aca6e62 的完整序列是
 *      a1 window=360 → a2 window=360 →（重建）→ a1 window=0 → 其后 49 条全是 0
 *    即上报时窗口本来已 layout 过，是守卫自己把 0 变成了常态。全量数据里有 9 台设备
 *    在首次 window=0 之前存在 window>0 的行，其中 8 台此后再未恢复。
 *
 * 所以现在：**只保留 reLaunch，绝不重建 Activity**；判定前先确认「应用在前台」且
 * 「首屏确实是当前页」，次数用尽即停手，回前台再重新给一次机会。
 *
 * 结果判定（看统计数据里的 boot-guard 错误组）：
 * - 白屏消失且没有 boot-guard 上报 → 首屏本来就正常，pageOrientation 配置是根因；
 * - 白屏消失但出现 boot-guard 上报 → 首屏确实没挂上，是守卫 reLaunch 救回来的；
 * - 仍然白屏且没有 boot-guard 上报 → JS 层没跑起来，问题在启动图 / 窗口层。
 */
import { qtTrackError } from "@/uni_modules/qt-stat";
import { logMsg, logMsgErr, logMsgWarn } from "@/services/logger";

/** 首屏路由：既是判定目标，也是重建目标 */
const HOME_ROUTE = "/pages/home/index";
/** 冷启动 onLaunch 之后首页挂载是毫秒级的，给足余量再判定 */
const CHECK_DELAY_MS = 8000;
/**
 * 每轮前台生命周期内最多上报/兜底几次，之后停手。
 * 注意这里**不能**再用「重建 Activity 清零 attempts」来兜底：那正是死循环的来源。
 */
const MAX_ATTEMPTS = 2;

let firstPageReady = false;
let installed = false;
let attempts = 0;
/** 应用是否在前台；由 App.uvue 的 onShow / onHide 维护 */
let appForeground = true;
/** 当前挂着的判定定时器；后台或被取代时要显式清掉 */
let checkTimer: number | null = null;

/** 首页 onMounted 调用：首屏已挂载，守卫不再干预 */
export function markFirstPageReady(): void {
  firstPageReady = true;
  clearCheckTimer();
  // 这一行是白屏类报障的分水岭：日志里有它 = 首屏正常挂载；
  // 只有启动横幅没有它 = 视图树确实没挂上（守卫会紧接着记下 attempt 与窗口尺寸）
  logMsg("[BootGuard] 首屏已挂载 " + HOME_ROUTE);
}

/** App onLaunch 末尾调用（须在 initQtStat 之后，保证上报可用）。重复调用无副作用 */
export function installBootGuard(): void {
  if (installed) return;
  installed = true;
  scheduleCheck();
}

/**
 * App onShow 调用：进入前台。
 * 后台期间系统会冻结 JS 定时器，冻到很晚才触发的判定毫无意义
 *（实测有 a1 11:45:24 → a2 12:04:23 这样间隔 19 分钟的用例），
 * 所以回前台重新计时，并给首屏一次新的机会。
 *
 * 只在「确实从后台回来」时才重置：onShow 也可能在没有 onHide 的情况下重复触发
 *（权限弹窗、跳系统设置页回来等），若无条件重置次数，守卫又会被反复唤醒成循环。
 */
export function notifyAppForeground(): void {
  if (appForeground) return;
  appForeground = true;
  if (firstPageReady) return;
  attempts = 0;
  scheduleCheck();
}

/** App onHide 调用：进入后台，停止一切判定（后台白屏不该被当成启动失败） */
export function notifyAppBackground(): void {
  appForeground = false;
  clearCheckTimer();
}

/** 栈顶页面路由；页面栈为空或取不到时返回 ""（与 App.uvue / ui-loading.uts 同款用法） */
function currentTopRoute(): string {
  try {
    const pages = getCurrentPages();
    if (pages.length > 0) {
      const top = pages[pages.length - 1];
      const route = top.route;
      if (route != null) return route;
    }
  } catch (_) {}
  return "";
}

/**
 * 去掉前导 "/" 后比较路由。
 * getCurrentPages()[].route 与 pages.json 的写法不保证一致（可能带或不带前导斜杠），
 * 直接 != 比较会把「就是首页」误判成「不是首页」而让守卫静默退出。
 */
function isHomeRoute(route: string): boolean {
  if (route.length == 0) return false;
  const a = route.charAt(0) == "/" ? route.substring(1) : route;
  const b = HOME_ROUTE.charAt(0) == "/" ? HOME_ROUTE.substring(1) : HOME_ROUTE;
  return a == b;
}

/** 页面栈深度；取不到时返回 -1，便于和「栈为空(0)」区分 */
function pageStackSize(): number {
  try {
    return getCurrentPages().length;
  } catch (_) {
    return -1;
  }
}

function clearCheckTimer(): void {
  if (checkTimer != null) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
}

function scheduleCheck(): void {
  clearCheckTimer();
  checkTimer = setTimeout(() => {
    checkTimer = null;
    if (firstPageReady) return;
    // 后台不判定：系统冻结定时器会让这次回调在任意晚的时刻触发
    if (!appForeground) return;
    // 前台已经是别的页面：首屏不是当前页，白屏判断不成立，守卫直接退出
    const top = currentTopRoute();
    if (top.length > 0 && !isHomeRoute(top)) {
      logMsg("[BootGuard] 当前页 " + top + "，非首屏，守卫退出");
      return;
    }
    attempts++;
    logMsgWarn("[BootGuard] 首屏 " + CHECK_DELAY_MS + "ms 未挂载，attempt=" + attempts);
    reportNotMounted(attempts);
    if (attempts >= MAX_ATTEMPTS) {
      // 用尽即停手：不再重建 Activity（那会重启 JS 运行时、把 attempts 清零，
      // 从而把守卫变成无限循环，并把 window 从「已 layout」打成永久 0）。
      // 下一次回前台时 notifyAppForeground() 会重新给一轮机会。
      logMsgErr("[BootGuard] 首屏 " + MAX_ATTEMPTS + " 次仍未挂载，本轮停止兜底");
      return;
    }
    // 首屏没挂上时界面不可交互，把首页整个重建一次作为唯一手段
    try {
      uni.reLaunch({ url: HOME_ROUTE, fail: (_: any) => {} });
    } catch (_) {}
    scheduleCheck();
  }, CHECK_DELAY_MS) as number;
}

/** 上报「首屏未挂载」，附带窗口尺寸/安全区等现场信息，便于比对机型/显示模式/导航方式 */
function reportNotMounted(attempt: number): void {
  let detail = "";
  try {
    const info = uni.getSystemInfoSync();
    // windowWidth 取的是 android.R.id.content 的 ViewGroup.getWidth()，为 0 只说明
    // 「内容视图从未 layout 过」，不代表窗口不存在；windowHeight 走的是另一条
    // 显示尺寸/inset 记账逻辑，所以 0x798 这种组合是可能的，别把它读成窗口宽 0。
    // 注意 windowWidth>0 也**不能**证明首页挂上了：启动页/其它页面同样会把
    // 内容视图 layout 出来（线上 4aca6e62 就是 w=360 时报的「未挂载」）。
    // screen* 与 status* 是 layout 无关的对照值，一起带上才好判断是哪一层没起来。
    detail = " window=" + info.windowWidth + "x" + info.windowHeight;
    detail = detail + " screen=" + info.screenWidth + "x" + info.screenHeight;
    detail = detail + " status=" + info.statusBarHeight;
    const insets = info.safeAreaInsets as any | null;
    if (insets != null) {
      // 注意：本 build 在 App.uvue 里固定 decorFitsSystemWindows=true，窗口不是
      // edge-to-edge，正常设备的 inset.bottom 本就大于 0；所以它不能用来越判手势导航。
      detail = detail + " inset=" + insets.top + "/" + insets.bottom;
    }
    // 正确字段名是 osTheme（UTSAndroid.getOsTheme → t6.q，由 Configuration.uiMode 初始化）。
    // 此前写的 osThemeName 在任何 d.ts / 运行时 / dex 里都不存在，恒为 undefined，
    // 于是 theme= 从未出现在上报里——是一处死代码。
    const osTheme = info.osTheme as string | null;
    if (osTheme != null) detail = detail + " theme=" + osTheme;
  } catch (_) {}
  // 页面栈现场：top= 为空串说明栈里一个页面都没有（最严重的白屏形态）
  const top = currentTopRoute();
  detail = detail + " top=" + (top.length > 0 ? top : "-");
  detail = detail + " pages=" + pageStackSize();
  // 与上报同源的现场信息也落本地日志：用户报白屏时我们手里往往只有这一份文件
  logMsgWarn("[BootGuard] 首屏未挂载 attempt=" + attempt + detail);
  qtTrackError("boot-guard", HOME_ROUTE + " not mounted, attempt=" + attempt + detail, "", HOME_ROUTE);
}
