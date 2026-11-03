/**
 * AI 供应商配置 + 客户端直连模型调用（每日推荐「本地模型」的数据面）。
 *
 * 移植自 qt-pc 的 Rust `ai_local` 模块（配置结构 / 四种协议 / 哑管道语义），
 * 差异只有一处：qt-pc 由 Rust 侧保管 Key 明文、前端只见掩码；uniappx 没有
 * 这一进程边界，Key 明文就存在 uni storage 里（key = AI_PROVIDERS_KEY），
 * 页面上展示时统一走 maskKey 掩码，不回显明文。
 *
 * 协议（与 qt-pc 同一套，端点口径对齐 ai_local.rs：地址先归一回「根」，
 * 端点尾巴 / 查询串 / 版本段（/v1、/v1beta）统一剥掉、由各协议按需补）：
 * - openai          POST {root}/v1/chat/completions   （OpenAI 兼容，中转站主流）
 * - openai-responses POST {root}/v1/responses          （新版官方 Responses API）
 * - anthropic       POST {root}/v1/messages + x-api-key
 * - gemini          POST {root}/v1beta/models/{model}:generateContent + x-goog-api-key
 *
 * aiLocalChat 是哑管道：提示词组装、候选池注入、结果硬校验全在
 * services/daily-recommend.ts，这里只负责把 messages 发出去、把 content 取回来。
 */

export type AiProviderProtocol = "openai" | "openai-responses" | "anthropic" | "gemini";

export interface AiProviderProfile {
  id: string;
  /** 展示名；空串时页面用主机名顶上 */
  name: string;
  baseUrl: string;
  protocol: AiProviderProtocol;
  /** 生效模型 = models[0]；models 为空时退回 model 字段 */
  model: string;
  models: string[];
  /** Key 明文列表（第一把使用中）。存储在 uni storage，页面只显示掩码。 */
  keys: string[];
  icon: string;
  skipCertVerify: boolean;
}

export interface AiProviderConfig {
  profiles: AiProviderProfile[];
  activeId: string;
}

export interface AiLocalMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiLocalReply {
  content: string;
  model: string;
  elapsedMs: number;
}

export interface AiLocalTestResult {
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  reply: string | null;
  error: string | null;
}

const AI_PROVIDERS_KEY = "qt-ai-providers";
/** 生成超时：与 qt-pc Rust 侧一致的宽松上限 */
const REQUEST_TIMEOUT_MS = 60000;

export const AI_PROTOCOL_ORDER: AiProviderProtocol[] = [
  "openai",
  "openai-responses",
  "anthropic",
  "gemini",
];

export function parseAiProtocol(raw: string): AiProviderProtocol {
  if (raw == "openai-responses" || raw == "anthropic" || raw == "gemini") return raw;
  return "openai";
}

/** Key 掩码：只露尾 2 位；过短全打点 */
export function maskKey(key: string): string {
  if (key.length == 0) return "";
  if (key.length <= 6) return "••••••";
  return "••••••" + key.substring(key.length - 2);
}

export function readProviders(): AiProviderConfig {
  const raw = uni.getStorageSync(AI_PROVIDERS_KEY);
  if (typeof raw == "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as AiProviderConfig;
      if (parsed != null && parsed.profiles != null) {
        const cfg: AiProviderConfig = { profiles: [], activeId: parsed.activeId ?? "" };
        for (let i = 0; i < parsed.profiles.length; i++) {
          const p = parsed.profiles[i];
          if (p == null) continue;
          const models: string[] = [];
          const src = p.models ?? [];
          for (let m = 0; m < src.length; m++) {
            const name = src[m] ?? "";
            if (name.length > 0 && models.indexOf(name) < 0) models.push(name);
          }
          cfg.profiles.push({
            id: p.id ?? "",
            name: p.name ?? "",
            baseUrl: p.baseUrl ?? "",
            protocol: parseAiProtocol(p.protocol ?? "openai"),
            model: p.model ?? "",
            models,
            keys: p.keys ?? [],
            icon: p.icon ?? "",
            skipCertVerify: p.skipCertVerify == true,
          });
        }
        return cfg;
      }
    } catch (e) {
      // 静默：坏数据当空配置处理，调用方按「未配置 AI」兜底
    }
  }
  return { profiles: [], activeId: "" };
}

