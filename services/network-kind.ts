/**
 * 网络面别（2026-11-14 用户需求：播放/下载音质按 WIFI 与移动网络独立管理）。
 * 取档点（player.effQualityOf、downloads.runTaskInner、music-api 取链缓存键）
 * 都是同步读，而 uni.getNetworkType 是异步的——这里维护一份进程内的当前网络
 * 缓存：首次读取发起一次 getNetworkType，之后靠 onNetworkStatusChange 常驻
 * 跟随；检测结果到达之前按「移动网络」保守处理（宁可低档不可偷跑流量）。
 */
export const NETWORK_KIND_WIFI = "wifi";
export const NETWORK_KIND_CELLULAR = "cellular";
/** 当前网络面别变化后广播；source-quality 转译成音质表变化事件，菜单/卡片刷新 */
export const NETWORK_KIND_CHANGED_EVENT = "qt-network-kind-changed";

let cachedKind = NETWORK_KIND_CELLULAR;
let watching = false;

function applyType(networkType: string): void {
  const next = networkType == NETWORK_KIND_WIFI ? NETWORK_KIND_WIFI : NETWORK_KIND_CELLULAR;
  if (next == cachedKind) return;
  cachedKind = next;
  uni.$emit(NETWORK_KIND_CHANGED_EVENT);
}

/**
 * 当前网络面别（同步读，幂等接管网络监听）。只有明确的 wifi 归 WIFI——
 * 2g/3g/4g/5g/ethernet/unknown/none 一律按移动网络口径处理（手机场景以太网
 * 罕见，保守归类不偷跑流量）。
 */
export function currentNetworkKind(): string {
  if (!watching) {
    watching = true;
    uni.getNetworkType({
      success: (res) => {
        applyType(res.networkType);
      },
    });
    uni.onNetworkStatusChange((res) => {
      applyType(res.networkType);
    });
  }
  return cachedKind;
}
