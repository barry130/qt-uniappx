/** Only the mounted, visible queue owns this dismissal callback. */
let activeClose: (() => void) | null = null;
export function registerPlaybackQueueClose(close: () => void): void { activeClose = close; }
export function unregisterPlaybackQueueClose(close: () => void): void {
  if (activeClose === close) activeClose = null;
}
export function closePlaybackQueue(): boolean {
  const close = activeClose;
  if (close == null) return false;
  activeClose = null;
  close();
  return true;
}
