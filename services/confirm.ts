/**
 * 应用内确认弹窗（替代 uni.showModal）。
 * 原生 showModal 不跟随 App 字号缩放，深色主题下还是系统灰底，所以换成自绘弹层：
 * 渲染在 qt-confirm-host（qt-page-frame 内全站一个实例），这里是全局状态与调用口。
 *
 * 用法（替代 uni.showModal 的 success 回调）：
 *   qtConfirm({ title: "退出登录", content: "…", danger: true }).then((ok) => {
 *     if (!ok) return;
 *     // 用户点了确认
 *   });
 * 仅提示不询问（原 showCancel: false）传 showCancel: false，确认回调里 ok 恒为 true。
 */
import { ref } from "vue";

export interface QtConfirmOptions {
  title: string;
  content?: string;
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮用危险色（删除/退出等） */
  danger?: boolean;
  /** false = 只显示确认键（纯提示弹窗），默认 true */
  showCancel?: boolean;
}

const visible = ref(false);
const title = ref("");
const content = ref("");
const confirmText = ref("确定");
const cancelText = ref("取消");
const danger = ref(false);
const showCancel = ref(true);

let resolver: ((ok: boolean) => void) | null = null;

export function qtConfirm(options: QtConfirmOptions): Promise<boolean> {
  // 连续弹窗时，上一个未决的直接按取消收场，避免 promise 悬挂
  if (resolver != null) {
    const previous = resolver;
    resolver = null;
    previous(false);
  }
  title.value = options.title;
  content.value = options.content ?? "";
  confirmText.value = options.confirmText ?? "确定";
  cancelText.value = options.cancelText ?? "取消";
  danger.value = options.danger == true;
  showCancel.value = options.showCancel !== false;
  visible.value = true;
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

/** 弹层点击回调：关闭并兑现 promise */
export function qtConfirmResolve(ok: boolean): void {
  if (!visible.value) return;
  visible.value = false;
  const settle = resolver;
  resolver = null;
  if (settle != null) settle(ok);
}

/** 宿主组件读取状态用 */
export function qtConfirmState() {
  return { visible, title, content, confirmText, cancelText, danger, showCancel };
}