export function saveProviders(config: AiProviderConfig): void {
  uni.setStorageSync(AI_PROVIDERS_KEY, JSON.stringify(config));
}

export function activeProfile(): AiProviderProfile | null {
  const cfg = readProviders();
  for (let i = 0; i < cfg.profiles.length; i++) {
    if (cfg.profiles[i].id == cfg.activeId) return cfg.profiles[i];
  }
  return null;
}

/** 当前生效模型名：models[0] 优先，退回 model 字段 */
export function activeModelOf(profile: AiProviderProfile): string {
  if (profile.models.length > 0 && profile.models[0].length > 0) return profile.models[0];
  return profile.model;
}

function firstKeyOf(profile: AiProviderProfile): string {
  if (profile.keys.length > 0) return profile.keys[0];
  return "";
}

/** 地址归一（对齐 qt-pc ai_local.rs 的 base_root，2026-11-03 审阅 R6）：
 * 用户可能填四种形态——根域名、带版本段（…/v1）、自建网关完整端点
 * （…/openai/v1/chat/completions）、甚至把 Gemini 的
 * …/v1beta/models/gemini-2.0-flash:generateContent?key=… 整段粘进来。
 * 统一剥掉端点尾巴、查询串与版本段，版本段由各协议自己按需补，
 * 四种形态都落到同一个请求地址上（老配置里的 /v1 地址行为不变）。
 */
function baseRootOf(baseUrl: string): string {
  let u = baseUrl.trim();
  // 粘进来的完整端点可能带 ?key=…：查询串 / 锚点一律丢掉
  const q = u.indexOf("?");
  if (q >= 0) u = u.substring(0, q);
  const h = u.indexOf("#");
  if (h >= 0) u = u.substring(0, h);
  while (u.length > 0 && u.charAt(u.length - 1) == "/") u = u.substring(0, u.length - 1);
  // 常见端点尾巴（OpenAI 兼容的三种写法 + 模型列表）
  const tails = ["/chat/completions", "/responses", "/messages", "/models"];
  for (let i = 0; i < tails.length; i++) {
    if (u.length > tails[i].length && u.substring(u.length - tails[i].length) == tails[i]) {
      u = u.substring(0, u.length - tails[i].length);
      break;
    }
  }
  while (u.length > 0 && u.charAt(u.length - 1) == "/") u = u.substring(0, u.length - 1);
  // Gemini 的端点尾巴是「动作段 + 模型段」：/models/<model>:generateContent
  const actions = [":streamGenerateContent", ":generateContent"];
  let hadAction = false;
  for (let i = 0; i < actions.length; i++) {
    const idx = u.lastIndexOf(actions[i]);
    if (idx >= 0) {
      u = u.substring(0, idx);
      hadAction = true;
      break;
    }
  }
  if (hadAction) {
    const m = u.lastIndexOf("/models/");
    if (m >= 0) u = u.substring(0, m);
  }
  // 版本段交给各协议补：/v1（OpenAI / Anthropic）、/v1beta（Gemini）
  const versions = ["/v1", "/v1beta"];
  for (let i = 0; i < versions.length; i++) {
    if (u.length > versions[i].length && u.substring(u.length - versions[i].length) == versions[i]) {
      u = u.substring(0, u.length - versions[i].length);
      break;
    }
  }
  while (u.length > 0 && u.charAt(u.length - 1) == "/") u = u.substring(0, u.length - 1);
  return u;
}

/** 归一后的根地址 + 协议自己的路径（版本段在这里补） */
function joinUrl(baseUrl: string, path: string): string {
  return baseRootOf(baseUrl) + path;
}

interface ChatHttpRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  data: string;
}

