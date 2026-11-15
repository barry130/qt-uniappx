# 轻听 Android TV 原生集成

## 分工与运行前提

原生能力隔离在 [qt-tv-native](<../uni_modules/qt-tv-native>)，应用服务负责 TV 模式选择、空间导航、焦点记忆、弹层优先级、搜索/快捷操作及滑杆的显式 ± 操作。手机、平板、车机沿用现有布局、原生输入和 Media3；本模块没有修改已有原生插件、主应用 Manifest、ABI、账号、歌词或音频会话。

Android 实现针对 HBuilderX **5.34 / UniAppX Vapor DOM2**；独立 native base 须实际包含该插件。应用 bytecode 编译通过、旧基座正在运行与新插件已进入 APK 是三个独立判据。iOS、Harmony、Web 及其他平台入口返回中性设备信息、空候选和无副作用操作。

## 稳定接口

类型定义见 [interface.uts](<../uni_modules/qt-tv-native/utssdk/interface.uts>)，实现见 [Android index.uts](<../uni_modules/qt-tv-native/utssdk/app-android/index.uts>)。

| 接口 | 契约 |
| --- | --- |
| `readTvDevice()` | `{ television, leanback, uiModeType, nativeAvailable }`，基于 Android `Configuration.uiMode` 与系统 features，非屏幕尺寸猜测 |
| `startTvRemote(handler)` | 注册全局 Activity 预分发钩子；回调 `void`，使用 `@UTSJS.keepAlive` 保活，重复调用替换 handler，不叠加钩子 |
| `setTvRemoteState(state)` | `{ enabled, captureBack, captureMenu, editing }`，由应用在模式、页面、弹层与输入状态变化时同步 |
| `stopTvRemote()` | 清 handler、钩子、候选、描边与编辑观察；presentation 独立由其开关还原 |
| `collectTvCandidates(root)` | 显式页面/弹层 scope；返回 `{ id,left,top,width,height,visible,enabled,input,longPress,scrollGroup }[]`，坐标为 DOM 逻辑像素 |
| `highlightTvElement(id,color)` | 当前 scope 的独立 decor Drawable ring；空 ID 清除，默认 `#57BDD0`，没有改变布局、selection 或业务样式 |
| `activateTvElement(id,longPress=false)` | 只对当前候选作用；普通 tap、longpress 经 Vapor touch bridge，input 聚焦并显示 IME |
| `scrollTvAncestor(id,direction)` | `up/down/left/right`，最近有剩余范围的 scroll 祖先移动约 70% 视口；只读 `qt-tv-scroll` 从自身起查，到 scope 停止 |
| `setTvPresentation(enabled)` | 真实 TV/Leanback Activity 暂时 `SENSOR_LANDSCAPE`，逐 Activity 保存原方向、关闭恢复，后续 Activity onResume 同步 |
| `performTvBack()` | 在应用弹层/页面处理后调用当前 Activity 既有 `onBackPressed()`；不制造第二个遥控 KeyEvent |

原生稳定 ID 形如 `tv:<appId>:<pageId>:custom:<dataset.qtTvId>`；无显式 ID 时为 `tv:<appId>:<pageId>:node:<nodeId>`。应用恢复焦点使用完整返回 ID；页面需要辨别自定义动作时比较 `:custom:` 后缀，不将完整 ID 与 `dataset.qtTvId` 直接相等比较。相同 scope 重新收集先建新 registry 再发布，保留同 ID 描边。`scrollGroup` 是候选最近 scope 内 scroll/list/swiper 祖先的稳定 ID，无则空字符串；应用空间导航拟跳出当前滚动组时先调用 `scrollTvAncestor`，成功即续滚留组，真实边界返回 false 后才允许转向 dock/rail。

## 按键所有权与编辑模式

