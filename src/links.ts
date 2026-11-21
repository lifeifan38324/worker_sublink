export interface ClashProxy {
  name: string;
  type: string;
  [key: string]: unknown;
}

export function b64decode(input: string): string {
  const normalized = input.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function parseHostPort(raw: string): { server: string; port: number } | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const server = value.slice(1, end);
    const port = Number(value.slice(end + 1).replace(/^:/, ""));
    return Number.isFinite(port) && port > 0 ? { server, port } : null;
  }

  const idx = value.lastIndexOf(":");
  if (idx <= 0) return null;
  const server = value.slice(0, idx);
  const port = Number(value.slice(idx + 1));
  return Number.isFinite(port) && port > 0 ? { server, port } : null;
}

function safeName(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw).trim() || fallback;
  } catch {
    return raw.trim() || fallback;
  }
}

function splitScheme(line: string): { scheme: string; body: string } {
  const idx = line.indexOf("://");
  if (idx < 0) return { scheme: "", body: "" };
  return { scheme: line.slice(0, idx).toLowerCase(), body: line.slice(idx + 3) };
}

function parseSS(body: string, fallbackName: string): ClashProxy | null {
  let rest = body;
  let name = fallbackName;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = safeName(rest.slice(hash + 1), fallbackName);
    rest = rest.slice(0, hash);
  }

  let query = "";
  const qm = rest.indexOf("?");
  if (qm >= 0) {
    query = rest.slice(qm + 1);
    rest = rest.slice(0, qm);
  }

  let method: string;
  let password: string;
  let hostPart: string;

  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    hostPart = rest.slice(at + 1);
    const decoded = b64decode(userinfo) || userinfo;
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    method = decoded.slice(0, colon);
    password = decoded.slice(colon + 1);
  } else {
    const decoded = b64decode(rest);
    if (!decoded) return null;
    const at2 = decoded.lastIndexOf("@");
    if (at2 < 0) return null;
    const userinfo = decoded.slice(0, at2);
    hostPart = decoded.slice(at2 + 1);
    const colon = userinfo.indexOf(":");
    if (colon < 0) return null;
    method = userinfo.slice(0, colon);
    password = userinfo.slice(colon + 1);
  }

  const hp = parseHostPort(hostPart);
  if (!hp) return null;

  const proxy: ClashProxy = {
    name,
    type: "ss",
    server: hp.server,
    port: hp.port,
    cipher: method,
    password,
    udp: true,
  };

  const params = new URLSearchParams(query);
  const plugin = params.get("plugin");
  if (plugin) {
    const [pluginName, ...pluginOpts] = plugin.split(";");
    proxy.plugin = pluginName;
    if (pluginOpts.length) {
      const opts: Record<string, string | boolean> = {};
      for (const opt of pluginOpts) {
        const [k, v] = opt.split("=");
        if (!k) continue;
        opts[k] = v ?? true;
      }
      proxy["plugin-opts"] = opts;
    }
  }

  return proxy;
}

function parseVmess(body: string, fallbackName: string): ClashProxy | null {
  const decoded = b64decode(body.split("#")[0]);
  if (!decoded) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }

  const server = String(raw.add ?? "");
  const port = Number(raw.port ?? 0);
  const uuid = String(raw.id ?? "");
  if (!server || !port || !uuid) return null;

  const network = String(raw.net ?? "tcp");
  const tls = String(raw.tls ?? "") === "tls";
  const host = String(raw.host ?? "");
  const path = String(raw.path ?? "");

  const proxy: ClashProxy = {
    name: String(raw.ps ?? fallbackName) || fallbackName,
    type: "vmess",
    server,
    port,
    uuid,
    alterId: Number(raw.aid ?? 0),
    cipher: String(raw.scy ?? "auto") || "auto",
    udp: true,
  };

  if (tls) {
    proxy.tls = true;
    proxy["skip-cert-verify"] = true;
    if (host) proxy.servername = host;
  }

  if (network === "ws") {
    proxy.network = "ws";
    proxy["ws-opts"] = { path: path || "/", headers: host ? { Host: host } : {} };
  } else if (network === "grpc") {
    proxy.network = "grpc";
    proxy["grpc-opts"] = { "grpc-service-name": path || host || "" };
  } else if (network !== "tcp") {
    proxy.network = network;
  }

  return proxy;
}

