/**
 * qt-js-engine 鸿蒙端「ArkWeb 宿主」——ets 混编层（builder.ets）
 *
 * ============================ 为什么必须有这个文件 ============================
 *
 * 安卓端能在**没有 UI 树**的情况下起一个隐藏 WebView（`activity.addContentView(view, 1×1)`），
 * 因为 `android.webkit.WebView` 是一个普通 View。鸿蒙不一样：
 *
 *   **ArkWeb 的 `Web` 是 ArkUI 组件，不是可以 `new` 出来独立跑的对象。**
 *   `webview.WebviewController` 只是一个「控制器句柄」，它的所有能力
 *   （`runJavaScript` / 拦截请求 / 加载数据）都必须先绑定到一个**已进入 UI 树**的
 *   `Web` 组件上（绑定完成的标志是 `onControllerAttached`）。控制器没有和 Web
 *   组件绑定时调用 `runJavaScript` 会直接失败/无回调。
 *
 * 而且鸿蒙**没有 headless JS 运行时可用作替代**：
 *   - `@ohos.taskpool` / `worker` 跑的是 ArkTS，不是 JS bundle 语义（没有 DOM、
 *     没有 `import()` 动态模块图、没有 prelude 依赖的那些 Web API 补齐）；
 *   - `@ohos.arkui.node` 的 BuilderNode/FrameNode 只是「把组件挂到既有节点上」，
 *     本身不提供 JS 引擎。
 *   所以「用 ArkWeb 复刻安卓架构」= **必须给 Web 组件找一处挂载点**，这件事没有第二条路。
 *
 * 结论（明确写出来，不糊过去）：**鸿蒙端本插件依赖一个可挂载的 UI 节点**。
 * 本文件按下面的三级策略找挂载点，**三级全部失败时** `attach()` 才返回错误文本，
 * `index.uts` 的 `start()` 会据此干净失败（上层 source-engine 本来就有 start 失败分支，
 * 不会崩，只是音源能力不可用）。
 *
 * 挂载策略（**逐级回退**，全部集中在本文件，uts 侧不感知）：
 *   策略 1（首选，**不需要 app 改一行**）  覆盖层：`UIContext.getOverlayManager()`
 *           + `OverlayManager.addComponentContent(ComponentContent)`。
 *           ComponentContent 与 BuilderNode 同源（都是在 UI 组件之外构建组件树），
 *           但覆盖层**自带挂载点**，所以完全不依赖页面里是否存在某个 id 的节点。
 *   策略 2  调用方通过 `new QtJsArkWebHost(..., hostNodeId)` 指定一个页面节点 id
 *           （app 侧写 `<view id="qt-js-engine-host">` 即可，一行、零成本）；
 *   策略 3  页面根节点：`getAttachedFrameNodeById('root')` / `getFrameNodeById('root')`。
 *           本机 SDK 里**没有** `getRootFrameNode()` 这类 API（全量搜索 0 命中），
 *           'root' 只是约定俗成的根节点 id，不保证存在，所以它排在最后且失败不致命。
 *
 * ⚠️ 三级是**逐级回退**关系，不是二选一：任一级失败都要把原因记进诊断串后**继续下一级**。
 * 曾经这里在策略 2 失败时直接 return 错误，导致「app 没放那个 view」时策略 3 永远不可达——
 * 真机上表现为「引擎待启动·异常:未找到宿主节点 id=qt-js-engine-host」。现在不再提前返回。
 * 全部失败时 `attach()` 才返回错误文本，`index.uts` 的 start() 据此干净失败
 * （上层 source-engine 本来就有 start 失败分支，不会崩，只是音源能力不可用）。
 *
 * 不要试图在 build 阶段把 Web 塞进 ability 的 windowStage：windowStage 没有
 * 「无页面的内容根」，`setUIContent` 又要求一个已注册的页面路径（那是 app 的资源，
 * 插件给不了）。
 *
 * ============================ 其它刻意的设计取舍 ============================
 *
 * 1. 模块脚本**从内存直供**，不落盘、不再读回。
 *    安卓端因为 `evaluateJavascript` 有 Binder 1MB 上限，必须把 1.7MB 的 bundle
 *    落盘再用 `WebResourceResponse(FileInputStream)` 喂给 WebView。鸿蒙这边
 *    `WebResourceResponse.setResponseData()` 收字符串，没有可用的流式入口，
 *    所以 index.uts 直接把源码交给本类（`setBundleSource`），拦截时原样返回。
 *    少一次写盘 + 少一次读盘，也少一个「文件权限/路径拼错」的失败面。
 *
 * 2. 拦截**白名单化**：只有 base URL 下的两个固定路径（meta / play）放行，
 *    外加 `/`（空白文档，仅作兜底），其余一律 403。
 *    与安卓的 `shouldInterceptRequest` 语义一致——bundle 代码里被收缴过的网络出口
 *    之外，不允许有任何真实网络请求逃逸。
 *
 * 3. 拦截响应带 `Access-Control-Allow-Origin: *`。
 *    模块脚本一律按 CORS 模式抓取；而注入脚本（`runJavaScript`）所在文档的 origin
 *    可能是 null/opaque，不带这个头就会报跨域而拿不到模块。
 *
 * 4. 本文件**不 import 任何 uts**（ets 不能引用 uts，只能 uts → ets）。
 *    所有常量（base URL、两个路径、空白 HTML）都由 index.uts 通过构造参数传入，
 *    保证「路径/URL 只有一处定义」，也避免两边常量漂移。
 *
 * 5. 页面 1×1、可见、不做半透明/隐藏处理。安卓端的注释已经踩过一次坑：
 *    0×0 会被某些实现当成「不可见」而节流渲染进程。1×1 可见最接近「有渲染优先级
 *    但几乎不可见」。而且本架构对节流**天然免疫**：bundle 的 `setTimeout/setInterval`
 *    被 prelude 整体接管到原生队列，推进力来自原生侧每 20ms 一次的 `runJavaScript`，
 *    不依赖页面自身定时器是否被节流。唯一要求是「微任务在每次脚本求值结束时能跑」
 *    （Chromium 语义保证，与安卓 WebView 相同）。
 */

