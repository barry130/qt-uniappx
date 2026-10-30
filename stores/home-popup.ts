import { reactive } from "vue";

/**
 * 首页全屏弹窗占用态（activePopup 裁决结果的对外镜像）。
 *
 * 为什么放进独立 store：启动弹窗队列（services/boot-modal-queue.ts）是 service，
 * 没有组件生命周期，跨文件去 watch 首页的 computed 还要管 unwatch 收口，比
 * 「页面主动上报、队列轮询读取」更绕。首页在 watch(activePopup) 里持续写入，
 * 队列在放下一个引导前读取。首页不在前台时恒为 false——公告/升级/数据包引导
 * 三个全屏弹窗都只挂在首页，别处不会出现。
 */
export class HomePopupStore {
  /** 首页公告/升级/数据包引导任一全屏弹窗在场（activePopup != "none"） */
  busy = false;
}

const homePopupStore = reactive(new HomePopupStore()) as HomePopupStore;

export function useHomePopupStore(): HomePopupStore {
  return homePopupStore;
}
