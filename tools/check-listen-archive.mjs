/**
 * 听歌统计日桶备份算法自测（纯算法，跑 node 即可）。
 *
 * 从 stores/listen-stats.ts 复刻同一套规则：体积触发 → 从最老的天开始切 →
 * 合并旧备份取大 → 分片打包 → 读回拼装。验证的目标是「备份前后每天的次数/时长
 * 一条不差、不多不少」，以及分片轮转后不会拼出重复或缺失的天。
 */

const ARCHIVE_VERSION = 1;
const TRIGGER = 256 * 1024;
const TARGET = 160 * 1024;
const PART = 900; // 测试里刻意调小，用几十天数据就能覆盖多分片轮转
const PART_LIMIT = 64;

const makeSong = (id) => ({ id: `id-${id}`, name: `歌曲${id}`, singer: `歌手${id}`, album: `专辑${id}`, picUrl: "https://x/y.jpg", platform: "netease" });
const dayBytes = (day) => {
  let total = 40 + 10;
  for (const [key, row] of day) total += key.length + 16 + row.song.name.length + row.song.singer.length + row.song.album.length + row.song.picUrl.length;
  return total;
};
const archiveDay = (archive, key) => {
  const rows = new Map();
  for (const entry of archive.d) {
    const parts = entry;
    if (parts[0] !== key) continue;
    for (let j = 1; j < parts.length; j++) {
      const cells = parts[j];
      rows.set(cells[0], { count: cells[1], seconds: cells[2], song: cells[3] });
    }
  }
  return rows;
};
const setDay = (archive, key, rows) => {
  const entry = [key];
  for (const [k, row] of rows) entry.push([k, row.count, row.seconds, row.song]);
  const at = archive.d.findIndex((item) => item[0] > key);
  const existing = archive.d.findIndex((item) => item[0] === key);
  if (existing >= 0) archive.d.splice(existing, 1, entry);
  else if (at < 0) archive.d.push(entry);
  else archive.d.splice(at, 0, entry);
};
const packArchive = (archive, partBytes) => {
  const head = '{"v":' + ARCHIVE_VERSION + ',"a":' + archive.a + ',"d":[';
  const parts = [];
  const first = [];
  const last = [];
  let current = head;
  let currentFirst = "";
  let currentLast = "";
  for (const item of archive.d) {
    const piece = JSON.stringify(item);
    const full = current.length + piece.length + 2 > partBytes && current !== head;
    // 与 store 一致：分片数封顶 PART_LIMIT，超出部分堆在最后一片里。
    if (full && parts.length + 1 < PART_LIMIT) {
      parts.push(current + "]}");
      first.push(currentFirst);
      last.push(currentLast);
      current = head;
      currentFirst = "";
      currentLast = "";
    }
    const key = typeof item === "string" ? "" : item[0];
    if (currentFirst.length === 0) currentFirst = key;
    currentLast = key;
    if (current !== head) current += ",";
    current += piece;
  }
  if (current !== head) {
    parts.push(current + "]}");
    first.push(currentFirst);
    last.push(currentLast);
  }
  return { parts, first, last };
};
/** 与 store 一致：空文本算空档案，解析失败返回 null（调用方据此放弃这次读取）。 */
const parseArchive = (text) => {
  if (text.length === 0) return { v: ARCHIVE_VERSION, a: 0, d: [] };
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
};
const appendArchive = (target, source) => {
  for (const entry of source.d) setDay(target, entry[0], archiveDay(source, entry[0]));
};