// ComponentContent / OverlayManager 都从 @kit.ArkUI 导出（已核对 kits/@kit.ArkUI.d.ts：
// ComponentContent 经 '@ohos.arkui.node' 导入并再导出，OverlayManager 经
// '@ohos.arkui.UIContext' 导入并再导出）。HitTestMode 是 enums.d.ts 里的环境枚举，无需 import。
import { BuilderNode, ComponentContent, FrameNode, OverlayManager, UIContext } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
// ⚠️ `.ets` 里 `UTSHarmony` **不是全局**（只有 `.uts` 才由编译器注入 import），
// 必须自己从运行时包导入。本文件只用到 `getWindowStage()`：它的 d.ets 返回
// `OHWindow.WindowStage`（`import OHWindow from '@ohos.window'`）可以正常解析。
// 刻意不调用 `getCurrentWindow()`——它的 d.ets 返回类型写死成
// `import("@dcloudio/uni-app-x-vapor-runtime/../../../../../../harmony-command-line-tools/sdk/...")`，
// 该相对路径在本机不存在，引用它会引入一个无法解析的模块类型。
import { UTSHarmony } from '@dcloudio/uni-app-x-vapor-runtime';

/**
 * 传给 `@Builder` 的参数对象。
 *
 * 为什么要用「取源码的函数」而不是直接传字符串字段：`@Builder` 的参数只在
 * 构建时读一次，而模块源码是在页面就绪之后才由 `setBundleSource()` 写进来的。
 * 拦截回调每次触发时现取（`params.bundleSource()`），才能拿到最新源码。
 */
export interface QtJsHostParams {
  /** 与 Web 组件绑定的控制器（由本文件的宿主类持有并传入） */
  controller: webview.WebviewController;
  /** 页面初始 src；同时作为模块 URL 的 base（import 用绝对 URL，见 index.uts） */
  src: string;
  /** meta bundle 的受拦路径（形如 /qt-bundle.js） */
  bundlePath: string;
  /** play bundle 的受拦路径（形如 /qt-play-bundle.js） */
  playPath: string;
  /** 空白文档本体（仅一个 doctype + charset meta，见 index.uts 的 QT_BLANK_HTML） */
  blankHtml: string;
  /** 取 meta bundle 源码（内存直供） */
  bundleSource: () => string;
  /** 取 play bundle 源码（内存直供） */
  playSource: () => string;
  /** 控制器已与 Web 组件绑定（此时 runJavaScript 才可用） */
  onControllerAttached: () => void;
  /** 页面加载结束 */
  onPageEnd: () => void;
  /** 渲染进程退出（ArkWeb 的 onRenderExited）——引擎不可再用的强信号 */
  onRenderExited: () => void;
  /** 资源加载错误（onErrorReceive）——只用于诊断，不直接决定成败 */
  onLoadError: (msg: string) => void;
}