/** 按协议组装请求体。messages 已是完整对话，这里只做转发格式。 */
function buildChatRequest(
  profile: AiProviderProfile,
  model: string,
  key: string,
  messages: AiLocalMessage[],
  temperature: number,
): ChatHttpRequest | null {
  const base = baseRootOf(profile.baseUrl);
  if (base.length == 0) return null;
  if (profile.protocol == "anthropic") {
    // Anthropic：system 独立字段，messages 只收 user/assistant
    let systemText = "";
    const bodyMessages: AiLocalMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role == "system") systemText += (systemText.length > 0 ? "\n" : "") + messages[i].content;
      else bodyMessages.push(messages[i]);
    }
    const header: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
    return {
      url: joinUrl(base, "/v1/messages"),
      method: "POST",
      header,
      data: JSON.stringify({
        model,
        system: systemText,
        messages: bodyMessages,
        // 4096 对齐 qt-pc 口径：每日推荐要一次性回 50 首歌的 JSON，2048 容易截断
        max_tokens: 4096,
        temperature,
      }),
    };
  }
  if (profile.protocol == "gemini") {
    const header: Record<string, string> = {
      "content-type": "application/json",
      "x-goog-api-key": key,
    };
    // Gemini：system 并进 systemInstruction，轮次并进 contents。
    // parts 必须是 {text:"…"} 对象数组——传裸字符串官方必 400；连续同角色要
    // 合并成一个 content 的多个 parts，官方要求 user/model 交替，平铺会被
    // 「messages must alternate」拒掉（对齐 qt-pc ai_local.rs 的 Gemini 分支，
    // 2026-11-03 审阅 R6：原先两处都错，gemini 协议整体不可用）。
    let systemText = "";
    interface GeminiPart { text: string }
    interface GeminiContent { role: string; parts: GeminiPart[] }
    const contents: GeminiContent[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role == "system") {
        systemText += (systemText.length > 0 ? "\n" : "") + m.content;
        continue;
      }
      const role = m.role == "assistant" ? "model" : "user";
      const last = contents.length > 0 ? contents[contents.length - 1] : null;
      if (last != null && last.role == role) {
        last.parts.push({ text: m.content });
      } else {
        contents.push({ role, parts: [{ text: m.content }] });
      }
    }
    const payload: Record<string, Object> = {
      contents,
      generationConfig: { temperature },
    };
    if (systemText.length > 0) payload["systemInstruction"] = { parts: [{ text: systemText }] };
    return {
      url: joinUrl(base, "/v1beta/models/" + encodeURIComponent(model) + ":generateContent"),
      method: "POST",
      header,
      data: JSON.stringify(payload),
    };
  }
  if (profile.protocol == "openai-responses") {
    const header: Record<string, string> = { "content-type": "application/json" };
    if (key.length > 0) header["authorization"] = "Bearer " + key;
    return {
      url: joinUrl(base, "/v1/responses"),
      method: "POST",
      header,
      data: JSON.stringify({ model, input: messages, temperature }),
    };
  }
  // 默认 openai 兼容
  const header: Record<string, string> = { "content-type": "application/json" };
  if (key.length > 0) header["authorization"] = "Bearer " + key;
  return {
    url: joinUrl(base, "/v1/chat/completions"),
    method: "POST",
    header,
    data: JSON.stringify({ model, messages, temperature }),
  };
}

