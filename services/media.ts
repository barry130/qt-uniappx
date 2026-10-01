/**
 * 媒体直传（UPDATE_DESIGN.md §5.2/§5.3）：头像 / 收藏歌单封面。
 *
 * 文件正文不经过 Astral 服务器，三段式：
 * ① 网关取签发凭证（ticket：直传地址 + 表单字段，校验在 storage 插件完成）；
 * ② 客户端把文件直传存储端——
 *    S3 系/R2/COS/OSS：预签名 PUT，body 就是文件原始字节（uni.request + ArrayBuffer）；
 *    TELEGRAM Worker / 又拍云：multipart 表单（uni.uploadFile，file 字段 + policy/authorization）；
 * ③ 凭 uploadId 回执登记，网关返回「URL 即版本」的永久地址。
 *
 * 注意：本层不做任何大小/类型/配额校验——策略由 storage 插件强制执行，
 * 服务端拒绝时把它的文案原样抛给调用方（如「今日上传次数已达上限」）。
 */
import { apiRequest } from "./http";

/** 直传凭证（后端 QtUploadTicketVo） */
type UploadTicket = {
  uploadUrl: string;
  method: string;
  formField: string;
  uploadId: string;
  formPolicy: string;
  formAuthorization: string;
};

function parseTicket(data: UTSJSONObject): UploadTicket | null {
  const uploadUrl = data.get("uploadUrl") as string | null;
  const uploadId = data.get("uploadId") as string | null;
  if (uploadUrl == null || uploadId == null) return null;
  const method = data.get("method") as string | null;
  const formField = data.get("formField") as string | null;
  const formPolicy = data.get("formPolicy") as string | null;
  const formAuthorization = data.get("formAuthorization") as string | null;
  return {
    uploadUrl,
    uploadId,
    method: method != null && method.length > 0 ? method : "PUT",
    formField: formField != null && formField.length > 0 ? formField : "file",
    formPolicy: formPolicy != null ? formPolicy : "",
    formAuthorization: formAuthorization != null ? formAuthorization : "",
  };
}

/** 从 ticket 响应取回执 URL（avatar/complete 与 cover/complete 都是 { url }） */
function urlOf(data: UTSJSONObject): string {
  const url = data.get("url") as string | null;
  if (url == null || url.length === 0) {
    throw new Error("回执缺少图片地址");
  }
  return url;
}

/** 扩展名 → 文件名后缀（不带点；取不到时按 png 兜底） */
function imageExt(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".jpg")) return "jpg";
  if (lower.endsWith(".jpeg")) return "jpeg";
  if (lower.endsWith(".webp")) return "webp";
  return "";
}

/** 扩展名 → MIME（与后端 qt-media 文件夹策略一致：png/jpg/jpeg/webp） */
export function guessImageMime(path: string): string {
  const ext = imageExt(path);
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "";
}

/** 读本地图片为原始字节（预签名 PUT 用） */
function readFileBytes(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    uni.getFileSystemManager().readFile({
      filePath,
      success: (res) => {
        resolve(res.data as ArrayBuffer);
      },
      fail: () => {
        reject(new Error("读取图片失败"));
      },
    });
  });
}

/** 读本地文件大小（ticket 签发必须携带真实 sizeBytes，后端拒绝 0） */
function fileSize(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    uni.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => {
        resolve(res.size);
      },
      fail: () => {
        reject(new Error("读取图片失败"));
      },
    });
  });
}

/** 预签名 PUT：原始字节直传对象存储 */
function putBytes(url: string, bytes: ArrayBuffer, mime: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const header = new UTSJSONObject();
    header.set("Content-Type", mime);
    uni.request({
      url,
      method: "PUT",
      data: bytes,
      header,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error("上传失败（存储端 HTTP " + res.statusCode + "）"));
        }
      },
      fail: () => {
        reject(new Error("网络请求失败"));
      },
    });
  });
}

/** multipart 表单直传（TELEGRAM Worker / 又拍云）：file 字段 + policy/authorization */
function uploadMultipart(ticket: UploadTicket, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const formData = new UTSJSONObject();
    if (ticket.formPolicy.length > 0) formData.set("policy", ticket.formPolicy);
    if (ticket.formAuthorization.length > 0) formData.set("authorization", ticket.formAuthorization);
    uni.uploadFile({
      url: ticket.uploadUrl,
      filePath,
      name: ticket.formField,
      formData,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error("上传失败（存储端 HTTP " + res.statusCode + "）"));
        }
      },
      fail: () => {
        reject(new Error("网络请求失败"));
      },
    });
  });
}

