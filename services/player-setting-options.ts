/** Shared display choices for playback settings and the player tool sheet. */
export type QtSleepOption = { minutes: number; name: string };
/** 90 is the existing stop-after-current sentinel, NOT a literal 90-minute timer. */
export const QT_SLEEP_OPTIONS: QtSleepOption[] = [
  { minutes: 0, name: "关闭定时" },
  { minutes: 10, name: "10 分钟后" },
  { minutes: 20, name: "20 分钟后" },
  { minutes: 30, name: "30 分钟后" },
  { minutes: 45, name: "45 分钟后" },
  { minutes: 60, name: "60 分钟后" },
  { minutes: 90, name: "播放完当前歌曲后" },
  { minutes: 120, name: "120 分钟后" },
];
export const QT_PLAYBACK_RATES: number[] = [0.75, 1, 1.25, 1.5, 2];
/** Exact preset only; a countdown remainder must not falsely select another preset. */
export function qtSleepSelectedIndex(stopAfterCurrent: boolean, endTime: number, requestedMinutes: number): number {
  if (!stopAfterCurrent && endTime > 0 && (requestedMinutes <= 0 || requestedMinutes == 90)) return -1;
  if (!Number.isFinite(endTime) || !Number.isFinite(requestedMinutes)) return -1;
  const minutes = stopAfterCurrent ? 90 : endTime <= 0 ? 0 : requestedMinutes;
  for (let i = 0; i < QT_SLEEP_OPTIONS.length; i++) {
    if (QT_SLEEP_OPTIONS[i].minutes == minutes) return i;
  }
  return -1;
}
