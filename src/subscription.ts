import { parse as parseYaml } from "yaml";
import { b64decode, parseShareLink, type ClashProxy } from "./links";
import { fetchText, HttpError } from "./text-fetch";

export interface SubscriptionEntry {
  name: string;
  url: string;
  ua?: string;
}

const DEFAULT_SUB_UA = "clash.meta";

export function parseSubscribeMap(raw: string | undefined): SubscriptionEntry[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text) as unknown;
      if (Array.isArray(arr)) {
        const parsed: SubscriptionEntry[] = [];
        for (const item of arr) {
          const obj = item as Record<string, unknown>;
          const name = String(obj.name ?? obj.tag ?? "").trim();
          const url = String(obj.url ?? "").trim();
          if (!name || !url) continue;
          parsed.push({ name, url, ...(obj.ua ? { ua: String(obj.ua) } : {}) });
        }
        return parsed;
      }
    } catch {
      // 继续按自定义格式解析
    }
  }

  const entries: SubscriptionEntry[] = [];
  const blockRe = /\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const fields = match[1].split(/,(?=\s*[\w-]+\s*=)/);
    const map: Record<string, string> = {};
    for (const field of fields) {
      const eq = field.indexOf("=");
      if (eq < 0) continue;
      const key = field.slice(0, eq).trim().toLowerCase();
      const value = field.slice(eq + 1).trim();
      if (key) map[key] = value;
    }
    if (map.name && map.url) {
      entries.push({ name: map.name, url: map.url, ua: map.ua });
    }
  }
  return entries;
}

/**
 * 解析前端提交的纯文本订阅列表，每行一条，写法为「名称 链接」。
 * 名称可以省略，省略时按顺序命名为「订阅1」「订阅2」。
 */
export function parseSubscribeText(raw: string | undefined): SubscriptionEntry[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  const entries: SubscriptionEntry[] = [];
  let auto = 0;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const tokens = line.split(/\s+/);
    const urlIndex = tokens.findIndex((token) => /^https?:\/\//i.test(token));
    if (urlIndex < 0) {
      throw new HttpError(
        400,
        `订阅第 ${i + 1} 行没有找到 http/https 链接：「${line.slice(0, 60)}」，正确写法是「名称 链接」`,
      );
    }

    const url = tokens[urlIndex];
    const name = tokens.slice(0, urlIndex).join(" ").trim() || `订阅${++auto}`;
    entries.push({ name, url });
  }

  return entries;
}

/**
 * 统一入口：环境变量里是 [{name=..,url=..}] 或 JSON 数组，前端提交的是「名称 链接」行文本。
 */
export function parseSubscriptionSource(raw: string | undefined): SubscriptionEntry[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[") || /\{\s*name\s*=/i.test(text)) return parseSubscribeMap(text);
  return parseSubscribeText(text);
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "").trim();
}

function looksBase64(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length > 40 && /^[A-Za-z0-9+/=_-]+$/.test(compact);
}

function fromYaml(text: string): ClashProxy[] | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  const container = doc as Record<string, unknown>;
  const list = container.proxies;
  if (!Array.isArray(list)) return null;

  const nodes: ClashProxy[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const proxy = item as Record<string, unknown>;
    const name = stripQuotes(String(proxy.name ?? ""));
    const type = stripQuotes(String(proxy.type ?? ""));
    if (!name || !type) continue;
    nodes.push({ ...proxy, name, type } as ClashProxy);
  }
  return nodes;
}

function fromShareLinks(text: string): { nodes: ClashProxy[]; skipped: string[] } {
  const nodes: ClashProxy[] = [];
  const skipped: string[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.includes("://")) continue;
    const scheme = line.slice(0, line.indexOf("://")).toLowerCase();
    const node = parseShareLink(line, i);
    if (node) nodes.push(node);
    else if (!skipped.includes(scheme)) skipped.push(scheme);
  }

  return { nodes, skipped };
}

export interface SubscriptionResult {
  name: string;
  url: string;
  nodeCount: number;
  format: string;
  bytes: number;
  warnings: string[];
  nodes: ClashProxy[];
}

