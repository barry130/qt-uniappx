/**
 * API 基地址配置（dev / prod 分离）
 *
 * - 开发环境地址：可正常提交到仓库。
 * - 生产环境地址：放在「不提交」的 services/config.local.ts 里（已加入 .gitignore），避免泄露到 GitHub。
 * - 切换环境：把 USE_DEV 改为 false（发布生产前改），即使用生产地址。
 */
import { API_BASE_URL_PROD } from "./config.local";

/** 开发环境基地址（本地/局域网服务，可提交） */
export const API_BASE_URL_DEV = "http://192.168.1.117:27000/api/v1/";

/** true=开发环境；false=生产环境（发布前改） */
export const USE_DEV = false;

/** 最终生效的 API 基地址 */
export const API_BASE_URL = USE_DEV ? API_BASE_URL_DEV : API_BASE_URL_PROD;
