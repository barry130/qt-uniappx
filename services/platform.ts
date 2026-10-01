export function platformLabel(platform: string): string {
  if (platform == "wyy") return "音源一";
  if (platform == "qq") return "音源二";
  if (platform == "kw") return "音源三";
  if (platform == "kg") return "音源四";
  return "未知";
}

export function platformShort(platform: string): string {
  if (platform == "local") return "本地";
  if (platform == "wyy") return "音源一";
  if (platform == "qq") return "音源二";
  if (platform == "kw") return "音源三";
  if (platform == "kg") return "音源四";
  return "未知";
}

export function platformColor(platform: string): string {
  if (platform == "local") return "#8b93a7";
  if (platform == "wyy") return "#e5484d";
  if (platform == "qq") return "#31c27c";
  if (platform == "kw") return "#f08300";
  if (platform == "kg") return "#2fa4e7";
  return "#8b92a1";
}
