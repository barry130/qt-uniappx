/** Public TV navigation seam. Geometry comes from the platform adapter, never from array index. */
export type QtTvCandidate = {
  id: string; left: number; top: number; width: number; height: number;
  visible: boolean; enabled: boolean; input: boolean; longPress: boolean;
  /** Nearest scroll container inside the active scope; empty for fixed controls. */
  scrollGroup?: string;
};
export type QtTvNavigationKey = { key: string; repeat: number };
export type QtTvNavigationAdapter = {
  collect: (root: any) => QtTvCandidate[];
  highlight: (id: string) => void;
  activate: (id: string, longPress: boolean) => void;
  scroll: (id: string, direction: string) => boolean;
  back: () => void;
  now: () => number;
};
export type QtTvScope = {
  root: any; active: () => boolean; modal: boolean;
  priority?: number; onBack?: () => void; getRoot?: () => any;
};
type ScopeEntry = { token: number; scope: QtTvScope; focused: string; last: QtTvCandidate | null };

function valid(node: QtTvCandidate): boolean {
  return node.enabled && node.visible && node.id.length > 0 && node.width > 0 && node.height > 0
    && Number.isFinite(node.left) && Number.isFinite(node.top)
    && Number.isFinite(node.width) && Number.isFinite(node.height);
}
function centerX(n: QtTvCandidate): number { return n.left + n.width / 2; }
function centerY(n: QtTvCandidate): number { return n.top + n.height / 2; }

/** Beam overlap takes precedence over a closer diagonal target; boundaries do not wrap. */
export function qtTvDirectionalCandidate(from: QtTvCandidate, nodes: QtTvCandidate[], direction: string): QtTvCandidate | null {
  const horizontal = direction == "left" || direction == "right";
  const negative = direction == "left" || direction == "up";
  let best: QtTvCandidate | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.id == from.id || !valid(node)) continue;
    const dx = centerX(node) - centerX(from);
    const dy = centerY(node) - centerY(from);
    const forward = horizontal ? dx : dy;
    if (negative ? forward >= -1 : forward <= 1) continue;
    const beam = horizontal
      ? node.top < from.top + from.height && node.top + node.height > from.top
      : node.left < from.left + from.width && node.left + node.width > from.left;
    const cross = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = (beam ? 0 : 1000000000) + Math.abs(forward) * 8 + cross * 3;
    if (score < bestScore || (score == bestScore && best != null && node.id < best.id)) {
      best = node; bestScore = score;
    }
  }
  return best;
}

export function createQtTvNavigation(adapter: QtTvNavigationAdapter) {
  let enabled = false;
  let nextToken = 1;
  let scopes: ScopeEntry[] = [];
  let shownToken = 0;
  let shownId = "";
  let currentNodes: QtTvCandidate[] = [];
  let lastMoveAt = -1000;

  function top(): ScopeEntry | null {
    let chosen: ScopeEntry | null = null;
    let rank = -1;
    for (const entry of scopes) {
      if (!entry.scope.active()) continue;
      const priority = (entry.scope.modal ? 10000 : 0) + (entry.scope.priority ?? 0);
      if (priority >= rank) { chosen = entry; rank = priority; }
    }
    return chosen;
  }
  function draw(entry: ScopeEntry | null, node: QtTvCandidate | null): void {
    const token = entry == null ? 0 : entry.token;
    const id = node == null ? "" : node.id;
    if (entry != null) { entry.focused = id; if (node != null) entry.last = node; }
    if (token != shownToken || id != shownId) {
      shownToken = token; shownId = id; adapter.highlight(id);
    }
  }
  function refresh(): void {
    if (!enabled) { currentNodes = []; draw(null, null); return; }
    const entry = top();
    if (entry == null) { currentNodes = []; draw(null, null); return; }
    const root = entry.scope.getRoot != null ? entry.scope.getRoot() : entry.scope.root;
    // A not-yet-mounted modal blocks the background even before its ref resolves.
    if (entry.scope.modal && root == null) { currentNodes = []; draw(entry, null); return; }
    currentNodes = adapter.collect(root).filter(valid);
    let focused: QtTvCandidate | null = null;
    for (const node of currentNodes) if (node.id == entry.focused) { focused = node; break; }
    if (focused == null && entry.last != null) {
      let distance = Number.POSITIVE_INFINITY;
      for (const node of currentNodes) {
        const d = Math.abs(centerX(node) - centerX(entry.last)) + Math.abs(centerY(node) - centerY(entry.last));
        if (d < distance) { distance = d; focused = node; }
      }
    }
    if (focused == null && currentNodes.length > 0) focused = currentNodes[0];
    draw(entry, focused);
  }
  function dispatch(event: QtTvNavigationKey): boolean {
    if (!enabled) return false;
    refresh();
    const entry = top();
    if (entry == null) return false;
    if (event.key == "back") {
      if (event.repeat > 0) return true;
      if (entry.scope.modal) { if (entry.scope.onBack != null) entry.scope.onBack(); }
      else if (entry.scope.onBack != null) entry.scope.onBack();
      else adapter.back();
      return true;
    }
    const focused = currentNodes.find((node): boolean => node.id == entry.focused) ?? null;
    if (event.key == "ok" || event.key == "menu") {
      if (event.repeat > 0) return true;
      if (focused != null && (event.key == "ok" || focused.longPress)) {
        adapter.activate(focused.id, event.key == "menu");
      }
      return true;
    }
    if (event.key != "up" && event.key != "down" && event.key != "left" && event.key != "right") return false;
    const now = adapter.now();
    if (event.repeat > 0 && now - lastMoveAt < 85) return true;
    lastMoveAt = now;
    if (focused == null) return true;
    const next = qtTvDirectionalCandidate(focused, currentNodes, event.key);
    // At a list edge, reveal the next viewport before escaping to a fixed rail/dock.
    // A exhausted scroll ancestor returns false so the outer controls remain reachable.
    if (focused.scrollGroup != null && focused.scrollGroup.length > 0
      && (next == null || next.scrollGroup != focused.scrollGroup)
      && adapter.scroll(focused.id, event.key)) { refresh(); return true; }
    if (next != null) draw(entry, next);
    else if (focused.scrollGroup == null || focused.scrollGroup.length == 0) {
      if (adapter.scroll(focused.id, event.key)) refresh();
    }
    return true;
  }
  return {
    setEnabled(value: boolean): void { enabled = value; refresh(); },
    pushScope(scope: QtTvScope): number { const token = nextToken++; scopes.push({ token, scope, focused: "", last: null }); refresh(); return token; },
    removeScope(token: number): void { scopes = scopes.filter((entry): boolean => entry.token != token); refresh(); },
    refresh,
    dispatch,
    focusedId(): string { return shownId; },
    activeToken(): number { return enabled && top() != null ? top()!.token : 0; },
    modalActive(): boolean { return enabled && top() != null && top()!.scope.modal; },
    focus(id: string): boolean {
      refresh();
      const entry = top();
      const exact = currentNodes.find((n): boolean => n.id == id);
      const business = exact == null && id.length > 0 ? currentNodes.filter((n): boolean => n.id.endsWith(":custom:" + id)) : [];
      // Resolve only an unambiguous business ID inside the currently visible scope.
      const node = exact ?? (business.length == 1 ? business[0] : null);
      if (entry == null || node == null) return false;
      draw(entry, node); return true;
    }
  };
}
