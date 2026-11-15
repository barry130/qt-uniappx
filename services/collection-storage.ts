import { getUserId } from "@/services/auth";

const KEYS: string[] = ["qt-liked-songs", "qt-saved-playlists", "qt-local-playlists", "qt-default-fav-playlist"];
const MIGRATED = "qt-collection-storage-v1";

/** Device history remains global; editable collections belong to their last signed-in owner. */
export function collectionStorageKey(key: string): string {
  if (KEYS.indexOf(key) < 0) return key;
  const uid = getUserId();
  return uid.length > 0 ? key + ":" + uid : key;
}

/** Copy before marking complete, so interrupted upgrades can safely retry. */
export function prepareCollectionStorage(): void {
  if (uni.getStorageSync(MIGRATED) == "1") return;
  const owner = (uni.getStorageSync("qt-like-account") as string) || getUserId();
  if (owner.length > 0) {
    for (let i = 0; i < KEYS.length; i++) {
      const scoped = KEYS[i] + ":" + owner;
      const existing = (uni.getStorageSync(scoped) as string) || "";
      const legacy = (uni.getStorageSync(KEYS[i]) as string) || "";
      if (existing.length == 0 && legacy.length > 0) uni.setStorageSync(scoped, legacy);
    }
  }
  uni.setStorageSync(MIGRATED, "1");
}

/** The first login adopts guest edits; subsequent logins restore only that owner's partition. */
export function adoptGuestCollections(uid: string): void {
  prepareCollectionStorage();
  if (getUserId().length > 0 || uid.length == 0) return;
  for (let i = 0; i < KEYS.length; i++) {
    const target = KEYS[i] + ":" + uid;
    const old = (uni.getStorageSync(target) as string) || "";
    const guest = (uni.getStorageSync(KEYS[i]) as string) || "";
    if (old.length == 0 && guest.length > 0) uni.setStorageSync(target, guest);
  }
  // Migrate the baseline with the adopted editable lists. Recovery has already
  // completed under the guest owner before login changes the account identity.
  const guestFollow = (uni.getStorageSync("qt-playlist-follow-v1:guest") as string) || "";
  const targetFollow = "qt-playlist-follow-v1:" + uid;
  if (guestFollow.length > 0 && !uni.getStorageSync(targetFollow)) uni.setStorageSync(targetFollow, guestFollow);
}
