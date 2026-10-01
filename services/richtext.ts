/**
 * 轻量富文本解析
 *
 * 背景：uni-app x 的 <rich-text> 在原生层解析 HTML 是异步的，会出现
 * “标题先渲染、内容后渲染”的两段式闪现。这里在 JS 侧把 HTML 解析成
 * 结构化的块 + 行内片段，交给原生 <text> 同步渲染，既保留富文本样式，
 * 又能与标题同一帧出现。
 */

/** 行内片段：一段连续、样式一致的文字 */
export interface RichRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 颜色，"" 表示继承 */
  color: string;
  /** 字号（含单位，如 "32rpx"），"" 表示继承 */
  fontSize: string;
  /** 链接地址，"" 表示非链接 */
  href: string;
}

/** 块：段落 / 标题 / 列表项 / 图片 / 分割线 */
export interface RichBlock {
  /** "p" 段落 | "h" 标题 | "li" 列表项 | "img" 图片 | "hr" 分割线 */
  kind: string;
  /** 标题级别 1-6，其他为 0 */
  level: number;
  runs: RichRun[];
  /** kind 为 img 时的图片地址 */
  src: string;
  /** 块级链接（图片外层包 <a> 时） */
  href: string;
}

/** 行内样式状态 */
interface InlineStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  fontSize: string;
  href: string;
}

/** 触发换块的标签 */
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "blockquote", "pre",
  "ul", "ol", "li", "table", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);

/** 自闭合标签 */
const VOID_TAGS = new Set([
  "br", "hr", "img", "input", "meta", "link", "source", "track", "wbr", "area", "base", "col", "embed",
]);

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([\w-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) != null) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs.set(m[1].toLowerCase(), decodeEntities(value));
  }
  return attrs;
}

function cloneStyle(s: InlineStyle): InlineStyle {
  return {
    bold: s.bold,
    italic: s.italic,
    underline: s.underline,
    strike: s.strike,
    color: s.color,
    fontSize: s.fontSize,
    href: s.href,
  } as InlineStyle;
}

function baseStyle(): InlineStyle {
  return {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: "",
    fontSize: "",
    href: "",
  } as InlineStyle;
}

function newBlock(kind: string, level: number): RichBlock {
  return { kind, level, runs: [], src: "", href: "" } as RichBlock;
}

/** 从 style 属性里取出我们支持的样式，写入 st */
function applyStyleAttr(st: InlineStyle, css: string): void {
  const lower = css.toLowerCase();
  const colorM = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(lower);
  if (colorM != null) st.color = colorM[1].trim();
  const sizeM = /font-size\s*:\s*([0-9.]+)\s*(rpx|px|pt)?/.exec(lower);
  if (sizeM != null) {
    const unit = sizeM[2] ?? "px";
    if (unit == "rpx" || unit == "px") st.fontSize = sizeM[1] + unit;
  }
  const weightM = /font-weight\s*:\s*([^;]+)/.exec(lower);
  if (weightM != null) {
    const w = weightM[1].trim();
    if (w == "bold" || w == "bolder" || w == "600" || w == "700" || w == "800" || w == "900") st.bold = true;
  }
  if (/font-style\s*:\s*italic/.test(lower)) st.italic = true;
  const decoM = /text-decoration(?:-line)?\s*:\s*([^;]+)/.exec(lower);
  if (decoM != null) {
    const d = decoM[1];
    if (d.indexOf("underline") >= 0) st.underline = true;
    if (d.indexOf("line-through") >= 0) st.strike = true;
  }
}

/** 标签自身带来的样式（b/i/u/s/a/font 等） */
function applyTagStyle(st: InlineStyle, tag: string, attrs: Map<string, string>): void {
  if (tag == "b" || tag == "strong") st.bold = true;
  if (tag == "i" || tag == "em") st.italic = true;
  if (tag == "u" || tag == "ins") st.underline = true;
  if (tag == "s" || tag == "del" || tag == "strike") st.strike = true;
  if (tag == "a") {
    const href = attrs.get("href") ?? "";
    if (href.length > 0) st.href = href;
    if (st.color.length == 0) st.color = "#4a7dff";
    st.underline = true;
  }
  if (tag == "font") {
    const c = attrs.get("color") ?? "";
    if (c.length > 0) st.color = c;
  }
  const css = attrs.get("style") ?? "";
  if (css.length > 0) applyStyleAttr(st, css);
}

