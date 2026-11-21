import { cached } from "./cache";
import type { ClashProxy } from "./links";
import {
  fetchRuleList,
  isRuleType,
  isUnsupportedRuleType,
  toClashRule,
  type ParsedRule,
} from "./rules";
import { fetchSubscriptions, parseSubscriptionSource } from "./subscription";
import { buildClashConfig } from "./targets/clash";
import { buildSingboxConfig } from "./targets/singbox";
import { fetchText, HttpError } from "./text-fetch";

export const DEFAULT_TEMPLATE_URL =
  "https://raw.githubusercontent.com/lifeifan38324/ConfigConvert/refs/heads/master/resource/template.yaml";

export type GroupType = "select" | "url-test" | "fallback" | "load-balance";

export interface ProxyGroupConfig {
  name: string;
  type: GroupType;
  otherGroups: string[];
  regexFilter?: string;
  testUrl?: string;
  interval?: number;
  tolerance?: number;
}

export interface RulesetConfig {
  useProxy: string;
  /** 规则列表地址，可省略（此时用内联规则） */
  ruleUrl?: string;
  /** 直接写在 ruleset 里的单条规则，如 {"GEOIP":"CN"} */
  inline?: ParsedRule[];
  /** {"final": true}，等价于最后一条 MATCH */
  final?: boolean;
}

export interface ConvertConfig {
  proxyGroups: ProxyGroupConfig[];
  rulesets: RulesetConfig[];
}

export interface ClashGroup {
  name: string;
  type: GroupType;
  proxies: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
}

export interface RuleEntry extends ParsedRule {
  policy: string;
}

