/**
 * 媒体上传（UPDATE_DESIGN.md §5.2/§5.3 + 2026-11 代传支持）：头像 / 收藏歌单封面。
 *
 * 统一入口是「上传计划」（upload-plan）：后端按目录首选渠道分流——
 * ① 直传家族（TELEGRAM Worker / S3 系 / COS / OSS / 又拍云）：计划返回 DIRECT + 直传凭证，
 *    三段式不变，文件正文不经过 Astral 服务器；
 *    S3 系/R2/COS/OSS：预签名 PUT，body 就是文件原始字节（uni.request + ArrayBuffer）；
 *    TELEGRAM Worker / 又拍云：multipart 表单（uni.uploadFile，file 字段 + policy/authorization）；
 * ② CUSTOM_HTTP（如 ImgBB）：不允许客户端直传（直传凭证会把上游凭据泄露给浏览器端），
 *    计划返回 PROXY + 两段式代传参数——原始字节 POST 到 astral 网关的代传端点，
 *    由服务端 HttpUploadGateway 发往上游；响应 state=COMMITTED 后凭 uploadId 调 apply 落业务字段。
 *
 * 注意：本层不做任何大小/类型/配额校验——策略由 storage 插件强制执行，
 * 服务端拒绝时把它的文案原样抛给调用方（如「今日上传次数已达上限」）。
 */
import { apiRequest, asUtso, resolveUrl } from "./http";
import { getAccessToken, getSessionEpoch, sessionIsCurrent } from "./auth";
import { cacheUserAvatar, getCachedAvatarUrl } from "./avatar-cache";
import { updateCachedMeAvatar } from "./user-cache";
import { mergeClientHeaders } from "./client-info";
import { logErrV } from "./logger";

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

// ==================== 两段式代传（CUSTOM_HTTP 渠道，正文经 astral 网关） ====================

/** 上传计划（后端 QtUploadPlanVo）：mode=DIRECT 带嵌套 ticket；mode=PROXY 带代传参数 */
type UploadPlan = {
  mode: string;
  ticket: UploadTicket | null;
  proxyUploadId: string;
  proxyContentPath: string;
};

function parsePlan(data: UTSJSONObject): UploadPlan | null {
  const mode = data.get("mode") as string | null;
  if (mode == null || mode.length === 0) return null;
  if (mode === "PROXY") {
    const uploadId = data.get("uploadId") as string | null;
    const contentPath = data.get("contentPath") as string | null;
    if (uploadId == null || contentPath == null) return null;
    return { mode, ticket: null, proxyUploadId: uploadId, proxyContentPath: contentPath };
  }
  const rawTicket = data.get("ticket");
  if (rawTicket == null || typeof rawTicket != "object") return null;
  const ticket = parseTicket(rawTicket as UTSJSONObject);
  if (ticket == null) return null;
  return { mode, ticket, proxyUploadId: "", proxyContentPath: "" };
}

/**
 * 幂等键：一次上传流程内固定（plan 网络重试复用同一键，服务端按它重放返回同一操作）。
 * 仅需唯一性，无需加密强度：时间戳 + 进程内自增即可。
 */
let uploadKeyCounter = 0;
function newIdempotencyKey(): string {
  uploadKeyCounter++;
  return "qt-upload-" + Date.now() + "-" + uploadKeyCounter;
}

/**
 * 代传正文单次发送（astral 网关自家端点，HTTP POST：生产网关/WAF 实测拦截 PUT）：
 * 必须带 satoken 与统一客户端系统头，与预签名直传不同（那些是第三方地址，一个自定义头都不能加）。
 * 返回操作状态：COMMITTED=完成；CREATED=本次渠道失败已切换备用渠道，需重发同一正文。
 */
function proxyPutOnce(contentPath: string, bytes: ArrayBuffer, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const header = new UTSJSONObject();
    header.set("Content-Type", mime);
    const token = getAccessToken();
    if (token.length > 0) {
      header.set("satoken", token);
    }
    mergeClientHeaders(header);
    uni.request({
      url: resolveUrl(contentPath),
      // 生产网关/WAF 拦截非 GET/POST 方法（实测 PUT 返回 200+纯文本「非法请求」），统一 POST
      method: "POST",
      data: bytes,
      header,
      timeout: 120000,
      // 与 http.ts 同约定（dataType: "text"）：保留原始文本到回调手动解析，
      // 避免运行时默认 JSON 解析抢先报错、或返回无 .get 的普通对象
      // （真机实测普通对象上 JSON.parse/as UTSJSONObject 双双抛错 → 误报「格式异常」）。
      dataType: "text",
      success: (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("代传失败（HTTP " + res.statusCode + "）"));
          return;
        }
        try {
          // 形态无关归一化（asUtso）：res.data 可能是原始文本，也可能是运行时
          // 已预解析的普通对象/UTSJSONObject（dataType 在部分平台对 PUT 不生效）。
          // 不要 `as string`——Kotlin 端不安全 cast 遇对象直接 ClassCastException。
          const body = asUtso(res.data);
          const code = body.get("code");
          if (code != null && (code as number) !== 200) {
            const msg = body.get("msg") as string | null;
            reject(new Error(msg != null && msg.length > 0 ? msg : "代传失败"));
            return;
          }
          const data = body.get("data");
          if (data == null || typeof data != "object") {
            reject(new Error("代传回执格式异常"));
            return;
          }
          const state = (data as UTSJSONObject).get("state") as string | null;
          if (state == null || state.length === 0) {
            reject(new Error("代传回执缺少状态"));
            return;
          }
          resolve(state);
        } catch (e) {
          // 真机定位用：原始回执形态（string/对象）与实际异常都落盘，诊断页可见
          logErrV("QT Music", "代传回执解析失败 " + contentPath + " data=" + typeof res.data, e);
          reject(new Error("代传回执格式异常"));
        }
      },
      fail: () => {
        reject(new Error("网络请求失败"));
      },
    });
  });
}

