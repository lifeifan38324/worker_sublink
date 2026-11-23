import type { ClashGroup, RuleEntry } from "../convert";
import type { ClashProxy } from "../links";
import { HttpError } from "../text-fetch";

/** 模板字段五花八门，取不到的一律当没写，所以这里用宽松类型 */
type Obj = Record<string, any>;

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

/** 需要目标地址才能判断的字段，必须放在 resolve 动作之后 */
const IP_FIELDS = new Set(["ip_cidr", "ip_is_private"]);

/** Clash 里的拒绝策略，在 sing-box 1.13+ 只能写成 rule action: reject */
const REJECT_TARGETS = new Set(["REJECT", "REJECT-DROP", "BLOCK"]);

/** 没有任何基础配置兜底时用到的 .srs 源（与 sing-box 官方文档一致） */
const RULE_SET_BASE = "https://raw.githubusercontent.com/SagerNet/sing";

const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";

function isRejectTarget(value: string): boolean {
  return REJECT_TARGETS.has(value.trim().toUpperCase());
}

/* ------------------------------------------------------------------ */
/* 出站：节点 + 分组                                                    */
/* ------------------------------------------------------------------ */

interface OutboundPlan {
  outbounds: Obj[];
  /** 本次输出里所有可被引用的出站 tag */
  tags: Set<string>;
  /** 纯 REJECT 分组：sing-box 没有对应出站，规则里改写成 reject 动作 */
  rejectTags: Set<string>;
  /** 替代模板里 select / GLOBAL 这类主出站的 tag */
  primary: string;
  skippedTypes: string[];
  warnings: string[];
}

function buildGroupOutbound(group: ClashGroup, members: string[]): Obj {
  if (group.type === "url-test" || group.type === "fallback") {
    return {
      type: "urltest",
      tag: group.name,
      outbounds: members,
      url: group.url ?? DEFAULT_TEST_URL,
      interval: `${Math.max(group.interval ?? 300, 30)}s`,
      ...(group.tolerance !== undefined ? { tolerance: group.tolerance } : {}),
    };
  }
  return { type: "selector", tag: group.name, outbounds: members };
}