/** 从四种协议的响应里取 content + 模型名 */
function parseChatReply(protocol: AiProviderProtocol, bodyText: string): AiLocalReply | null {
  try {
    const obj = JSON.parse(bodyText) as any;
    if (obj == null) return null;
    const started = Date.now();
    if (protocol == "anthropic") {
      const blocks = (obj["content"] ?? []) as any[];
      let text = "";
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b != null && typeof b == "object" && (b as any)["type"] == "text") {
          text += ((b as any)["text"] ?? "") as string;
        }
      }
      return { content: text, model: (obj["model"] ?? "") as string, elapsedMs: 0 };
    }
    if (protocol == "gemini") {
      // 官方形态 candidates[0].content.parts = [{text:"…"}] 对象数组，逐段拼
      // 正文（对齐 qt-pc extract_gemini_reply；2026-11-03 审阅 R6：原先只认
      // 字符串形态 parts，真实响应永远取不到正文，gemini 永远回空）。
      const cand = (obj["candidates"] ?? []) as any[];
      let text = "";
      if (cand.length > 0) {
        const content = ((cand[0] as any)["content"] ?? {}) as any;
        const parts = (content["parts"] ?? (cand[0] as any)["parts"]) as any[];
        if (parts != null) {
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (typeof p == "string") {
              text += p;
            } else if (p != null && typeof p == "object") {
              text += ((p as any)["text"] ?? "") as string;
            }
          }
        }
      }
      // 有的版本回 modelVersion，有的回 model（qt-pc 同口径）
      const modelName = ((obj["modelVersion"] ?? obj["model"]) ?? "") as string;
      return { content: text, model: modelName, elapsedMs: 0 };
    }
    if (protocol == "openai-responses") {
      const out = obj["output"] ?? [];
      let text = "";
      const arr = out as any[];
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i] as any;
        if (item != null && item["type"] == "message") {
          const content = (item["content"] ?? []) as any[];
          for (let c = 0; c < content.length; c++) {
            if ((content[c] as any)["type"] == "output_text") text += ((content[c] as any)["text"] ?? "") as string;
          }
        }
      }
      return { content: text, model: (obj["model"] ?? "") as string, elapsedMs: 0 };
    }
    // openai 兼容
    const choices = (obj["choices"] ?? []) as any[];
    if (choices.length > 0) {
      const msg = (choices[0] as any)["message"] as any;
      const content = msg != null ? ((msg["content"] ?? "") as string) : "";
      return { content, model: (obj["model"] ?? "") as string, elapsedMs: 0 };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 哑管道生成：用「当前生效档」发完整 messages，取回 content。
 * 没有生效档 / 地址为空 / 网络 or 解析失败一律 throw（daily-recommend 会退回规则推荐）。
 */
export function aiLocalChat(messages: AiLocalMessage[], temperature: number = 0.4): Promise<AiLocalReply> {
  return new Promise<AiLocalReply>((resolve, reject) => {
    const profile = activeProfile();
    if (profile == null) {
      reject(new Error("还没有配置本地模型接口（设置 · AI 与模型 · 第 2 步 模型配置）"));
      return;
    }
    const model = activeModelOf(profile);
    if (model.length == 0) {
      reject(new Error("模型配置里还没有选模型"));
      return;
    }
    const req = buildChatRequest(profile, model, firstKeyOf(profile), messages, temperature);
    if (req == null) {
      reject(new Error("接口地址为空"));
      return;
    }
    const startedAt = Date.now();
    uni.request({
      url: req.url,
      method: req.method as RequestMethod,
      header: req.header,
      data: req.data,
      timeout: REQUEST_TIMEOUT_MS,
      sslVerify: !profile.skipCertVerify,
      success: (res) => {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          let detail = "";
          if (typeof res.data == "string") detail = (res.data as string).substring(0, 120);
          reject(new Error("接口返回 " + status + (detail.length > 0 ? "：" + detail : "")));
          return;
        }
        const bodyText = typeof res.data == "string" ? (res.data as string) : JSON.stringify(res.data);
        const reply = parseChatReply(profile.protocol, bodyText);
        if (reply == null || reply.content.length == 0) {
          reject(new Error("接口响应里没有正文"));
          return;
        }
        reply.elapsedMs = Date.now() - startedAt;
        resolve(reply);
      },
      fail: (err) => {
        reject(new Error(err.errMsg ?? "网络请求失败"));
      },
    });
  });
}

/** 拉模型列表（openai 家族 GET {root}/v1/models；gemini GET {root}/v1beta/models）。
 *  失败 reject，页面允许手填不阻断。 */
