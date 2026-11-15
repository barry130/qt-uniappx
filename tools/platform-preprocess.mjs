// Select the native platform before inspecting JS/UTS service imports.
// Negative platform alternatives must use nested #ifndef directives, matching
// the project's documented uni-preprocess restriction.
export function preprocessPlatform(source, platform) {
  const symbols = new Set([platform]);
  if (platform.startsWith('APP-')) { symbols.add('APP'); symbols.add('APP-PLUS'); }
  const stack = [];
  let active = true;
  const lines = [];
  const condition = expression => {
    const tokens = expression.match(/[A-Z][A-Z0-9_-]*|&&|\|\||[()!]/g) ?? [];
    if (tokens.join('') !== expression.replace(/\s/g, '')) throw new Error(`Unsupported platform expression: ${expression}`);
    let index = 0;
    function atom() {
      const token = tokens[index++];
      if (token === '!') return !atom();
      if (token === '(') {
        const result = alternatives();
        if (tokens[index++] !== ')') throw new Error(`Unbalanced platform expression: ${expression}`);
        return result;
      }
      if (!token || !/^[A-Z][A-Z0-9_-]*$/.test(token)) throw new Error(`Invalid platform expression: ${expression}`);
      return symbols.has(token);
    }
    function conjunctions() {
      let result = atom();
      while (tokens[index] === '&&') { index++; const next = atom(); result = result && next; }
      return result;
    }
    function alternatives() {
      let result = conjunctions();
      while (tokens[index] === '||') { index++; const next = conjunctions(); result = result || next; }
      return result;
    }
    const result = alternatives();
    if (index !== tokens.length) throw new Error(`Invalid platform expression: ${expression}`);
    return result;
  };
  for (const line of source.split(/\r?\n/)) {
    const directive = line.match(/^\s*\/\/\s*#(ifdef|ifndef|else|endif)\b(.*)$/);
    if (!directive) { if (active) lines.push(line); continue; }
    const [, kind, raw] = directive;
    if (kind === 'ifdef' || kind === 'ifndef') {
      const expression = raw.trim();
      if (kind === 'ifndef' && !/^[A-Z][A-Z0-9_-]*$/.test(expression)) {
        throw new Error(`Use nested #ifndef directives for platform alternatives: ${expression}`);
      }
      const matches = kind === 'ifdef' ? condition(expression) : !condition(expression);
      stack.push({ parent: active, matches, elseSeen: false });
      active = active && matches;
    } else {
      const frame = stack.at(-1);
      if (!frame) throw new Error(`Unexpected #${kind}`);
      if (kind === 'else') {
        if (frame.elseSeen) throw new Error('Duplicate #else');
        frame.elseSeen = true;
        active = frame.parent && !frame.matches;
      } else {
        stack.pop();
        active = frame.parent;
      }
    }
  }
  if (stack.length > 0) throw new Error('Unclosed platform directive');
  return lines.join('\n');
}
