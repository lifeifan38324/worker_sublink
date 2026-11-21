import { DEFAULT_TEMPLATE_URL, runConvert } from "./convert";
import { parseSubscriptionSource } from "./subscription";
import { HttpError } from "./text-fetch";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function pickTarget(param: string | null, userAgent: string | null): "clash" | "singbox" {
  const value = (param ?? "").trim().toLowerCase();
  if (["singbox", "sing-box", "sbox"].includes(value)) return "singbox";
  if (["clash", "mihomo", "meta", "stash"].includes(value)) return "clash";

  const ua = (userAgent ?? "").toLowerCase();
  if (ua.includes("sing-box") || ua.includes("sbox")) return "singbox";
  return "clash";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 提示里不泄露 token/密码这类查询参数 */
function maskSecrets(value: string): string {
  return value.replace(
    /([?&](?:token|key|password|passwd|secret|auth)=)[^&\s"'<>]+/gi,
    "$1***",
  );
}

function clip(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 把警告打包进响应头：JSON 数组 → percent 编码。
 * 按整条累加直到预算用尽，不会像直接截断那样切出半个 %XX 序列，
 * 前端 decodeURIComponent 也就不会抛错。
 */
export function packWarnings(warnings: string[], budget = 4000): string {
  if (warnings.length === 0) return "";

  const kept: string[] = [];
  for (const item of warnings) {
    if (encodeURIComponent(JSON.stringify([...kept, item])).length > budget) break;
    kept.push(item);
  }

  if (kept.length === 0) {
    const single = warnings[0].slice(0, Math.max(40, Math.floor(budget / 9)));
    return encodeURIComponent(JSON.stringify([`${single}…`]));
  }

  // 放不下全部时，腾出空间给「还有 N 条」这行提示
  while (kept.length < warnings.length) {
    const rest = `…另有 ${warnings.length - kept.length} 条提示未显示`;
    if (encodeURIComponent(JSON.stringify([...kept, rest])).length <= budget) {
      kept.push(rest);
      break;
    }
    if (kept.length <= 1) break;
    kept.pop();
  }

  return encodeURIComponent(JSON.stringify(kept));
}

/** 给静态页注入「环境变量默认值」作为占位符提示 */
function buildPlaceholders(env: Env): Record<string, string> {
  let subCount = 0;
  try {
    subCount = parseSubscriptionSource(env.SUBSCRIBE_MAP || env.subscribe_map || "").length;
  } catch {
    subCount = 0;
  }

  const subs = [
    "机场A https://example.com/api/v1/client/subscribe?token=xxx",
    "https://example.com/sub",
  ].join("\n");

  const config = env.CONVERT_CONFIG
    ? clip(maskSecrets(env.CONVERT_CONFIG))
    : "留空则使用环境变量 CONVERT_CONFIG；也可以直接粘贴分流 JSON 或配置链接";

  const template = env.TEMPLATE_URL
    ? clip(maskSecrets(env.TEMPLATE_URL))
    : clip(DEFAULT_TEMPLATE_URL);

  const note = [
    `订阅：${subCount > 0 ? `环境变量已配置 ${subCount} 条，留空即使用它` : "环境变量未配置，必须填写"}`,
    `分流配置：${env.CONVERT_CONFIG ? "环境变量已配置，留空即使用它" : "环境变量未配置，必须填写"}`,
    `基础规则：${env.TEMPLATE_URL ? "环境变量已配置，默认用它" : "使用内置默认模板"}`,
  ].join(" · ");

  return {
    __SUBS_PLACEHOLDER__: escapeHtml(subs).replace(/\n/g, "&#10;"),
    __CONFIG_PLACEHOLDER__: escapeHtml(config),
    __TEMPLATE_PLACEHOLDER__: escapeHtml(template),
    __ENV_NOTE__: escapeHtml(note),
  };
}

async function servePage(request: Request, env: Env): Promise<Response> {
  const assetUrl = new URL("/index.html", new URL(request.url).origin);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { headers: request.headers }));
  if (!asset.ok) return asset;

  const html = await asset.text();
  const filled = Object.entries(buildPlaceholders(env)).reduce(
    (acc, [token, value]) => acc.replaceAll(token, value),
    html,
  );

  return new Response(filled, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    const allowLocal = env.ALLOW_LOCAL_FETCH === "true";

    if (url.pathname === "/api/health") {
      return json({ status: "ok", runtime: "workerd" });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        return await servePage(request, env);
      } catch {
        return env.ASSETS.fetch(request);
      }
    }

    try {
      if (url.pathname === "/api/convert") {
        // 页面提交的订阅是「名称 链接」行文本；没带就用环境变量
        const subsParam = (url.searchParams.get("subs") ?? "").trim();
        const subscribeMapRaw =
          subsParam || env.SUBSCRIBE_MAP || env.subscribe_map || "";

        const result = await runConvert({
          subscribeMapRaw,
          configRaw: url.searchParams.get("config") || env.CONVERT_CONFIG || "",
          templateUrl: url.searchParams.get("template") || env.TEMPLATE_URL || DEFAULT_TEMPLATE_URL,
          target: pickTarget(url.searchParams.get("target"), request.headers.get("user-agent")),
          allowLocal,
        });

        if (url.searchParams.get("stats") === "1") {
          return json({ ...result.stats, warnings: result.warnings });
        }

        return new Response(result.content, {
          headers: {
            "content-type": result.contentType,
            "cache-control": "no-store",
            "profile-update-interval": "24",
            "x-convert-stats": encodeURIComponent(JSON.stringify(result.stats)),
            "x-convert-warnings": packWarnings(result.warnings),
          },
        });
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: `服务内部错误：${msg}` }, 500);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found", path: url.pathname }, 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