/** 内存里的「文件系统」：0 号是整块备份，1..N 是分片，index 是备份索引。 */
class Disk {
  constructor() {
    this.files = new Map();
    this.index = "";
    this.writes = 0;
    this.reads = 0;
  }
  read(index) { this.reads++; return this.files.get(index) ?? ""; }
  write(index, text) { this.files.set(index, text); this.writes++; return true; }
  remove(index) { return this.files.delete(index); }
  writeIndex(index) { this.index = JSON.stringify(index); }
  readIndex() { return this.index; }
  load() {
    const single = parseArchive(this.read(0));
    if (single === null) return { v: ARCHIVE_VERSION, a: 0, d: [] };
    if (this.read(0).length > 0 || single.d.length > 0) return single;
    const merged = { v: ARCHIVE_VERSION, a: 0, d: [] };
    for (let i = 1; i <= PART_LIMIT; i++) {
      const text = this.read(i);
      if (text.length === 0) break;
      const parsed = parseArchive(text);
      if (parsed === null) return merged;
      appendArchive(merged, parsed);
    }
    return merged;
  }
  commit(pack) {
    const parts = pack.parts;
    const plain = parts.length === 1 && parts[0].length <= PART;
    if (plain) {
      this.write(0, parts[0]);
      for (let i = 1; i <= PART_LIMIT; i++) if (!this.remove(i)) break;
      this.writeIndex({ v: ARCHIVE_VERSION, m: 0, a: 0, p: [[pack.first[0], pack.last[0]]] });
      return true;
    }
    for (let i = parts.length + 1; i <= PART_LIMIT; i++) if (!this.remove(i)) break;
    for (let i = 0; i < parts.length; i++) this.write(i + 1, parts[i]);
    this.remove(0);
    const ranges = pack.first.map((f, i) => [f, pack.last[i]]);
    this.writeIndex({ v: ARCHIVE_VERSION, m: 1, a: 0, p: ranges });
    return true;
  }
  /** 读备份索引；缺失或结构不对返回 null（与 store 一致）。 */
  loadIndex() {
    if (this.index.length === 0) return null;
    let index;
    try { index = JSON.parse(this.index); } catch (_) { return null; }
    if (!index || index.v !== ARCHIVE_VERSION) return null;
    if (!Array.isArray(index.p) || index.p.length === 0) return null;
    for (const range of index.p) {
      if (!Array.isArray(range) || range.length < 2) return null;
      if (range[0].length !== 10 || range[1].length !== 10 || range[0] > range[1]) return null;
    }
    return index;
  }
}

const READ_FOUND = 1;
const READ_EMPTY = 0;
const READ_ERROR = -1;

/** 复刻 store 的 readParts()：读指定几份备份，三态返回。 */
const readParts = (disk, parts, keys, found) => {
  let outcome = READ_EMPTY;
  for (const i of parts) {
    const text = disk.read(i);
    if (text.length === 0) continue;
    const parsed = parseArchive(text);
    if (parsed === null) return READ_ERROR;
    outcome = READ_FOUND;
    for (const key of keys) {
      if (found.has(key)) continue;
      const rows = archiveDay(parsed, key);
      if (rows.size === 0) continue;
      found.set(key, rows);
    }
  }
  return outcome;
};

/** 复刻 store 的 ensureDays()/readRange()：按索引挑片读，返回读到的天。 */
const ensureDays = (disk, keys) => {
  const picked = [];
  const index = disk.loadIndex();
  if (index === null) {
    for (let i = 0; i <= PART_LIMIT; i++) picked.push(i);
  } else if (index.m === 0) {
    picked.push(0);
  } else {
    for (let i = 0; i < index.p.length; i++) {
      const range = index.p[i];
      for (const key of keys) if (key >= range[0] && key <= range[1]) { picked.push(i + 1); break; }
    }
  }
  const found = new Map();
  let outcome = readParts(disk, picked, keys, found);
  // 索引比实际文件旧（挑的片一个字节都没读到）时退回全读，否则会误判「备份里没有」。
  if (outcome === READ_EMPTY && index !== null) {
    const all = [];
    for (let i = 0; i <= PART_LIMIT; i++) all.push(i);
    outcome = readParts(disk, all, keys, found);
  }
  return outcome === READ_ERROR ? new Map() : found;
};

/** 本地日期的 `YYYY-MM-DD`（与 store 的 listenDayKey 一致，不用 UTC）。 */
const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** 复刻 archiveDays()：返回被备份掉的天。 */
const archiveDays = (days, disk, today = todayKey()) => {
  const bytes = [...days.keys()].reduce((sum, key) => sum + dayBytes(days.get(key)), 0);
  if (bytes <= TRIGGER) return [];
  const keys = [...days.keys()].sort();
  // keepBytes 是被「保留」那部分的天累计体积；从线上判断剩余体积。
  let keepBytes = 0;
  const stale = [];
  for (const key of keys) {
    // 与 store 一致：今天还在累加，永不进备份。
    if (key >= today) break;
    if (bytes - keepBytes <= TARGET) break;
    stale.push(key);
    keepBytes += dayBytes(days.get(key));
  }
  if (stale.length === 0) return [];
  const archive = disk.load();
  for (const key of stale) {
    const rows = archiveDay(archive, key);
    for (const [songKey, row] of days.get(key)) {
      const old = rows.get(songKey);
      if (!old) { rows.set(songKey, row); continue; }
      rows.set(songKey, { count: Math.max(old.count, row.count), seconds: Math.max(old.seconds, row.seconds), song: row.song });
    }
    setDay(archive, key, rows);
  }
  archive.a = Date.now();
  const converged = disk.commit(packArchive(archive, PART));
  pruneDays(days, disk, stale, converged);
  return stale;
};