export function extractNodes(
  text: string,
  label: string,
): { nodes: ClashProxy[]; format: string; warnings: string[] } {
  const warnings: string[] = [];
  const trimmed = text.trim();

  if (!trimmed) {
    return { nodes: [], format: "空响应", warnings: [`${label}: 响应为空`] };
  }

  let body = trimmed;
  let format = "clash-yaml";

  const yamlNodes = fromYaml(body);
  if (yamlNodes) {
    if (yamlNodes.length === 0) warnings.push(`${label}: YAML 中 proxies 为空`);
    return { nodes: yamlNodes, format, warnings };
  }

  if (looksBase64(body)) {
    const decoded = b64decode(body);
    if (decoded) {
      const innerYaml = fromYaml(decoded);
      if (innerYaml) {
        format = "base64(yaml)";
        if (innerYaml.length === 0) warnings.push(`${label}: base64 解码后 proxies 为空`);
        return { nodes: innerYaml, format, warnings };
      }
      body = decoded;
      format = "base64(links)";
    } else {
      warnings.push(`${label}: 疑似 base64 但解码失败`);
    }
  }

  const links = fromShareLinks(body);
  if (links.nodes.length > 0) {
    format = format === "clash-yaml" ? "share-links" : format;
    if (links.skipped.length) {
      warnings.push(`${label}: 跳过不支持的协议 ${links.skipped.join(", ")}`);
    }
    return { nodes: links.nodes, format, warnings };
  }

  warnings.push(`${label}: 无法识别订阅格式（既不是 Clash YAML，也不是可解析的分享链接）`);
  return { nodes: [], format: "unknown", warnings };
}

export function prefixNodes(nodes: ClashProxy[], prefix: string): ClashProxy[] {
  return nodes.map((node) => ({ ...node, name: `${prefix}_${node.name}` }));
}

export function dedupeNodes(nodes: ClashProxy[]): ClashProxy[] {
  const seen = new Map<string, number>();
  const out: ClashProxy[] = [];

  for (const node of nodes) {
    const base = node.name;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push(count === 0 ? node : { ...node, name: `${base} ${count + 1}` });
  }
  return out;
}

/** 机场常把「剩余流量」「套餐到期」伪装成节点，这类条目不能参与测速和分流 */
const INFO_NAME_RE =
  /(剩余流量|套餐到期|到期时间|距离下次|下次重置|过期时间|流量重置|重置时间|已用流量|官网|订阅地址)/;

const INVALID_SERVERS = new Set(["", "0.0.0.0", "127.0.0.1", "::", "::1"]);

export function filterUsableNodes(nodes: ClashProxy[]): {
  nodes: ClashProxy[];
  dropped: string[];
} {
  const kept: ClashProxy[] = [];
  const dropped: string[] = [];

  for (const node of nodes) {
    const server = String(node.server ?? "").trim();
    const port = Number(node.port);
    const badServer = INVALID_SERVERS.has(server);
    const badPort = !Number.isFinite(port) || port <= 0 || port > 65535;
    if (badServer || badPort || INFO_NAME_RE.test(node.name)) {
      dropped.push(node.name);
      continue;
    }
    kept.push(node);
  }

  return { nodes: kept, dropped };
}

export async function fetchSubscriptions(
  entries: SubscriptionEntry[],
  allowLocal: boolean,
): Promise<{ nodes: ClashProxy[]; results: SubscriptionResult[] }> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const file = await fetchText(entry.url, {
          allowLocal,
          userAgent: entry.ua || DEFAULT_SUB_UA,
          accept: "*/*",
        });
        const extracted = extractNodes(file.text, entry.name);
        const prefixed = prefixNodes(extracted.nodes, entry.name);
        const usable = filterUsableNodes(prefixed);
        if (usable.dropped.length > 0) {
          const sample = usable.dropped.slice(0, 3).join("、");
          const more = usable.dropped.length > 3 ? " 等" : "";
          extracted.warnings.push(
            `${entry.name}: 已过滤 ${usable.dropped.length} 个信息或无效节点（${sample}${more}）`,
          );
        }
        const nodes = usable.nodes;
        return {
          name: entry.name,
          url: entry.url,
          nodeCount: nodes.length,
          format: extracted.format,
          bytes: file.bytes,
          warnings: extracted.warnings,
          nodes,
        } satisfies SubscriptionResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          name: entry.name,
          url: entry.url,
          nodeCount: 0,
          format: "error",
          bytes: 0,
          warnings: [`${entry.name}: 拉取失败 ${msg}`],
          nodes: [],
        } satisfies SubscriptionResult;
      }
    }),
  );

  const nodes = dedupeNodes(results.flatMap((r) => r.nodes));
  return { nodes, results };
}