export function listModels(
  baseUrl: string,
  key: string,
  protocol: AiProviderProtocol,
  skipCertVerify: boolean,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const base = baseRootOf(baseUrl);
    if (base.length == 0) {
      reject(new Error("接口地址为空"));
      return;
    }
    let url = "";
    const header: Record<string, string> = { "content-type": "application/json" };
    if (protocol == "anthropic") {
      url = joinUrl(base, "/v1/models");
      if (key.length > 0) header["x-api-key"] = key;
      header["anthropic-version"] = "2023-06-01";
    } else if (protocol == "gemini") {
      // Gemini 官方是 /v1beta/models（原先 /v1/models 与 chat 的前缀互相矛盾，
      // 2026-11-03 审阅 R6 对齐 qt-pc models_endpoint）
      url = joinUrl(base, "/v1beta/models");
      if (key.length > 0) header["x-goog-api-key"] = key;
    } else {
      url = joinUrl(base, "/v1/models");
      if (key.length > 0) header["authorization"] = "Bearer " + key;
    }
    uni.request({
      url,
      method: "GET",
      header,
      timeout: 20000,
      sslVerify: !skipCertVerify,
      success: (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("接口返回 " + res.statusCode));
          return;
        }
        const bodyText = typeof res.data == "string" ? (res.data as string) : JSON.stringify(res.data);
        try {
          const obj = JSON.parse(bodyText) as any;
          const data = (obj["data"] ?? obj["models"] ?? []) as any[];
          const names: string[] = [];
          for (let i = 0; i < data.length; i++) {
            const item = data[i];
            let id = "";
            if (item != null && typeof item == "object") {
              id = ((item as any)["id"] ?? (item as any)["name"] ?? "") as string;
              // Gemini 的 name 带 models/ 前缀，拼 URL 时不能重复；缺失
              // supportedGenerationMethods 按支持算，有则只留能 generateContent
              // 的（对齐 qt-pc parse_gemini_models，2026-11-03 审阅 R6）。
              if (protocol == "gemini") {
                if (id.indexOf("models/") == 0) id = id.substring("models/".length);
                const methods = (item as any)["supportedGenerationMethods"] as any[] | null;
                if (methods != null && methods.indexOf("generateContent") < 0) continue;
              }
            }
            if (id.length > 0 && names.indexOf(id) < 0) names.push(id);
          }
          resolve(names);
        } catch (e) {
          reject(new Error("模型列表解析失败"));
        }
      },
      fail: (err) => {
        reject(new Error(err.errMsg ?? "网络请求失败"));
      },
    });
  });
}

/** 试连：发一句「你好」，用表单当前值（允许先试再存） */
export function testConnection(
  baseUrl: string,
  protocol: AiProviderProtocol,
  model: string,
  key: string,
  skipCertVerify: boolean,
): Promise<AiLocalTestResult> {
  return new Promise<AiLocalTestResult>((resolve) => {
    const startedAt = Date.now();
    const fake: AiProviderProfile = {
      id: "",
      name: "",
      baseUrl,
      protocol,
      model,
      models: model.length > 0 ? [model] : [],
      keys: key.length > 0 ? [key] : [],
      icon: "",
      skipCertVerify,
    };
    const req = buildChatRequest(fake, model, key, [{ role: "user", content: "你好" }], 0.2);
    if (req == null) {
      resolve({ ok: false, status: null, elapsedMs: 0, reply: null, error: "接口地址为空" });
      return;
    }
    uni.request({
      url: req.url,
      method: req.method as RequestMethod,
      header: req.header,
      data: req.data,
      timeout: 30000,
      sslVerify: !skipCertVerify,
      success: (res) => {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          resolve({ ok: false, status, elapsedMs: Date.now() - startedAt, reply: null, error: "接口返回 " + status });
          return;
        }
        const bodyText = typeof res.data == "string" ? (res.data as string) : JSON.stringify(res.data);
        const reply = parseChatReply(protocol, bodyText);
        if (reply == null || reply.content.length == 0) {
          resolve({ ok: false, status, elapsedMs: Date.now() - startedAt, reply: null, error: "接口响应里没有正文" });
          return;
        }
        resolve({ ok: true, status, elapsedMs: Date.now() - startedAt, reply: reply.content, error: null });
      },
      fail: (err) => {
        resolve({ ok: false, status: null, elapsedMs: Date.now() - startedAt, reply: null, error: err.errMsg ?? "网络请求失败" });
      },
    });
  });
}
