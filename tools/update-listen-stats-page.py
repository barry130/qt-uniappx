from pathlib import Path
p = Path(__file__).resolve().parents[1] / 'pages/stats/index.uvue'
s = p.read_text(encoding='utf-8')
start = s.index('      <view\n        v-if="historyCount > 0"\n        class="foot"')
end = s.index('      <view class="pad"', start)
s = s[:start] + s[end:]
s = '\n'.join(line for line in s.split('\n') if not line.startswith(('.foot ', '.foot-body ', '.foot-title ', '.foot-sub ', '.foot-wide ')))
s = s.replace('import { computed, ref } from "vue";', 'import { computed, ref } from "vue";\nimport { onShow } from "@dcloudio/uni-app";\nimport { useListenStatsStore } from "@/stores/listen-stats";')
s = s.replace('const player = usePlayerStore();', '''const player = usePlayerStore();
const stats = useListenStatsStore();
const failedArtists = ref<string[]>([]);
onShow(() => {
  stats.load(player.history, player.playCounts).then(async () => {
    await stats.flush();
    // 升级后已有的 Top 5 同样补头像，避免必须再播一次才显示。
    for (let i = 0; i < topArtists.value.length; i++) {
      const name = topArtists.value[i].name;
      for (let j = 0; j < stats.songs.length; j++) {
        if (stats.songs[j].song.singer == name) { await stats.ensureArtistPic(stats.songs[j].song); break; }
      }
    }
  });
});
function artistPic(name: string): string {
  return failedArtists.value.indexOf(name) >= 0 ? "" : stats.artistPic(name);
}
function artistImageError(name: string): void {
  if (failedArtists.value.indexOf(name) < 0) failedArtists.value.push(name);
}
function sourceIcon(id: string): string {
  if (["wyy", "qq", "kw", "kg", "bili"].indexOf(id) >= 0) return "/static/source/" + id + ".png";
  return "";
}
function durationValue(seconds: number): string {
  if (seconds >= 3600) return "" + Math.floor(seconds / 3600);
  if (seconds >= 60) return "" + Math.floor(seconds / 60);
  return "" + Math.floor(seconds);
}
function durationUnit(seconds: number): string {
  if (seconds >= 3600) return "小时 " + Math.floor((seconds % 3600) / 60) + " 分";
  return seconds >= 60 ? "分钟" : "秒";
}
function openStatsPermissions(): void { uni.navigateTo({ url: "/pages/permissions/index" }); }''')
# Keep the four-cell band and add the requested duration as a separate primary stat.
pos = s.index('      <!-- 数据带：')
s = s[:pos] + '''      <view class="duration-card" :class="layout.isWide ? 'duration-card-wide' : ''" :style="'background-color:' + themeStore.skin.surface + ';border-color:' + themeStore.skin.border + ';'">
        <view class="duration-heading">
          <QtIcon name="clock" :size="layout.isWide ? 18 : 30" :color="themeStore.skin.accent" />
          <text class="duration-label" :style="('color:' + themeStore.skin.textMuted + ';') + qtFontDual(24, 14)">累计播放时长</text>
        </view>
        <view class="duration-line">
          <text class="duration-number" :style="('color:' + themeStore.skin.text + ';') + qtFontDual(60, 34)">{{ durationValue(stats.totalSeconds) }}</text>
          <text class="duration-unit" :style="('color:' + themeStore.skin.textMuted + ';') + qtFontDual(24, 14)">{{ durationUnit(stats.totalSeconds) }}</text>
        </view>
        <text class="duration-note" :style="('color:' + themeStore.skin.textSubtle + ';') + qtFontDual(20, 12)">只累计实际听过的秒数，未播完也计入；暂停、缓冲和拖动进度不计入</text>
        <text class="duration-note" :style="('color:' + themeStore.skin.textSubtle + ';') + qtFontDual(20, 12)">从本次升级开始记录时长，旧播放记录不补算</text>
        <view class="storage-status" @click="openStatsPermissions">
          <text :style="('color:' + themeStore.skin.textMuted + ';') + qtFontDual(20, 12)">{{ storageLabel }}</text>
          <text v-if="stats.publicSaved" class="duration-note" :style="('color:' + themeStore.skin.textSubtle + ';') + qtFontDual(18, 11)">{{ stats.storagePath }}</text>
        </view>
      </view>

''' + s[pos:]
s = s.replace('const historyCount = computed((): number => player.history.length);', 'const historyCount = computed((): number => stats.songs.length);\nconst storageLabel = computed((): string => {\n  if (!stats.ready) return "正在读取统计存档";\n  if (stats.publicSaved) return "已保存到公共目录，卸载后可恢复";\n  if (stats.storagePath.length == 0) return "此平台暂存应用目录，卸载前请保留数据";\n  return "暂存应用目录：开启所有文件访问后迁移，点此设置";\n});')
a = s.index('const totalPlayed = computed(')
b = s.index('\ntype TopSongEntry', a)
s = s[:a] + '''const totalPlayed = computed((): number => {
  let total = 0;
  for (let i = 0; i < stats.songs.length; i++) total += stats.songs[i].count;
  return total;
});
''' + s[b:]
s = s.replace('player.history.length', 'stats.songs.length').replace('const song = player.history[i];', 'const song = stats.songs[i].song;').replace('const count = player.playCount(song);', 'const count = stats.songs[i].count;')
s = s.replace('(current != null ? current : 0) + 1', '(current != null ? current : 0) + stats.songs[i].count')
s = s.replace('type ArtistEntry = { name: string; count: number };', 'type ArtistEntry = { name: string; count: number };')
s = s.replace('''              <view
                class="artist-avatar"''', '''              <image v-if="artistPic(item.name) != ''" class="artist-avatar" :class="layout.isWide ? 'artist-avatar-wide' : ''" :src="artistPic(item.name)" mode="aspectFill" @error="artistImageError(item.name)" />
              <view v-else
                class="artist-avatar"''')
