import { reactive } from "vue";

const THEME_V2_KEY = "qt-ui-theme-v2";
const LEGACY_THEME_KEY = "qt-theme-dark";
const LEGACY_SKIN_KEY = "qt-ui-skin";

export type QtThemeMode = "system" | "light" | "dark";

export type QtSkin = {
  id: string;
  name: string;
  description: string;
  accent: string;
  onAccent: string;
  accentSoft: string;
  background: string;
  surface: string;
  surfaceStrong: string;
  surfaceMuted: string;
  surfaceInset: string;
  sheetSurface: string;
  tabSurface: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  icon: string;
  iconMuted: string;
  border: string;
  divider: string;
  overlay: string;
  scrim: string;
  danger: string;
  dangerSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  placeholder: string;
  coverPlaceholder: string;
  shadow: string;
  mediaText: string;
  mediaMuted: string;
  mediaSurface: string;
  mediaBorder: string;
  mediaScrim: string;
  mediaControl: string;
  backgroundImage: string;
};

export type QtSkinPreset = {
  id: string;
  name: string;
  description: string;
  light: QtSkin;
  dark: QtSkin;
};

/**
 * 给 #RRGGBB 颜色按指定不透明度生成 rgba 串（accentSoft 等“强调色弱化底”用）。
 * 非 hex 输入（自定义皮肤可能配 rgba/非法值）时退回中性弱化底，保证可读性。
 */
function withAlpha(color: string, alpha: number): string {
  if (color.length == 7 && color.charAt(0) == "#") {
    let ok = true;
    const rgb: number[] = [];
    for (let ch = 1; ch < 7; ch += 2) {
      const hi = hexVal(color.charAt(ch));
      const lo = hexVal(color.charAt(ch + 1));
      if (hi < 0 || lo < 0) { ok = false; break; }
      rgb.push(hi * 16 + lo);
    }
    if (ok) {
      const a = Math.round(alpha * 100) / 100;
      return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
    }
  }
  return "rgba(25,29,38,0.06)";
}