function mapGroupType(raw: string): GroupType {
  const value = String(raw ?? "")
    .toLowerCase()
    .replace(/[_\s]/g, "-");
  if (["ur-test", "url-test", "urltest", "url-testing", "urltest-group"].includes(value)) return "url-test";
  if (["fallback", "auto", "fall-back"].includes(value)) return "fallback";
  if (["load-balance", "loadbalance", "balance"].includes(value)) return "load-balance";
  return "select";
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function parseConvertConfig(raw: unknown, warnings: string[] = []): ConvertConfig {
  let root: unknown = raw;

  if (typeof raw === "string") {
    try {
      root = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(400, `分流配置文件不是合法 JSON：${msg}`);
    }
  }

  if (!root || typeof root !== "object") {
    throw new HttpError(400, "分流配置文件内容为空或格式不对");
  }

  const obj = root as Record<string, unknown>;
  const rawGroups = (obj.proxy_group ?? obj.proxyGroups ?? obj["proxy-groups"]) as unknown;
  const rawRules = (obj.ruleset ?? obj.rulesets ?? obj.rules) as unknown;

  if (!Array.isArray(rawGroups)) {
    throw new HttpError(400, "分流配置缺少 proxy_group 数组");
  }
  if (!Array.isArray(rawRules)) {
    throw new HttpError(400, "分流配置缺少 ruleset 数组");
  }

  const proxyGroups: ProxyGroupConfig[] = rawGroups.map((item, index) => {
    const g = item as Record<string, unknown>;
    const name = String(g.name ?? "").trim();
    if (!name) throw new HttpError(400, `proxy_group[${index}] 缺少 name`);

    const group: ProxyGroupConfig = {
      name,
      type: mapGroupType(String(g.type ?? "select")),
      otherGroups: asArray(g["other-groups"] ?? g.otherGroups),
    };

    const regex = g["regex-filter"] ?? g.regexFilter ?? g.regex;
    if (typeof regex === "string" && regex.trim()) group.regexFilter = regex.trim();

    const testUrl = g["test-utl"] ?? g["test-url"] ?? g.testUrl;
    if (typeof testUrl === "string" && testUrl.trim()) group.testUrl = testUrl.trim();

    if (g.interval !== undefined) {
      const interval = Number(g.interval);
      if (Number.isFinite(interval) && interval > 0) group.interval = interval;
    }
    if (g.tolerance !== undefined) {
      const tolerance = Number(g.tolerance);
      if (Number.isFinite(tolerance)) group.tolerance = tolerance;
    }

    return group;
  });

  const rulesets: RulesetConfig[] = [];

  for (let index = 0; index < rawRules.length; index++) {
    const r = rawRules[index] as Record<string, unknown>;
    const useProxy = String(r["use-proxy"] ?? r.useProxy ?? "").trim();
    if (!useProxy) throw new HttpError(400, `ruleset[${index}] 缺少 use-proxy`);

    let ruleUrl = String(r["rule-url"] ?? r.ruleUrl ?? "").trim();
    let noResolve = String(r["no-resolve"] ?? r.noResolve ?? "") === "true";
    const inline: ParsedRule[] = [];
    const skippedUnsupported: string[] = [];
    let isFinal = false;

    for (const [key, value] of Object.entries(r)) {
      const lower = key.toLowerCase();
      // 元数据字段，不是规则
      if (lower === "use-proxy") continue;
      if (lower === "rule-url") {
        ruleUrl = String(value ?? "").trim();
        continue;
      }
      if (lower === "no-resolve") {
        noResolve = value === true || value === "true" || value === 1;
        continue;
      }
      if (lower === "final") {
        if (value === true || value === "true" || value === 1) isFinal = true;
        continue;
      }

      const type = key.toUpperCase();

      // 内核对不支持的类型直接跳过，避免整份配置加载失败（典型如 URL-REGEX）
      if (!isRuleType(type)) {
        if (isUnsupportedRuleType(type)) {
          skippedUnsupported.push(`${type},${String(value)}`);
          continue;
        }
        throw new HttpError(
          400,
          `ruleset[${index}] 的字段「${key}」不是可识别的规则类型；内联规则应写成规则名，例如 {"use-proxy":"🎯 全球直连","GEOIP":"CN"}`,
        );
      }

      // {"GEOIP": true} 这种写法等价于 MATCH
      if (type === "MATCH" && (value === true || value === "true")) {
        isFinal = true;
        continue;
      }

      const list = Array.isArray(value) ? value.map((v) => String(v)) : [String(value)];
      for (const raw of list) {
        const text = raw.trim();
        if (!text) continue;
        inline.push(noResolve ? { type, value: text, flag: "no-resolve" } : { type, value: text });
      }
    }

    const describeSkipped = (): string =>
      `${skippedUnsupported.slice(0, 3).join("、")}${skippedUnsupported.length > 3 ? " 等" : ""}`;

    if (!ruleUrl && inline.length === 0 && !isFinal) {
      if (skippedUnsupported.length > 0) {
        warnings.push(
          `ruleset[${index}] 的 ${skippedUnsupported.length} 条规则内核均不支持，整条已跳过：${describeSkipped()}`,
        );
        continue;
      }
      throw new HttpError(
        400,
        `ruleset[${index}] 既没有 rule-url，也没有可用的内联规则`,
      );
    }

    if (skippedUnsupported.length > 0) {
      warnings.push(
        `ruleset[${index}] 跳过 ${skippedUnsupported.length} 条内核不支持的规则：${describeSkipped()}`,
      );
    }

    const ruleset: RulesetConfig = { useProxy, final: isFinal };
    if (ruleUrl) ruleset.ruleUrl = ruleUrl;
    if (inline.length > 0) ruleset.inline = inline;
    rulesets.push(ruleset);
  }

  return { proxyGroups, rulesets };
}

/** Clash 内置策略，不需要在 proxy_group 里定义 */
const BUILTIN_TARGETS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS"]);

/**
 * 把 mihomo/Go 风格的正则转成 JS 可用的形式。
 * 主要是去掉内联标志 (?i)，因为编译时统一加了 i 标志；(?i:foo) 这种局部写法没有等价物，直接展开。
 */
function normalizeRegex(pattern: string): string {
  return pattern
    .replace(/\(\?[imsux]+\)/g, "")
    .replace(/\(\?-[imsux]+\)/g, "")
    .replace(/\(\?[imsux]+:/g, "(?:");
}

export function buildGroups(
  nodes: ClashProxy[],
  config: ConvertConfig,
): { groups: ClashGroup[]; warnings: string[] } {
  const warnings: string[] = [];
  const defined = new Set(config.proxyGroups.map((g) => g.name));
  const groups: ClashGroup[] = [];

  for (const cfg of config.proxyGroups) {
    const members: string[] = [];

    for (const other of cfg.otherGroups) {
      if (other === cfg.name) continue;
      if (!defined.has(other) && !BUILTIN_TARGETS.has(other)) {
        warnings.push(`分组「${cfg.name}」引用了不存在的分组「${other}」，已忽略`);
        continue;
      }
      if (!members.includes(other)) members.push(other);
    }

    if (cfg.regexFilter) {
      let regex: RegExp | null = null;
      const pattern = normalizeRegex(cfg.regexFilter);
      try {
        regex = new RegExp(pattern, "i");
      } catch {
        warnings.push(`分组「${cfg.name}」的正则无效：${cfg.regexFilter}`);
      }
      if (regex) {
        for (const node of nodes) {
          if (regex.test(node.name) && !members.includes(node.name)) members.push(node.name);
        }
      }
    }

    if (cfg.type === "select" && !members.includes("DIRECT")) members.push("DIRECT");

    if (members.length === 0) {
      members.push("DIRECT");
      warnings.push(`分组「${cfg.name}」没有匹配到任何节点，已回退为 DIRECT`);
    }

    const group: ClashGroup = { name: cfg.name, type: cfg.type, proxies: members };

    if (cfg.type === "url-test" || cfg.type === "fallback" || cfg.type === "load-balance") {
      group.url = cfg.testUrl ?? "http://www.gstatic.com/generate_204";
      group.interval = cfg.interval ?? 300;
      if (cfg.tolerance !== undefined) group.tolerance = cfg.tolerance;
    }

    groups.push(group);
  }

  return { groups, warnings };
}

export interface RulePlan {
  entries: RuleEntry[];
  clashRules: string[];
  warnings: string[];
  sources: number;
  /** 兜底策略，「漏网之鱼」那一条 final */
  final?: string;
}

export async function buildRulePlan(
  config: ConvertConfig,
  groups: ClashGroup[],
  allowLocal: boolean,
): Promise<RulePlan> {
  const warnings: string[] = [];
  const groupNames = new Set(groups.map((g) => g.name));
  const entries: RuleEntry[] = [];
  const seen = new Set<string>();

  // 只对带 rule-url 的条目发起请求，顺序与 ruleset 数组保持一致
  const lists: ParsedRule[][] = config.rulesets.map(() => []);
  const targets = config.rulesets
    .map((rs, index) => (rs.ruleUrl ? index : -1))
    .filter((index) => index >= 0);

  // 规则列表通常有几十个，一次性并发会被源站限速甚至超时，这里限流并重试一次
  const RULE_CONCURRENCY = 6;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const slot = cursor++;
      if (slot >= targets.length) return;
      const index = targets[slot];
      const url = config.rulesets[index].ruleUrl as string;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const list = await fetchRuleList(url, allowLocal);
          if (list.skipped > 0) {
            const types =
              list.skippedTypes.length > 0
                ? `（${list.skippedTypes.slice(0, 3).join("、")}${
                    list.skippedTypes.length > 3 ? " 等" : ""
                  }）`
                : "";
            warnings.push(`规则集 ${url} 跳过 ${list.skipped} 行内核不支持的规则${types}`);
          }
          lists[index] = list.rules;
          break;
        } catch (err) {
          if (attempt === 0) continue; // 首次失败重试一次
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`规则集 ${url} 拉取失败：${msg}`);
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(RULE_CONCURRENCY, Math.max(targets.length, 1)) }, worker),
  );

  let finalPolicy: string | undefined;

  for (let i = 0; i < config.rulesets.length; i++) {
    const rs = config.rulesets[i];
    if (!groupNames.has(rs.useProxy)) {
      warnings.push(`规则集指向的分组「${rs.useProxy}」不存在，相关规则已跳过`);
      continue;
    }

    // 列表规则在前，内联规则在后，与配置书写顺序一致
    for (const rule of [...lists[i], ...(rs.inline ?? [])]) {
      // 兜底：任何来源的 URL-REGEX 都不写进输出
      if (isUnsupportedRuleType(rule.type)) continue;
      if (rule.type === "MATCH") {
        finalPolicy = rs.useProxy;
        continue;
      }
      const key = `${rule.type}|${rule.value}|${rs.useProxy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...rule, policy: rs.useProxy });
    }

    if (rs.final) finalPolicy = rs.useProxy;
  }

  const clashRules = entries.map((entry) => toClashRule(entry, entry.policy));
  clashRules.push(`MATCH,${finalPolicy ?? "DIRECT"}`);

  return { entries, clashRules, warnings, sources: targets.length, final: finalPolicy };
}

export interface ConvertParams {
  subscribeMapRaw: string;
  configRaw: string;
  templateUrl?: string;
  target: "clash" | "singbox";
  allowLocal: boolean;
}

export interface ConvertStats {
  target: string;
  nodes: number;
  groups: number;
  rules: number;
  subscriptions: { name: string; nodeCount: number; format: string; bytes: number }[];
  elapsedMs: number;
  bytes: number;
}

export interface ConvertResult {
  content: string;
  contentType: string;
  stats: ConvertStats;
  warnings: string[];
}

async function fetchTemplate(url: string, allowLocal: boolean) {
  return cached(`template:${url}`, 10 * 60_000, () =>
    fetchText(url, { allowLocal, accept: "text/yaml,*/*" }),
  );
}

async function loadConfigText(configRaw: string, allowLocal: boolean): Promise<string> {  const raw = configRaw.trim();
  if (!raw) throw new HttpError(500, "未配置分流配置文件（环境变量 CONVERT_CONFIG 或参数 config）");
  if (/^https?:\/\//i.test(raw)) {
    const file = await fetchText(raw, { allowLocal });
    return file.text;
  }
  return raw;
}

export async function runConvert(params: ConvertParams): Promise<ConvertResult> {
  const started = Date.now();

  const entries = parseSubscriptionSource(params.subscribeMapRaw);
  if (entries.length === 0) {
    throw new HttpError(
      500,
      "没有可用的订阅：页面未填写订阅链接，环境变量 SUBSCRIBE_MAP 也为空",
    );
  }

  const configText = await loadConfigText(params.configRaw, params.allowLocal);
  const configWarnings: string[] = [];
  const config = parseConvertConfig(configText, configWarnings);

  const [{ nodes, results }, templateFile] = await Promise.all([
    fetchSubscriptions(entries, params.allowLocal),
    fetchTemplate(params.templateUrl || DEFAULT_TEMPLATE_URL, params.allowLocal),
  ]);

  if (nodes.length === 0) {
    throw new HttpError(502, "所有订阅都没有解析出节点，请检查订阅链接或 UA");
  }

  const { groups, warnings: groupWarnings } = buildGroups(nodes, config);
  const { entries: ruleEntries, clashRules, warnings: ruleWarnings, final: finalPolicy } =
    await buildRulePlan(config, groups, params.allowLocal);

  const warnings = [
    ...configWarnings,
    ...results.flatMap((r) => r.warnings),
    ...groupWarnings,
    ...ruleWarnings,
  ];

  let content: string;
  if (params.target === "singbox") {
    const built = buildSingboxConfig({ nodes, groups, ruleEntries, final: finalPolicy });
    content = built.content;
    if (built.skippedTypes.length > 0) {
      warnings.push(`sing-box 输出不支持的节点类型，已跳过：${built.skippedTypes.join(", ")}`);
    }
    if (built.skippedRules.length > 0) {
      warnings.push(`sing-box 没有对应语法的规则类型，已跳过：${built.skippedRules.join(", ")}`);
    }
  } else {
    content = buildClashConfig(templateFile.text, nodes, groups, clashRules);
  }

  return {
    content,
    contentType:
      params.target === "singbox"
        ? "application/json; charset=utf-8"
        : "text/yaml; charset=utf-8",
    stats: {
      target: params.target,
      nodes: nodes.length,
      groups: groups.length,
      rules: ruleEntries.length,
      subscriptions: results.map((r) => ({
        name: r.name,
        nodeCount: r.nodeCount,
        format: r.format,
        bytes: r.bytes,
      })),
      elapsedMs: Date.now() - started,
      bytes: new TextEncoder().encode(content).byteLength,
    },
    warnings,
  };
}
