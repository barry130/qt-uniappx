/**
 * 屏蔽匹配算法的跨端向量表校验（`npm run check:dislike`，已并入 `npm run check`）。
 *
 * 背景：`stores/dislike-match.ts` 是 qt-pc `src-tauri/src/db/store/dislikes.rs` 的
 * UTS 移植，两端各写一遍。「PC 屏蔽生效、安卓不生效」这种漂移只有用户能发现，
 * 所以改成机器挡：同一份向量表 `tools/dislike-parity.json`（对端拷贝在
 * `qt-pc/src-tauri/tests/fixtures/dislike-parity.json`，cargo test 跑同一份），
 * 本脚本执行 UTS 实现逐条核对 expect，并比对两端文件是否字节相同。
 *
 * 直接 `import` .ts：本文件只含可擦除类型语法，node ≥22.6 原生去类型即可执行，
 * 不需要额外的构建步骤 —— 这是「让向量表能在 CI 里真跑起来」的关键。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeKey,
  singerTokensOf,
  splitSingers,
  stripNoteSegments,
} from "../stores/dislike-match.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "dislike-parity.json");
const pcFixturePath = join(
  here,
  "..",
  "..",
  "qt-pc",
  "src-tauri",
  "tests",
  "fixtures",
  "dislike-parity.json",
);

const failures = [];

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runSection(label, cases, fn) {
  for (const c of cases) {
    const got = fn(c.input);
    if (!same(got, c.expect)) {
      failures.push(
        `${label}: input=${JSON.stringify(c.input)} → ${JSON.stringify(got)}，向量表要求 ${JSON.stringify(c.expect)}`,
      );
    }
  }
}

const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
runSection("normalizeKey", fx.normalize ?? [], normalizeKey);
runSection("stripNoteSegments", fx.strip ?? [], stripNoteSegments);
runSection("singerTokensOf", fx.split ?? [], singerTokensOf);
runSection("splitSingers", fx.splitRaw ?? [], splitSingers);

// 两端向量表必须字节相同：expect 改了只改一边，等于两端口径已经分叉
let pcNote = "";
try {
  const mine = readFileSync(fixturePath);
  const pc = readFileSync(pcFixturePath);
  if (!mine.equals(pc)) {
    const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
    failures.push(
      `向量表与 qt-pc 不同步：本端 sha=${h(mine)}（${fixturePath}）\n` +
        `  对端 sha=${h(pc)}（${pcFixturePath}）`,
    );
  }
} catch (err) {
  // 同级没有克隆 qt-pc（只拿 uniappx 仓库单独构建）时跳过比对，不算失败
  pcNote = `（未找到 ${pcFixturePath}，跳过跨仓字节比对）`;
}

const caseCount =
  (fx.normalize?.length ?? 0) +
  (fx.strip?.length ?? 0) +
  (fx.split?.length ?? 0) +
  (fx.splitRaw?.length ?? 0);

if (failures.length > 0) {
  console.error("[dislike-parity] 屏蔽匹配算法与 qt-pc 不一致：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`[dislike-parity] ${caseCount} 条用例通过 ${pcNote}`);