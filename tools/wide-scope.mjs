// 「宽屏会渲染的范围」判定工具（scan-rpx-wide-risky / count-bare-qtfont-wide /
// fix-bare-qtfont-wide / find-rpx-font-no-inline 共用）。
//
// 早前的实现是「从 v-if="!layout.isWide" 的节点开始，到下一个 v-else 之前」，
// 这在嵌套 v-else 上会切错：pages/home/index.uvue 的竖屏块
//   :32 <view v-if="!layout.isWide" class="portrait-home"> ... :80 </view>
// 内部 :70 还有一个 <scroll-view v-else class="shelf-scroll">，于是区间在 :70 被提前截断，
// 把 :71-:111 这段本该算竖屏的内容误判为「宽屏渲染」。
//
// 正确做法：建一棵轻量元素树（按引号状态扫描起始标签，避免被属性值里的 ">" 截断），
// 再按**同级兄弟**关系把 v-if="!layout.isWide" 与它后面的 v-else / v-else-if 串成一条链。

function tokens(tpl) {
  const out = [];
  let i = 0;
  while (i < tpl.length) {
    const lt = tpl.indexOf("<", i);
    if (lt < 0) break;
    if (tpl.startsWith("<!--", lt)) {
      const e = tpl.indexOf("-->", lt + 4);
      const end = e < 0 ? tpl.length : e + 3;
      i = end;
      continue;
    }
    let j = lt + 1;
    let quote = "";
    while (j < tpl.length) {
      const c = tpl[j];
      if (quote != "") {
        if (c == quote) quote = "";
      } else if (c == '"' || c == "'") {
        quote = c;
      } else if (c == ">") {
        break;
      }
      j++;
    }
    const end = j < tpl.length ? j + 1 : tpl.length;
    const raw = tpl.slice(lt, end);
    let kind = "open";
    let name = "";
    if (raw.startsWith("</")) {
      kind = "close";
      name = raw.slice(2).replace(/[\s>\/].*$/, "").trim();
    } else {
      name = raw.slice(1).replace(/[\s>\/].*$/, "").trim();
      if (/\/>\s*$/.test(raw)) kind = "self";
    }
    out.push({ kind, name, start: lt, end, raw });
    i = end;
  }
  return out;
}

// 建树：每个节点 { name, start, end, startTagEnd, raw, kids: [] }
function buildTree(tpl) {
  const tk = tokens(tpl);
  const root = { name: "#root", start: 0, end: tpl.length, startTagEnd: 0, raw: "", kids: [] };
  const stack = [root];
  for (const t of tk) {
    const top = stack[stack.length - 1];
    if (t.kind == "close") {
      // 找到匹配的祖先并收口
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].name == t.name) {
          stack[k].end = t.end;
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const node = { name: t.name, start: t.start, end: t.end, startTagEnd: t.end, raw: t.raw, kids: [] };
    top.kids.push(node);
    if (t.kind == "open") stack.push(node);
  }
  return root;
}

// 返回 [[start, end], ...]：所有 v-if="!layout.isWide" 元素**自身子树**的区间。
//
// 只取 v-if 分支本身，**不**向后吃掉 v-else —— v-else 才是宽屏分支，
// 把它算进「竖屏」会让宽屏内容被当成竖屏而漏修（这是最初的实现方向，反了）。
export function portraitRanges(tpl) {
  const tree = buildTree(tpl);
  const ranges = [];
  const walk = (node) => {
    for (const c of node.kids) {
      if (/v-if="!layout\.isWide"/.test(c.raw)) ranges.push([c.start, c.end]);
      walk(c);
    }
  };
  walk(tree);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    if (merged.length == 0) merged.push(r);
    else {
      const last = merged[merged.length - 1];
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
  }
  return merged;
}

export function inPortrait(ranges, pos) {
  for (const [s, e] of ranges) if (pos >= s && pos < e) return true;
  return false;
}

export function lineOf(tpl, pos) {
  return tpl.slice(0, pos).split("\n").length;
}

export function splitTemplate(src) {
  const i = src.indexOf("<script");
  return i < 0 ? src : src.slice(0, i);
}
