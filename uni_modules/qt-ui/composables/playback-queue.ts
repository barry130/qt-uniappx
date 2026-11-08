import type { Song } from "@/types/music";
import { playerQueueMetrics } from "./player-presentation";

/** The in-page queue uses the same timeline and persistence contract as the player. */
export type PlaybackQueueController = {
  queue: Song[];
  current: Song | null;
  currentIndex(): number;
  play(song: Song): Promise<void>;
  stop(): void;
  syncTimeline(): void;
  persist(): void;
};

export function removePlaybackQueueItem(player: PlaybackQueueController, index: number): void {
  const queue = player.queue;
  if (index < 0 || index >= queue.length) return;
  const current = player.current;
  // A duplicate ID is a different queue entry; removing it must not restart the current song.
  const removingCurrent = current != null && (queue[index] === current ||
    (!queue.some((song: Song): boolean => song === current) && index == player.currentIndex()));
  const next = queue.slice();
  next.splice(index, 1);
  player.queue = next;
  if (next.length == 0) {
    player.stop();
    return;
  }
  if (removingCurrent) player.play(next[Math.min(index, next.length - 1)]);
  else player.syncTimeline();
  player.persist();
}

export function movePlaybackQueueItem(player: PlaybackQueueController, index: number, offset: number): void {
  const target = index + offset;
  if (index < 0 || index >= player.queue.length || target < 0 || target >= player.queue.length || target == index) return;
  const next = player.queue.slice();
  const song = next[index];
  next.splice(index, 1);
  next.splice(target, 0, song);
  player.queue = next;
  player.syncTimeline();
  player.persist();
}

/** Fit above the wide dock; compact uses a bottom sheet. Short queues do not leave a tall blank panel. */
export function playbackQueueMetrics(width: number, height: number, wide: boolean, status: number, safeBottom: number, dock: number, scale: number, count: number) {
  const unit = Math.max(1, width) / 750;
  const stridePx = playerQueueMetrics(width, height, wide, safeBottom, scale).stridePx;
  const headerPx = wide ? Math.max(60, Math.ceil(24 * scale + 24)) : Math.max(100, Math.ceil(36 * scale + 40)) * unit;
  const insetBottomPx = wide ? Math.max(0, dock) + 12 : 0;
  const panelBottomPx = wide ? 8 : Math.max(12 * unit, safeBottom);
  const available = Math.max(0, height - Math.max(0, status) - insetBottomPx - panelBottomPx - headerPx - 24);
  const cap = Math.min(available, wide ? 480 : height * 0.65);
  const viewportPx = Math.min(cap, Math.max(count > 0 ? stridePx : stridePx * 2, count * stridePx));
  return { stridePx, headerPx, insetBottomPx, panelBottomPx, viewportPx };
}