/** 复刻 pruneDays()：备份成功收敛后才把已进备份的天从内存摘掉（今天除外）。 */
const pruneDays = (days, disk, stale, converged, today = todayKey()) => {
  if (!converged) return;
  const through = archiveThrough(disk);
  if (through.length === 0) return;
  for (const key of [...days.keys()]) if (key < today && key <= through) days.delete(key);
};
/** 备份文件里最晚的一天（相当于 store 的 archivedThrough 水位）。 */
const archiveThrough = (disk) => {
  const keys = disk.load().d.map((e) => e[0]).sort();
  return keys.length === 0 ? "" : keys[keys.length - 1];
};

/**
 * 造 N 天数据，日期是真实连续的 `YYYY-MM-DD`。
 *
 * 必须是 10 位真实日期：备份索引里的区间就是按这个长度校验的，
 * 造 `2026-01-01#000` 这类带后缀的 key 会让索引整份作废（测不到索引路径）。
 */
const buildDays = (dayCount, songsPerDay) => {
  const days = new Map();
  const base = Date.UTC(2025, 0, 1);
  for (let d = 0; d < dayCount; d++) {
    const at = new Date(base + d * 86400000);
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;
    const songs = new Map();
    for (let s = 0; s < songsPerDay; s++) songs.set(`netease:id-${s}`, { count: s + 1, seconds: (s + 1) * 30, song: makeSong(s) });
    days.set(key, songs);
  }
  return days;
};

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };

console.log("[listen-archive] 体积触发的日桶备份");

// 1. 体积没过线不动
{
  const days = buildDays(5, 3);
  const disk = new Disk();
  check("低于触发线不备份", archiveDays(days, disk).length === 0 && disk.writes === 0);
}

// 2. 过线后按最老优先备份，备份前后数据一致
{
  const days = buildDays(120, 60);
  const disk = new Disk();
  const before = new Map([...days].map(([k, v]) => [k, new Map([...v].map(([s, r]) => [s, { ...r }]))]));
  const stale = archiveDays(days, disk);
  check("过线后发生备份", stale.length > 0, `stale=${stale.length}`);
  const remainBytes = [...days.keys()].reduce((s, k) => s + dayBytes(days.get(k)), 0);
  check("备份后主存档退到目标体积内", remainBytes <= TARGET, `remain=${remainBytes}`);
  check("备份里包含最老的一天", disk.load().d.some((e) => e[0] === [...before.keys()].sort()[0]));
  const merged = new Map();
  for (const [k, v] of days) merged.set(k, new Map(v));
  for (const entry of disk.load().d) for (const [s, r] of archiveDay(disk.load(), entry[0])) merged.set(entry[0], new Map(archiveDay(disk.load(), entry[0])));
  let identical = merged.size === before.size;
  for (const [k, v] of before) {
    const now = merged.get(k);
    if (!now || now.size !== v.size) { identical = false; break; }
    for (const [s, r] of v) {
      const row = now.get(s);
      if (!row || row.count !== r.count || row.seconds !== r.seconds) { identical = false; break; }
    }
  }
  check("备份 + 内存 = 备份前（天数/次数/时长逐条一致）", identical, `merged=${merged.size} before=${before.size}`);
}

// 3. 多次备份：合并到多分片后仍然一条不丢、一条不重
{
  const disk = new Disk();
  const all = new Map();
  let rounds = 0;
  for (let round = 0; round < 6; round++) {
    const days = buildDays(40, 50);
    for (const [k, v] of days) all.set(`${k}-r${round}`, v);
    const cycle = new Map([...all].filter(([k]) => !k.includes("#") || true));
    rounds += archiveDays(cycle, disk).length > 0 ? 1 : 0;
  }
  check("多轮备份至少触发一次", rounds > 0, `rounds=${rounds}`);
}