1. `UniActivityWindowCallback.dispatchPreKeyEvent(params,event)` 通过 `UTSAndroid.onActivityCallback(callback,null)` 注册，第二参数是 **pageRoute**；`null` 覆盖本应用 Activity 路由，不是类名。
2. `params.returnResult=true` 在原生预分发中同步设置。JS handler 返回值与消费无关，避免 JS→native 往返造成系统默认焦点或返回先执行。
3. 捕获 DPAD `19–23`、ENTER `66`、NUMPAD_ENTER `160`；Back `4`/Escape `111`、Menu `82` 由独立状态控制。回调为 `{ key,code,action:"down",repeat }`。
4. 所有权键为 `deviceId:keyCode:downTime`。已消费 DOWN 的匹配 UP 同样消费，无第二次业务动作；方向 repeat 持续下发，OK/Back/Menu 重复 DOWN 保留消费但不重复执行；孤立 repeat 不新建所有权。
5. HOME、音量和全部 `KEYCODE_MEDIA_*` 原样进入 Android / 已有 Media3 会话。
6. native `EditText` 与 IME 状态补充应用 `editing`。IME 可见时 DPAD/Enter/第一次 Back 放给原生；IME 关闭的 global-layout 转换清除旧 editor 焦点并恢复 TV 导航。硬件键盘/已隐藏 IME 时第一次 Back 只退出编辑，随后 Back 交应用。`editorDismissed` 防止晚到的 JS 编辑状态/原生 autofocus 再次锁住 DPAD；仅候选 input 的 OK 再入编辑。
7. Android 30+ 使用 `WindowInsets.Type.ime()`；26–29 用可见窗口高度差识别键盘。原生编辑观察只在 TV 生命周期存在，停用/离页释放。
8. 焦点 View 或其祖先为嵌入 `WebView` 时，新 DOWN 放给浏览器；已拥有的 repeat/UP 仍保持消费，且不向页面 JS 重投 repeat。系统 picker/Dialog 的独立 Window 沿用其原生处理。

## Vapor 候选与动作桥的依据

普通 Vapor `UniViewElement` 的事件主要存于 bridge 注册表，部分元素被 flatten/virtual 化，纯 Android View 的 `isClickable` / `hasOnClickListeners` / `performClick` 遍历覆盖不到这些业务动作。

本模块使用当前 runtime 的实际公开 native seam：

```text
// Kotlin/UTS source uses the Kotlin object, not its Java-bytecode INSTANCE field.
io.dcloud.uniappxv.bridge.CEventManager
  .hasElementEventListener(UniElement, "tap" | "click" | "longpress")
UniElement.dispatchEvent(new UniTouchEvent("tap", [], []))
UniElement.dispatchEvent(new UniTouchEvent("longpress", [], []))
```

这些 seam 已用安装 SDK 的实际 Vapor JAR `javap` 核实，版本依赖明确隔离于单插件；升级 HBuilderX/UniAppX 时复核签名和实际 touch bridge 通知链，而非以旧声明替代运行证据。统一 `tap` 优先，一次 OK 不同时发 tap 与 click。

收集使用 UniElement 的 children，而非 Android 原生 View 树。排除断开、隐藏、零尺寸、离屏/被 scope 与 scroll 祖先裁剪的候选；`qt-tv-skip` 只排除该节点自身，保留合法业务子节点（例如 click-stop panel）。scope 自身不加入候选。扫描分两阶段：第一阶段广度优先、最多 512 个布局/动作节点（子节点检查另有有界预算），无动作的叶子 text/image 不占预算，后部 rail/dock 不被前部长文本 DFS 吞没；当页面节点数超出预算（巨大非虚拟列表）时，第二阶段只对被预算截断的队列尾与容器剩余子节点做视口优先补扫——离屏包装不消耗可见预算，可见尾行每轮刷新都可达，补充扫描有硬性总预算，不做无界遍历。每轮完整重建候选注册表：滚出视口或被移除的旧候选立即淘汰，重复 collect 不保留跨轮游标，scope 切换清空全部候选。滚动仅在显式 scope 内。模态打开时集成方必须立即切换到其真实内容根，再收集/高亮；背景根的候选与 ring 不保留。

描边从 scope 向上查找尺寸匹配的真实 Android View，结合 `getLocationOnScreen()` 对 DOM 逻辑坐标与 decor 像素偏移校准，随后 preDraw 跟随滚动；退出、隐藏、scope 变化或元素失连后移除 drawable/observer。

`qt-tv-scroll` 仅用于显式只读 scroll/list/swiper 容器：无 tap 也进入候选，`scrollGroup` 与滚动起点取容器自身，OK/longpress 不制造业务动作，支持倒计时确认框等长正文逐屏翻阅。