/** 代传正文：PUT + 渠道切换重试（state=CREATED 表示已切到备用渠道，重发同一正文） */
async function proxyUpload(contentPath: string, filePath: string, mime: string): Promise<void> {
  const bytes = await readFileBytes(filePath);
  // 上限 3 次与服务端两段式 MAX_ATTEMPTS 对齐：首次 + 最多 2 次渠道切换
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await proxyPutOnce(contentPath, bytes, mime);
    if (state === "COMMITTED") return;
    if (state !== "CREATED") {
      throw new Error("文件发送失败（" + state + "）");
    }
  }
  throw new Error("上传渠道暂不可用，请稍后重试");
}

/** 上传一条龙共用体：plan 分流 → 直传或代传 → complete/apply，返回永久 URL */
async function uploadFlow(
  planPath: string,
  planBody: UTSJSONObject,
  completePath: string,
  applyPath: string,
  filePath: string,
  mime: string
): Promise<string> {
  const planRes = await apiRequest(planPath, planBody, "POST", true);
  const plan = parsePlan(planRes);
  if (plan == null) {
    throw new Error("获取上传计划失败");
  }
  if (plan.mode === "PROXY") {
    await proxyUpload(plan.proxyContentPath, filePath, mime);
    const done = await apiRequest(
      applyPath,
      { uploadId: plan.proxyUploadId } as UTSJSONObject,
      "POST",
      true
    );
    return urlOf(done);
  }
  const ticket = plan.ticket;
  if (ticket == null) {
    throw new Error("获取上传凭证失败");
  }
  await directUpload(ticket, filePath, mime);
  const done = await apiRequest(completePath, { uploadId: ticket.uploadId } as UTSJSONObject, "POST", true);
  return urlOf(done);
}

/**
 * 头像上传（仅修改时调用；每日每用户次数由文件夹策略限制）。
 * 大小上限不在这里预检：单一事实源在后端目录策略（QtMediaService.leafPolicy
 * 的 maxSizeBytes），超限时 plan 阶段直接返回带上限数值的友好文案。
 * 成功后同步资料缓存并保存本机选图，展示页无需再次下载。
 */
export async function uploadAvatar(filePath: string): Promise<string> {
  const epoch = getSessionEpoch();
  const mime = guessImageMime(filePath);
  if (mime.length === 0) {
    throw new Error("仅支持 png / jpg / webp 图片");
  }
  const size = await fileSize(filePath);
  const fileName = "avatar." + imageExt(filePath);
  const url = await uploadFlow(
    "app/user/avatar/upload-plan",
    {
      fileName,
      contentType: mime,
      sizeBytes: size,
      idempotencyKey: newIdempotencyKey(),
    } as UTSJSONObject,
    "app/user/avatar/complete",
    "app/user/avatar/apply",
    filePath,
    mime
  );
  if (!sessionIsCurrent(epoch)) throw new Error("登录状态已变化，请重新操作");
  cacheUserAvatar(url, filePath);
  updateCachedMeAvatar(url);
  return url;
}

/**
 * 歌单封面上传（/like/playlist/{pid}/cover/** 直传链路，UPDATE_DESIGN.md §5.3）。
 *
 * 与头像那条链路不同的地方：complete 阶段服务端直接改数据库
 * （`qt_like_playlist.pic_url`）并推进该用户的同步 seq，所以封面是「真的写库」，
 * 其他设备下次增量拉取就能看到新封面，客户端不需要再补推 playlist/add。
 *
 * 前置条件：这个歌单在服务器上必须已有收藏行 —— 同步过的自建歌单，或任何已收藏的
 * 在线歌单。还没同步过的自建歌单服务端会说「歌单不存在」，文案原样抛给调用方。
 */
export async function uploadPlaylistCover(pid: string, platform: string, filePath: string): Promise<string> {
  const mime = guessImageMime(filePath);
  if (mime.length === 0) {
    throw new Error("仅支持 png / jpg / webp 图片");
  }
  const size = await fileSize(filePath);
  const fileName = "cover." + imageExt(filePath);
  return await uploadFlow(
    "app/user/like/playlist/" + pid + "/cover/upload-plan",
    {
      platform,
      fileName,
      contentType: mime,
      sizeBytes: size,
      idempotencyKey: newIdempotencyKey(),
    } as UTSJSONObject,
    "app/user/like/playlist/" + pid + "/cover/complete?platform=" + platform,
    "app/user/like/playlist/" + pid + "/cover/apply?platform=" + platform,
    filePath,
    mime
  );
}

/** 取消自定义封面（恢复默认展示）：服务端把 pic_url 置空并推进 seq，不占每日上传次数。 */
export async function clearPlaylistCover(pid: string, platform: string): Promise<void> {
  await apiRequest(
    "app/user/like/playlist/" + pid + "/cover?platform=" + platform,
    new UTSJSONObject(),
    "DELETE",
    true
  );
}

/** 让 uni.chooseImage 走一张压缩图（头像/封面/背景都够用，省流量）。
 * 只取一张：count 固定为 1，并且即便个别平台忽略 count 回了多张，也只认第一张。 */
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
export { DEFAULT_AVATAR_ASSET } from "./avatar-cache";
export const DEFAULT_PLAYLIST_COVER_ASSET = "/static/icon/xxxhdpi.png";

/** 读取缓存头像（登录/me/上传成功时写入） */
export function getCachedAvatar(): string {
  return getCachedAvatarUrl();
}
