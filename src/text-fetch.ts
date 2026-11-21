export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,
  /^::1$/i,
  /^169\.254\./,
  /\.local$/i,
  /\.internal$/i,
];

export function assertFetchable(rawUrl: string, allowLocal: boolean): URL {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw new HttpError(400, "链接格式不合法，需要以 http:// 或 https:// 开头");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, `只支持 http/https 链接，当前是 ${url.protocol}`);
  }
  if (!allowLocal && BLOCKED_HOSTS.some((re) => re.test(url.hostname))) {
    throw new HttpError(400, "出于安全考虑，不允许访问本机或内网地址");
  }
  return url;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    throw new HttpError(413, `文件过大（${formatBytes(declared)}），上限 ${formatBytes(max)}`);
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw new HttpError(413, `文件过大，上限 ${formatBytes(max)}`);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, `文件超过 ${formatBytes(max)} 上限，已中断下载`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function countReplacement(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) n++;
  return n;
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8 (BOM)" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }

  const asUtf8 = new TextDecoder("utf-8").decode(bytes);
  const utf8Bad = countReplacement(asUtf8);
  if (utf8Bad === 0) return { text: asUtf8, encoding: "utf-8" };

  try {
    const asGbk = new TextDecoder("gb18030").decode(bytes);
    if (countReplacement(asGbk) < utf8Bad) return { text: asGbk, encoding: "gb18030" };
  } catch {
    // 运行时缺少该编码表时忽略，回退到 utf-8 结果
  }

  return { text: asUtf8, encoding: "utf-8 (存在无法解码的字节)" };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export interface FetchedText {
  url: string;
  finalUrl: string;
  text: string;
  encoding: string;
  bytes: number;
  contentType: string | null;
}

export interface FetchOptions {
  allowLocal?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  userAgent?: string;
}

export async function fetchText(rawUrl: string, opts: FetchOptions = {}): Promise<FetchedText> {
  const url = assertFetchable(rawUrl, !!opts.allowLocal);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      redirect: "follow",
      headers: {
        "user-agent": opts.userAgent ?? "Mozilla/5.0 (compatible; worker-sublink/1.0)",
        accept: opts.accept ?? "*/*",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new HttpError(504, `源站 ${timeoutMs / 1000} 秒内无响应`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `拉取失败：${msg}`);
  }

  if (!res.ok) {
    throw new HttpError(502, `源站返回 ${res.status} ${res.statusText || ""}`.trim());
  }

  const bytes = await readCapped(res, maxBytes);
  const { text, encoding } = decodeText(bytes);

  return {
    url: url.toString(),
    finalUrl: res.url || url.toString(),
    text,
    encoding,
    bytes: bytes.byteLength,
    contentType: res.headers.get("content-type"),
  };
}