async function directUpload(ticket: UploadTicket, filePath: string, mime: string): Promise<void> {
  if (ticket.method.toUpperCase() == "PUT") {
    const bytes = await readFileBytes(filePath);
    await putBytes(ticket.uploadUrl, bytes, mime);
    return;
  }
  await uploadMultipart(ticket, filePath);
}

/** 上传一条龙共用体：ticket → 直传 → complete，返回永久 URL */
async function uploadFlow(
  ticketPath: string,
  ticketBody: UTSJSONObject,
  completePath: string,
  filePath: string,
  mime: string
): Promise<string> {
  const ticketRes = await apiRequest(ticketPath, ticketBody, "POST", true);
  const ticket = parseTicket(ticketRes);
  if (ticket == null) {
    throw new Error("获取上传凭证失败");
  }
  await directUpload(ticket, filePath, mime);
  const done = await apiRequest(completePath, { uploadId: ticket.uploadId } as UTSJSONObject, "POST", true);
  return urlOf(done);
}

/**
 * 头像上传（仅修改时调用；每日每用户次数由文件夹策略限制）。
 * 成功后把 URL 写入 qt-avatar 存储，展示页直接读取。
 */
export async function uploadAvatar(filePath: string): Promise<string> {
  const mime = guessImageMime(filePath);
  if (mime.length === 0) {
    throw new Error("仅支持 png / jpg / webp 图片");
  }
  const size = await fileSize(filePath);
  const fileName = "avatar." + imageExt(filePath);
  const url = await uploadFlow(
    "app/user/avatar/ticket",
    { fileName, contentType: mime, sizeBytes: size } as UTSJSONObject,
    "app/user/avatar/complete",
    filePath,
    mime
  );
  uni.setStorageSync("qt-avatar", url);
  return url;
}

/**
 * 收藏歌单封面上传（每日所有歌单合计限次，由文件夹策略承载）。
 * pid 用歌单的全局唯一键（在线歌单即平台歌单号）。
 */
export async function uploadPlaylistCover(pid: string, platform: string, filePath: string): Promise<string> {
  const mime = guessImageMime(filePath);
  if (mime.length === 0) {
    throw new Error("仅支持 png / jpg / webp 图片");
  }
  const size = await fileSize(filePath);
  const fileName = "cover." + imageExt(filePath);
  const url = await uploadFlow(
    "app/user/like/playlist/" + encodeURIComponent(pid) + "/cover/ticket",
    { platform, fileName, contentType: mime, sizeBytes: size } as UTSJSONObject,
    "app/user/like/playlist/" + encodeURIComponent(pid) + "/cover/complete?platform=" + encodeURIComponent(platform),
    filePath,
    mime
  );
  return url;
}

/** 清除歌单封面（恢复默认本地资源） */
export async function clearPlaylistCover(pid: string, platform: string): Promise<void> {
  await apiRequest(
    "app/user/like/playlist/" + encodeURIComponent(pid) + "/cover?platform=" + encodeURIComponent(platform),
    new UTSJSONObject(),
    "DELETE",
    true
  );
}

/** 让 uni.chooseImage 走一张压缩图（头像/封面都够用，省流量） */
export function chooseImage(): Promise<string> {
  return new Promise((resolve, reject) => {
    uni.chooseImage({
      count: 1,
      sizeType: ["compressed"],
      success: (res) => {
        const paths = res.tempFilePaths;
        if (paths != null && paths.length > 0 && paths[0].length > 0) {
          resolve(paths[0]);
        } else {
          reject(new Error("未选择图片"));
        }
      },
      fail: () => {
        reject(new Error("未选择图片"));
      },
    });
  });
}

/** 展示地址兜底：空头像时渲染本地默认资源（与 qt-pc 同路径约定）。
 * 默认头像/歌单封面直接复用应用图标（static/icon 最大档），不单独维护占位图文件 */
export const DEFAULT_AVATAR_ASSET = "/static/icon/xxxhdpi.png";
export const DEFAULT_PLAYLIST_COVER_ASSET = "/static/icon/xxxhdpi.png";

/** 读取缓存头像（登录/me/上传成功时写入） */
export function getCachedAvatar(): string {
  return uni.getStorageSync("qt-avatar") as string;
}
