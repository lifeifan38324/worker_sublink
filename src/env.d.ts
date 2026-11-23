/**
 * 这三项用 Cloudflare secret 存储，不写进 wrangler.jsonc 的 vars，
 * 否则会与 secret 同名冲突（Binding name already in use）。
 * `wrangler types` 只会根据 vars 生成类型，所以在这里补声明。
 */
interface Env extends __BaseEnv_Env {
  SUBSCRIBE_MAP: string;
  /** 历史兼容的小写写法，可不存在 */
  subscribe_map?: string;
  CONVERT_CONFIG: string;
  TEMPLATE_URL: string;
  /** sing-box 基础配置：http(s) 链接，或直接是 JSON 文本；生成 sing-box 时必填 */
  SINGBOX_TEMPLATE_URL: string;
}