`root=null` 通过当前 `UniPageActivity.page.bodyElement` 的 Kotlin metadata 属性取得原生页面元素；无自定义 ID 时调用 `UniElement.getNodeId()`。Java 字节码的 getter 名并不表示 Kotlin source 可直接调用。`UniPageBody` 只是矩形信息，不作为遍历根。生产页面与弹层优先传显式根，避免穿越其他浮层。

## TV Launcher 与资源合并

资源入口为插件的 [AndroidManifest.xml](<../uni_modules/qt-tv-native/utssdk/app-android/AndroidManifest.xml>) 与 [320×180 横幅](<../uni_modules/qt-tv-native/utssdk/app-android/res/drawable-nodpi/qt_tv_banner.png>)，遵循 UTS 插件 `app-android/res/` 合并路径。横幅包含轻听品牌文字、既有图标与启动绿 `#0e2418`。

- `android.hardware.touchscreen` 与 `android.software.leanback` 均 `required=false`，单包保留手机/平板/车机安装兼容。
- 独立 `activity-alias` `io.quietmusic.tv.Launcher` 只声明 `MAIN` + `LEANBACK_LAUNCHER`，原手机 `LAUNCHER` 保持。
- alias 的 `targetActivity="io.dcloud.uniappxv.UniAppActivity"` 对齐 HBuilderX **5.34** 实际 `libVapor` JAR 的主类。旧已安装基座中的 `io.dcloud.uniappx.UniAppActivity` 不是本交付的入口依据；最终包仍应检查合并 Manifest 中该 Activity 存在。
- 当前主 Manifest minSdk 26、target 34 和 arm64 ABI 原样保持。电视的 x86/armeabi-v7a 支持按最终原生依赖和设备矩阵另验，不以 source 中增加 ABI 代替 native library 支持。

## 验证分层与设备清单

已完成：安装 SDK/runtime 签名核实；本插件独立 UTS→Kotlin 转译；实际 Vapor/Android/UTS 与缓存 AndroidX classpath 的 Kotlin 编译 exit0（未改 SDK、未使用合成 API stubs）；横幅 320×180 RGB 检查。编译产物 38773B、SHA256 `000c4f932c0af0d703f5cc485f4f958486a2419652d8bc7b8a0dee1942ad7df1`。合并 APK、自定义基座更新与真实遥控尚待匹配设备验收，不从编译/旧基座推出新插件已装载。

最终验证使用实际匹配 APK/设备：

1. 检查合并 Manifest 的 TV alias 目标 Activity 确实存在，Leanback 分类、optional features 与 banner 资源解析正常；手机桌面入口仍为原入口。
2. TV 桌面启动，`readTvDevice()` 与模式一致；进入/离开/关闭 TV 方向恢复原值，phone manual mode 不强制更改原生方向。
3. DPAD 四向含长按 repeat；OK 短按一次，Back/Menu 含重复与 UP 无双执行，page→sheet→nested sheet→page 焦点记忆保持。
4. 半屏/全屏 opaque modal 打开立即切 scope；背景元素无 ring/激活/跨 scope 滚动；同 scope 多次收集同 ID ring 不闪退。
5. 输入 OK 打开 IME；第一次 Back 关闭键盘并清旧焦点，下一次方向恢复导航；输入硬件键盘、重新编辑、原生 autofocus、快速模式切换各复核；嵌入 WebView 与系统 picker 接收自身方向/返回。
6. 靠近 scroll 边缘四向续滚约 70%；边界返回 false，rail/dock 与列表末端可达；只读 `qt-tv-scroll` 长正文四向可翻阅且 OK 无动作；slider 用应用 ± 按钮，原生不制造拖动事件。
7. Media play/pause/next/previous、音量、车载媒体会话不被遥控消费；系统 HOME 正常。
8. 页面销毁、应用退后台、stop/start、多次 handler 替换后无重复回调、残留 ring 或 Activity observer。
9. 手机、平板、车机自动模式不启用 TV，原有输入/触摸/宽屏行为通过既有回归；fallback 平台不产生 Android import 泄漏。

撤回本适配时关闭 TV 模式/presentation 后移除新插件及应用侧接线；既有原生插件与主 Manifest 无需恢复覆盖。当前交付无基座重建、APK 安装、git commit 或 push。
