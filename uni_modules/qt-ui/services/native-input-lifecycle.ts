// #ifdef APP-ANDROID
import { getCurrentInstance, onBeforeUnmount } from "vue";

type InputTimerOwner = {
  disposed: boolean;
  tasks: Set<InputTimerTask>;
};
type InputTimerTask = {
  id: number | null;
  owner: InputTimerOwner;
  pending: boolean;
};
// #endif

/**
 * HBuilderX 5.34 的内置 input 在 mounted 中延迟 80ms 同步原生样式，
 * beforeUnmount 只 destroy()，没有取消该定时器或清空 inputView。
 * 快速卸载后回调会调用已注销实例的 _uni-form / beginUpdateBatch(19)。
 * textarea 同样有未清理的 80ms 高度初始化，统一随所属实例取消。
 *
 * 只接管当前内置 input / textarea 实例创建的 timeout：保留原生定时器 ID、参数与
 * 异常传播；卸载时取消，已进入调度队列的回调也检查存活状态。
 * 不替换 input、不推迟卸载，也不拦截页面、播放器或网络重试的定时器。
 * 在 createSSRApp 注册内置组件之后、app mount 之前安装。
 */
export function installQtNativeInputLifecycle(app: any): void {
  // #ifdef APP-ANDROID
  const types = [
    app.component("input") ?? app.component("Input"),
    app.component("textarea") ?? app.component("Textarea"),
  ].filter((type: any): boolean => type != null);
  if (types.length == 0) return;
  const runtime = globalThis as any;
  const guardKey = "__qtNativeInputTimersV1";
  const registerInput = runtime.setTimeout[guardKey];
  if (typeof registerInput == "function") {
    types.forEach((type: any) => registerInput(type));
    return;
  }

  const inputTypes = new WeakSet<object>();
  types.forEach((type: any) => inputTypes.add(type));
  const owners = new WeakMap<object, InputTimerOwner>();
  const pending = new Map<number, InputTimerTask>();
  const nativeSetTimeout = runtime.setTimeout;
  const nativeClearTimeout = runtime.clearTimeout;

  function release(task: InputTimerTask): void {
    task.pending = false;
    task.owner.tasks.delete(task);
    if (task.id != null && pending.get(task.id) === task) pending.delete(task.id);
  }

  const guardedTimeout: any = function (this: any, callback: any, delay?: number, ...args: any[]): number {
    const instance = getCurrentInstance();
    if (typeof callback != "function" || instance == null || !inputTypes.has(instance.type)) {
      return nativeSetTimeout.call(this, callback, delay, ...args);
    }

    let owner = owners.get(instance);
    if (owner == null) {
      owner = { disposed: false, tasks: new Set<InputTimerTask>() };
      owners.set(instance, owner);
      const mountedOwner = owner;
      onBeforeUnmount(() => {
        mountedOwner.disposed = true;
        mountedOwner.tasks.forEach((task) => {
          release(task);
          if (task.id != null) nativeClearTimeout.call(runtime, task.id);
        });
      }, instance);
    }

    const task: InputTimerTask = { id: null, owner, pending: true };
    const id: number = nativeSetTimeout.call(this, function (this: any, ...values: any[]): any {
      const shouldRun = task.pending && !task.owner.disposed;
      release(task);
      if (shouldRun) return callback.apply(this, values);
    }, delay, ...args);
    task.id = id;
    if (task.pending && !owner.disposed) {
      owner.tasks.add(task);
      pending.set(id, task);
    } else {
      release(task);
      nativeClearTimeout.call(runtime, id);
    }
    return id;
  };
  guardedTimeout[guardKey] = (component: object): void => { inputTypes.add(component); };
  runtime.setTimeout = guardedTimeout;
  runtime.clearTimeout = function (this: any, id: number): void {
    const task = pending.get(id);
    if (task != null) release(task);
    nativeClearTimeout.call(this, id);
  };
  // #endif
}
