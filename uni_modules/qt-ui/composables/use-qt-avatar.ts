import { ref, onUnmounted } from "vue";
import { AVATAR_CHANGED_EVENT, getAvatarSource, prepareCachedAvatar, recoverCachedAvatar } from "@/services/avatar-cache";

/** 个人头像三处展示共享本地文件与更新事件，横竖屏使用相同来源。 */
export function useQtAvatar() {
  const avatarSource = ref(getAvatarSource());
  function sync(): void { avatarSource.value = getAvatarSource(); }
  function refreshAvatar(): void {
    sync();
    prepareCachedAvatar();
  }
  function onAvatarError(): void { recoverCachedAvatar(avatarSource.value); }
  uni.$on(AVATAR_CHANGED_EVENT, sync);
  onUnmounted(() => { uni.$off(AVATAR_CHANGED_EVENT, sync); });
  refreshAvatar();
  return { avatarSource, refreshAvatar, onAvatarError };
}