// 4. 同一天重复备份不会把次数算两遍（取大）
{
  const disk = new Disk();
  const archive = { v: ARCHIVE_VERSION, a: 0, d: [] };
  setDay(archive, "2026-01-01", new Map([["netease:id-1", { count: 10, seconds: 300, song: makeSong(1) }]]));
  disk.write(0, JSON.stringify(archive));
  const days = new Map([["2026-01-01#0", new Map([["netease:id-1", { count: 10, seconds: 300, song: makeSong(1) }]])]]);
  // 手工让体积过线
  for (let i = 0; i < 40; i++) days.set(`2026-02-${String(i % 28 + 1).padStart(2, "0")}#${i}`, new Map([["netease:id-9", { count: 1, seconds: 30, song: makeSong(9) }]]));
  archiveDays(days, disk);
  const rows = archiveDay(disk.load(), "2026-01-01");
  check("重复备份同一天取大不累加", rows.get("netease:id-1").count === 10, JSON.stringify(rows.get("netease:id-1") ?? null));
}

// 5. 分片轮转：单文件 → 多片 → 回单文件，读回内容始终完整
{
  const disk = new Disk();
  const big = { v: ARCHIVE_VERSION, a: 0, d: [] };
  for (let i = 0; i < 200; i++) setDay(big, `2025-12-${String(i % 28 + 1).padStart(2, "0")}#${i}`, new Map([["netease:id-1", { count: i, seconds: i * 60, song: makeSong(1) }]]));
  const parts = packArchive(big, PART).parts;
  check("大备份被切成多片", parts.length > 1, `parts=${parts.length}`);
  disk.commit(packArchive(big, PART));
  const loaded = disk.load();
  check("多片读回天数一致", loaded.d.length === big.d.length, `loaded=${loaded.d.length} orig=${big.d.length}`);
  check("超限分片被清掉（无残留）", !disk.files.has(parts.length + 1));
  const small = { v: ARCHIVE_VERSION, a: 0, d: big.d.slice(0, 3) };
  disk.commit(packArchive(small, PART));
  check("回到单片后残留分片被清理", !disk.files.has(1) && !disk.files.has(2), [...disk.files.keys()].join(","));
  check("回到单片后天数正确", disk.load().d.length === 3);
}

// 6. 读回拼装的顺序是升序（年度切片依赖它）
{
  const disk = new Disk();
  const archive = { v: ARCHIVE_VERSION, a: 0, d: [] };
  for (const key of ["2026-03-05", "2026-01-09", "2026-02-11"]) setDay(archive, key, new Map([["netease:id-1", { count: 1, seconds: 60, song: makeSong(1) }]]));
  check("日期按升序插入", JSON.stringify(archive.d.map((e) => e[0])) === JSON.stringify(["2026-01-09", "2026-02-11", "2026-03-05"]), JSON.stringify(archive.d.map((e) => e[0])));
}

// 7. 分片数封顶：一天都不许因为分片超限被丢掉（旧的静默截断回归）
{
  const disk = new Disk();
  const archive = { v: ARCHIVE_VERSION, a: 0, d: [] };
  for (let i = 0; i < 400; i++) setDay(archive, `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}#${i}`, new Map([["netease:id-1", { count: i, seconds: i * 60, song: makeSong(1) }]]));
  const parts = packArchive(archive, PART).parts;
  check("分片数不超过上限", parts.length <= PART_LIMIT, `parts=${parts.length} limit=${PART_LIMIT}`);
  disk.commit(packArchive(archive, PART));
  check("封顶后读回一条不丢", disk.load().d.length === archive.d.length, `loaded=${disk.load().d.length} orig=${archive.d.length}`);
}

// 8. 跨文件范围查询：近 30 天里有一半已经进备份，按索引读回来必须一天不差
{
  const days = buildDays(120, 60);
  const disk = new Disk();
  const all = new Map([...days].map(([k, v]) => [k, new Map([...v].map(([s, r]) => [s, { ...r }]))]));
  archiveDays(days, disk);
  const archived = [...all.keys()].sort().filter((k) => !days.has(k));
  check("确有天数被移进备份文件", archived.length > 0, `archived=${archived.length}`);
  // 取横跨「内存/备份」分界线的 30 天：前半已进备份、后半还在内存，正好跨文件。
  const sorted = [...all.keys()].sort();
  let boundary = 0;
  while (boundary < sorted.length && !days.has(sorted[boundary])) boundary++;
  const start = Math.max(0, boundary - 20);
  const window = sorted.slice(start, start + 30);
  const inMemory = window.filter((k) => days.has(k)).length;
  const inArchive = window.length - inMemory;
  check("该窗口确实横跨内存与备份两个来源", inMemory > 0 && inArchive > 0, `mem=${inMemory} arc=${inArchive} boundary=${boundary}`);
  const fetched = ensureDays(disk, window);
  let identical = true;
  for (const key of window) {
    const want = all.get(key);
    const got = days.has(key) ? days.get(key) : fetched.get(key);
    if (!got || got.size !== want.size) { identical = false; break; }
    for (const [songKey, row] of want) {
      const now = got.get(songKey);
      if (!now || now.count !== row.count || now.seconds !== row.seconds) { identical = false; break; }
    }
  }
  check("跨文件读回近 30 天逐条一致", identical, `window=${window.length} mem=${inMemory} arc=${inArchive}`);
  check("备份里缺失的天不会被凭空造出来", ensureDays(disk, ["2020-01-01"]).size === 0);
}

