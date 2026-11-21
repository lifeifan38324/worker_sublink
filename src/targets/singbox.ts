import type { ClashGroup, RuleEntry } from "../convert";
import type { ClashProxy } from "../links";

type Obj = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function buildTransport(node: ClashProxy): Obj | undefined {
  const network = str(node.network || (node as Obj)["network"]).toLowerCase();
  const wsOpts = node["ws-opts"] as Obj | undefined;
  const grpcOpts = node["grpc-opts"] as Obj | undefined;
  const httpOpts = node["http-opts"] as Obj | undefined;
  const wsPath = str(wsOpts?.path) || "/";

  if (network === "ws" || wsOpts) {
    const headers = (wsOpts?.headers ?? {}) as Record<string, string>;
    const transport: Obj = { type: "ws", path: wsPath };
    if (headers && Object.keys(headers).length > 0) {
      transport.headers = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, str(v)]),
      );
    }
    return transport;
  }

  if (network === "grpc" || grpcOpts) {
    return {
      type: "grpc",
      service_name: str(grpcOpts?.["grpc-service-name"]),
    };
  }

  if (network === "h2" || network === "http" || httpOpts) {
    return { type: "http", path: str(httpOpts?.path) || wsPath };
  }

  return undefined;
}

function buildTls(node: ClashProxy, defaultEnabled: boolean): Obj | undefined {
  const enabled = node.tls === undefined ? defaultEnabled : truthy(node.tls);
  const reality = node["reality-opts"] as Obj | undefined;
  if (!enabled && !reality) return undefined;

  const tls: Obj = { enabled: true };
  const serverName = str(node.servername || node.sni);
  if (serverName) tls.server_name = serverName;
  if (truthy(node["skip-cert-verify"])) tls.insecure = true;

  const fingerprint = str(node["client-fingerprint"]);
  if (fingerprint) tls.utls = { enabled: true, fingerprint };

  if (reality) {
    tls.reality = {
      enabled: true,
      public_key: str(reality["public-key"]),
      short_id: str(reality["short-id"]),
    };
  }

  return tls;
}

function convertNode(node: ClashProxy): Obj | null {
  const base: Obj = {
    tag: node.name,
    server: str(node.server),
    server_port: num(node.port),
  };

  switch (node.type) {
    case "ss": {
      const out: Obj = {
        type: "shadowsocks",
        ...base,
        method: str(node.cipher),
        password: str(node.password),
      };
      const plugin = str(node.plugin);
      if (plugin) {
        out.plugin = plugin;
        const opts = node["plugin-opts"] as Obj | undefined;
        if (opts && typeof opts === "object") {
          out.plugin_opts = Object.entries(opts)
            .map(([k, v]) => (v === true ? k : `${k}=${str(v)}`))
            .join(";");
        }
      }
      return out;
    }

    case "vmess": {
      const out: Obj = {
        type: "vmess",
        ...base,
        uuid: str(node.uuid),
        security: str(node.cipher) || "auto",
        alter_id: num(node.alterId),
      };
      const transport = buildTransport(node);
      if (transport) out.transport = transport;
      const tls = buildTls(node, false);
      if (tls) out.tls = tls;
      return out;
    }

    case "trojan": {
      const out: Obj = {
        type: "trojan",
        ...base,
        password: str(node.password),
      };
      const transport = buildTransport(node);
      if (transport) out.transport = transport;
      const tls = buildTls(node, true);
      if (tls) out.tls = tls;
      return out;
    }

    case "vless": {
      const out: Obj = {
        type: "vless",
        ...base,
        uuid: str(node.uuid),
      };
      const flow = str(node.flow);
      if (flow) out.flow = flow;
      const transport = buildTransport(node);
      if (transport) out.transport = transport;
      const tls = buildTls(node, true);
      if (tls) out.tls = tls;
      return out;
    }

    case "hysteria2": {
      const out: Obj = {
        type: "hysteria2",
        ...base,
        password: str(node.password),
      };
      const tls = buildTls(node, true);
      if (tls) out.tls = tls;
      const obfs = str(node.obfs);
      if (obfs) out.obfs = { type: obfs, password: str(node["obfs-password"]) };
      return out;
    }

    default:
      return null;
  }
}

