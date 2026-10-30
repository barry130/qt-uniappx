/**
 * 播放包半屏直装引导（qt-pack-install-sheet 的全局状态与调用口）。
 *
 * 配方同 services/confirm.ts：服务持全局状态 + resolver，宿主组件
 * （uni_modules/qt-ui/components/qt-pack-install-sheet/qt-pack-install-sheet.uvue，
 * 现挂在首页）读状态渲染，收口动作由服务统一兑现 promise。这样 App.uvue
 * （无模板）也能发起半屏，与 qtConfirm 的调用形态一致。
 *
 * 一次打开的完整链路：beginLoading（拉 manifest）→ officialInstallOffer 构造
 * 官方包首装 offer → 展示半屏 → 用户「立即安装」→ applyUpdate（下载/头校验/
 * 签名/冒烟/回滚全链路）→ toast 结果 → settle promise（installed / dismissed）。
 * 官方包拿不到（离线、服务端无发布、版本被拉黑）返回 "unavailable"，由调用方
 * 降级：App 层退回老指路确认框，首页横幅退回跳音源包管理页。
 *
 * 收口结果用导出的 string 常量而不是字面量联合类型别名：全仓 service 没有
 * 字面量联合别名的先例（只有 requestJson 参数上的内联 "GET"|"POST"），
 * 不给 uts 编译器引入未经验证的语言特性。
 */
import { ref } from "vue";
import { beginLoading, finishLoading } from "@/services/ui-loading";
import { qtShowToast } from "@/services/toast";
import { logMsgErr, describeValue } from "@/services/logger";
import { officialInstallOffer, applyUpdate, pickSmokeSongs } from "@/services/source-update";
import type { PackUpdateOffer } from "@/services/source-update";
import { PACK_KIND_PLAY } from "@/services/source-bundle-fs";

/** 半屏收口结果：installed=装好了（App 层无需再收尾，toast 已出、红点/横幅随事件自动刷新） */
export const PACK_SHEET_INSTALLED = "installed";
/** 半屏收口结果：dismissed=用户关掉半屏或点了「手动管理」 */
export const PACK_SHEET_DISMISSED = "dismissed";
/** 半屏收口结果：unavailable=官方包 offer 拿不到（半屏未展示），调用方走自己的降级路径 */
export const PACK_SHEET_UNAVAILABLE = "unavailable";

const visible = ref(false);
const offerName = ref("");
const offerCode = ref(0);
const offerNotes = ref("");
/** 安装中：关闭钮/蒙层点击不收口（loading mask 之外再兜一层防误关） */
const installing = ref(false);
/** 全量 offer（逻辑用：applyUpdate 需要 targetId/newCode/url；展示走上面的拆字段 ref） */
let gOffer: PackUpdateOffer | null = null;
let resolver: ((r: string) => void) | null = null;

/** 宿主组件读取状态用（qt-confirm-host 同款） */
export function packInstallSheetState() {
  return { visible, offerName, offerCode, offerNotes, installing };
}

/**
 * 打开半屏（先拉官方播放包首装 offer，拉取期间 loading）。
 * 返回的 promise 在半屏收口时兑现（PACK_SHEET_* 常量）；
 * 拿不到 offer 时立即以 unavailable 兑现（半屏未展示）。
 */
export async function openPackInstallSheet(): Promise<string> {
  // 单飞：上一个未决的按用户放弃收口，绝不悬挂旧 promise（同 qtConfirm 语义）
  settleSheet(PACK_SHEET_DISMISSED);
  const token = beginLoading("正在获取官方包…");
  try {
    const o = await officialInstallOffer(PACK_KIND_PLAY);
    finishLoading(token);
    if (o == null) return PACK_SHEET_UNAVAILABLE;
    gOffer = o;
    offerName.value = o.newName;
    offerCode.value = o.newCode;
    offerNotes.value = o.notes;
    visible.value = true;
    // 半屏展示期间挂起，直到用户关闭/装完（安装中 loading mask 兜住误关）
    return await new Promise<string>((resolve) => {
      resolver = resolve;
    });
  } catch (_) {
    // manifest 拉取意外失败（网络栈异常）：loading 必须收口，按拿不到处理
    finishLoading(token);
    return PACK_SHEET_UNAVAILABLE;
  }
}

/** 关闭半屏（关闭钮/蒙层点击）：按用户放弃收口 */
export function packInstallSheetClose(): void {
  if (installing.value) return;
  settleSheet(PACK_SHEET_DISMISSED);
}

/** 次按钮「手动管理」：关掉半屏并直跳音源包管理页（与首页横幅同一指路终点） */
export function packInstallSheetGoManual(): void {
  settleSheet(PACK_SHEET_DISMISSED);
  uni.navigateTo({ url: "/pages/source-pack/index" });
}

/**
 * 主按钮「立即安装」。
 *
 * 为什么走 applyUpdate 而不是 downloadPackText + installFromText：
 * applyUpdate 下载后强制头校验「id/kind/versionCode 与 offer 逐项匹配」——
 * manifest 里 release 版本号与产物头不一致（CDN 缓存旧产物等错位）会在安装前
 * 被拒绝；installFromText 只按包体自身头登记，挡不住这类错位。首装 offer 的
 * currentCode=0 对 applyUpdate 无影响（它只看 targetId/kind/newCode）。失败回滚
 * 回「未安装」原状、版本拉黑、manifest 渠道灰度上报（reportResult）也一并
 * 复用，不需要另写一条安装链路。
 */
export async function packInstallSheetInstall(): Promise<void> {
  const o = gOffer;
  if (o == null || installing.value) return;
  installing.value = true;
  const token = beginLoading("正在安装…");
  try {
    const songs = await pickSmokeSongs();
    const result = await applyUpdate(o, songs);
    // beginLoading/finishLoading 必须配对：漏收口就是永久 loading
    finishLoading(token);
    installing.value = false;
    qtShowToast({ title: result.message, icon: "none", duration: 3000 });
    if (result.ok) {
      // 成功即收口（组件向 App 层「emit 成功」的服务化形态）：App 层拿到
      // installed 无需再做什么——红点/首页横幅随 SOURCE_PACKS_CHANGED_EVENT
      // 自动刷新，toast 已给出结果
      settleSheet(PACK_SHEET_INSTALLED);
    }
    // 失败：半屏留着，用户可重试或「手动管理」；toast 已带原因
    return;
  } catch (e) {
    finishLoading(token);
    installing.value = false;
    // 链路意外异常（applyUpdate 之外的抛错）：toast 通用文案，原始异常进本地日志
    qtShowToast({ title: "安装失败，请稍后重试", icon: "none", duration: 3000 });
    logMsgErr("[PackInstallSheet] 安装链路异常: " + describeValue(e));
  }
}

/** 收口：关半屏 + 兑现 promise（没有未决 resolver 时静默，供单飞复用） */
function settleSheet(result: string): void {
  visible.value = false;
  installing.value = false;
  const finish = resolver;
  resolver = null;
  if (finish != null) finish(result);
}