function parseTrojanLike(
  body: string,
  scheme: "trojan" | "vless",
  fallbackName: string,
): ClashProxy | null {
  let rest = body;
  let name = fallbackName;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = safeName(rest.slice(hash + 1), fallbackName);
    rest = rest.slice(0, hash);
  }

  const at = rest.lastIndexOf("@");
  if (at < 0) return null;
  const secret = rest.slice(0, at);
  const tail = rest.slice(at + 1);

  const qm = tail.indexOf("?");
  const hostPart = qm >= 0 ? tail.slice(0, qm) : tail;
  const params = new URLSearchParams(qm >= 0 ? tail.slice(qm + 1) : "");

  const hp = parseHostPort(hostPart);
  if (!hp) return null;

  const proxy: ClashProxy = {
    name,
    type: scheme,
    server: hp.server,
    port: hp.port,
    udp: true,
  };

  if (scheme === "trojan") proxy.password = secret;
  else proxy.uuid = secret;

  const sni = params.get("sni") || params.get("peer") || params.get("host") || "";
  const security = params.get("security") || "";
  const network = params.get("type") || "tcp";

  if (scheme === "trojan" || security === "tls" || security === "reality") {
    proxy.tls = true;
    if (sni) proxy.sni = sni;
    if (params.get("allowInsecure") === "1" || params.get("insecure") === "1") {
      proxy["skip-cert-verify"] = true;
    }
  } else if (params.get("allowInsecure") === "1") {
    proxy["skip-cert-verify"] = true;
  }

  if (scheme === "vless") {
    if (sni) proxy.servername = sni;
    const flow = params.get("flow");
    if (flow) proxy.flow = flow;
    if (security === "reality") {
      proxy["reality-opts"] = {
        "public-key": params.get("pbk") || "",
        "short-id": params.get("sid") || "",
      };
      if (params.get("fp")) proxy["client-fingerprint"] = params.get("fp");
    }
  }

  if (network === "ws") {
    proxy.network = "ws";
    const path = params.get("path") || "/";
    const host = params.get("host") || "";
    proxy["ws-opts"] = { path, headers: host ? { Host: host } : {} };
  } else if (network === "grpc") {
    proxy.network = "grpc";
    proxy["grpc-opts"] = { "grpc-service-name": params.get("serviceName") || "" };
  }

  return proxy;
}

function parseHysteria2(body: string, fallbackName: string): ClashProxy | null {
  let rest = body;
  let name = fallbackName;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = safeName(rest.slice(hash + 1), fallbackName);
    rest = rest.slice(0, hash);
  }

  const at = rest.lastIndexOf("@");
  if (at < 0) return null;
  const password = safeName(rest.slice(0, at), "");
  const tail = rest.slice(at + 1);

  const qm = tail.indexOf("?");
  const hostPart = qm >= 0 ? tail.slice(0, qm) : tail;
  const params = new URLSearchParams(qm >= 0 ? tail.slice(qm + 1) : "");

  const hp = parseHostPort(hostPart);
  if (!hp) return null;

  const proxy: ClashProxy = {
    name,
    type: "hysteria2",
    server: hp.server,
    port: hp.port,
    password,
    udp: true,
  };

  const sni = params.get("sni") || params.get("peer") || "";
  if (sni) proxy.sni = sni;
  if (params.get("insecure") === "1") proxy["skip-cert-verify"] = true;
  if (params.get("obfs")) {
    proxy.obfs = params.get("obfs");
    proxy["obfs-password"] = params.get("obfs-password") || "";
  }

  return proxy;
}

export function parseShareLink(line: string, index: number): ClashProxy | null {
  const raw = line.trim();
  if (!raw) return null;
  const { scheme, body } = splitScheme(raw);
  const fallback = `node-${index + 1}`;

  switch (scheme) {
    case "ss":
      return parseSS(body, fallback);
    case "vmess":
      return parseVmess(body, fallback);
    case "trojan":
      return parseTrojanLike(body, "trojan", fallback);
    case "vless":
      return parseTrojanLike(body, "vless", fallback);
    case "hysteria2":
    case "hy2":
      return parseHysteria2(body, fallback);
    default:
      return null;
  }
}

export const SUPPORTED_SCHEMES = ["ss", "vmess", "trojan", "vless", "hysteria2", "hy2"];