/** 空白文档路径：`src` 与 `loadData` 都指向它，拦截时也用它兜底 */
const BLANK_PATH = '/';

/** `BusinessError` 的结构子集：只取 message/code，避免为一行日志引入 @kit.BasicServicesKit 依赖。
 *  这两个字段声明为**可选**是刻意的：ArkTS 对「必选 string 与 undefined 比较」会报
 *  TS2367（无重叠）类错误，声明成可选后这些防御性判空才是合法写法。 */
interface BusinessErrorLike {
  message?: string;
  code?: number;
}

/** 从「可能是 BusinessError 的任意对象」里取错误文本；取不到或 code===0 一律返回空串 */
function errMessage(e: Object): string {
  const be = e as BusinessErrorLike;
  const message = be.message;
  const code = be.code;
  if (message === undefined || message === null || message.length === 0) {
    return '';
  }
  if (code !== undefined && code === 0) {
    return '';
  }
  return String(message);
}

/** 错误文本：ArkTS 的 catch 变量是 unknown 语义，统一在这里转型 */
function errorText(e: Object): string {
  const message = errMessage(e);
  return message.length > 0 ? message : String(e);
}

/** 从完整 URL 里取 path（丢掉 scheme/host/query/hash），用于受拦路径匹配 */
function pathOf(url: string): string {
  let rest = url;
  const scheme = url.indexOf('://');
  if (scheme >= 0) {
    rest = url.substring(scheme + 3);
  }
  const slash = rest.indexOf('/');
  let path = slash >= 0 ? rest.substring(slash) : BLANK_PATH;
  const query = path.indexOf('?');
  if (query >= 0) {
    path = path.substring(0, query);
  }
  const hash = path.indexOf('#');
  if (hash >= 0) {
    path = path.substring(0, hash);
  }
  return path.length === 0 ? BLANK_PATH : path;
}

/**
 * 构造一个受拦响应。
 *
 * 类型说明（已核对，别再改回 `webview.WebResourceResponse`）：
 *   `WebResourceResponse` 是 **ArkUI 组件的全局声明类**（与 `Web`、`Color` 同一层，
 *   来自 SDK 的 `component/web.d.ts`），**不属于 `webview` 命名空间**。
 *   实测本机 `@ohos.web.webview.d.ts`（267KB）里只有 `WebResourceType` /
 *   `WebResourceHandler` / `WebSchemeHandlerResponse`，没有 `WebResourceResponse`；
 *   写成 `webview.WebResourceResponse` 会直接报「命名空间上不存在该成员」。
 *   本文件是原生 .ets，全局组件声明是 ambient 的，所以直接写 `new WebResourceResponse()`。
 *
 * TODO(harmony-verify): 下面六个 setter 的**存在性**已按 API 12 文档书写，但
 *   本机 UTS 类型树不含 `component/` 目录，无法离线核对：
 *     setResponseData(data: string | number | Resource | ArrayBuffer): void
 *     setResponseEncoding(encoding: string): void
 *     setResponseMimeType(mimeType: string): void
 *     setResponseHeader(header: Object): void
 *     setResponseCode(code: number): void
 *     setReasonMessage(reason: string): void
 *   备选：若 `setResponseCode`/`setReasonMessage` 在这个 API 版本不存在，删掉这两行即可
 *   （空体 + 缺失状态码同样会让浏览器判定资源不可用，语义不损失）；
 *   另外某些版本要求显式 `setResponseIsReady(true)`，同样按需追加。
 */
