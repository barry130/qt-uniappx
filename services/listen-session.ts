/** 一次收听的内存会话。暂停/取链重试保留，换歌/主动重播/自然循环重新开始。 */
export type ListenDelta = { seconds: number; plays: number; completed: number; at: number };
export class ListenSession {
  private key = "";
  private seconds = 0;
  private counted = false;
  private finished = false;
  private tickAt = -1;
  private position = -1;

  start(key: string): void {
    this.key = key;
    this.seconds = 0;
    this.counted = false;
    this.finished = false;
    this.resetSample();
  }

  resetSample(): void { this.tickAt = -1; this.position = -1; }

  sample(key: string, position: number, duration: number, playing: boolean, now: number, rate: number, at: number): ListenDelta | null {
    if (key != this.key) this.start(key);
    const elapsed = (now - this.tickAt) / 1000;
    const advanced = position - this.position;
    const speed = rate > 0 && Number.isFinite(rate) ? rate : 1;
    const valid = !this.finished && playing && this.tickAt >= 0 && this.position >= 0 && elapsed > 0 && elapsed <= 15 &&
      advanced > 0 && advanced <= elapsed * speed * 1.25 + 0.25;
    this.tickAt = playing ? now : -1;
    this.position = position;
    if (!valid) return null;
    const seconds = Math.min(elapsed, advanced / speed);
    this.seconds += seconds;
    const qualified = this.seconds + 0.001 >= Math.max(30, duration > 0 ? duration / 2 : 30);
    const plays = !this.counted && qualified ? 1 : 0;
    if (plays > 0) this.counted = true;
    return { seconds, plays, completed: 0, at };
  }

  end(at: number): ListenDelta | null {
    if (this.finished) return null;
    this.finished = true;
    const plays = this.counted ? 0 : 1;
    this.counted = true;
    this.resetSample();
    return { seconds: 0, plays, completed: 1, at };
  }
}
