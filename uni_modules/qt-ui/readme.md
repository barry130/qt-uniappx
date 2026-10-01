# Qt UI · Steam 宽屏设计系统

这是一个面向 uni-app x Vapor 模式的独立 UI 组件模块。

详细设计、CSS 约束、组件 API、换肤模型和宽屏策略请阅读：

- `docs/design.md`
- `components/qt-page-frame/qt-page-frame.uvue`
- `components/qt-button/qt-button.uvue`
- `components/qt-card/qt-card.uvue`
- `components/qt-icon/qt-icon.uvue`
- `composables/use-qt-layout.ts`
- `stores/theme.ts`
- 以及当前项目中的播放、歌曲行、弹层、加载等业务 UI 组件

## 页面外壳

所有业务页面使用 `qt-page-frame`：

```vue
<qt-page-frame :max-width="1320">
  <!-- 页面内容 -->
</qt-page-frame>
```

它负责：

- 读取主题皮肤背景色；
- 渲染自定义背景图片；
- 渲染壁纸遮罩，保证内容可读；
- 宽屏时按运行时像素宽度限制内容列并居中；
- 沉浸式页面可通过 `full-width` 保持全宽。
- 业务页面根节点不要再写不透明背景色，否则会盖住皮肤背景和壁纸。

## 约束

该模块严格避免 uni-app x Vapor 不支持或容易触发编译错误的 CSS 写法，尤其是：

- 后代选择器、子选择器、兄弟选择器；
- `:first-child`、`:last-child` 等伪类；
- `max-width: 100%`；
- 未经验证的 Web-only 样式；
- **`box-shadow`**（uni-app x Android 上会导致点击穿透 / 命中丢失，实证见 `docs/ui-review.md` §1）——层级一律用 `border` + surface 色差表达，纯装饰不可点击容器可用极轻 shadow。

宽屏尺寸优先使用运行时计算的 `px`，手机端固定尺寸可以使用 `rpx`。

标签组 `qt-segmented` 的间距由可选 prop `item-gap`（px，默认 0）控制：短标签紧贴时页面显式传值拉开，未传值的既有页面样式不变（见 [`docs/design.md`](docs/design.md) §6.7）。

平台红线、整改进度与剩余问题清单见 [`docs/ui-review.md`](docs/ui-review.md)。