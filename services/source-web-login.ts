/**
 * 音源账号网页登录（v17 契约 auth.webLogin）——PC 版 lib/source-web-login.ts 的移动端对应物。
 *
 * 职责只有两件：
 *  1. 提供纯函数：Cookie 拼接（mergeCookies）、标记命中（markerHit）、捕获 URL 清单（captureUrlsOf）；
 *  2. 定义网页登录成功后的全局广播事件（WEB_LOGIN_DONE_EVENT），
 *     web-login 页在登录落库后 uni.$emit，账号页监听后触发「登录即自动同步」。
 *
 * 真正的「开 WebView → 轮询 Cookie → 导入凭据」流程在 pages/web-login/index.uvue。
 */
import type { RegistryWebLogin } from "@/services/music-api";

/** 网页登录成功后广播（payload：{source, name}）：账号页监听后触发 maybeAutoSync */
export const WEB_LOGIN_DONE_EVENT = "qt-weblogin-done";

/**
 * 把「逐 URL 读到的 Cookie 串」合并成一条 "name=value; name2=value2" 头。
 * 同名 Cookie 按「先到先得」去重——captureUrls 里登录域排在前面，
 * 登录域读到的值（qm_keyst / MUSIC_U 等）优先于其它域的同名项。
 */
export function mergeCookies(chunks: string[]): string {
  const names: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const parts = chunks[i].split(";");
    for (let j = 0; j < parts.length; j++) {
      const text = parts[j].trim();
      if (text.length == 0) continue;
      const eq = text.indexOf("=");
      if (eq <= 0) continue;
      const name = text.substring(0, eq).trim();
      const value = text.substring(eq + 1).trim();
      let seen = false;
      for (let k = 0; k < names.length; k++) {
        if (names[k] == name) {
          seen = true;
          break;
        }
      }
      if (seen) continue;
      names.push(name);
      values.push(value);
    }
  }
  const pairs: string[] = [];
  for (let i = 0; i < names.length; i++) {
    pairs.push(names[i] + "=" + values[i]);
  }
  return pairs.join("; ");
}

/**
 * 判断这条 Cookie 头里是否出现「能证明已登录」的标记（qm_keyst / MUSIC_U / SESSDATA 等）。
 * 标记清单为空 = 无契约：按「有 Cookie 就算命中」兜底（PC 同语义）。
 */
export function markerHit(cookie: string, markers: string[]): boolean {
  if (cookie.length == 0) return false;
  if (markers.length == 0) return true;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (m.length > 0 && cookie.indexOf(m) >= 0) return true;
  }
  return false;
}

/**
 * 网页登录过程中要轮询读取的 URL 清单：契约的 captureUrls 优先；
 * 契约没给则由 domains 兜底拼 https://{domain}/。
 * host-only Cookie（如 y.qq.com 的 qm_keyst）必须精确到该域才能读到，清单必须含登录域。
 */
export function captureUrlsOf(webLogin: RegistryWebLogin, domains: string[]): string[] {
  if (webLogin.captureUrls.length > 0) return webLogin.captureUrls;
  const urls: string[] = [];
  for (let i = 0; i < domains.length; i++) {
    urls.push("https://" + domains[i] + "/");
  }
  return urls;
}