const RULE_FIELD: Record<string, string> = {
  DOMAIN: "domain",
  "DOMAIN-SUFFIX": "domain_suffix",
  "DOMAIN-KEYWORD": "domain_keyword",
  "DOMAIN-REGEX": "domain_regex",
  "IP-CIDR": "ip_cidr",
  "IP-CIDR6": "ip_cidr",
  "IP-ISET": "ip_is_private",
  "PROCESS-NAME": "process_name",
  "PROCESS-PATH": "process_path",
  "SRC-IP-CIDR": "source_ip_cidr",
  "SRC-PORT": "source_port",
  "DST-PORT": "port",
  NETWORK: "network",
};

/** sing-box 1.11 起 GEOIP/GEOSITE 不能写在规则里，改用远程 rule_set（.srs） */
const RULE_SET_BASE = "https://raw.githubusercontent.com/SagerNet/sing";

export interface SingboxBuild {
  content: string;
  skippedTypes: string[];
  skippedRules: string[];
}

export function buildSingboxConfig(input: {
  nodes: ClashProxy[];
  groups: ClashGroup[];
  ruleEntries: RuleEntry[];
  /** MATCH 对应的兜底出站，缺省为 direct */
  final?: string;
}): SingboxBuild {
  const outbounds: Obj[] = [];
  const skipped = new Set<string>();
  const available = new Set<string>();

  for (const node of input.nodes) {
    const converted = convertNode(node);
    if (!converted) {
      skipped.add(node.type);
      continue;
    }
    outbounds.push(converted);
    available.add(node.name);
  }

  const groupNames = new Set(input.groups.map((g) => g.name));
  const resolve = (member: string): string | null => {
    if (member === "DIRECT") return "direct";
    if (member === "REJECT" || member === "REJECT-DROP") return "REJECT";
    if (groupNames.has(member)) return member;
    if (available.has(member)) return member;
    return null;
  };

  for (const group of input.groups) {
    const members = group.proxies
      .map(resolve)
      .filter((m): m is string => m !== null && m !== group.name);
    const unique = [...new Set(members)];
    if (unique.length === 0) unique.push("direct");

    if (group.type === "url-test" || group.type === "fallback") {
      outbounds.push({
        type: "urltest",
        tag: group.name,
        outbounds: unique,
        url: group.url ?? "http://www.gstatic.com/generate_204",
        interval: `${Math.max(group.interval ?? 300, 30)}s`,
        ...(group.tolerance !== undefined ? { tolerance: group.tolerance } : {}),
      });
    } else {
      outbounds.push({ type: "selector", tag: group.name, outbounds: unique });
    }
  }

  outbounds.push({ type: "direct", tag: "direct" });

  const needsReject = input.groups.some((g) =>
    g.proxies.some((m) => m === "REJECT" || m === "REJECT-DROP"),
  );
  if (needsReject) outbounds.push({ type: "block", tag: "REJECT" });

  const rules: Obj[] = [];
  const ruleSets: Obj[] = [];
  const ruleSetTags = new Set<string>();
  const skippedRules = new Set<string>();

  const ensureRuleSet = (kind: "geoip" | "geosite", value: string): string => {
    const slug = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const tag = `${kind}-${slug}`;
    if (!ruleSetTags.has(tag)) {
      ruleSetTags.add(tag);
      ruleSets.push({
        type: "remote",
        tag,
        format: "binary",
        url: `${RULE_SET_BASE}-${kind}/rule-set/${tag}.srs`,
      });
    }
    return tag;
  };

  for (const entry of input.ruleEntries) {
    if (!groupNames.has(entry.policy)) continue;

    if (entry.type === "GEOIP" || entry.type === "GEOSITE") {
      const kind = entry.type === "GEOIP" ? "geoip" : "geosite";
      rules.push({ rule_set: [ensureRuleSet(kind, entry.value)], outbound: entry.policy });
      continue;
    }

    const field = RULE_FIELD[entry.type];
    if (!field) {
      skippedRules.add(entry.type);
      continue;
    }
    const value = entry.type === "NETWORK" ? entry.value.toLowerCase() : entry.value;
    rules.push({ [field]: [value], outbound: entry.policy });
  }

  const finalTag =
    !input.final || input.final === "DIRECT"
      ? "direct"
      : input.final === "REJECT"
        ? "REJECT"
        : groupNames.has(input.final)
          ? input.final
          : "direct";

  const config = {
    log: { level: "info", timestamp: true },
    inbounds: [
      { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 7890 },
    ],
    outbounds,
    route: {
      ...(ruleSets.length > 0 ? { rule_set: ruleSets } : {}),
      rules,
      final: finalTag,
    },
  };

  return {
    content: JSON.stringify(config, null, 2),
    skippedTypes: [...skipped],
    skippedRules: [...skippedRules],
  };
}