/**
 * 把 HTML 解析成块数组。纯文本（无标签）也能正常处理。
 */
export function parseRichText(html: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  if (html == null || html.length == 0) return blocks;

  let cur = newBlock("p", 0);
  // 样式栈：索引 0 为基础样式；styleTags 与 styles[1..] 一一对应
  const styles: InlineStyle[] = [baseStyle()];
  const styleTags: string[] = [];
  // 跳过 <style>/<script> 内部内容
  let skipTag = "";

  const tokenRe = /<[^>]+>|[^<]+/g;
  const closeRe = /^<\s*\/\s*([a-zA-Z][\w-]*)/;
  const openRe = /^<\s*([a-zA-Z][\w-]*)([^>]*?)\/?>$/;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) != null) {
    const token = m[0];

    // 文本节点
    if (token.charAt(0) != "<") {
      if (skipTag.length > 0) continue;
      const text = decodeEntities(token).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
      if (text.trim().length == 0) {
        // 块内已有内容时保留单个空格，避免相邻行内标签粘连
        if (cur.runs.length > 0 && text.length > 0) {
          const st = styles[styles.length - 1];
          cur.runs.push({
            text: " ",
            bold: st.bold, italic: st.italic, underline: st.underline, strike: st.strike,
            color: st.color, fontSize: st.fontSize, href: st.href,
          } as RichRun);
        }
        continue;
      }
      const st = styles[styles.length - 1];
      cur.runs.push({
        text,
        bold: st.bold, italic: st.italic, underline: st.underline, strike: st.strike,
        color: st.color, fontSize: st.fontSize, href: st.href,
      } as RichRun);
      continue;
    }

    // 闭合标签
    const cm = closeRe.exec(token);
    if (cm != null) {
      const tag = cm[1].toLowerCase();
      if (skipTag.length > 0) {
        if (tag == skipTag) skipTag = "";
        continue;
      }
      // 弹出该标签带来的行内样式
      for (let i = styleTags.length - 1; i >= 0; i--) {
        if (styleTags[i] == tag) {
          styleTags.splice(i);
          styles.splice(i + 1);
          break;
        }
      }
      // 块级标签闭合 -> 换块
      if (BLOCK_TAGS.has(tag)) {
        if (cur.runs.length > 0) blocks.push(cur);
        cur = newBlock("p", 0);
      }
      continue;
    }

    // 开始标签
    const om = openRe.exec(token);
    if (om == null) continue; // 注释 / DOCTYPE 等
    const tag = om[1].toLowerCase();
    if (skipTag.length > 0) continue;
    if (tag == "style" || tag == "script") {
      skipTag = tag;
      continue;
    }
    const attrs = parseAttrs(om[2]);

    if (tag == "br") {
      if (cur.runs.length > 0) blocks.push(cur);
      cur = newBlock("p", 0);
      continue;
    }
    if (tag == "hr") {
      if (cur.runs.length > 0) blocks.push(cur);
      cur = newBlock("p", 0);
      blocks.push(newBlock("hr", 0));
      continue;
    }
    if (tag == "img") {
      if (cur.runs.length > 0) blocks.push(cur);
      cur = newBlock("p", 0);
      const src = attrs.get("src") ?? "";
      if (src.length > 0) {
        const imgBlock = newBlock("img", 0);
        imgBlock.src = src;
        imgBlock.href = styles[styles.length - 1].href;
        blocks.push(imgBlock);
      }
      continue;
    }

    // 块级标签开始 -> 先结束上一块
    if (BLOCK_TAGS.has(tag)) {
      if (cur.runs.length > 0) blocks.push(cur);
      if (tag.length == 2 && tag.charAt(0) == "h") {
        const lv = parseInt(tag.substring(1)) || 1;
        cur = newBlock("h", lv);
      } else if (tag == "li") {
        cur = newBlock("li", 0);
      } else {
        cur = newBlock("p", 0);
      }
    }

    // 行内样式入栈（自闭合标签不入栈）
    if (!VOID_TAGS.has(tag)) {
      const next = cloneStyle(styles[styles.length - 1]);
      applyTagStyle(next, tag, attrs);
      styles.push(next);
      styleTags.push(tag);
    }
  }

  if (cur.runs.length > 0) blocks.push(cur);
  return blocks;
}