function makeResponse(data: string, mime: string, code: number, reason: string): WebResourceResponse {
  const res = new WebResourceResponse();
  // 头名/头值都是纯 ASCII 常量，不存在转义问题。
  // 类型必须是 ArkUI 组件声明里的 `Header`（`declare interface Header`，见
  // `ets/component/web.d.ts:3008`）：它是**全局声明**而不是 `@kit.ArkWeb` 的导出
  // （该 kit 只导出 `webview`），所以这里既不能 import 也不能用 `Record<string,string>`
  // ——`setResponseHeader(header: Array<Header>)` 只认结构化数组。
  const headers: Header[] = [
    { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' },
    { headerKey: 'Access-Control-Allow-Headers', headerValue: '*' },
    { headerKey: 'Access-Control-Allow-Methods', headerValue: '*' },
    // 模块图按完整 URL 缓存，播放包用 ?v=N 击穿缓存；no-store 让 meta 热更新也稳定
    { headerKey: 'Cache-Control', headerValue: 'no-store' }
  ];
  res.setResponseMimeType(mime);
  res.setResponseEncoding('utf-8');
  res.setResponseHeader(headers);
  res.setResponseCode(code);
  res.setReasonMessage(reason);
  res.setResponseData(data);
  return res;
}

/** 受拦的模块脚本响应 */
function makeScriptResponse(source: string, path: string): WebResourceResponse {
  if (source.length === 0) {
    // 源码为空说明调用方还没把 bundle 交过来（顺序错误），给一个明确的失败而不是空文件
    return makeResponse('throw new Error("qt-js-engine: bundle 源码为空（' + path + '）");',
      'text/javascript', 404, 'Not Found');
  }
  return makeResponse(source, 'text/javascript', 200, 'OK');
}

/** 未受拦路径：一律 403 空体，杜绝真实网络出口 */
function makeBlockedResponse(): WebResourceResponse {
  return makeResponse('', 'text/plain', 403, 'Blocked by qt-js-engine');
}

/**
 * 拦截处理：只放行三个路径（meta / play / 空白文档），其余 403。
 * 与安卓 `V8Client.shouldInterceptRequest` 同语义。
 */
function handleIntercept(params: QtJsHostParams, url: string): WebResourceResponse {
  const path = pathOf(url);
  if (path === params.bundlePath) {
    return makeScriptResponse(params.bundleSource(), path);
  }
  if (path === params.playPath) {
    return makeScriptResponse(params.playSource(), path);
  }
  if (path === BLANK_PATH) {
    // 兜底：若某些实现会把主框架导航也送进拦截（安卓 21+ 会），这里返回空白文档本体，
    // 保证文档 origin 是 base URL 而不是错误页。
    return makeResponse(params.blankHtml, 'text/html', 200, 'OK');
  }
  return makeBlockedResponse();
}

/**
 * 1×1 的 Web 宿主组件（@Builder 必须是全局函数，`wrapBuilder` 才能引用它）。
 *
 * 属性只保留真正需要的最小集合：尺寸、JS 开关、文件访问关闭，以及五个事件。
 * 刻意不写 darkMode / mixedMode / zoomAccess 之类「默认值就够用」的属性——
 * 每多一个属性名就多一个待验证的编译面。
 */
@Builder
export function buildQtJsEngineHost(params: QtJsHostParams) {
  Web({ src: params.src, controller: params.controller })
    .width(1)
    .height(1)
    .backgroundColor(Color.Transparent)
    // 覆盖层挂载时本组件浮在整个页面之上，(0,0) 处的 1×1 会吃掉该点的点击。
    // None = 自身不参与命中测试、也不阻断兄弟/祖先节点，等价于「对用户不可见」。
    // 对 BuilderNode 路径同样无害（1×1 本来就不该接收触摸）。
    .hitTestBehavior(HitTestMode.None)
    .javaScriptAccess(true)
    // 关掉文件访问：页面只需要模块脚本，能力越小越好（与安卓 setAllowFileAccess(false) 对齐）
    .fileAccess(false)
    .onControllerAttached(() => {
      params.onControllerAttached();
    })
    .onPageEnd(() => {
      params.onPageEnd();
    })
    .onRenderExited(() => {
      params.onRenderExited();
    })
    .onErrorReceive((event) => {
      // 只做诊断：主框架导航到 base URL 失败是预期内的情况（内容由 loadData 提供），
      // 所以这里绝不能把「有错误」直接当失败，否则正常启动会被误判。
      params.onLoadError('ArkWeb 资源错误');
    })
    .onInterceptRequest((event) => {
      const url = event.request.getRequestUrl();
      return handleIntercept(params, url);
    });
}

/**
 * ArkWeb 宿主：把「构建 + 挂载 + 求值 + 生命周期状态」封装成一个 uts 可直接 new 的类。
 *
 * 线程语义：全部在 ArkTS 主线程（鸿蒙上跑插件的只有主线程），所以本类**不做任何阻塞等待**，
 * 只提供「异步求值 + 状态位」；串行化、超时、poison 等策略都在 index.uts 里（那才是语义层）。
 */
export class QtJsArkWebHost {
  private controller: webview.WebviewController = new webview.WebviewController();
  private node: BuilderNode<[QtJsHostParams]> | null = null;
  /** 策略 1（覆盖层）成功时持有；与 node 互斥 */
  private content: ComponentContent<QtJsHostParams> | null = null;
  private overlay: OverlayManager | null = null;
  /** 实际生效的挂载策略，用于诊断（见 mountStrategy） */
  private strategy: string = '';
  private params: QtJsHostParams | null = null;
  private uiContext: UIContext | null = null;
  private src: string = '';
  private bundlePath: string = '';
  private playPath: string = '';
  private blankHtml: string = '';
  private hostNodeId: string = '';
  private bundleSource: string = '';
  private playSource: string = '';
  private attached: boolean = false;
  private ctrlReady: boolean = false;
  private pageReady: boolean = false;
  private renderGone: boolean = false;
  private loadErrorMsg: string = '';
  private readyCb: () => void = () => {};
  private renderGoneCb: () => void = () => {};

  constructor(bundlePath: string, playPath: string, src: string, blankHtml: string, hostNodeId: string) {
    this.bundlePath = bundlePath;
    this.playPath = playPath;
    this.src = src;
    this.blankHtml = blankHtml;
    this.hostNodeId = hostNodeId;
    // 立刻构造参数对象：`@Builder` 与拦截回调都长期持有它，
    // 「取源码」用箭头函数现取 this 上的字段（构建后再 set 也能生效）。
    this.params = {
      controller: this.controller,
      src: this.src,
      bundlePath: this.bundlePath,
      playPath: this.playPath,
      blankHtml: this.blankHtml,
      bundleSource: () => this.bundleSource,
      playSource: () => this.playSource,
      onControllerAttached: () => this.onControllerAttached(),
      onPageEnd: () => this.onPageEnd(),
      onRenderExited: () => this.onRenderExited(),
      onLoadError: (msg: string) => {
        this.loadErrorMsg = msg;
      }
    };
  }

  /** 交给 meta bundle 源码（页面就绪之前调用即可） */
  setBundleSource(code: string): void {
    this.bundleSource = code;
  }

  /** 交给 play bundle 源码（每次装载前覆盖；导入用 ?v=N 击穿模块缓存） */
  setPlaySource(code: string): void {
    this.playSource = code;
  }

  /**
   * 注册「控制器已附加 + 页面已结束」的回调。
   * index.uts 收到后就注入 prelude/bootstrap 并探测——这是唯一一次的「注入时机」。
   */
  onReady(cb: () => void): void {
    this.readyCb = cb;
    if (this.ctrlReady && this.pageReady) {
      cb();
    }
  }

  /** 渲染进程退出：引擎不可能自愈，index.uts 会把它变成 isHealthy()==false */
  onRenderGone(cb: () => void): void {
    this.renderGoneCb = cb;
  }

  isControllerAttached(): boolean {
    return this.ctrlReady;
  }

  isPageReady(): boolean {
    return this.pageReady;
  }

  isRenderGone(): boolean {
    return this.renderGone;
  }

  /** 最近一次资源加载错误（仅诊断用，失败信息里会拼上它） */
  lastLoadError(): string {
    return this.loadErrorMsg;
  }

  /** 当前是否已挂载（teardown 后为 false） */
  isAttached(): boolean {
    return this.attached;
  }

  /**
   * 构建并挂载 1×1 的 Web 组件。
   *
   * 返回空串表示已挂到 UI 树上（控制器是否已有点，等 `onReady`）；否则返回中文错误文本。
   * **同步**返回原因：挂载这件事必须立刻知道成败，不能等异步回调（否则 start() 的超时
   * 诊断会混淆「没挂上」和「挂上了但页面慢」）。
   */
  attach(): string {
    if (this.attached) {
      return '';
    }
    const ui = resolveUIContext();
    if (ui === null) {
      return '未取得 UIContext（windowStage 尚未创建或当前没有 UI 实例）';
    }
    this.uiContext = ui;
    const params = this.params;
    if (params === null) {
      return 'ArkWeb 宿主已释放（params 为空）';
    }

    // 逐级回退：每级失败只记录原因，**不提前返回**，直到有一级成功。
    // （旧实现把「找不到 id」当成终局错误直接 return，真机上只要 app 没放那个 view
    //   就必然失败——这就是「未找到宿主节点 id=qt-js-engine-host」的来源。）
    const reasons: string[] = [];
    if (this.mountViaOverlay(ui, params, reasons)) {
      this.attached = true;
      return '';
    }
    if (this.mountViaFrameNode(ui, params, reasons)) {
      this.attached = true;
      return '';
    }
    return '鸿蒙端没有可用的 WebView 宿主挂载点（ArkWeb 必须有 UI 树，无法无头运行）。'
      + '已逐级尝试：' + reasons.join('；') + '。'
      + '兜底办法：在常驻页面里放一个 <view id="' + this.hostNodeId + '"></view>'
      + '（见 builder.ets 文件头「挂载策略」）。';
  }

  /**
   * 实际生效的挂载策略（诊断用）。
   *
   * 挂载是同步成功的，但「Web 真的进了 UI 树并触发 onControllerAttached」是异步的。
   * 真机上如果卡在页面就绪超时，这条信息能立刻区分「策略 1 挂上了但 Web 没渲染」
   * 和「三级都挂了、压根没挂载点」——两者的排查方向完全不同。
   */
  mountStrategy(): string {
    return this.strategy;
  }

  /**
   * 策略 1：挂到**覆盖层**（OverlayManager）。
   *
   * 为什么它排在第一位：覆盖层自带挂载点，**不需要 app 侧存在任何特定 id 的节点**。
   * ComponentContent 与 BuilderNode 同源（都是在 UI 组件之外构建组件树），但
   * BuilderNode 只负责「构建」，必须自己再 appendChild 到某个已存在的 FrameNode 上；
   * 而 `OverlayManager.addComponentContent()` 由框架负责把节点挂进当前 UIContext 的
   * 覆盖层——这正好绕开「页面里必须有个 view」这个前置条件。
   */
  private mountViaOverlay(ui: UIContext, params: QtJsHostParams, reasons: string[]): boolean {
    let content: ComponentContent<QtJsHostParams> | null = null;
    try {
      content = new ComponentContent<QtJsHostParams>(
        ui, wrapBuilder<[QtJsHostParams]>(buildQtJsEngineHost), params);
    } catch (e) {
      reasons.push('覆盖层构建失败：' + errorText(e));
      return false;
    }
    try {
      const overlay = ui.getOverlayManager();
      if (overlay === null || overlay === undefined) {
        reasons.push('UIContext.getOverlayManager() 返回空');
        disposeContent(content);
        return false;
      }
      overlay.addComponentContent(content);
      this.content = content;
      this.overlay = overlay;
      this.strategy = '覆盖层(OverlayManager)';
      return true;
    } catch (e) {
      reasons.push('覆盖层挂载失败：' + errorText(e));
      disposeContent(content);
      return false;
    }
  }

  /**
   * 策略 2/3：BuilderNode 构建 → 逐级找挂载点（调用方 id → 页面根节点）后 appendChild。
   *
   * 每一级找不到/挂不上都只是记一笔原因然后继续，绝不中断整条链。
   */
  private mountViaFrameNode(ui: UIContext, params: QtJsHostParams, reasons: string[]): boolean {
    let node: BuilderNode<[QtJsHostParams]> | null = null;
    try {
      node = new BuilderNode<[QtJsHostParams]>(ui);
      // `wrapBuilder` 在 ArkUI 里是全局函数（官方 CalendarPicker 示例没有 import 它）。
      node.build(wrapBuilder<[QtJsHostParams]>(buildQtJsEngineHost), params);
    } catch (e) {
      reasons.push('BuilderNode 构建失败：' + errorText(e));
      return false;
    }
    const frame: FrameNode | null = node.getFrameNode();
    if (frame === null || frame === undefined) {
      reasons.push('BuilderNode.build 未生成 FrameNode');
      disposeNode(node);
      return false;
    }

    // 候选挂载点按优先级排列：调用方指定的 id 最优先（语义最明确），
    // 其次是页面根节点 id。去重，避免同一个 id 试两遍刷两条同样的原因。
    const ids: string[] = [];
    if (this.hostNodeId.length > 0) {
      ids.push(this.hostNodeId);
    }
    if (ROOT_NODE_ID.length > 0 && ROOT_NODE_ID !== this.hostNodeId) {
      ids.push(ROOT_NODE_ID);
    }

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const target = findFrameNode(ui, id);
      if (target === null) {
        reasons.push('未找到节点 id=' + id);
        continue;
      }
      try {
        target.appendChild(frame);
        this.node = node;
        this.strategy = '节点(' + id + ')';
        return true;
      } catch (e) {
        reasons.push('挂到节点 ' + id + ' 失败：' + errorText(e));
      }
    }
    // 一条都没挂上：不留半成品节点
    disposeNode(node);
    return false;
  }

  /**
   * 异步求值。
   *
   * [已核对] `WebviewController.runJavaScript` 的两个重载都在本机 SDK 类型定义里
   * （@ohos.web.webview.d.ts）：
   *   runJavaScript(script: string): Promise<string>                    —— :3473
   *   runJavaScript(script: string, callback: AsyncCallback<string>): void —— :3499
   * 回调形态更贴合本架构（index.uts 的求值队列逐条串联），所以用回调形态。
   * 备选（若某版本只剩 Promise 形态）：改成
   * `this.controller.runJavaScript(code).then((v: string) => done(v)).catch(...)`
   * ——index.uts 只依赖 `done(value)` 这一个出口，改这里不影响语义层。
   *
   * `done('')` 同时被用作「求值失败」的载体：空字符串在协议里本来就不是合法返回值
   * （探测值 '2'、pump 文本、opId 都非空），index.uts 会结合 `lastEvalError` 判别。
   */
  evalAsync(code: string, done: (value: string) => void): void {
    if (!this.attached || !this.ctrlReady) {
      done('');
      return;
    }
    try {
      this.controller.runJavaScript(code, (err, value) => {
        // 用 errMessage 统一判别：成功时 err 为 null（或 code===0），失败时拿到 message。
        // 不直接比较 err.message，规避「必选 string 与 undefined 比较」的编译错误。
        const message = errMessage(err);
        if (message.length > 0) {
          this.loadErrorMsg = 'runJavaScript 失败：' + message;
          done('');
          return;
        }
        done(value === null || value === undefined ? '' : value);
      });
    } catch (e) {
      this.loadErrorMsg = 'runJavaScript 抛异常：' + errorText(e);
      done('');
    }
  }

  /** 卸载并释放：stop / 重建引擎时调用。dispose 之后所有事件都不会再回调 */
  detach(): void {
    this.attached = false;
    this.ctrlReady = false;
    this.pageReady = false;
    this.strategy = '';
    const node = this.node;
    this.node = null;
    const content = this.content;
    this.content = null;
    const overlay = this.overlay;
    this.overlay = null;
    this.params = null;
    // 覆盖层路径：必须先 removeComponentContent 再 dispose——
    // dispose 只解除与后端节点的引用，节点本身仍留在覆盖层上。
    if (content !== null) {
      if (overlay !== null) {
        try {
          overlay.removeComponentContent(content);
        } catch (e) {
        }
      }
      disposeContent(content);
    }
    if (node !== null) {
      disposeNode(node);
    }
  }

  /** 控制器与 Web 组件绑定的瞬间：立刻用 loadData 铺空白文档（不依赖主框架拦截是否可用） */
  private onControllerAttached(): void {
    this.ctrlReady = true;
    const params = this.params;
    if (params !== null) {
      try {
        // [已核对] `loadData` 签名（@ohos.web.webview.d.ts:2840）：
        //   loadData(data: string, mimeType: string, encoding: string,
        //            baseUrl?: string, historyUrl?: string): void
        // baseUrl 必须给成 https://qt.local/ —— 它决定文档 origin，而 bundle 的
        // `import('https://qt.local/qt-bundle.js')` 依赖同源（跨域时靠拦截响应上的
        // Access-Control-Allow-Origin 兜住）。备选：4 参数形态（去掉 historyUrl）。
        this.controller.loadData(params.blankHtml, 'text/html', 'utf-8', this.src, this.src);
      } catch (e) {
        this.loadErrorMsg = 'loadData 失败：' + errorText(e);
      }
    }
    this.fireReadyIfNeeded();
  }

  private onPageEnd(): void {
    this.pageReady = true;
    this.fireReadyIfNeeded();
  }

  private onRenderExited(): void {
    this.renderGone = true;
    this.renderGoneCb();
  }

  private fireReadyIfNeeded(): void {
    if (this.ctrlReady && this.pageReady) {
      this.readyCb();
    }
  }
}