s = s.replace('''              <view
                class="source-badge"''', '''              <image v-if="sourceIcon(item.id) != ''" class="source-badge" :class="layout.isWide ? 'source-badge-wide' : ''" :src="sourceIcon(item.id)" mode="aspectFit" />
              <view v-else
                class="source-badge"''')
s = s.replace('{{ item.count }} 首', '{{ item.count }} 次')
s = s.replace('/** 歌手头像位没有图片，用名字首字做圆形占位（PC 端 StatsPage 同做法） */', '/** 暂无歌手头像或图片加载失败时，用名字首字占位。 */')
s = s.replace('// 歌手：统计出现次数（历史里每首歌只算一次），顺带给出「常听歌手」这一格的去重总数', '// 歌手：按每首歌的实际起播次数加权，与卡片「播放次数」口径一致')
s = s.replace('''// 模板按 { song, count } 渲染，player.topPlayed() 只返回 Song[] 不带次数，
// 这里自行从播放记录聚合；history 里同一首只出现一次，所以先按 platform:id 去重''', '// 使用独立统计存档，不受最近播放历史的长度上限或清理操作影响')
css = '''.duration-card { margin:20rpx 24rpx 0; padding:26rpx; border-width:1px; border-style:solid; border-radius:26rpx; }
.duration-card-wide { margin:16px 24px 0; padding:20px; border-radius:16px; }
.duration-heading { flex-direction:row; align-items:center; }
.duration-label { margin-left:12rpx; }
.duration-line { flex-direction:row; align-items:baseline; margin-top:10rpx; }
.duration-number { font-weight:700; }
.duration-unit { margin-left:12rpx; }
.duration-note { margin-top:8rpx; }
.storage-status { margin-top:18rpx; }
'''
s = s.replace('/* 数据带：一排四格 */', css + '\n/* 数据带：一排四格 */')
p.write_text(s, encoding='utf-8')
