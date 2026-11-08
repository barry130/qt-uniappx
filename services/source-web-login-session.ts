/**
 * 原生登录 WebView 是进程级单例；页面栈中的旧网页登录页不能收掉新页的窗口。
 * owner 只限定交互生命期，不持有 Cookie/账号，也不接管 source-auth 的凭据版本。
 * app onHide 不释放：切换到 QQ/浏览器授权属于正常流程。
 */
let currentOwner = 0;
let ownerActive = false;

export function claimSourceWebLogin(): number {
  currentOwner++;
  ownerActive = true;
  return currentOwner;
}

export function sourceWebLoginIsCurrent(owner: number): boolean {
  return ownerActive && owner > 0 && owner == currentOwner;
}

/** 只在当前 owner 已卸载时允许 retained 页拿到新的 lease，绝不复活旧 lease。 */
export function sourceWebLoginIsAvailable(): boolean {
  return !ownerActive;
}

export function releaseSourceWebLogin(owner: number): void {
  if (sourceWebLoginIsCurrent(owner)) ownerActive = false;
}