/** 取得 UIContext：windowStage 主窗口优先，其次当前窗口 */
function resolveUIContext(): UIContext | null {
  // [已核对] 两条路径的签名都在本机 SDK 类型定义里：
  //   路径 A：`WindowStage.getMainWindowSync(): Window`（@ohos.window.d.ts:5791）
  //           + `Window.getUIContext(): UIContext`（@ohos.window.d.ts:3422）
  //   路径 B：`UTSHarmony.getCurrentWindow(): _ohos_window.default.Window`（UTSHarmony.d.ts:272）
  // 仍然保留 try/catch：windowStage 在 UI 起来之前取不到，属预期内的失败。
  // 备选：`getContext()`（全局，API 18 起废弃）返回的是 Context 不是 UIContext，
  // 不能用于挂载；若两条路径都不可用，就必须改用「调用方传节点 id」策略。
  try {
    const ws = UTSHarmony.getWindowStage();
    if (ws !== null && ws !== undefined) {
      const win = ws.getMainWindowSync();
      if (win !== null && win !== undefined) {
        const ui = win.getUIContext();
        if (ui !== null && ui !== undefined) {
          return ui;
        }
      }
    }
  } catch (e) {
  }
  try {
    const win = UTSHarmony.getCurrentWindow();
    if (win !== null && win !== undefined) {
      const ui = win.getUIContext();
      if (ui !== null && ui !== undefined) {
        return ui;
      }
    }
  } catch (e) {
  }
  return null;
}

