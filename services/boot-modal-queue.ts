/**
 * 启动弹窗队列（boot modal queue，2026-10-27）。
 *
 * 为什么需要它：qtConfirm 是**单槽**弹窗（services/confirm.ts:36-53），连续调用
 * 时新弹窗会把未决的旧弹窗按取消收场顶替显示。首启时间线上有多个独立来源的
 * 弹窗并发冒出——首启免责声明（全屏读秒）、开屏公告、电池白名单引导（6s）、
 * 音源包更新提示（3s 发现后逐条）、播放包缺失引导（点歌失败广播）——免责声明
 * 还压在屏幕上时电池引导/更新确认就弹了，qtConfirm 互顶、跨系统视觉叠加
 * （2026-10-27 用户反馈「首次启动弹窗通知重叠」）。
 *
 * 口径：只管**启动窗口内**（launch 后 2 分钟）的系统级引导——一次只显示一个，
 * 前一个 settle 后才放下一个；窗口外的入队视为运行期弹窗，直接执行不排队
 * （运行期弹窗是用户即时操作的反馈，排队反而让人困惑）。
 *
 * 显示前提（blocked 判定，放下一个之前轮询）：
 *   - 首启免责声明在前台（stores/disclaimer.ts 的 visible getter）：全屏遮罩，
 *     引导电在它上面只会白弹一次；
 *   - 首页全屏弹窗占用中（stores/home-popup.ts 的 busy）：开屏公告可能
 *     dialogClosable=0 必须先看完，升级弹窗可能正在下载。
 * 等待用 500ms 轮询而不是 watch：service 无组件生命周期，跨模块 watch 还要
 * 管 unwatch 收口；轮询只在「有队 + 被遮挡」时发生，一次一个 setTimeout，
 * 代价可忽略。已知残余竞态：引导已开、免责声明/公告才到，会盖在引导上——
 * 遮罩层更高本来就是正确的主次关系，不做中途撤回。
 *
 * 不改 qtConfirm 本身：单槽顶替是它对运行期弹窗的正确语义；本队列只在启动
 * 窗口内约束「哪些弹窗允许同时发起」。
 */
import { useDisclaimerStore } from "@/stores/disclaimer";
import { useHomePopupStore } from "@/stores/home-popup";

/** 播放包缺失引导：用户刚点歌失败，是对用户动作的直接回应，必须最先解释 */
export const BOOT_MODAL_PRIORITY_PLAY_PACK = 300;
/** 电池白名单引导：一次性系统设置提示，重要性次之 */
export const BOOT_MODAL_PRIORITY_BATTERY = 200;
/** 音源包更新提示：纯提示性质，红点会保留，晚一点不丢信息 */
export const BOOT_MODAL_PRIORITY_PACK_UPDATE = 100;

interface BootModalEntry {
  id: string;
  priority: number;
  run: () => Promise<void>;
}

/** 启动窗口：launch 后这段时间内的引导走队列；窗口外视为运行期直接执行 */
const BOOT_QUEUE_WINDOW_MS = 2 * 60 * 1000;
/** 队头被免责声明/首页弹窗挡住时的轮询间隔 */
const BOOT_QUEUE_POLL_MS = 500;

/** 模块加载时刻 ≈ App 启动时刻：App.uvue 顶部 import 本模块，早于 onLaunch 体执行 */
const gLoadedAt = Date.now();

let gQueue: BootModalEntry[] = [];
/** 正在展示的引导 id（"" = 空闲）；同一 id 在队/在展都不重复入队 */
let gRunningId = "";
let gPollTimer = 0;

/**
 * 把一个启动弹窗排进队列。
 * 窗口内：按优先级降序插入——后到的高优先级插到已排队的前面，但绝不抢占
 * 正在展示的那个（qtConfirm 单槽，中途顶替会把在展弹窗按取消收场，用户
 * 莫名其妙少了一个选择）。窗口外：直接执行。
 */
export function enqueueBootModal(id: string, priority: number, run: () => Promise<void>): void {
  if (Date.now() - gLoadedAt >= BOOT_QUEUE_WINDOW_MS) {
    // 运行期：不排队，立即执行；异常吞掉（引导弹窗的失败不该外抛打断调用方）
    run().catch((_e) => {});
    return;
  }
  if (gRunningId == id) return;
  for (let i = 0; i < gQueue.length; i++) {
    if (gQueue[i].id == id) return;
  }
  const entry: BootModalEntry = { id: id, priority: priority, run: run };
  // 插入排序（降序、稳定：同优先级先到先弹）。UTS 数组不依赖 splice——
  // 按本仓惯例（dropOffer 同款）重建数组
  const next: BootModalEntry[] = [];
  let inserted = false;
  for (let i = 0; i < gQueue.length; i++) {
    if (!inserted && gQueue[i].priority < priority) {
      next.push(entry);
      inserted = true;
    }
    next.push(gQueue[i]);
  }
  if (!inserted) next.push(entry);
  gQueue = next;
  pump();
}

/** 尝试展示队头；被免责声明/首页全屏弹窗挡住时起轮询等它们退场 */
function pump(): void {
  if (gRunningId.length > 0) return;
  if (gQueue.length == 0) return;
  if (blocked()) {
    if (gPollTimer == 0) {
      gPollTimer = setTimeout(() => {
        gPollTimer = 0;
        pump();
      }, BOOT_QUEUE_POLL_MS) as number;
    }
    return;
  }
  const entry = gQueue[0];
  const rest: BootModalEntry[] = [];
  for (let i = 1; i < gQueue.length; i++) rest.push(gQueue[i]);
  gQueue = rest;
  gRunningId = entry.id;
  entry
    .run()
    .then(() => {
      settleRun();
    })
    .catch((_e) => {
      // 单个引导链路意外失败不拦住队列里后面的引导（与 promptPackUpdates 同口径）
      settleRun();
    });
}

function settleRun(): void {
  gRunningId = "";
  pump();
}

/** 显示前提：首启免责声明与首页全屏弹窗（公告/升级/数据包引导）都不在场 */
function blocked(): boolean {
  if (useDisclaimerStore().visible) return true;
  if (useHomePopupStore().busy) return true;
  return false;
}
