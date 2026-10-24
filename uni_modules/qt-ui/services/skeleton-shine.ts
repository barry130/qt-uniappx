/**
 * 骨架屏「扫光带」贴图
 *
 * 一条柔和的斜向高光，用作全页骨架屏共用的扫光光源。
 *
 * ── 为什么是一张内嵌 PNG，而不是 CSS 渐变 ────────────────────────────────────
 * AGENTS.md 禁止 linear-gradient（未经真机验证），仓库里唯一一处 linear-gradient
 * 在 pages/home/index.uvue 的 heroStyle，且它的两层色被不透明底色吃掉，无法作为
 * 依据。filter / blur / mask 在 uni-app x 文档里根本没有对应条目，属于明确不支持，
 * 所以「柔和的边」只能靠贴图自带的 alpha 渐变来实现。
 * services/icons.ts 的真机探针已经证明 `data:image/png;base64,` 在鸿蒙上正常渲染，
 * 因此这里沿用同一条已验证的管线。
 *
 * 贴图本身是 128x8 的 RGBA：横向按升余弦曲线做 alpha 渐变（两端全透明、中间 0.95），
 * 纵向无变化，因此纵向拉伸不会产生任何失真。斜向由组件侧 transform: rotate() 完成，
 * 贴图只负责「柔和」。
 *
 * 峰值从 0.70 提到 0.95 的原因：光带是白色，压在半透明白卡片上，实测对比度只有
 * 17/255（约 6.7%），真机截图里几乎读不出来。剩下的对比度由骨架块的底色
 * （各页面 index.uvue 的 .sk-cover）负责。
 *
 * 2026-10 回调：用户反馈「扫光感觉太亮」。贴图峰值是**全主题上限**，只保留 0.95；
 * 主题差异改由组件侧 `.qt-skeleton-shine-track` 的 opacity 表达（浅色 0.78 / 深色 0.48）。
 * 之所以不直接压贴图峰值：光带是白色，压在深色底上对比度 68%，压在浅色底上 16%，
 * 一份贴图压到深色够暗时浅色就「完全看不出来」了（0.70 那一版的历史结论）。
 * 合成模型与两个主题的对比度数值见 shots/contrast-model.py。
 */

/** 扫光带贴图（白，峰值不透明度 0.95） */
export const SHINE_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAAAICAYAAAAx3fd+AAAAbklEQVR42u2SuwrAMAwDlVf//3ubpO5SgzAeukcHx2UqNaiYGT4KtVIrgJbYgyPxSvrXkbz5253qNmqjf690E8tY8Pnc1A1gUd1JdW9qfP9xJo2u4E70O4zq96JCHI0GoAEIDUBoAEIDEBqAOI0X/UY/DbaWhk8AAAAASUVORK5CYII=";