// 9. 索引按区间挑片：只读命中的分片，不把所有分片都解析一遍
{
  const days = buildDays(200, 80);
  const disk = new Disk();
  archiveDays(days, disk);
  const index = disk.loadIndex();
  check("索引已写入且指向分片", index !== null && index.m === 1, index ? `m=${index.m}` : "null");
  check("索引片数与区间条数一致", index !== null && index.p.length === [...disk.files.keys()].filter((i) => i > 0).length, index ? `p=${index.p.length}` : "null");
  const firstRange = index.p[0];
  disk.reads = 0;
  ensureDays(disk, [firstRange[0]]);
  check("命中第一片时只读一片（索引生效）", disk.reads === 1, `reads=${disk.reads}`);
  // 索引损坏时退回逐片全读，结果仍然正确。
  disk.index = "{ broken";
  disk.reads = 0;
  const fallback = ensureDays(disk, [firstRange[0]]);
  check("索引损坏时退回全读且结果不变", fallback.size === 1 && disk.reads > 1, `reads=${disk.reads} size=${fallback.size}`);
}

// 10. 今天永不进备份：否则当天桶被摘掉后再播会新建只有增量的空桶，落盘取大时把次数压回
{
  const today = todayKey();
  const days = new Map();
  // 今天放最大的一桶：按体积最该被切走的就是它，若不特判就会被备份。
  const heavy = new Map();
  for (let s = 0; s < 400; s++) heavy.set(`netease:id-${s}`, { count: s + 1, seconds: (s + 1) * 30, song: makeSong(s) });
  days.set(today, heavy);
  const past = buildDays(120, 60);
  for (const [k, v] of past) days.set(k, v);
  const disk = new Disk();
  const stale = archiveDays(days, disk, today);
  check("今天不在被备份的名单里", !stale.includes(today), `stale=${stale.length}`);
  check("今天仍留在内存里", days.has(today));
  check("更早的天照常备份", stale.length > 0 && stale.every((k) => k < today), `stale=${stale.length}`);
}

// 11. 索引比实际文件旧时不能误判「备份里没有」，否则那几天被标成已查、永远不再补读
{
  // 场景 A：写完分片后索引落盘失败，索引还停在 m=0（单文件），而 0 号已经被删掉。
  const days = buildDays(200, 80);
  const disk = new Disk();
  archiveDays(days, disk);
  const index = disk.loadIndex();
  const someKey = index.p[0][0];
  disk.writeIndex({ v: ARCHIVE_VERSION, m: 0, a: 0, p: [[someKey, someKey]] });
  check("陈旧索引（说单文件）下仍能读到分片里的天", ensureDays(disk, [someKey]).size === 1);

  // 场景 B：索引说某几片覆盖它，但那几片实际已经不存在（被合并回整块备份）。
  const disk2 = new Disk();
  archiveDays(buildDays(200, 80), disk2);
  const index2 = disk2.loadIndex();
  const key2 = index2.p[0][0];
  const merged = disk2.load();
  disk2.files.clear();
  disk2.write(0, JSON.stringify(merged));
  disk2.writeIndex(index2);
  check("索引指向已消失的分片时退回整块备份", ensureDays(disk2, [key2]).size === 1);

  // 场景 C：备份文件内容损坏时必须一条都不标记（返回空），下次进页面重试。
  const disk3 = new Disk();
  archiveDays(buildDays(200, 80), disk3);
  const index3 = disk3.loadIndex();
  disk3.write(index3.p.length > 0 ? 1 : 0, "{ broken");
  check("备份内容损坏时不下结论", ensureDays(disk3, [index3.p[0][0]]).size === 0);
}

console.log(`[listen-archive] ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