function hexVal(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function makeSkin(
  id: string,
  name: string,
  description: string,
  dark: boolean,
  accent: string,
  background: string,
  surface: string,
  surfaceStrong: string,
  text: string,
  textMuted: string,
  border: string,
  overlay: string,
  tabSurface: string,
): QtSkin {
  return {
    id, name, description, accent,
    onAccent: dark ? "#151820" : "#ffffff",
    accentSoft: withAlpha(accent, dark ? 0.20 : 0.12),
    background, surface, surfaceStrong,
    surfaceMuted: dark ? "rgba(255,255,255,0.07)" : "rgba(25,29,38,0.04)",
    surfaceInset: dark ? "rgba(0,0,0,0.22)" : "rgba(25,29,38,0.05)",
    sheetSurface: dark ? "#242936" : "#ffffff",
    tabSurface,
    text, textMuted,
    textSubtle: dark ? "#7f8798" : "#969dad",
    icon: text, iconMuted: textMuted, border,
    divider: dark ? "rgba(255,255,255,0.08)" : "rgba(25,29,38,0.07)",
    overlay,
    scrim: dark ? "rgba(0,0,0,0.64)" : "rgba(17,20,28,0.52)",
    danger: dark ? "#ff7378" : "#d93c43",
    dangerSoft: dark ? "rgba(255,115,120,0.16)" : "#fff0f1",
    success: dark ? "#55cf91" : "#218b58",
    successSoft: dark ? "rgba(85,207,145,0.16)" : "#e9f8ef",
    warning: dark ? "#f2bb55" : "#a86408",
    warningSoft: dark ? "rgba(242,187,85,0.16)" : "#fff5df",
    placeholder: dark ? "#71798b" : "#9aa1b0",
    coverPlaceholder: dark ? "#292e3b" : "#e5e7ec",
    shadow: dark ? "rgba(0,0,0,0.34)" : "rgba(25,29,38,0.14)",
    mediaText: "#ffffff", mediaMuted: "rgba(255,255,255,0.70)",
    mediaSurface: "rgba(16,18,24,0.68)", mediaBorder: "rgba(255,255,255,0.14)",
    mediaScrim: "rgba(0,0,0,0.52)", mediaControl: "rgba(255,255,255,0.18)",
    backgroundImage: "",
  };
}

const LINEN_LIGHT = makeSkin("linen", "Linen", "暖白纸张与珊瑚红", false, "#e5484d", "#f6f7f8", "rgba(255,255,255,0.78)", "rgba(255,255,255,0.94)", "#191d26", "#737b8e", "rgba(25,29,38,0.08)", "rgba(245,246,248,0.76)", "#ffffff");
const LINEN_DARK = makeSkin("linen", "Linen", "暖白纸张与珊瑚红", true, "#ff656a", "#15171d", "rgba(34,37,46,0.82)", "rgba(43,47,58,0.96)", "#f6f3ee", "#aaa8a5", "rgba(255,255,255,0.10)", "rgba(21,23,29,0.72)", "#1a1d25");
const GRAPHITE_LIGHT = makeSkin("graphite", "Graphite", "中性石墨与清晰层次", false, "#d9474e", "#eef0f3", "rgba(255,255,255,0.82)", "rgba(255,255,255,0.96)", "#20232b", "#6b7280", "rgba(32,35,43,0.10)", "rgba(238,240,243,0.76)", "#ffffff");
const GRAPHITE_DARK = makeSkin("graphite", "Graphite", "中性石墨与清晰层次", true, "#ff5b61", "#11141c", "rgba(31,36,48,0.82)", "rgba(38,44,58,0.96)", "#f4f5f7", "#a6adbc", "rgba(255,255,255,0.10)", "rgba(17,20,28,0.64)", "#161a23");
const AURORA_LIGHT = makeSkin("aurora", "Aurora", "蓝紫层次与通透玻璃", false, "#6b5ce7", "#eef0fb", "rgba(255,255,255,0.72)", "rgba(255,255,255,0.92)", "#1e2030", "#71748c", "rgba(76,69,145,0.12)", "rgba(238,240,251,0.70)", "#ffffff");
const AURORA_DARK = makeSkin("aurora", "Aurora", "蓝紫层次与通透玻璃", true, "#9789ff", "#141424", "rgba(35,34,59,0.82)", "rgba(46,44,76,0.96)", "#f5f3ff", "#aaa6c2", "rgba(180,172,255,0.15)", "rgba(20,20,36,0.64)", "#1a1a2e");
const OCEAN_LIGHT = makeSkin("ocean", "Ocean", "深海蓝与清爽水面", false, "#0b7ad1", "#f1f5f9", "rgba(255,255,255,0.80)", "rgba(255,255,255,0.95)", "#16212b", "#6e7b88", "rgba(22,33,43,0.08)", "rgba(241,245,249,0.76)", "#ffffff");
const OCEAN_DARK = makeSkin("ocean", "Ocean", "深海蓝与清爽水面", true, "#58aef5", "#0f151d", "rgba(32,42,56,0.82)", "rgba(42,54,70,0.96)", "#eef3f8", "#a2aebb", "rgba(255,255,255,0.10)", "rgba(15,21,29,0.72)", "#171f29");
const FOREST_LIGHT = makeSkin("forest", "Forest", "松林绿与自然晨雾", false, "#1f9d61", "#f1f8f3", "rgba(255,255,255,0.80)", "rgba(255,255,255,0.95)", "#14211a", "#6d7d72", "rgba(20,33,26,0.08)", "rgba(241,248,243,0.76)", "#ffffff");
const FOREST_DARK = makeSkin("forest", "Forest", "松林绿与自然晨雾", true, "#4cd08d", "#0e1712", "rgba(30,44,36,0.82)", "rgba(40,56,47,0.96)", "#ecf5ef", "#9fb2a6", "rgba(255,255,255,0.10)", "rgba(14,23,18,0.72)", "#16211b");
const SUNSET_LIGHT = makeSkin("sunset", "Sunset", "落日橙与暖沙余晖", false, "#d96a1f", "#faf5f0", "rgba(255,255,255,0.80)", "rgba(255,255,255,0.94)", "#241a12", "#7d7266", "rgba(36,26,18,0.08)", "rgba(250,245,240,0.76)", "#ffffff");
const SUNSET_DARK = makeSkin("sunset", "Sunset", "落日橙与暖沙余晖", true, "#ff9e54", "#191210", "rgba(46,36,30,0.82)", "rgba(58,45,37,0.96)", "#f8f1ea", "#b3a69a", "rgba(255,255,255,0.10)", "rgba(25,18,16,0.72)", "#211a15");
const BLOSSOM_LIGHT = makeSkin("blossom", "Blossom", "樱花粉与柔和春日", false, "#d6487e", "#fbf3f7", "rgba(255,255,255,0.80)", "rgba(255,255,255,0.94)", "#241520", "#7f6d79", "rgba(36,21,32,0.08)", "rgba(251,243,247,0.76)", "#ffffff");
const BLOSSOM_DARK = makeSkin("blossom", "Blossom", "樱花粉与柔和春日", true, "#ff7fae", "#1a1117", "rgba(47,33,42,0.82)", "rgba(60,42,54,0.96)", "#f9edf3", "#b5a1ad", "rgba(255,255,255,0.10)", "rgba(26,17,23,0.72)", "#231820");

export const QT_SKINS: QtSkinPreset[] = [
  { id: "linen", name: "Linen", description: "暖白纸张与珊瑚红", light: LINEN_LIGHT, dark: LINEN_DARK },
  { id: "graphite", name: "Graphite", description: "中性石墨与清晰层次", light: GRAPHITE_LIGHT, dark: GRAPHITE_DARK },
  { id: "aurora", name: "Aurora", description: "蓝紫层次与通透玻璃", light: AURORA_LIGHT, dark: AURORA_DARK },
  { id: "ocean", name: "Ocean", description: "深海蓝与清爽水面", light: OCEAN_LIGHT, dark: OCEAN_DARK },
  { id: "forest", name: "Forest", description: "松林绿与自然晨雾", light: FOREST_LIGHT, dark: FOREST_DARK },
  { id: "sunset", name: "Sunset", description: "落日橙与暖沙余晖", light: SUNSET_LIGHT, dark: SUNSET_DARK },
  { id: "blossom", name: "Blossom", description: "樱花粉与柔和春日", light: BLOSSOM_LIGHT, dark: BLOSSOM_DARK },
];

function hasPreset(id: string): boolean {
  for (let i = 0; i < QT_SKINS.length; i++) if (QT_SKINS[i].id == id) return true;
  return false;
}

function cloneSkin(source: QtSkin): QtSkin {
  return { ...source } as QtSkin;
}

function presetFor(id: string): QtSkinPreset {
  for (let i = 0; i < QT_SKINS.length; i++) if (QT_SKINS[i].id == id) return QT_SKINS[i];
  return QT_SKINS[0];
}

function validString(value: any, fallback: string): string {
  return typeof value == "string" && value.length > 0 ? value : fallback;
}

function validOptionalString(value: any, fallback: string): string {
  return typeof value == "string" ? value : fallback;
}

function validatedCustomSkin(value: any, fallback: QtSkin): QtSkin | null {
  if (value == null || typeof value != "object") return null;
  const result = cloneSkin(fallback);
  result.id = "custom";
  result.name = validString(value.name, "Custom");
  result.description = validString(value.description, "由你定义的专属皮肤");
  result.accent = validString(value.accent, fallback.accent);
  result.onAccent = validString(value.onAccent, fallback.onAccent);
  result.accentSoft = validString(value.accentSoft, fallback.accentSoft);
  result.background = validString(value.background, fallback.background);
  result.surface = validString(value.surface, fallback.surface);
  result.surfaceStrong = validString(value.surfaceStrong, fallback.surfaceStrong);
  result.surfaceMuted = validString(value.surfaceMuted, fallback.surfaceMuted);
  result.surfaceInset = validString(value.surfaceInset, fallback.surfaceInset);
  result.sheetSurface = validString(value.sheetSurface, fallback.sheetSurface);
  result.tabSurface = validString(value.tabSurface, fallback.tabSurface);
  result.text = validString(value.text, fallback.text);
  result.textMuted = validString(value.textMuted, fallback.textMuted);
  result.textSubtle = validString(value.textSubtle, fallback.textSubtle);
  result.icon = validString(value.icon, fallback.icon);
  result.iconMuted = validString(value.iconMuted, fallback.iconMuted);
  result.border = validString(value.border, fallback.border);
  result.divider = validString(value.divider, fallback.divider);
  result.overlay = validString(value.overlay, fallback.overlay);
  result.scrim = validString(value.scrim, fallback.scrim);
  result.danger = validString(value.danger, fallback.danger);
  result.dangerSoft = validString(value.dangerSoft, fallback.dangerSoft);
  result.success = validString(value.success, fallback.success);
  result.successSoft = validString(value.successSoft, fallback.successSoft);
  result.warning = validString(value.warning, fallback.warning);
  result.warningSoft = validString(value.warningSoft, fallback.warningSoft);
  result.placeholder = validString(value.placeholder, fallback.placeholder);
  result.coverPlaceholder = validString(value.coverPlaceholder, fallback.coverPlaceholder);
  result.shadow = validString(value.shadow, fallback.shadow);
  result.mediaText = validString(value.mediaText, fallback.mediaText);
  result.mediaMuted = validString(value.mediaMuted, fallback.mediaMuted);
  result.mediaSurface = validString(value.mediaSurface, fallback.mediaSurface);
  result.mediaBorder = validString(value.mediaBorder, fallback.mediaBorder);
  result.mediaScrim = validString(value.mediaScrim, fallback.mediaScrim);
  result.mediaControl = validString(value.mediaControl, fallback.mediaControl);
  result.backgroundImage = "";
  return result;
}

type ThemePayload = {
  version: number;
  mode: QtThemeMode;
  skinId: string;
  backgroundImage: string;
  customSkin: QtSkin | null;
};

class ThemeStore {
  mode: QtThemeMode = "system";
  dark: boolean = false;
  followSystem: boolean = true;
  skinId: string = "linen";
  backgroundImage: string = "";
  customSkin: QtSkin | null = null;
  skin: QtSkin = cloneSkin(LINEN_LIGHT);
  private appliedTheme: string = "";
  private systemDarkKnown: boolean = false;
  private lastSystemDark: boolean = false;

  init(): void {
    let loaded = false;
    try {
      const raw = uni.getStorageSync(THEME_V2_KEY) as string | null;
      if (raw != null && raw.length > 0) {
        const parsed = JSON.parse(raw) as any;
        if (parsed != null && parsed.version == 2) {
          this.loadPayload(parsed);
          loaded = true;
        }
      }
    } catch (_) {}
    if (!loaded) this.migrateLegacy();
    this.syncSystemTheme();
    if (this.persist()) this.clearLegacy();
    this.setupThemeListener();
  }

  setMode(value: QtThemeMode): void {
    this.mode = value == "light" || value == "dark" ? value : "system";
    this.followSystem = this.mode == "system";
    if (this.mode != "system") this.dark = this.mode == "dark";
    this.syncSystemTheme();
    this.persist();
  }

  setDark(value: boolean): void {
    this.setMode(value ? "dark" : "light");
  }

  setFollowSystem(value: boolean): void {
    if (value) this.setMode("system");
    else this.setMode(this.dark ? "dark" : "light");
  }

  toggle(): void {
    this.setDark(!this.dark);
  }

  setSkin(id: string): void {
    const previousImage = this.backgroundImage;
    if (id == "custom" && this.customSkin != null) this.skinId = "custom";
    else this.skinId = presetFor(id).id;
    this.backgroundImage = previousImage;
    this.resolveSkin();
    this.persist();
  }

  setBackgroundImage(url: string): void {
    this.backgroundImage = url.trim();
    this.resolveSkin();
    this.persist();
  }

  setCustomSkin(
    name: string,
    accent: string,
    background: string,
    surface: string,
    text: string,
    textMuted: string,
    border: string,
    overlay: string,
  ): void {
    const base = this.resolvedBaseSkin();
    const custom = cloneSkin(base);
    custom.id = "custom";
    custom.name = name.length > 0 ? name : "Custom";
    custom.description = "由你定义的专属皮肤";
    custom.accent = validString(accent, base.accent);
    custom.background = validString(background, base.background);
    custom.surface = validString(surface, base.surface);
    custom.text = validString(text, base.text);
    custom.textMuted = validString(textMuted, base.textMuted);
    custom.border = validString(border, base.border);
    custom.overlay = validString(overlay, base.overlay);
    custom.backgroundImage = "";
    this.customSkin = custom;
    this.skinId = "custom";
    this.resolveSkin();
    this.persist();
  }

  resetSkin(): void {
    this.skinId = "linen";
    this.customSkin = null;
    this.resolveSkin();
    this.persist();
  }

  resetAll(): void {
    this.mode = "system";
    this.followSystem = true;
    this.skinId = "linen";
    this.backgroundImage = "";
    this.customSkin = null;
    this.syncSystemTheme();
    this.persist();
  }

  syncSystemTheme(): void {
    if (this.mode == "system") {
      // 优先使用 onThemeChange 推送的系统主题；部分平台 osThemeName 不会在运行期更新
      if (this.systemDarkKnown) {
        this.dark = this.lastSystemDark;
      } else {
        try {
          const system = uni.getSystemInfoSync();
          const osTheme = system.osThemeName as string | null;
          if (osTheme == "light" || osTheme == "dark") {
            this.systemDarkKnown = true;
            this.lastSystemDark = osTheme == "dark";
          }
          this.dark = this.lastSystemDark;
        } catch (_) {
          this.dark = false;
        }
      }
    } else {
      this.dark = this.mode == "dark";
    }
    this.followSystem = this.mode == "system";
    this.resolveSkin();
    this.applyAppTheme();
  }

  setupThemeListener(): void {
    try {
      uni.onThemeChange((result) => {
        const t = (result as any).theme as string | null;
        if (t != "light" && t != "dark") return;
        this.systemDarkKnown = true;
        this.lastSystemDark = t == "dark";
        if (this.mode == "system") {
          this.dark = this.lastSystemDark;
          this.resolveSkin();
          this.applyAppTheme();
        }
      });
    } catch (_) {}
  }

  applyAppTheme(): void {
    // system 模式交给原生层跟随系统（manifest defaultAppTheme=auto），显式模式才固定覆盖
    const target = this.mode == "system" ? "auto" : this.dark ? "dark" : "light";
    if (this.appliedTheme == target) return;
    try {
      uni.setAppTheme({ theme: target as 'auto' | 'light' | 'dark' });
      this.appliedTheme = target;
    } catch (_) {}
  }

  private loadPayload(value: any): void {
    const savedMode = value.mode as string | null;
    this.mode = savedMode == "light" || savedMode == "dark" ? savedMode as QtThemeMode : "system";
    const savedId = value.skinId as string | null;
    if (savedId == "custom") this.skinId = "custom";
    else if (savedId != null && hasPreset(savedId)) this.skinId = savedId;
    else this.skinId = "linen";
    this.backgroundImage = validOptionalString(value.backgroundImage, "").trim();
    this.customSkin = validatedCustomSkin(value.customSkin, LINEN_LIGHT);
    if (this.skinId == "custom" && this.customSkin == null) this.skinId = "linen";
  }

  private migrateLegacy(): void {
    try {
      const legacyMode = uni.getStorageSync(LEGACY_THEME_KEY) as string | null;
      if (legacyMode == "light" || legacyMode == "dark") this.mode = legacyMode as QtThemeMode;
      else this.mode = "system";
    } catch (_) {
      this.mode = "system";
    }
    try {
      const rawSkin = uni.getStorageSync(LEGACY_SKIN_KEY) as string | null;
      if (rawSkin != null && rawSkin.length > 0) {
        const parsed = JSON.parse(rawSkin) as any;
        const legacyId = parsed.id as string | null;
        if (legacyId != null && hasPreset(legacyId)) this.skinId = legacyId;
        else if (legacyId == "custom") {
          this.customSkin = validatedCustomSkin(parsed, LINEN_LIGHT);
          if (this.customSkin != null) this.skinId = "custom";
        }
        this.backgroundImage = validOptionalString(parsed.backgroundImage, "").trim();
      }
    } catch (_) {}
  }

  private clearLegacy(): void {
    try {
      uni.removeStorageSync(LEGACY_THEME_KEY);
      uni.removeStorageSync(LEGACY_SKIN_KEY);
    } catch (_) {}
  }

  private resolvedBaseSkin(): QtSkin {
    if (this.skinId == "custom" && this.customSkin != null) return this.customSkin;
    const preset = presetFor(this.skinId);
    return this.dark ? preset.dark : preset.light;
  }

  private resolveSkin(): void {
    const resolved = cloneSkin(this.resolvedBaseSkin());
    resolved.backgroundImage = this.backgroundImage;
    this.skin = resolved;
    this.applyTabBar();
  }

  /** 让原生 tabBar 颜色跟随当前皮肤（accent 选中色 + 实色底），仅 tab 页生效，失败静默 */
  private applyTabBar(): void {
    try {
      uni.setTabBarStyle({
        color: this.skin.textMuted,
        selectedColor: this.skin.accent,
        backgroundColor: this.skin.tabSurface,
        borderStyle: this.dark ? "black" : "white",
        fail: (_: any) => {},
      } as any);
    } catch (_) {}
  }

  private persist(): boolean {
    const payload: ThemePayload = {
      version: 2,
      mode: this.mode,
      skinId: this.skinId,
      backgroundImage: this.backgroundImage,
      customSkin: this.customSkin,
    };
    try {
      uni.setStorageSync(THEME_V2_KEY, JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }
}

export const theme = reactive(new ThemeStore());

/** 供页面取“强调色按指定不透明度弱化”的渐变/底色（accent 变化时随之联动） */
export function qtAccentRgba(skin: QtSkin, alpha: number): string {
  return withAlpha(skin.accent, alpha);
}

/** 供页面取“强调色上的文字/图标（onAccent）按指定不透明度弱化”的颜色 */
export function qtOnAccentRgba(skin: QtSkin, alpha: number): string {
  return withAlpha(skin.onAccent, alpha);
}
export function useThemeStore(): ThemeStore {
  return theme;
}