/**
 * 页面根节点的约定 id（策略 3 的候选）。
 *
 * ⚠️ 本机 SDK 里**没有** `getRootFrameNode()` 之类的 API（全量搜索 0 命中），
 * 所以 'root' 只是一个「大家都这么叫」的约定，**不保证存在**。因此：
 *   - 它排在覆盖层与调用方 id 之后，只作最后兜底；
 *   - 找不到它是**正常情况**，不产生任何错误（只记一条原因用于诊断）。
 * 两个查找入口都试：`getAttachedFrameNodeById` 是官方 uvue 运行时自己用的
 * （runtime/components/RichTextSelectionMenuHost.ets:224 就是它），
 * `getFrameNodeById` 是不限定「已附加到当前窗口」的版本，覆盖面更宽。
 */
const ROOT_NODE_ID = 'root';

/** 按 id 找已渲染的 FrameNode：两个入口都试，任一命中即返回 */
function findFrameNode(ui: UIContext, id: string): FrameNode | null {
  try {
    const attached = ui.getAttachedFrameNodeById(id);
    if (attached !== null && attached !== undefined) {
      return attached;
    }
  } catch (e) {
  }
  try {
    const anyNode = ui.getFrameNodeById(id);
    if (anyNode !== null && anyNode !== undefined) {
      return anyNode;
    }
  } catch (e) {
  }
  return null;
}

/** 释放 BuilderNode；失败忽略（dispose 只影响资源，不该影响调用方流程） */
function disposeNode(node: BuilderNode<[QtJsHostParams]>): void {
  try {
    node.dispose();
  } catch (e) {
  }
}

/** 释放 ComponentContent；失败忽略 */
function disposeContent(content: ComponentContent<QtJsHostParams>): void {
  try {
    content.dispose();
  } catch (e) {
  }
}