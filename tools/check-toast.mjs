/**
 * 轻提示（toast）一致性自检。
 *
 * 全站临时提示只允许走 `services/toast.uts` 的 `qtShowToast()`，由
 * `uni_modules/qt-ui/stores/toast.ts` 收口、`qt-toast-host` 在**屏幕底部居中**渲染。
 * 这个脚本守住五件容易被改回去的事：
 *   1. 不许再出现 `uni.showToast(...)` 调用（原生 Toast 各家 ROM 长得不一样）；
 *   2. 每个用 `qtShowToast` 的文件都要 import 到它（否则跑起来是未定义）；
 *   3. 宿主仍然挂在 `qt-page-frame` 里、仍是底部居中的那套定位，kind/图标/时长没被改散；
 *   4. 不许再出现 `uni.showModal(...)` 调用（原生弹窗不跟字号缩放、不跟深色主题），
 *      确认弹窗一律走 `services/confirm.ts` 的 `qtConfirm()`；
 *   5. 确认弹窗宿主 `qt-confirm-host` 仍然挂在 `qt-page-frame` 里。
 *
 * 运行：node tools/check-toast.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const HOST = "uni_modules/qt-ui/components/qt-toast-host/qt-toast-host.uvue";
const STORE = "uni_modules/qt-ui/stores/toast.ts";
const ENTRY = "services/toast.uts";
const FRAME = "uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue";
const LAYOUT = "uni_modules/qt-ui/composables/use-qt-layout.ts";
const SHEET_ENTRY = "services/action-sheet.ts";
const SHEET_HOST = "uni_modules/qt-ui/components/qt-action-sheet-host/qt-action-sheet-host.uvue";
const CONFIRM_ENTRY = "services/confirm.ts";

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "unpackage" || e === ".git" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(uvue|uts|ts)$/.test(e)) out.push(full);
  }
  return out;
}

function read(rel) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) {
    errors.push("缺少文件: " + rel);
    return "";
  }
  return readFileSync(full, "utf8");
}

function require(text, re, message, rel) {
  if (!re.test(text)) errors.push(rel + ": " + message);
}

// 1) 不许再调原生 Toast（注释里提到 `uni.showToast` 不算）
let legacyCalls = 0;
let entryUsers = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (rel.startsWith("tools/")) continue;
  const src = readFileSync(file, "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  if (/\buni\.showToast\s*\(/.test(code)) {
    errors.push(rel + ": 仍在调用 uni.showToast，请改成 qtShowToast({ title, icon })");
    legacyCalls++;
  }
  if (/\buni\.showModal\s*\(/.test(code)) {
    errors.push(rel + ": 仍在调用 uni.showModal，请改成 qtConfirm({ title, content })（原生弹窗不跟字号/主题）");
    legacyCalls++;
  }
  if (/\buni\.showActionSheet\s*\(/.test(code)) {
    errors.push(rel + ": 仍在调用 uni.showActionSheet，请改成 qtShowActionSheet({ itemList })（原生弹窗不跟字号/主题）");
    legacyCalls++;
  }
  if (/\bqtConfirm\s*\(/.test(code) && rel !== CONFIRM_ENTRY) {
    if (!/import\s*\{[^}]*\bqtConfirm\b[^}]*\}\s*from\s*["']@\/services\/confirm["']/.test(src)) {
      errors.push(rel + ": 用了 qtConfirm 但没 import { qtConfirm } from \"@/services/confirm\"");
    }
  }
  const uses = (src.match(/\bqtShowToast\s*\(/g) || []).length;
  if (uses === 0 || rel === ENTRY || rel === STORE) continue;
  entryUsers++;
  if (!/import\s*\{[^}]*\bqtShowToast\b[^}]*\}\s*from\s*["']@\/services\/toast["']/.test(src)) {
    errors.push(rel + ": 用了 qtShowToast 但没 import { qtShowToast } from \"@/services/toast\"");
  }
  const sheetUses = (src.match(/\bqtShowActionSheet\s*\(/g) || []).length;
  if (sheetUses > 0 && rel !== SHEET_ENTRY) {
    if (!/import\s*\{[^}]*\bqtShowActionSheet\b[^}]*\}\s*from\s*["']@\/services\/action-sheet["']/.test(src)) {
      errors.push(rel + ": 用了 qtShowActionSheet 但没 import { qtShowActionSheet } from \"@/services/action-sheet\"");
    }
  }
}

// 2) 出口与 store
const entry = read(ENTRY);
require(entry, /export function qtShowToast\(/, "缺少 qtShowToast 出口", ENTRY);
require(entry, /qtShowToastByKind\(/, "没有把 kind 交给 stores/toast.ts 收口", ENTRY);
require(entry, /icon == "loading"/, "loading 档应当直接返回（转圈由 qt-loading 表达）", ENTRY);

const store = read(STORE);
require(store, /"success"\s*\|\s*"info"\s*\|\s*"error"/, "QtToastKind 应为 success/info/error 三档", STORE);
require(store, /QT_TOAST_ERROR_DURATION_MS\s*=\s*6000/, "出错档停留应为 6 秒（同 qt-pc）", STORE);
require(store, /QT_TOAST_DURATION_MS\s*=\s*3000/, "普通/成功档停留应为 3 秒（同 qt-pc）", STORE);
require(store, /QT_TOAST_MAX_ITEMS\s*=\s*4/, "同时最多迭 4 条（同 qt-pc）", STORE);
require(store, /export function qtShowToastByKind\(/, "缺少字符串形态的 kind 入口", STORE);

// 3) 宿主：挂在 page-frame 内、底部居中、让开 TabBar
const host = read(HOST);
require(host, /position:\s*fixed/, "宿主必须 fixed 浮起来", HOST);
require(host, /align-items:\s*center/, "宿主必须水平居中", HOST);
require(host, /bottom:/, "宿主必须贴底定位", HOST);
require(host, /qtTabBarHeightPx\(\)/, "竖屏 bottom 要让开底部 TabBar", HOST);
require(host, /pointer-events:\s*none/, "纯展示浮层不能吃掉底部控件点击", HOST);
require(host, /item\.kind == ['"]error['"]/, "缺少出错档样式分支", HOST);
require(host, /item\.kind == ['"]success['"]/, "缺少成功档样式分支", HOST);

const frame = read(FRAME);
require(frame, /<qt-toast-host\s*\/>/, "qt-page-frame 里没有挂 qt-toast-host", FRAME);
require(frame, /<qt-confirm-host\s*\/>/, "qt-page-frame 里没有挂 qt-confirm-host", FRAME);
require(frame, /<qt-action-sheet-host\s*\/>/, "qt-page-frame 里没有挂 qt-action-sheet-host", FRAME);

const layout = read(LAYOUT);
require(layout, /QT_TAB_BAR_HEIGHT_RPX\s*=\s*144/, "TabBar 总占位常量丢失（qt-toast-host 依赖它）", LAYOUT);

// 6) 操作表出口与宿主（同 confirm：全局一个宿主，service 兑现 Promise）
const sheetEntry = read(SHEET_ENTRY);
require(sheetEntry, /export function qtShowActionSheet\(/, "缺少 qtShowActionSheet 出口", SHEET_ENTRY);
require(sheetEntry, /Promise<number>/, "qtShowActionSheet 应返回 Promise<number>（-1 = 取消）", SHEET_ENTRY);
require(sheetEntry, /list\.length == 0[\s\S]{0,40}Promise\.resolve\(-1\)/, "空 itemList 应直接兑现 -1 不弹窗", SHEET_ENTRY);
const sheetHost = read(SHEET_HOST);
require(sheetHost, /<qt-action-sheet/, "宿主必须复用 qt-action-sheet 组件渲染", SHEET_HOST);
require(sheetHost, /qtActionSheetPick/, "选中要经 qtActionSheetPick 兑现下标", SHEET_HOST);
require(sheetHost, /qtActionSheetCancel/, "关闭要经 qtActionSheetCancel 兑现 -1", SHEET_HOST);

if (errors.length > 0) {
  for (const e of errors) console.log("ERROR " + e);
  console.log("[check-toast] " + errors.length + " 处问题");
  process.exit(1);
}
console.log(
  "[check-toast] 通过：无 uni.showToast/showModal/showActionSheet 残留，qtShowToast 调用点 " + entryUsers + " 个文件均已 import，宿主仍为底部居中",
);
