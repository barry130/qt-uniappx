/**
 * 生成 tabBar 图标 PNG（static/tab/*.png）
 *
 * tabBar 只接受图片，无法直接使用 SVG data URI，
 * 因此这里用与 services/icons.ts 完全一致的几何规范（24x24 视图框、2px 描边、
 * 圆角端点）自行栅格化出 PNG，保证 tabBar 与页面内图标风格统一。
 *
 * 运行：node tools/gen-tab-icons.mjs
 * 依赖：仅 Node 内置模块（zlib / fs）
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "static", "tab");

const SIZE = 81; // tabBar 建议 81x81
const VIEW = 24; // 与 services/icons.ts 相同的视图框
const STROKE = 2; // 与 services/icons.ts 相同的描边宽度
const SS = 4; // 每像素超采样倍数

/* ---------- 距离场基元（坐标基于 24x24 视图框） ---------- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);

/** 线段（圆角端点）到点的距离 */
function dSegment(p, a, b) {
  const pa = sub(p, a);
  const ba = sub(b, a);
  const h = Math.min(1, Math.max(0, dot(pa, ba) / dot(ba, ba)));
  return len([pa[0] - ba[0] * h, pa[1] - ba[1] * h]);
}

/** 圆环（描边圆）到点的距离 */
function dCircle(p, c, r) {
  return Math.abs(len(sub(p, c)) - r);
}

/**
 * 圆弧描边到点的距离
 * from/to 为角度（度），0 度指向 +x，顺时针为正（与屏幕坐标一致）
 */
function dArc(p, c, r, from, to) {
  const v = sub(p, c);
  let ang = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  let a0 = ((from % 360) + 360) % 360;
  let a1 = ((to % 360) + 360) % 360;
  const inside = a0 <= a1 ? ang >= a0 && ang <= a1 : ang >= a0 || ang <= a1;
  if (inside) return Math.abs(len(v) - r);
  const pa = [c[0] + r * Math.cos((a0 * Math.PI) / 180), c[1] + r * Math.sin((a0 * Math.PI) / 180)];
  const pb = [c[0] + r * Math.cos((a1 * Math.PI) / 180), c[1] + r * Math.sin((a1 * Math.PI) / 180)];
  return Math.min(len(sub(p, pa)), len(sub(p, pb)));
}

/** 圆角矩形边框到点的距离 */
function dRoundRect(p, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(p[0] - cx) - (w / 2 - r);
  const qy = Math.abs(p[1] - cy) - (h / 2 - r);
  const outside = len([Math.max(qx, 0), Math.max(qy, 0)]);
  const insideDist = Math.min(Math.max(qx, qy), 0);
  return Math.abs(outside + insideDist - r);
}

/** 多边形填充判定 */
function inPolygon(p, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/* ---------- 图标定义：与 services/icons.ts 中同名图标保持一致 ---------- */

/** compass —— “发现” */
function iconCompass(p) {
  if (dCircle(p, [12, 12], 9) <= STROKE / 2) return true;
  if (inPolygon(p, [[15.6, 8.4], [13.8, 13.8], [8.4, 15.6], [10.2, 10.2]])) return true;
  return false;
}

/** music —— “音乐库” */
function iconMusic(p) {
  if (dSegment(p, [9, 18], [9, 5]) <= STROKE / 2) return true;
  if (dSegment(p, [9, 5], [21, 3]) <= STROKE / 2) return true;
  if (dSegment(p, [21, 3], [21, 16]) <= STROKE / 2) return true;
  if (dCircle(p, [6, 18], 3) <= STROKE / 2) return true;
  if (dCircle(p, [18, 16], 3) <= STROKE / 2) return true;
  return false;
}

/** user —— “我的” */
function iconUser(p) {
  if (dCircle(p, [12, 8], 4) <= STROKE / 2) return true;
  if (dArc(p, [12, 21], 7.5, 180, 360) <= STROKE / 2) return true;
  return false;
}

/* ---------- 栅格化与 PNG 编码 ---------- */

function rasterize(shape, hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const scale = VIEW / SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const vx = (x + (sx + 0.5) / SS) * scale;
          const vy = (y + (sy + 0.5) / SS) * scale;
          if (shape([vx, vy])) hits++;
        }
      }
      const alpha = Math.round((hits / (SS * SS)) * 255);
      const o = (y * SIZE + x) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = alpha;
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crcSrc = Buffer.concat([Buffer.from(type, "ascii"), data]);
  out.writeUInt32BE(crc32(crcSrc), data.length + 8);
  return out;
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const NORMAL = "#6b7385";
const ACTIVE = "#e5484d";
const TARGETS = [
  ["discover", iconCompass],
  ["library", iconMusic],
  ["profile", iconUser],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, shape] of TARGETS) {
  writeFileSync(resolve(OUT_DIR, name + ".png"), encodePng(rasterize(shape, NORMAL)));
  writeFileSync(resolve(OUT_DIR, name + "-active.png"), encodePng(rasterize(shape, ACTIVE)));
}
console.log("tab icons generated:", SIZE + "x" + SIZE, TARGETS.map((t) => t[0]).join(", "));
