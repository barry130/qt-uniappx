/**
 * 全局唯一 pid（UUID v4 形态，36 字符，满足后端 ≤64 约束）。
 * 本地歌单用它作为多端同步的唯一键：不能用平台自己的歌单号（多端含义不同），
 * 也不能用「时间戳 + 短随机」（多设备同时建歌单会撞车）。
 *
 * 批次⑥（2026-10-27）从 stores/player.ts 移出成独立模块：like-sync 引擎
 * （services/like-sync.ts）与播放器 store 两边都要用，此前引擎侧是漏 import
 * 的悬空引用（静态门禁不查 .ts 逻辑、抽离当时未跑 vapor 构建，查不出来）；
 * 收进纯函数模块后 engine 与 store 共享同一定义，测试沙箱也能直接装载。
 */
export function generateGlobalPid(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += hex.charAt(Math.floor(Math.random() * 16));
  }
  // 版本号 4 + 变体位，拼成 8-4-4-4-12 的标准形态
  const variant = "89ab".charAt(Math.floor(Math.random() * 4));
  return (
    out.substring(0, 8) +
    "-" +
    out.substring(8, 12) +
    "-4" +
    out.substring(13, 16) +
    "-" +
    variant +
    out.substring(17, 20) +
    "-" +
    out.substring(20, 32)
  );
}