function planOutbounds(nodes: ClashProxy[], groups: ClashGroup[]): OutboundPlan {
  const outbounds: Obj[] = [];
  const tags = new Set<string>();
  const skippedTypes = new Set<string>();

  for (const node of nodes) {
    const converted = convertNode(node);
    if (!converted) {
      skippedTypes.add(node.type);
      continue;
    }
    // 同名节点会让 sing-box 直接拒绝加载，保留先出现的那个
    if (tags.has(node.name)) continue;
    outbounds.push(converted);
    tags.add(node.name);
  }

  const groupNames = new Set(groups.map((g) => g.name));
  /** 规则命中后要拦截的分组：整组只有 REJECT，或者默认策略（第一个成员）就是 REJECT */
  const rejectTags = new Set<string>();
  /** 其中「默认是 REJECT、但还有别的选项」的那批，需要单独提示灵活性被削弱 */
  const defaultRejectTags = new Set<string>();
  for (const group of groups) {
    if (group.proxies.length === 0) continue;
    if (group.proxies.every((m) => isRejectTarget(m))) {
      rejectTags.add(group.name);
      continue;
    }
    if (isRejectTarget(str(group.proxies[0]))) {
      rejectTags.add(group.name);
      defaultRejectTags.add(group.name);
    }
  }

  const warnings: string[] = [];
  const added: string[] = [];

  for (const group of groups) {
    if (rejectTags.has(group.name)) {
      if (defaultRejectTags.has(group.name)) {
        warnings.push(
          `分组「${group.name}」默认策略是 REJECT（第一个成员），sing-box 的 selector 放不了 reject，` +
            `已按「命中即拦截」处理；要能一键放行，请把它改成只含 DIRECT 或节点的分组`,
        );
      }
      continue;
    }

    if (tags.has(group.name)) {
      warnings.push(`分组「${group.name}」与某个节点同名，sing-box 不允许重复 tag，该分组已忽略`);
      continue;
    }

    const members: string[] = [];
    let droppedReject = 0;
    const droppedRejectGroups: string[] = [];

    for (const member of group.proxies) {
      if (isRejectTarget(member)) {
        droppedReject++;
        continue;
      }
      if (rejectTags.has(member)) {
        droppedRejectGroups.push(member);
        continue;
      }
      if (member === "DIRECT") {
        if (!members.includes("direct")) members.push("direct");
        continue;
      }
      if (member === "PASS") continue;
      if (member === group.name) continue;
      if (groupNames.has(member) || tags.has(member)) {
        if (!members.includes(member)) members.push(member);
      }
    }

    if (droppedReject > 0 || droppedRejectGroups.length > 0) {
      const parts: string[] = [];
      if (droppedReject > 0) parts.push(`${droppedReject} 个 REJECT 成员`);
      if (droppedRejectGroups.length > 0) {
        parts.push(`拦截分组「${droppedRejectGroups.join("」「")}」`);
      }

      // 能走到这里说明该组默认不是拦截（第一个成员另有其人），所以丢掉 REJECT 只影响手动切换
      warnings.push(
        `分组「${group.name}」包含 ${parts.join("、")}，sing-box 的 selector 放不了 reject，已忽略；` +
          `这组的默认策略不受影响，但客户端里少了一个「拦截」选项`,
      );
    }

    if (members.length === 0) {
      members.push("direct");
      warnings.push(`分组「${group.name}」没有可用节点，已回退为 direct`);
    }

    outbounds.push(buildGroupOutbound(group, members));
    tags.add(group.name);
    added.push(group.name);
  }

  outbounds.push({ type: "direct", tag: "direct" });
  tags.add("direct");

  return {
    outbounds,
    tags,
    rejectTags,
    primary: added[0] ?? "direct",
    skippedTypes: [...skippedTypes],
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 规则：沿用分流配置里的顺序，按「域名类 / IP 类」切成两段               */
/* ------------------------------------------------------------------ */

interface NeededRuleSet {
  kind: "geoip" | "geosite";
  value: string;
  tag: string;
}

interface RulePlan {
  domain: Obj[];
  ip: Obj[];
  ruleSets: NeededRuleSet[];
  skippedRules: string[];
}

function planRules(entries: RuleEntry[], plan: OutboundPlan): RulePlan {
  const domain: Obj[] = [];
  const ip: Obj[] = [];
  const needed = new Map<string, NeededRuleSet>();
  const skippedRules = new Set<string>();

  for (const entry of entries) {
    const policy = entry.policy.trim();
    const reject = isRejectTarget(policy) || plan.rejectTags.has(policy);
    const outbound = reject ? undefined : policy === "DIRECT" ? "direct" : policy;

    if (!reject && (!outbound || !plan.tags.has(outbound))) {
      skippedRules.add(policy || "(空策略)");
      continue;
    }

    const target: Obj = reject ? { action: "reject" } : { action: "route", outbound };

    if (entry.type === "GEOIP" || entry.type === "GEOSITE") {
      const kind: "geoip" | "geosite" = entry.type === "GEOIP" ? "geoip" : "geosite";
      const value = entry.value.trim().toLowerCase();
      if (!value) continue;
      const tag = `${kind}-${value}`;
      if (!needed.has(tag)) needed.set(tag, { kind, value, tag });
      const rule: Obj = { rule_set: [tag], ...target };
      (kind === "geoip" ? ip : domain).push(rule);
      continue;
    }

    const field = RULE_FIELD[entry.type];
    if (!field) {
      skippedRules.add(entry.type);
      continue;
    }

    if (field === "ip_is_private") {
      ip.push({ ip_is_private: true, ...target });
      continue;
    }

    const value = entry.type === "NETWORK" ? entry.value.toLowerCase() : entry.value;
    const rule: Obj = { [field]: [value], ...target };
    (IP_FIELDS.has(field) ? ip : domain).push(rule);
  }

  return { domain, ip, ruleSets: [...needed.values()], skippedRules: [...skippedRules] };
}

interface FinalPlan {
  tag: string;
  reject: boolean;
}

function planFinal(final: string | undefined, plan: OutboundPlan): FinalPlan {
  const value = str(final).trim();
  if (!value || value.toUpperCase() === "DIRECT") return { tag: "direct", reject: false };
  if (isRejectTarget(value) || plan.rejectTags.has(value)) return { tag: "direct", reject: true };
  if (plan.tags.has(value)) return { tag: value, reject: false };
  return { tag: "direct", reject: false };
}

/* ------------------------------------------------------------------ */
/* 与基础配置合并                                                       */
/* ------------------------------------------------------------------ */

function parseBaseTemplate(text: string): Obj {
  const raw = (text ?? "").trim();
  if (!raw) {
    throw new HttpError(
      500,
      "缺少 sing-box 基础配置：环境变量 SINGBOX_TEMPLATE_URL 未配置，请求参数 sbox_template 也没有提供",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `sing-box 基础配置不是合法 JSON：${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(502, "sing-box 基础配置的顶层必须是 JSON 对象");
  }
  return parsed as Obj;
}

/** 递归看一条规则（含 logical 嵌套）有没有引用 rule_set，用于判断它是不是模板自带的分流规则 */
function referencesRuleSet(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => referencesRuleSet(item, depth + 1));
  const obj = value as Obj;
  if (obj.rule_set !== undefined) return true;
  return Object.values(obj).some((item) => referencesRuleSet(item, depth + 1));
}

/** 按模板已有的 .srs 地址推同类规则集的 URL，推不出来再退回 SagerNet */
function ruleSetUrl(need: NeededRuleSet, sample?: Obj): string {
  const url = str(sample?.url);
  const matched = /^(https?:\/\/.+\/geo\/)(?:geoip|geosite)\/[^/?#]+\.srs$/.exec(url);
  if (matched) return `${matched[1]}${need.kind}/${need.value}.srs`;
  return `${RULE_SET_BASE}-${need.kind}/rule-set/${need.tag}.srs`;
}

function mergeRuleSets(templateRoute: Obj, needed: NeededRuleSet[], warnings: string[]): Obj[] {
  const merged: Obj[] = (Array.isArray(templateRoute.rule_set) ? templateRoute.rule_set : [])
    .filter((item: unknown) => item && typeof item === "object")
    .map((item: Obj) => ({ ...item }));

  const known = new Map<string, Obj>();
  for (const item of merged) {
    const tag = str(item.tag);
    if (tag) known.set(tag, item);
  }

  const sample = merged.find((item) => str(item.type || "remote") === "remote" && str(item.url));
  const httpClient = sample ? str(sample.http_client) : "";

  for (const need of needed) {
    if (known.has(need.tag)) continue; // 模板里已经有同名规则集，直接复用（保留它自己的镜像和 http_client）
    const item: Obj = {
      type: "remote",
      tag: need.tag,
      format: "binary",
      url: ruleSetUrl(need, sample),
    };
    if (httpClient) item.http_client = httpClient;
    merged.push(item);
    known.set(need.tag, item);

    if (!sample) {
      warnings.push(`基础配置里没有现成的远程 rule_set，规则集「${need.tag}」已按 SagerNet 官方地址生成`);
    }
  }

  return merged;
}

function mergeIntoTemplate(
  template: Obj,
  plan: OutboundPlan,
  rules: RulePlan,
  final: FinalPlan,
  warnings: string[],
): Obj {
  const config: Obj = { ...template };
  config.outbounds = plan.outbounds;

  const remapped = new Set<string>();
  const remap = (tag: unknown, where: string): unknown => {
    if (typeof tag !== "string" || !tag) return tag;
    if (plan.tags.has(tag)) return tag;
    if (!remapped.has(tag)) {
      remapped.add(tag);
      warnings.push(`${where}指向模板出站「${tag}」，本次输出没有这个出站，已改指向「${plan.primary}」`);
    }
    return plan.primary;
  };

  // DNS 服务器可能 detour 到模板自带的出站（如 proxy-dns → select），要跟着换成本次的分组
  if (template.dns && typeof template.dns === "object" && Array.isArray(template.dns.servers)) {
    const dns: Obj = { ...template.dns };
    dns.servers = dns.servers.map((server: Obj) => {
      if (!server || typeof server !== "object") return server;
      const next: Obj = { ...server };
      if (typeof next.detour === "string") {
        const label = `DNS 服务器「${str(next.tag) || str(next.server)}」的 detour `;
        next.detour = remap(next.detour, label);
      }
      return next;
    });
    config.dns = dns;
  }

  const templateRoute: Obj =
    template.route && typeof template.route === "object" ? (template.route as Obj) : {};

  // 模板自带的分流规则（引用 rule_set 的那些）整体换成本次规则，系统规则（sniff / hijack-dns / resolve 等）保留
  const kept: Obj[] = [];
  let replaced = 0;
  for (const rule of Array.isArray(templateRoute.rules) ? templateRoute.rules : []) {
    if (!rule || typeof rule !== "object") continue;
    if (referencesRuleSet(rule)) {
      replaced++;
      continue;
    }
    const next: Obj = { ...(rule as Obj) };
    if (typeof next.outbound === "string") {
      next.outbound = remap(next.outbound, "基础配置的路由规则");
    }
    kept.push(next);
  }

  // 域名类规则放 resolve 之前，IP 类规则放 resolve 之后：resolve 之后才能拿到目标 IP
  const resolveIndex = kept.findIndex((rule) => rule.action === "resolve");
  const head = resolveIndex >= 0 ? kept.slice(0, resolveIndex) : kept;
  const resolveRules = resolveIndex >= 0 ? [kept[resolveIndex]] : [];
  const tail = resolveIndex >= 0 ? kept.slice(resolveIndex + 1) : [];

  const routeRules: Obj[] = [...head, ...rules.domain, ...resolveRules, ...rules.ip, ...tail];
  if (final.reject) routeRules.push({ action: "reject" });

  const route: Obj = { ...templateRoute };
  route.rules = routeRules;
  route.final = final.tag;

  const ruleSets = mergeRuleSets(templateRoute, rules.ruleSets, warnings);
  if (ruleSets.length > 0) route.rule_set = ruleSets;
  else delete route.rule_set;

  config.route = route;

  if (replaced > 0) {
    warnings.push(`基础配置里的 ${replaced} 条分流规则（引用 rule_set 的）已由本次分流规则替换`);
  }
  if (resolveIndex < 0 && rules.ip.length > 0) {
    warnings.push("基础配置里没有 resolve 规则，IP 类规则只对目标本身是 IP 的流量生效");
  }

  return config;
}

export interface SingboxBuild {
  content: string;
  skippedTypes: string[];
  skippedRules: string[];
  warnings: string[];
}

export interface SingboxInput {
  nodes: ClashProxy[];
  groups: ClashGroup[];
  ruleEntries: RuleEntry[];
  /** MATCH 对应的兜底出站，缺省为 direct */
  final?: string;
  /** 基础配置 JSON 原文（android/1.15/fakeip.json 之类），必填 */
  templateText: string;
}

/**
 * 生成 sing-box 配置：以基础配置为骨架（DNS / TUN / fakeip / experimental 全部保留），
 * 只替换其中的 outbounds、route.rules、route.rule_set 与 route.final。
 * 基础配置必须由调用方提供（环境变量 SINGBOX_TEMPLATE_URL 或参数 sbox_template），代码里不内置任何默认骨架。
 */
export function buildSingboxConfig(input: SingboxInput): SingboxBuild {
  const warnings: string[] = [];

  const plan = planOutbounds(input.nodes, input.groups);
  warnings.push(...plan.warnings);

  const rules = planRules(input.ruleEntries, plan);
  const final = planFinal(input.final, plan);
  const template = parseBaseTemplate(input.templateText);
  const config = mergeIntoTemplate(template, plan, rules, final, warnings);

  return {
    content: JSON.stringify(config, null, 2),
    skippedTypes: plan.skippedTypes,
    skippedRules: rules.skippedRules,
    warnings,
  };
}
